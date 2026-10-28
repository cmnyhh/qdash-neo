/**
 * schemastery → 表单描述（纯函数，M3 第二阶段）。
 *
 * 为什么让服务端生成描述，而不是前端认识每个字段：
 * 加一个配置字段就不该改前端。前端的职责只有"按 type 画控件"，
 * 一旦把 policy/judge 的字段名写进 app.js，两边就会开始漂移。
 *
 * 内省依据（2026-10-26 实测 `@deepseek-ai/schemastery` 0.2.x）：
 *   - Schema 本身是**函数**：`schema({})` 直接解析出全默认值对象
 *   - object 节点有 `dict`（子节点表）；数组有 `inner`；union 有 `list`
 *   - 每个节点都有 `meta`（`default` / `description` / `role`）
 *   - union 的 `list` 是 uid 引用（`{uid,refs}`），**直接读会被内部结构绑死**，
 *     所以取值走 `node.toString()` → `'"m" | "n"'`，再按引号解析。
 *     解析不出就退化成自由文本 + warn，不做静默丢弃。
 */

/**
 * 生效档位（2026-10-26 分三档）。
 *
 * 之前只有 `live | restart`，而 restart 在 UI 上是**直接禁用**——
 * 结果是 wsUrl / token / 存储路径全显示灰色，"为什么不能改"变成最常见的疑问。
 * 现在改成：能改的一律允许改，只在旁边标清"什么时候生效"。
 *
 *   live      保存即生效（gates/judge/memory/persona/outbound 都走热更新）
 *   reconnect 保存后自动重连（OneBot 三件套：地址、口令、自身 QQ）
 *   restart   下次启动生效（监听端口、库路径、挂载方式 —— 这些在构造期读进闭包）
 */
export const RECONNECT_PATHS = new Set(['onebot.wsUrl', 'onebot.token', 'onebot.selfId'])

export const RESTART_PATHS = new Set([
  'store.path',
  'console.enabled',
  'console.mode',
  'console.port',
  'console.host',
  'console.mount',
])

/** @param {string} path */
export function appliesOf(path) {
  if (RECONNECT_PATHS.has(path)) return 'reconnect'
  if (RESTART_PATHS.has(path)) return 'restart'
  return 'live'
}

/**
 * provider / model 这类字段的可选值是**运行时从宿主 LLM 服务问出来的**，
 * 静态 schema 里没有，所以只在字段上打个来源标记，由前端去 `/api/llm` 拉。
 *
 * 为什么不塞进 describe：`listModels()` 是异步的、且可能为空，
 * 放进每 5 秒轮询的 `/api/config` 会让配置页一直等模型清单。
 */
export const LLM_PROVIDER_PATHS = new Set(['agent.provider', 'judge.provider', 'memory.daily.provider'])
export const LLM_MODEL_PATHS = new Set(['agent.model', 'judge.model', 'memory.daily.model'])

/** @param {string} path @returns {'llm.providers'|'llm.models'|null} */
export function optionsFromOf(path) {
  if (LLM_PROVIDER_PATHS.has(path)) return 'llm.providers'
  if (LLM_MODEL_PATHS.has(path)) return 'llm.models'
  return null
}

/**
 * 取值由 adapter 决定、内核无法枚举的字段 → 给一组**建议值**（可以手填别的）。
 *
 * `reasoningEffort` 是 branded string，DSH 的 `LlmModelInfo` 里不返回可选列表，
 * 所以只能给常见值做提示；填错会在调用时由 adapter 报错，不会静默失效。
 */
/**
 * 字段中文名。
 *
 * 界面上原来直接把配置 key 当标题（`groupTrigger`、`maxSegments`…），
 * 中文说明缩在下面一行小字里 —— 扫一眼找不到"触发策略在哪"是必然的。
 * 只给**值得一眼认出**的字段配名字，其余仍显示 key（避免 70 个字段全翻译一遍还翻不准）。
 */
