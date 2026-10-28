/**
 * QQ 工具集与工具白名单 —— 把 OneBot(SnowLuma) 的能力挂成 agent 可调用的工具。
 *
 * 三条约束决定了这里的形状：
 *
 * 1. **读图必须走附件服务**。工具的返回值只能是 lossless JSON（`output.schema` 里声明的），
 *    塞不进图片字节；DSH 让模型"看见"图的唯一通道是 `exec.deferContext()` + `ImageBlock`，
 *    而 `ImageBlock.attachment` 必须由 `ctx.attachments.saveImage()` 生成。
 *    拿不到附件服务时**不报错**，而是返回一句"看不了图"让模型自然回话（用户定的口径）。
 *
 * 2. **写类必须走出站队列**。直连 OneBot 会绕过限流、分条、ledger、死信重试 ——
 *    这些正是防止"机器人自己刷屏"的唯一保障。
 *
 * 3. **白名单要能容错**。`tools.restrict({allow})` 对**未注册的名字会抛错**，
 *    而各 profile 注册的工具集合不同（MCP 是动态的）。所以：先 `schemas()` 取真实清单，
 *    求交集再 restrict；配了但当前不存在的项留痕，绝不让会话建不起来。
 */

import { randomUUID } from 'node:crypto'

import { planReply } from '../outbox/split.js'
import { isDenied, resolveAllowed } from './catalog.js'

/** `g:123` / `u:456` → 目标信息 */
export function parseChatKey(chatKey) {
  const key = String(chatKey ?? '')
  if (key.startsWith('g:')) return { kind: 'group', groupId: key.slice(2) }
  if (key.startsWith('u:')) return { kind: 'private', userId: key.slice(2) }
  return { kind: 'unknown' }
}

/**
 * 从 `get_image` 的返回值里取图片字节。
 *
 * SnowLuma/OneBot 实现之间不统一，三种都可能遇到：
 *   - `{ file: 'base64://....' }`
 *   - `{ url: 'https://...' }`（或 `file` 本身就是 http 链接）
 *   - `{ file: '/abs/path.jpg' }`（本地路径，仅同机部署才有）
 *
 * @param {unknown} res
 * @param {Function} [log]
 * @returns {Promise<Uint8Array|null>}
 */