export const FIELD_LABELS = {
  'policy.whitelist': '私聊白名单',
  /**
   * `voice.*` 和 `proactive.*` 原来没有中文名，配置页显示成
   * `voice.enabled`、`proactive.enabled` 这样的英文 key ——
   * 用户根本认不出这是"语音开关"和"主动发言"，也就改不了。
   */
  'voice.enabled': '语音功能（总开关）',
  'voice.dir': '语音库目录',
  'voice.maxBytes': '单个音频上限（字节）',
  'voice.maxSeconds': '语音时长上限（秒）',
  'voice.maxPerMinute': '每分钟最多几条',
  'voice.maxPerHour': '每小时最多几条',
  /**
   * `policy.sleep.*` 之前一个中文名都没有 —— 配置页显示成
   * `policy.sleep.shortSeconds`，用户根本认不出这是"安静一会儿"。
   */
  'policy.sleep.enabled': '允许它自己静默',
  /**
   * **三个数要读起来像一个梯度**，而不是三个并列的孤立名词。
   *
   * 「安静」有歧义（听着像音量），用「静默」；
   * 「一般上限」太含糊 —— 和下面的「最长」分不出层次。
   */
  'policy.sleep.shortMinSeconds': '静默下限（秒）',
  'policy.sleep.shortMaxSeconds': '静默上限（秒）',
  'policy.sleep.maxSeconds': '最长静默（秒）',
  'policy.sleep.maxConsecutive': '连续静默几次后不再允许',
  'policy.updateCheck.enabled': '检查新版本（只提示，不自动装）',
  'policy.updateCheck.intervalHours': '每隔几小时查一次',
  'policy.updateCheck.registry': 'npm 源地址',
  'policy.idleSleep.enabled': '群安静后自动静默',
  'policy.idleSleep.afterMinutes': '安静多久算没人说话（分钟）',
  'policy.idleSleep.quietMinutes': '静默持续多久（分钟）',
  'policy.idleSleep.findTopic': '静默期间自己找话题',
  'policy.idleSleep.minMinutes': '找话题间隔下限（分钟）',
  'policy.idleSleep.maxMinutes': '找话题间隔上限（分钟）',
  'policy.idleSleep.maxPerHour': '每小时最多找几次话题',
  'proactive.enabled': '主动发言（定时唤起）',
  'proactive.maxPerDay': '每天最多主动发言几次',
  'proactive.quietHours': '安静时段（这段时间不唤起）',
  'policy.groupEnabled': '响应群消息',
  'policy.groupWhitelist': '群白名单',
  'policy.groupTrigger': '触发策略',
  'policy.groupMentionOnly': '旧版 @ 开关',
  'policy.groupTriggerKeywords': '触发关键词',
  'policy.groupToolGuard': '群工具守卫',
  'policy.ratePerMinute': '每分钟上限',
  'agent.provider': 'Provider',
  'agent.model': '模型',
  'agent.reasoningEffort': '思考强度',
  'agent.maxTokens': '输出上限',
  'agent.systemPrompt': '系统提示',
  'agent.cwd': '工作目录',
  'agent.maxHistoryChars': '会话历史重建阈值（字）',
  'agent.preset': 'Preset',
  'outbound.split': '分条方式',
  'outbound.maxChars': '单条上限',
  'outbound.maxSegments': '最多几条',
  'outbound.plainText': 'Markdown 转纯文本',
  'outbound.intervalMs': '分条间隔',
  'judge.enabled': '启用判定',
  'judge.threshold': '判定阈值',
  'judge.onUnsure': '犹豫时怎么办',
  'judge.batchWindowMs': '批窗口',
  'judge.batchMaxWaitMs': '批最长等待',
  'memory.enabled': '启用长期记忆',
  'memory.inject': '注入到 prompt',
  'memory.maxChars': '记忆字数预算',
  'onebot.wsUrl': 'WS 地址',
  'onebot.token': 'Access Token',
  'onebot.selfId': '机器人 QQ 号',
  'console.port': '监听端口',
  'console.host': '监听地址',
  'console.username': '登录用户名',
  'console.sessionHours': '会话有效期',
  'store.path': '数据库路径',
}

/** @param {string} path @returns {string|null} */
export function labelOf(path) {
  return FIELD_LABELS[path] ?? null
}

/**
 * 该用多行输入框的字符串字段。
 *
 * schema 里 `string` 一律渲染成单行 input，但"系统提示""角色卡"这类内容
 * 天生是多段落的，塞进一行里既难写也看不见全貌。
 */
export const MULTILINE_PATHS = new Set(['agent.systemPrompt'])

/** @param {string} path */
export function multilineOf(path) {
  return MULTILINE_PATHS.has(path)
}

export const FIELD_SUGGESTS = {
  // `dsh-agent-default-model` 里它是 `z.string().volatile()` —— 纯自由字符串，
  // 这里只是提示常见写法；真实可接受的集合由当前 provider 的 adapter 决定
  'agent.reasoningEffort': ['off', 'low', 'medium', 'high'],
}

/** @param {string} path @returns {string[]|null} */
export function suggestOf(path) {
  return FIELD_SUGGESTS[path] ?? null
}

/** 数组元素类型 → 前端控件提示；不认识的按 JSON 文本处理 */
function mapType(node) {
  const t = node?.type
  if (t === 'boolean') return 'boolean'
  if (t === 'number') return 'number'
  if (t === 'string') return node?.meta?.role === 'secret' ? 'secret' : 'string'
  if (t === 'union') return 'enum'
  if (t === 'array') {
    const inner = node?.inner?.type
    if (inner === 'string') return 'string[]'
    if (inner === 'number') return 'number[]'
    return 'json'
  }
  return 'json'
}

/**
 * 从 union 节点取可选值。
 *
 * `list` 里的元素是 `{uid, refs:{[uid]:{type:'const',value}}}`（序列化后更明显），
 * 依赖它等于依赖 schemastery 的内部实现。`toString()` 是公开行为，更稳。
 */
function enumOptions(node, path, onWarn) {
  let text = ''
  try {
    text = String(node?.toString?.() ?? '')
  } catch {
    text = ''
  }
  const options = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
  if (options.length === 0 && /\d/.test(text)) {
    // union([1,2]) 这种：没引号但确实是枚举，按数字取
    const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]))
    if (nums.length) return nums
  }
  if (options.length === 0) {
    onWarn?.(`配置字段 ${path} 是 union 但取不出可选值（toString=${JSON.stringify(text)}），退化为文本输入`)
  }
  return options.length ? options : null
}

/**
 * 把 schema 摊平成叶子字段列表。只摊 object（嵌套对象就是一层分组），
 * 数组/union 一律当叶子 —— 表单里不做"对象数组"这种复杂编辑器。
 *
 * @param {any} schema schemastery Schema（可为 undefined：单测/未就绪时）
 * @param {{ prefix?: string, onWarn?: Function }} [opts]
 * @returns {Array<{ path: string, key: string, type: string, description: string,
 *                   defaultValue: unknown, secret: boolean, options: unknown[]|null,
 *                   applies: 'live'|'restart' }>}
 */
export function flattenSchema(schema, { prefix = '', onWarn } = {}) {
  const out = []
  if (!schema || schema.type !== 'object' || !schema.dict) return out

  for (const [key, node] of Object.entries(schema.dict)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (node?.type === 'object' && node.dict) {
      out.push(...flattenSchema(node, { prefix: path, onWarn }))
      continue
    }
    const type = mapType(node)
    out.push({
      path,
      key,
      type,
      description: String(node?.meta?.description ?? ''),
      defaultValue: node?.meta?.default,
      secret: node?.meta?.role === 'secret',
      options: type === 'enum' ? enumOptions(node, path, onWarn) : null,
      // 中文显示名（没有就用 key）
      label: labelOf(path),
      // 多行文本框（系统提示这类多段落内容）
      multiline: multilineOf(path),
      // 由前端另行拉取的候选来源（provider/model）；null 表示就是个普通文本/枚举字段
      optionsFrom: optionsFromOf(path),
      // 静态建议值（可手填别的），如思考强度
      suggest: suggestOf(path),
      applies: appliesOf(path),
    })
  }
  return out
}

/**
 * 顶层分组：段名 → 组标题。标题取段的 `description`（config.js 里每段都写了中文说明），
 * 没有就用段名。
 *
 * @param {any} schema
 * @returns {Array<{ key: string, label: string }>}
 */
export function listGroups(schema) {
  if (!schema || schema.type !== 'object' || !schema.dict) return []
  return Object.entries(schema.dict)
    .filter(([, node]) => node?.type === 'object')
    .map(([key, node]) => ({ key, label: String(node?.meta?.description ?? key) }))
}

/** 点路径读写：配置是嵌套对象，而 kv 与 HTTP 都以 `a.b.c` 为键 */
export function getPath(obj, path) {
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 只在与原值不同时才写，避免把数组/对象引用直接塞进 base（base 必须不可变） */
export function setPath(obj, path, value) {
  const segs = String(path).split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i]
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {}
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
  return obj
}