export async function imageBytesOf(res, log = () => {}) {
  const r = res && typeof res === 'object' ? res : {}
  const file = String(r.file ?? r.base64 ?? '')
  const url = String(r.url ?? '')

  if (file.startsWith('base64://')) {
    try {
      return Buffer.from(file.slice('base64://'.length), 'base64')
    } catch (err) {
      log('warn', `qdash-neo: base64 图片解码失败 msg=${err?.message}`)
      return null
    }
  }
  const remote = url || (file.startsWith('http') ? file : '')
  if (remote) {
    try {
      const res2 = await fetch(remote, { signal: AbortSignal.timeout(15_000) })
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`)
      return new Uint8Array(await res2.arrayBuffer())
    } catch (err) {
      log('warn', `qdash-neo: 下载图片失败 url=${remote.slice(0, 80)} msg=${err?.message}`)
      return null
    }
  }
  if (file) {
    try {
      const { readFile } = await import('node:fs/promises')
      return new Uint8Array(await readFile(file))
    } catch (err) {
      log('warn', `qdash-neo: 读取本地图片失败 file=${file.slice(0, 80)} msg=${err?.message}`)
      return null
    }
  }
  return null
}

/**
 * 按魔数判断 mediaType。不信任扩展名 —— QQ 图床的链接常常没有后缀。
 * @param {Uint8Array} bytes
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function sniffMediaType(bytes) {
  const b = bytes
  if (!b || b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    return 'image/webp'
  }
  return null
}

/** 工具返回值的渲染：JSON 值 → 给模型看的文本 */
function renderJson(value) {
  if (value === null || value === undefined) return [{ type: 'text', text: '(无结果)' }]
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const text = JSON.stringify(value, null, 2)
  // 太长就截断：工具结果会占上下文，一次列 500 个群成员没有意义
  return [{ type: 'text', text: text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text }]
}

/** 所有 QQ 工具共用的输出声明 */
/**
 * 所有 QQ 工具的公共输出声明。
 *
 * `schema` 必须**同时接受对象与数组**：OneBot 的返回值形态不统一 ——
 * `get_group_member_list` 返回成员**数组**，`get_group_msg_history` 返回对象，
 * 而 `set_group_kick` 可能返回 `null`。原来写死 `type: 'object'`，
 * 于是调用 `qq_member_list` 直接 `INVALID_TOOL_OUTPUT`（2026-10-26 实测）。
 *
 * 不逐工具写精确 schema 是有意的：这些工具的输出就是上游 API 的透传，
 * 声明得越精确，上游加字段就越容易崩。这里只保证"是合法 JSON 值"。
 */
/**
 * 统一的 output 声明。
 *
 * 导出是为了让插件工具复用同一份形状 —— 插件手写 JSON Schema 既啰嗦又容易
 * 漏 `additionalProperties`，混起来还会让模型看到两种风格的返回值描述。
 */
export const JSON_OUTPUT = {
  /**
   * **必须用 `oneOf`，不能用 `anyOf`**。
   *
   * DSH 的校验器只支持
   * `type / oneOf / properties / required / additionalProperties / items / enum / const`，
   * `anyOf` 会直接抛 `unsupported JSON schema`，**整个工具注册失败** ——
   * 表现是模型压根看不到这个工具（2026-10-26 实测：踢人工具"不愿意调"其实是没挂上）。
   * 六个分支互斥，`oneOf` 的语义刚好合适。
   */
  schema: {
    oneOf: [
      { type: 'object' },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ],
  },
  render: (_args, value) => renderJson(value),
}

/**
 * 造一批工具定义（还没注册）。
 *
 * @param {{
 *   chatKey: string,
 *   client: { call: (action: string, params?: object, timeoutMs?: number) => Promise<any> },
 *   attachments?: object|null,
 *   enqueue?: (chatKey: string, text: string, meta?: object) => void,
 *   enqueueSegments?: (chatKey: string, segments: object[], meta?: object) => void,
 *   config?: object,
 *   log?: Function,
 * }} deps
 * @returns {object[]} ToolDefinition 形状的对象
 */
export function createQqTools({
  chatKey,
  client,
  attachments = null,
  enqueue = null,
  enqueueSegments = null,
  memory = null,
  lastImageFile = null,
  /** 能授权群管理操作的 QQ 号（Set 或数组）；由 `tools.adminOwners` 或私聊白名单推导 */
  ownerIds = null,
  /** 这次触发回复的消息发送者 QQ 号；`qq_kick` 用它做身份校验 */
  senderId = null,
  /** 语音库（`VoiceLibrary` 实例）；为 null 时语音工具不注册 */
  voice = null,
  /**
   * `qq_send_message({ reply_to })` 的校验函数：这个 ID 是不是真在本轮的批里。
   *
   * 为 null 时不校验（老内核 / 测试环境）。内核传入的是
   * `id => turnBatches.get(chatKey)?.has(id) ?? false`。
   *
   * @type {((id: string) => boolean)|null}
   */
  canReply = null,
  /**
   * 分享卡片（`qq_send_card` 用），就是 `service.card`。
   *
   * **为 null 时不注册这个工具** —— 老内核没有这个能力，
   * 挂上去只会让模型点了报错。
   *
   * @type {{ share: Function }|null}
   */
  card = null,
  config = {},
  log = () => {},
}) {
  const target = parseChatKey(chatKey)
  const imageMode = String(config?.tools?.imageMode ?? 'auto')
  /** 写类工具"这一回合已经发过东西"的标记，供出站侧跳过自动转发 */
  const sent = { count: 0 }
  const defs = []

  const callOneBot = async (action, params = {}) => {
    if (!client || typeof client.call !== 'function') throw new Error('OneBot 未就绪')
    return client.call(action, params)
  }

  /** 群相关动作要补 group_id；私聊场景直接拒绝 */
  const groupParams = extra => {
    if (target.kind !== 'group') throw new Error('这个能力只在群会话里可用')
    return { group_id: target.groupId, ...extra }
  }

  /**
   * 图片类工具的核心：取字节 → 交给附件服务 → deferContext。
   * 任一步失败都返回**可读的说明**而不是抛错 —— 用户要求"看不了就直说"。
   */
  const attachImage = async (exec, file, label) => {
    if (imageMode === 'off') {
      return { ok: false, reason: `看图已关闭（tools.imageMode=off）；${label} 的原始位置：${file || '(未提供)'}` }
    }
    let res
    try {
      res = await callOneBot('get_image', { file })
    } catch (err) {
      return { ok: false, reason: `取图失败：${err?.message ?? '未知错误'}` }
    }
    const bytes = await imageBytesOf(res, log)
    if (!bytes || !bytes.length) {
      return { ok: false, reason: '取不到图片内容（链接失效或实现不支持）' }
    }
    const mediaType = sniffMediaType(bytes)
    if (!mediaType) return { ok: false, reason: '不认识的图片格式（只支持 png/jpeg/gif/webp）' }

    if (!attachments || typeof attachments.saveImage !== 'function') {
      // 宿主没挂附件服务：明确告诉模型"看不了"，它会自然回一句
      if (imageMode === 'on') throw new Error('当前宿主没有附件服务，无法把图片交给模型')
      return { ok: false, reason: '当前会话没有可用的图片通道，我只能知道你发了一张图，但看不了内容。' }
    }

    try {
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: label })
      /**
       * `deferContext` 收的是完整的 **UserMessage**（`MessageBase`）：
       *
       * ```ts
       * interface MessageBase {
       *   readonly id: MessageId        // 必需
       *   readonly content: ContentBlock[]
       *   readonly source: MessageSource // 必需，内部读 `source.kind`
       * }
       * ```
       *
       * 之前只传了 `{ role, content }`，缺 `id` 与 `source` —— DSH 在把这条消息
       * 挂进 inbox 时读 `source.kind` 直接抛
       * `Cannot read properties of undefined (reading 'kind')`，
       * 于是整回合 `turn/end: error`，图**注入后立刻被撤回**，模型什么都看不到。
       * （2026-10-26 实测：落盘图片完好，但会话记录里 image block 出现后马上
       * `removedCount:1` 撤回。）
       *
       * `source.kind` 取 `'user'`：这条上下文是"人发来的"（不是模型或工具产出）。
       * 官方 PTC 用的是 `'ptc-mode'`，那是它自己的 producer 标识。
       */
      exec.deferContext({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'user' },
      })
      return { ok: true, width: ref.width, height: ref.height, bytes: ref.bytes, mediaType }
    } catch (err) {
      if (imageMode === 'on') throw err
      log('warn', `qdash-neo: 图片入库失败 msg=${err?.message}`)
      return { ok: false, reason: '这张图没法交给模型（入库失败），我只能知道它存在，看不了内容。' }
    }
  }

  /** 统一构造一个工具定义。`execute(args, exec)` —— 读图要靠 exec.deferContext */
  const tool = (name, description, params, execute) => {
    const properties = {}
    for (const [key, desc] of Object.entries(params ?? {})) {
      properties[key] = { type: 'string', description: String(desc) }
    }
    defs.push({
      name,
      description,
      parameters: { type: 'object', properties, additionalProperties: false },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const started = Date.now()
        try {
          return await execute(args ?? {}, exec)
        } finally {
          // 工具调用留痕：用户要求"不需要确认但全部留痕"
          log('info', `qdash-neo: 工具 ${name} ${chatKey} ${Date.now() - started}ms`)
        }
      },
    })
  }

  /* ---------------- 读 ---------------- */

  tool(
    'qq_get_image',
    '把一张 QQ 图片取回来看看。模型支持看图时会直接把图放进上下文；不支持时会返回说明。\n' +
      'file 传消息里 [图片:xxx] 的那个 xxx（或完整 URL）。**不知道是哪张就传 latest** —— ' +
      '会取这个会话最近一张图。不要自己编 id，OneBot 会回 image not found in cache。',
    { file: '消息里 [图片:xxx] 的 xxx；不知道就传 latest' },
    async (args, exec) => {
      let file = String(args.file ?? '').trim()
      /**
       * `latest` 兜底。
       *
       * 模型经常拿不到具体 id（历史消息只渲染成 `[图片]`，或者它想"看刚才那张"），
       * 于是自己编一个 —— OneBot 直接回 `image not found in cache`。
       * 这里用入站时记下的 file 兜底，比让它猜可靠得多。
       */
      if (!file || file === 'latest' || file === 'last') {
        file = String(lastImageFile?.() ?? '').trim()
        if (!file) throw new Error('这个会话还没有收到过图片；请传消息里 [图片:xxx] 的 xxx')
      }
      return attachImage(exec, file, '图片')
    },
  )

  tool(
    'qq_get_custom_face',
    '看看群里的表情包。参数 file 传表情 ID；不传则列出该群可用的表情（返回的是 ID 列表，不含画面）。',
    { file: '表情 ID / 文件名；留空列出收藏' },
    async args => {
      const file = String(args.file ?? '').trim()
      if (!file) {
        const list = await callOneBot('fetch_custom_face', groupParams({ count: 20 }))
        return { ok: true, faces: list }
      }
      return callOneBot('fetch_custom_face', groupParams({ count: 1, file }))
    },
  )

  tool(
    'qq_get_msg',
    '按消息 ID 读一条消息的完整结构（消息段、发送者、时间）。',
    { message_id: '消息 ID' },
    async args => {
      const id = String(args.message_id ?? '').trim()
      if (!id) throw new Error('message_id 不能为空')
      return callOneBot('get_msg', { message_id: Number(id) || id })
    },
  )

  tool(
    'qq_get_history',
    '往前翻当前群的旧消息（当前对话窗口之外的）。只读，不会把消息塞进上下文。',
    { count: '条数，默认 20，最多 50' },
    async args => {
      const n = Math.min(50, Math.max(1, Number(args.count) || 20))
      return callOneBot('get_group_msg_history', groupParams({ count: n }))
    },
  )

  tool(
    'qq_get_forward',
    '把一条「合并转发」展开成里面的各条内容。',
    { id: '转发消息 id' },
    async args => {
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('id 不能为空')
      return callOneBot('get_forward_msg', { id })
    },
  )

  tool('qq_group_info', '看当前群的名称、人数、公告等。', {}, async () => callOneBot('get_group_info', groupParams({})))

  tool(
    'qq_member_info',
    '看某位群成员的昵称、名片、群等级、入群时间。不传 user_id 就用当前发言人。',
    { user_id: 'QQ 号' },
    async args => {
      const uid = String(args.user_id ?? '').trim()
      if (!uid) throw new Error('user_id 不能为空')
      return callOneBot('get_group_member_info', groupParams({ user_id: Number(uid) || uid }))
    },
  )

  tool('qq_member_list', '列出群成员（人多时别当通讯录用）。', {}, async () =>
    callOneBot('get_group_member_list', groupParams({})),
  )

  tool('qq_group_files', '列出群文件根目录。', {}, async () => callOneBot('get_group_root_files', groupParams({})))

  tool(
    'qq_group_file_url',
    '拿某个群文件的下载链接（不自动下载）。',
    { file_id: '文件 ID', busid: 'busid（列目录时会给）' },
    async args => {
      const fileId = String(args.file_id ?? '').trim()
      if (!fileId) throw new Error('file_id 不能为空')
      return callOneBot('get_group_file_url', groupParams({ file_id: fileId, busid: Number(args.busid) || 0 }))
    },
  )

  /* ---------------- 写（全部走出站队列） ---------------- */

  /**
   * 发一段文本：清洗 → 按 `outbound.split` 拆条 → 入队。
   *
   * 拆条放在这一侧而不是"模型输出那侧"，因为**工具是唯一出口**：
   * 模型可以一次交一段带换行的长文字，由插件决定实际发几条。
   * 返回值里带上真实条数，免得它以为只发了一条又去补发。
   */
  const sendText = async (text, replyTo) => {
    if (!enqueue) throw new Error('出站队列未就绪')
    const oc = config?.outbound ?? {}
    const plan = planReply(text, {
      split: oc.split,
      plainText: oc.plainText !== false,
      maxChars: oc.maxChars,
      maxSegments: oc.maxSegments,
      onWarn: msg => log('warn', `qdash-neo: ${msg}`),
    })
    /**
     * 清洗后为空：不抛错。
     *
     * 模型发了个空串、或者只有空白，属于"它没什么要说的"。
     * 报错会让它以为工具坏了，反而再去重试一次。
     */
    if (plan.parts.length === 0) {
      log('warn', 'qdash-neo: 发送内容清洗后为空，已忽略')
      return { ok: true, queued: 0 }
    }
    // 截断必须留痕：静默丢字是最难发现的一类问题（用户只会觉得"它怎么说到一半没了"）
    if (plan.truncated) {
      log('warn', `qdash-neo: 回复超长，已省略 ${plan.droppedChars} 字，分片=${plan.parts.length}`)
    }
    /**
     * 同一批分片共享 `replyId` 前缀（`out:<ts>:<n>` / `out:<ts>:<n>:2`）。
     *
     * 控制台靠这个前缀把"一次回复拆出来的几条"归成一組；
     * 每条一个独立 id 的话，界面上就是三句互不相干的话。
     */
    const replyId = `out:${Date.now()}:${sent.count + 1}`
    /**
     * 校验 `reply_to` 是不是真在本轮的批里。
     *
     * **降级而不是拒绝**：抄错一位是模型常犯的小错，为它丢掉整条消息不值。
     * 不认识就当作没传，发一条普通消息 —— 用户至少能看到内容。
     *
     * 不校验的后果：OneBot 返回"找不到消息"，进死信重试三次再丢，
     * 用户只看到"它没说话"，而根因是一条引用到不存在消息上的发送。
     */
    const asked = String(replyTo ?? '').trim()
    const allowed = !asked || typeof canReply !== 'function' || canReply(asked)
    const rid = allowed ? asked : ''
    if (asked && !allowed) {
      log('warn', `qdash-neo: reply_to=${asked} 不在本轮批里，已降级为普通消息`)
    }

    plan.parts.forEach((part, i) => {
      const qqMsgId = plan.parts.length === 1 ? replyId : `${replyId}:${i + 1}`
      enqueue(chatKey, part, {
        fromTool: 'qq_send_message',
        qqMsgId,
        replyId,
        total: plan.parts.length,
        fullText: plan.text,
        /**
         * 引用**只加在第一条**。
         *
         * 一段话被拆成三条时，每条都顶上同一个引用块，观感非常吵；
         * 而第一条已经表明了"在回哪一句"，后面几条自然是接着说的。
         */
        ...(i === 0 && rid ? { replyTo: rid } : {}),
      })
    })
    sent.count += plan.parts.length
    return {
      ok: true,
      queued: plan.parts.length,
      ...(plan.truncated ? { truncated: true, droppedChars: plan.droppedChars } : {}),
    }
  }

  tool(
    'qq_send_message',
    '往当前会话发消息。**这是你唯一的发言出口**：你写出来的正文不会自动发到 QQ，' +
      '必须调用本工具才发得出去。想分几条说就调多次，也可以一次交一段带换行的文字、' +
      '由 outbound.split 决定怎么拆（返回值里的 queued 是实际发出条数）。' +
      '不想说话时就不要调它，直接结束这一轮 —— 那是完全正常的。',
    {
      text: '要发送的文本',
      reply_to: '可选：要引用回复的消息 ID。群里就是消息前面的 [#数字]；私聊会忽略',
    },
    async args => {
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      return sendText(text, args.reply_to)
    },
  )

  /**
   * 发消息段。
   * @param {object[]} segments
   * @param {{ text?: string }} [meta] `text` 是给人看的标签（`[语音] 晚安`），会落库
   */
  const sendSegments = async (segments, meta = {}) => {
    if (!enqueueSegments) throw new Error('出站队列不支持消息段')
    enqueueSegments(chatKey, segments, { fromTool: 'qq_send_segment', ...meta })
    sent.count += 1
    return { ok: true, queued: true }
  }

  /**
   * 分享卡片。
   *
   * 比光贴链接显眼，点开直接跳小程序/网页。**但卡片里只有标题和封面**，
   * 正文文案读不到 —— 想说的话得另外发一条。这条要写进 description，
   * 否则模型会把"评价"塞进 card 里，结果群里只看到一张没有态度的卡片。
   *
   * 实现不支持卡片时，`card.share` 自己降级成纯文本（标题 + 链接），
   * **所以调用它不会失败**。
   */
  if (card) {
    tool(
      'qq_send_card',
      '发一张分享卡片（B 站视频这类）。点开能直接跳，比光贴链接显眼。' +
        '**卡片里只有标题和封面，正文读不到** —— 想说什么另外用 qq_send_message 发一条。' +
        /**
         * **不要和"裸链接"混着用**。
         *
         * 早先这里写的是「只有真值得分享时才用，别把它当链接生成器」——
         * 抑制过头了：一次要分享两条时，它给第一条发卡片、第二条降级成
         * 一条裸链接，群里变成"一条能点、一条不能点"，观感很怪。
         *
         * 它想省的那点"别滥用"，换来的是不一致；而不一致比多用一张卡片糟得多。
         */
        '**分享同一个东西时不要混着来**：要么发卡片，要么发文字，' +
        '别一张卡片再配一条裸链接 —— 群里会变成一条能点、一条不能点。' +
        '要分享几个就发几张卡片。',
      {
        kind:
          '卡片类型：news（默认，通用图文卡片，点开跳链接）' +
          '或 bili（B 站小程序卡片 —— 需要 QQ 内测权限，普通账号点开提示「应用内测中」，别用）',
        title: '标题',
        desc: '可选：一句话描述，显示在标题下面',
        cover: '可选：封面图地址',
        url: '要跳转的链接，必填',
      },
      async args => {
        const url = String(args?.url ?? '').trim()
        if (!url) throw new Error('url 不能为空（卡片点开总得有地方去）')
        return card.share({
          chatKey,
          kind: String(args?.kind ?? 'news').trim() || 'news',
          title: String(args?.title ?? '').trim(),
          desc: String(args?.desc ?? '').trim(),
          cover: String(args?.cover ?? '').trim(),
          url,
        })
      },
    )
  }

  /**
   * 语音。
   *
   * 走 `record` 段，和图片共用同一条出站链路（限流、死信、落库都生效）。
   * 路径解析与发送额度都在 `VoiceLibrary` 里 —— 那里是唯一入口，
   * 否则很容易出现"某个调用点忘了查穿越"。
   */
  if (voice) {
    tool(
      'qq_send_voice',
      '往当前会话发一条语音库里的音频。name 传文件名（不带路径），有哪些文件用 qq_voice_list 查。' +
        '**语音是"语气比字面更重要"时才用的东西**：一两句就说完、情绪明显、或者懒得打字。' +
        '说正事、内容偏长、群里人多的时候，用 qq_send_message 打字更合适。',
      { name: '语音库里的文件名，如 hi.mp3' },
      async args => {
        /**
         * 发送、体检、限流、落库全在 `voice.send` 里 ——
         * 工具这层只做参数传递，不多写一条路径，避免防线分叉。
         */
        const r = await voice.send({ chatKey, file: args.name, label: args.name })
        return { ok: true, queued: true, spoke: r.label }
      },
    )

    tool('qq_voice_list', '列出语音库里可用的音频文件。', {}, async () => ({
      ok: true,
      files: voice.list().map(f => f.name),
    }))
  }

  tool(
    'qq_send_image',
    '往当前会话发一张图片。file 传本地绝对路径或 http(s) 链接。',
    { file: '本地路径或 URL' },
    async args => {
      const file = String(args.file ?? '').trim()
      if (!file) throw new Error('file 不能为空')
      return sendSegments([{ type: 'image', data: { file } }])
    },
  )

  tool(
    'qq_send_custom_face',
    '往当前会话发一个表情包（按表情 ID）。',
    { id: '表情 ID' },
    async args => {
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('id 不能为空')
      return sendSegments([{ type: 'face', data: { id } }])
    },
  )

  tool(
    'qq_recall',
    '撤回一条消息（只能撤自己发的，或管理员权限内的）。',
    { message_id: '消息 ID' },
    async args => {
      const id = String(args.message_id ?? '').trim()
      if (!id) throw new Error('message_id 不能为空')
      return callOneBot('delete_msg', { message_id: Number(id) || id })
    },
  )

  tool(
    'qq_poke',
    '戳一戳某人（群里别拿来刷）。',
    { user_id: 'QQ 号' },
    async args => {
      const uid = String(args.user_id ?? '').trim()
      if (!uid) throw new Error('user_id 不能为空')
      return callOneBot('send_poke', groupParams({ user_id: Number(uid) || uid }))
    },
  )

  tool(
    'qq_react',
    '给一条消息贴表情回应（比发言更轻的互动）。',
    { message_id: '消息 ID', emoji_id: '表情 ID，默认 128077' },
    async args => {
      const id = String(args.message_id ?? '').trim()
      if (!id) throw new Error('message_id 不能为空')
      return callOneBot('set_msg_emoji_like', {
        message_id: Number(id) || id,
        emoji_id: String(args.emoji_id ?? '128077'),
      })
    },
  )

  /* ---------------- 记忆 ---------------- */

  /**
   * 让模型自己写记忆。
   *
   * 三类各有各的用途，别混：
   *   - `topic`：进行中的话题（会被 `touch()` 刷新活性，久不提就淘汰）
   *   - `impression`：对某个群友的稳定印象（用 `target` 区分是谁）
   *   - `thought`：想说但没说的（带 TTL，天然有界）
   *
   * 为什么不自动抽：自动抽要么多一次模型调用（贵），要么靠关键词（糙）。
   * 记不记、记什么交给模型判断，成本为零，只是它得"自觉" —— prompt 里给了引导。
   */
  tool(
    'memory_add',
    '把值得长期记住的事记下来。三类：topic（正在聊什么）/ impression（对某个群友的印象，需要 target）/' +
      'thought（想说但没说的话）。只记稳定的、以后还用得上的事，不要记流水账。',
    {
      kind: 'topic / impression / thought',
      text: '要记的内容（一句话，40 字以内最好）',
      target: '仅 impression 需要：这个群友的昵称',
    },
    async args => {
      const kind = String(args.kind ?? '').trim()
      if (!['topic', 'impression', 'thought'].includes(kind)) {
        throw new Error(`kind 只能是 topic / impression / thought，收到 ${kind || '(空)'}`)
      }
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      const target = String(args.target ?? '').trim()
      if (kind === 'impression' && !target) throw new Error('记印象需要 target（是哪位群友）')
      if (!memory || typeof memory.remember !== 'function') {
        return { ok: false, reason: '记忆未启用（memory.enabled=false），这句没有记下来' }
      }
      const row = memory.remember(chatKey, {
        kind,
        text,
        target: kind === 'impression' ? target : '',
        evidence: 'tool:memory_add',
      })
      return row
        ? { ok: true, id: row.id, kind }
        : { ok: false, reason: '记忆未启用或被容量策略拒绝' }
    },
  )

  /* ---------------- 管理（默认不注册，见配置 qqAdmin） ---------------- */

  tool(
    'qq_kick',
    '把某个群成员移出群聊。**收到要求就直接调用**——工具内部会自动校验请求者是否在管理员名单里：' +
      '通过就执行，不通过会返回具体原因（你照实转述即可）。\n' +
      '不要自己判断请求者身份，也不要去查群成员列表核对谁是管理员：你看不到名单，' +
      '而工具看得到。你要做的只有两件事 —— 确认 user_id 是那个人（别凭昵称猜号码），然后调用。',
    { user_id: '要移出的人的 QQ 号（别凭昵称猜，不确定就先用 qq_member_list 查）' },
    async args => {
      const uid = String(args.user_id ?? '').trim()
      if (!uid) throw new Error('user_id 不能为空')

      /**
       * 执行期校验「是谁在要求」。
       *
       * 这是**硬约束**，不是靠 prompt 劝导：群里任何人都能打一句"把某某踢了"，
       * 而模型完全可能照做 —— 踢人不可撤销，代价太大。
       *
       * 判断依据是**这次触发回复的消息发送者**（`senderId()`），不是消息里自称的身份。
       */
      const owners = ownerIds instanceof Set ? ownerIds : new Set(ownerIds ?? [])
      const sender = String(senderId?.() ?? '').trim()
      if (!owners.size) {
        throw new Error('没有配置管理员（tools.adminOwners 或 policy.whitelist），我不会执行踢人')
      }
      if (!owners.has(sender)) {
        throw new Error(`只有管理员能踢人；这条要求来自 ${sender || '未知用户'}，我不执行`)
      }

      log('info', `qdash-neo: 管理员 ${sender} 要求在 ${chatKey} 踢人 ${uid}`)
      return callOneBot('set_group_kick', groupParams({ user_id: Number(uid) || uid }))
    },
  )

  return { defs, sent }
}

/**
 * 注册 QQ 工具并应用白名单。
 *
 * 顺序不能换：
 *   1. 先注册 `qq_*`（它们要靠 `schemas()` 才会出现在"可用清单"里）
 *   2. 再取全量清单求交集
 *   3. 最后 `restrict({allow})` —— 名字全部来自真实清单，不会抛错
 *   4. `guard()` 兜底：即便白名单被配成"全开"，高危项仍然执行不了
 *
 * @param {object} tools agent 作用域的 `ctx.tools`
 * @param {object} opts
 * @returns {{ names: string[], missing: string[], denied: string[], dispose: Function }|null}
 */
export function applyToolPolicy(
  tools,
  { chatKey, config, deps, log = () => {}, withGuard = true, pluginTools = null },
) {
  if (!tools || typeof tools.register !== 'function') return null
  if (config?.tools?.enabled === false) {
    /**
     * 关掉工具：空 allow 让所有 global 工具不可见。
     * 但 `restrict` 管不到 scoped 注册，而且它自己也可能失败 ——
     * 所以再挂一道"全拒"守卫，别出现"关掉了却还能调"。
     */
    let restore = null
    let unguard = null
    try {
      restore = tools.restrict({ allow: [] })
    } catch (err) {
      log('warn', `qdash-neo: 关闭工具时 restrict 失败 msg=${err?.message}`)
    }
    try {
      if (withGuard && typeof tools.guard === 'function') {
        unguard = tools.guard(() => '工具已关闭（tools.enabled=false）')
      }
    } catch (err) {
      log('warn', `qdash-neo: 关闭工具时挂守卫失败 msg=${err?.message}`)
    }
    return {
      names: [],
      missing: [],
      denied: [],
      available: [],
      dispose: () => {
        try {
          restore?.()
        } catch {
          /* ignore */
        }
        try {
          unguard?.()
        } catch {
          /* ignore */
        }
      },
    }
  }

  const created = createQqTools({ chatKey, config, log, ...deps })
  const qqGroups = {
    read: config?.tools?.qqRead !== false,
    write: config?.tools?.qqWrite !== false,
    admin: config?.tools?.qqAdmin === true,
  }
  // 记忆工具只在记忆开着时注册（关了还挂一个"记不下来"的工具只会浪费 schema 预算）
  const includeMemory = config?.memory?.enabled === true
  /**
   * 语音工具只在语音开着时注册。
   *
   * 挂了但必然报错是最浪费的一种情况：模型会调一次、读错误、再换个说法调一次，
   * 一整轮就这么没了 —— 而它本来可以直接打字。
   */
  const includeVoice = config?.voice?.enabled === true

  const wantedQq = new Set()
  for (const d of created.defs) {
    // 管理组默认不注册（不是"注册了但禁用"），避免它出现在模型可见清单里
    if (!qqGroups.admin && d.name === 'qq_kick') continue
    if (!qqGroups.read && d.name.startsWith('qq_get_')) continue
    if (!qqGroups.write && (d.name.startsWith('qq_send_') || d.name === 'qq_recall' || d.name === 'qq_poke' || d.name === 'qq_react')) {
      continue
    }
    if (!includeMemory && d.name === 'memory_add') continue
    if (!includeVoice && (d.name === 'qq_send_voice' || d.name === 'qq_voice_list')) continue
    wantedQq.add(d.name)
  }

  const disposers = []
  for (const d of created.defs) {
    if (!wantedQq.has(d.name)) continue
    try {
      disposers.push(tools.register(d))
    } catch (err) {
      // 重名（宿主已有同名工具）不该让会话建不起来
      log('warn', `qdash-neo: 注册工具 ${d.name} 失败 msg=${err?.message}`)
      wantedQq.delete(d.name)
    }
  }

  /**
   * 插件工具。
   *
   * 位置很关键，三处都不能挪：
   *   - 在 `wantedQq` 之后 → 才能判重名
   *   - 在 `schemas()` 之前 → 才进得了 `available`（否则算 allow 时它还"不存在"）
   *   - 在 `guard` 之前 → 名字才来得及并进 `allow`
   *
   * **重名判定用 `created.defs` 而不是 `wantedQq`**：被 `qqWrite=false` 过滤掉的内核工具
   * 不在 `wantedQq` 里，但插件顶替它同样危险（关掉的能力被插件悄悄打开）。
   */
  const kernelNames = new Set(created.defs.map(d => d.name))
  const pluginNames = []
  /** @type {Map<string, Function[]>} owner → 该插件在本会话里的 disposer */
  const pluginDisposers = new Map()
  /**
   * 授予哪些插件的工具。
   *
   * **默认空 = 一个都不授予。** 插件能注册工具，但不能自己给自己授权 ——
   * 否则装上一个插件就等于把它的全部能力交给模型，管理员没有决策点。
   *
   * 工具会出现在控制台「工具」页（看得见），但不进会话的 allow，模型拿不到。
   */
  const grantedPlugins = new Set((config?.tools?.grantedPlugins ?? []).map(String))
  if (pluginTools && config?.tools?.allowPluginTools !== false) {
    for (const d of pluginTools.defs()) {
      if (!grantedPlugins.has(String(d.owner ?? ''))) {
        // 不是错误：注册了但没授予，工具在控制台可见、模型拿不到
        log('info', `qdash-neo: 插件「${d.owner}」的工具未授予，跳过 ${d.name}`)
        continue
      }
      if (kernelNames.has(d.name)) {
        log('warn', `qdash-neo: 插件工具 ${d.name} 与内核同名，已跳过（内核优先）`)
        continue
      }
      try {
        /**
         * 包一层把 `chatKey` 传进去。
         *
         * 内核工具靠闭包拿到 `chatKey`，插件工具没有那个闭包 ——
         * 而"发给哪个会话"是它唯一必须知道的上下文。`exec` 是 DSH 的调用上下文，
         * 里面没有 `chatKey`，所以在这里注入，插件侧就是 `execute(args, { chatKey })`。
         */
        const disposeTool = tools.register({
          ...d,
          execute: (args, exec) => d.execute(args, { ...(exec ?? {}), chatKey }),
        })
        disposers.push(disposeTool)

        // 按 owner 分别记账：`tools.grantedPlugins` 变更时要能精确摘掉某个插件的工具
        const owner = String(d.owner ?? '')
        if (!pluginDisposers.has(owner)) pluginDisposers.set(owner, [])
        pluginDisposers.get(owner).push(disposeTool)

        pluginNames.push(d.name)
      } catch (err) {
        // 重名（宿主或别的插件已注册）不该让会话建不起来
        log('warn', `qdash-neo: 注册插件工具 ${d.name} 失败 msg=${err?.message}`)
      }
    }
  }

  let available = []
  try {
    available = (tools.schemas?.() ?? []).map(s => s?.name).filter(Boolean)
  } catch (err) {
    log('warn', `qdash-neo: 读工具清单失败 msg=${err?.message}`)
  }

  const resolved = resolveAllowed({
    available,
    qqGroups,
    internalAllow: config?.tools?.internalAllow ?? [],
    externalAllow: config?.tools?.externalAllow ?? [],
    includeMemory,
  })

  // 只保留真正注册成功的 QQ 工具 + 清单里存在的外部项
  const allow = resolved.allow.filter(name => wantedQq.has(name) || available.includes(name))

  /**
   * 插件工具并入白名单。
   *
   * `guard` 是**正面白名单**：不在 `allow` 里的一律拒绝。而 `allow` 来自
   * `resolveAllowed`，它只认 `catalog.js` 与内置安全模式 —— 插件工具永远不会在里面。
   * 不并进来就会「注册成功、调用被拒」，而且日志只在调用那一刻出现，
   * 排查的人通常不会想到是建会话时的白名单算漏了。
   *
   * 仍然过一遍 `isDenied()`：插件注册期已经拦过一次，这里是第二道
   * （`allowPluginTools` 关掉再打开、或有人直接改注册表时兜底）。
   */
  for (const name of pluginNames) {
    if (isDenied(name)) {
      log('warn', `qdash-neo: 插件工具 ${name} 命中高危名单，未并入白名单`)
      continue
    }
    if (!allow.includes(name)) allow.push(name)
  }

  let restore = null
  try {
    restore = tools.restrict({ allow })
  } catch (err) {
    // 真到了这里说明上面的求交集有问题：退回 guard（只拒绝，不给白名单）
    log('error', `qdash-neo: restrict 失败，退回 guard name=${err?.name} msg=${err?.message}`)
  }

  let unguard = null
  try {
    if (withGuard && typeof tools.guard === 'function') {
      /**
       * **正面白名单**，不再只是"拦高危"。
       *
       * 为什么必须这样：`restrict` 只过滤"继承来的工具"（global 层与祖先层），
       * 源码注释原文是 *"a restriction filters what a scope inherits … and never
       * what its OWN layer registers"* —— 也就是说，如果某个插件在
       * `agent.ctx.tools.register()` 注册工具（scoped 注册），`restrict` 管不到它。
       *
       * 而 `guard` 走的是 dispatch 期（`guardReason` 汇总 global + 整条 scope 链），
       * 不受那个豁免影响，且**单调**：任何 guard 返回 reason 就拒绝，没有 guard 能强制放行。
       * 所以用它兜住"restrict 漏出来"的部分：不在 allow 里的一律拒绝。
       *
       * 代价：`allow` 是建会话那一刻的快照，之后才注册的工具（MCP 晚连）会被拒。
       * 这正是白名单语义 —— 宁可"勾了暂时用不了"，也不要"没勾也能用"。
       */
      const allowed = new Set(allow)
      unguard = tools.guard(exec => {
        const name = String(exec?.name ?? exec?.toolName ?? '')
        // 拿不到名字不误伤：传输层/嵌套调用可能没有常规 name
        if (!name) return undefined
        if (isDenied(name)) return `高危工具已全局禁用：${name}`
        if (!allowed.has(name)) return `工具不在白名单：${name}（在控制台「工具」里勾选后可用）`
        return undefined
      })
    }
  } catch (err) {
    log('warn', `qdash-neo: 注册工具守卫失败 msg=${err?.message}`)
  }

  if (resolved.missing.length) {
    log('warn', `qdash-neo: 工具白名单里有 ${resolved.missing.length} 项当前未注册：${resolved.missing.join(', ')}`)
  }
  log(
    'info',
    `qdash-neo: 工具已挂载 ${chatKey} 共 ${allow.length} 个` +
      (resolved.denied.length ? `（已剔除高危 ${resolved.denied.length} 个）` : ''),
  )

  return {
    names: allow,
    missing: resolved.missing,
    denied: resolved.denied,
    /**
     * 这个 agent 作用域此刻能看到的全部工具名（`schemas()` 的结果）。
     *
     * 控制台读根作用域只能看到 `working_directory` 这类全局工具 ——
     * DSH 的内置工具是按 preset 注册在 **agent 作用域**的，所以"真实清单"
     * 只能从建过会话的 agent 里取。这里回传给 `service.toolStates` 供控制台汇总。
     */
    available,

    /**
     * 把插件工具**补挂到已存在的会话**上。
     *
     * 为什么需要：插件工具原本只在建会话时挂载，于是"改配置前就建好的会话"
     * 永远拿不到新工具。用户看到的是"开了 TTS，当前对话里模型还是不能用"，
     * 而唯一的解是删掉会话重建 —— 反直觉，且没人会想到。
     *
     * 两件事都要做：`register` 与**并进 `allow`**。`guard` 是正面白名单，
     * 只注册不并的话会「注册成功、调用被拒」，而日志只在调用那一刻出现。
     *
     * @param {object} d 归一化后的工具定义（`PluginToolRegistry.defs()` 的一项）
     * @returns {boolean} 是否真的挂上了
     */
    attachPluginTool(d) {
      const name = String(d?.name ?? '').trim()
      if (!name) return false
      // 已经挂过就直接返回：补挂是幂等的，重复 register 只会抛"已存在"并刷日志
      if (allow.includes(name) || created.defs.some(k => k.name === name)) return false
      if (isDenied(name)) return false
      try {
        tools.register(d)
      } catch (err) {
        log('warn', `qdash-neo: 补挂插件工具 ${name} 失败 msg=${err?.message}`)
        return false
      }
      allow.push(name)
      return true
    },

    /**
     * 摘掉某个插件的全部工具。
     *
     * `tools.grantedPlugins` 变更时用 —— 没有它的话"禁用"只对**新建会话**生效，
     * 已有会话里那个工具还能被调用，而界面上已经显示"已禁用"。
     *
     * @param {string} owner 插件名（注册工具时传的 owner）
     * @returns {number} 摘掉了几个
     */
    detachPluginOwner(owner) {
      const key = String(owner ?? '')
      const list = pluginDisposers.get(key)
      if (!list?.length) return 0
      for (const fn of list) {
        try {
          fn()
        } catch {
          /* 单个失败不该影响其它 */
        }
      }
      pluginDisposers.delete(key)
      return list.length
    },

    /**
     * 本会话当前挂了哪些插件的工具。
     *
     * `tools.grantedPlugins` 是白名单，收回权限时要找出"哪些该摘" ——
     * 只能从会话这边问，因为配置里已经没有它的名字了。
     *
     * @returns {string[]}
     */
    pluginOwners() {
      return [...pluginDisposers.keys()]
    },

    /** 本回合已经通过工具发过几条 */
    get sentCount() {
      return created.sent.count
    },
    /**
     * 本回合已经通过工具发过几条。**只读，不清零。**
     *
     * 早先是 `consumeSent()`，读完就清零。那在"一轮只有一段正文"时没问题，
     * 但 agent loop 里模型经常产生**多段**文本：调工具前想一句、调完再想一句。
     *
     *   [正文] 我该怎么说…      ← 读到 0，落库
     *   [工具] qq_send_message   ← 真正发出去
     *   [正文] 好了，说完了      ← 计数已被上一段消费掉，又读到 0，落库
     *
     * 结果是控制台里堆一串 `unforwarded`，看着像"漏发"，而它其实只是模型的思考。
     * 清零改到回合结束（`resetSent`），一轮之内所有正文都能看到真实计数。
     */
    sentCount() {
      return created.sent.count
    },

    /** 回合结束时清零，避免下一轮被误判 */
    resetSent() {
      created.sent.count = 0
    },
    dispose: () => {
      for (const fn of disposers.reverse()) {
        try {
          fn?.()
        } catch {
          /* 释放失败不影响会话关闭 */
        }
      }
      try {
        restore?.()
      } catch {
        /* ignore */
      }
      try {
        unguard?.()
      } catch {
        /* ignore */
      }
    },
  }
}
