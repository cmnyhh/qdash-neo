/**
 * 工具目录 —— **纯数据 + 纯判定，不碰 ctx、不碰网络**。
 *
 * 三件事在这里定清楚：
 *   1. QQ 工具清单（名字、分组、参数说明、是否有副作用）
 *   2. DSH 内置工具里哪些「安全可给」（只读类），哪些「永远不给」（能执行命令/写文件的那批）
 *   3. 白名单求交集的纯函数
 *
 * 为什么不把工具定义直接写在注册处：白名单要在**建会话之前**就算好
 * （`restrict` 只接受真实存在的工具名），而工具定义要等 `setup(agentCtx)` 才能注册。
 * 两者共用一份数据，才不会出现"白名单里有、实际没注册"。
 */

/**
 * QQ 工具分组。
 *
 * 配置只暴露三个开关，不逐个列：能力有十几种，全摊在配置页上没人看得完；
 * 而"读 / 写 / 管理"是三件风险不同的事，够用了。
 */
export const QQ_GROUPS = /** @type {const} */ (['read', 'write', 'admin'])

/**
 * `qq_*` 工具清单。
 *
 * `action` 是 OneBot 动作名；`params` 只写**模型需要填**的字段（其余由插件补上下文）。
 * `modal: true` 表示会产出图片内容（需要走附件服务让模型看图）。
 *
 * @type {Array<{name:string, group:'read'|'write'|'admin', action:string, title:string,
 *   description:string, params:Record<string,string>, modal?:boolean, sideEffect?:boolean}>}
 */
export const QQ_TOOLS = [
  /* ---- 读 ---- */
  {
    name: 'qq_get_image',
    group: 'read',
    action: 'get_image',
    title: '看图片',
    description:
      '把消息里的一张图片取回来看。传当前消息或历史消息里的图片 ID / 文件名 / URL。' +
      '模型支持看图时会直接把图放进上下文；不支持时会返回一段说明。',
    params: { file: '图片 ID、文件名或 URL（见群聊记录里的 [图片:xxx]）' },
    modal: true,
  },
  {
    name: 'qq_get_custom_face',
    group: 'read',
    action: 'fetch_custom_face',
    title: '看表情包',
    description: '把群里的表情包取回来看。传表情 ID 或收藏夹里的文件名。',
    params: { file: '表情 ID / 文件名；留空则列出该群的收藏表情' },
    modal: true,
  },
  {
    name: 'qq_get_msg',
    group: 'read',
    action: 'get_msg',
    title: '读单条消息',
    description: '按消息 ID 读一条消息的完整结构（含消息段、发送者、时间）。',
    params: { message_id: '消息 ID' },
  },
  {
    name: 'qq_get_history',
    group: 'read',
    action: 'get_group_msg_history',
    title: '读群历史',
    description: '往前翻群消息（当前会话之外的旧消息）。',
    params: { count: '条数，默认 20，最多 50' },
  },
  {
    name: 'qq_get_forward',
    group: 'read',
    action: 'get_forward_msg',
    title: '拆合并转发',
    description: '把一条「合并转发」消息展开成里面的各条内容。',
    params: { id: '转发消息的 id' },
  },
  {
    name: 'qq_group_info',
    group: 'read',
    action: 'get_group_info',
    title: '看群资料',
    description: '当前群的名称、人数、公告等。',
    params: {},
  },
  {
    name: 'qq_member_info',
    group: 'read',
    action: 'get_group_member_info',
    title: '看群成员',
    description: '看某位群成员的昵称、名片、群等级、入群时间等。',
    params: { user_id: 'QQ 号；留空用当前发言人' },
  },
  {
    name: 'qq_member_list',
    group: 'read',
    action: 'get_group_member_list',
    title: '列群成员',
    description: '列出群成员（人多时只取前 N 个，注意别把它当通讯录用）。',
    params: {},
  },
  {
    name: 'qq_group_files',
    group: 'read',
    action: 'get_group_root_files',
    title: '列群文件',
    description: '列出群文件的根目录。',
    params: {},
  },
  {
    name: 'qq_group_file_url',
    group: 'read',
    action: 'get_group_file_url',
    title: '取群文件链接',
    description: '拿到某个群文件的下载链接（不自动下载）。',
    params: { file_id: '文件 ID', busid: 'busid（列目录时会给）' },
  },

  /* ---- 写 ---- */
  {
    name: 'qq_send_message',
    group: 'write',
    action: 'send',
    title: '发消息',
    description:
      '往当前会话发一条消息（纯文本）。走的是插件的出站队列（限流、分条、死信重试都生效），' +
      '不要用它刷屏；正常回复直接用普通输出即可。' +
      '群里想明确回某一条时带 reply_to（消息前面的 [#数字]）；整体回应就不用带。',
    params: {
      text: '要发送的文本',
      reply_to: '可选：要引用回复的消息 ID（群聊里消息前的 [#数字]）。私聊忽略',
    },
    sideEffect: true,
  },
  {
    name: 'qq_send_image',
    group: 'write',
    action: 'send',
    title: '发图片',
    description: '往当前会话发一张图片（本地路径或 URL）。',
    params: { file: '本地绝对路径或 http(s) URL' },
    sideEffect: true,
  },
  {
    name: 'qq_send_voice',
    group: 'write',
    action: 'send',
    title: '发语音',
    description: '往当前会话发一条语音库里的音频文件（默认只允许库内文件）。',
    params: { name: '语音库里的文件名，如 hi.mp3' },
    sideEffect: true,
  },
  {
    name: 'qq_voice_list',
    group: 'read',
    action: 'list',
    title: '语音库',
    description: '列出语音库里可用的音频文件。',
    params: {},
  },
  {
    name: 'qq_send_custom_face',
    group: 'write',
    action: 'send',
    title: '发表情',
    description: '往当前会话发一个表情包（按表情 ID）。',
    params: { id: '表情 ID' },
    sideEffect: true,
  },
  {
    name: 'qq_recall',
    group: 'write',
    action: 'delete_msg',
    title: '撤回消息',
    description: '撤回一条消息（只能撤回机器人自己发的，或群里管理员权限内的）。',
    params: { message_id: '消息 ID' },
    sideEffect: true,
  },
  {
    name: 'qq_poke',
    group: 'write',
    action: 'send_poke',
    title: '戳一戳',
    description: '戳一戳某人（群里别拿来刷）。',
    params: { user_id: 'QQ 号；留空用当前发言人' },
    sideEffect: true,
  },
  {
    name: 'qq_react',
    group: 'write',
    action: 'set_msg_emoji_like',
    title: '表情回应',
    description: '给一条消息贴表情回应（比发言更轻的互动方式）。',
    params: { message_id: '消息 ID', emoji_id: '表情 ID，默认 128077（点赞）' },
    sideEffect: true,
  },

  /* ---- 管理（默认关闭） ---- */
  {
    name: 'qq_kick',
    group: 'admin',
    action: 'set_group_kick',
    title: '踢人',
    description: '把某个群成员移出群聊（执行期自动校验请求者身份，不在管理员名单则拒绝）。',
    params: { user_id: 'QQ 号' },
    sideEffect: true,
  },
]

/** 按分组取工具名 */
export function qqToolsOf(group) {
  return QQ_TOOLS.filter(t => t.group === group).map(t => t.name)
}

/** 全部 QQ 工具名 */
export const QQ_TOOL_NAMES = QQ_TOOLS.map(t => t.name)

/**
 * 插件自己注册的**非 QQ** 工具。
 *
 * `memory_add`：让模型自己决定"这句值得长期记住"。
 * 之前三类记忆只有 `thought` 有生产者（还依赖判定链），`topic` / `impression`
 * 完全没有写入路径 —— 表现就是"能注入但没有新记忆"。
 *
 * 它不操作 QQ，所以不归 `qq_*` 那套分组；只在 `memory.enabled` 时才进白名单。
 */
export const MEMORY_TOOLS = ['memory_add']

/**
 * **永远不给 agent** 的工具名模式（用户定的口径：全局禁高危）。
 *
 * 不是"默认关、可勾选"，而是根本不出现在可勾选列表里 —— 群里是提示注入的重灾区，
 * 一个能被说服的模型配一把 shell 就等于把机器交出去。
 *
 * 用正则而不是精确名：DSH 各 profile 注册的工具名不完全一样
 * （`bash` / `bash_persistent` / `pwsh` / `fs_write` / `str_replace_editor`…），
 * 精确名列表一定会漏。
 */
export const DENY_PATTERNS = [
  // 用子串而不是 `\b`：工具名是 `bash_persistent` / `subagent_control` 这种下划线拼接的，
  // 而 `\b` 在 `_` 与字母之间不算边界 —— 会漏掉最该拦的那批
  /(bash|pwsh|powershell|shell|terminal)/i,
  /str_replace_editor/i,
  /fs_(write|edit|delete|move|copy|mkdir|remove|patch)/i,
  /(sub_?agent|worktree|ralph|workflow)/i,
  /cordis/i,
  /(execute|run)_(command|shell|script)/i,
]

/**
 * DSH 内置工具里**推荐**给的（只读 / 无副作用）。
 *
 * 前缀匹配：`fs_read`、`web_search` 这类名字在各 profile 里可能有细微差别，
 * 用正向模式比精确名稳；最终仍会被 `schemas()` 求交集，配错不会炸。
 */
export const SAFE_PATTERNS = [
  /^fs_(read|list|stat|glob|search)/i,
  /^web_(search|fetch)/i,
  /^(todo|goal|schedule|present|skill|session_query)$/i,
  /^ask_user$/i,
  /^working_directory$/i,
  /^workspace_dependencies$/i,
]

/**
 * 这个名字是不是高危（永远不给）。
 * @param {string} name
 */
export function isDenied(name) {
  const n = String(name ?? '')
  if (!n) return true
  // QQ 工具是自家注册的，不受内置高危名单影响
  if (QQ_TOOL_NAMES.includes(n)) return false
  return DENY_PATTERNS.some(re => re.test(n))
}

/**
 * 这个名字是不是"内置安全项"（可以出现在默认勾选里）。
 * @param {string} name
 */
export function isSafeInternal(name) {
  const n = String(name ?? '')
  if (!n) return false
  return SAFE_PATTERNS.some(re => re.test(n))
}

/**
 * 求实际生效的工具名列表。
 *
 * 三道过滤，顺序不能换：
 *   1. 高危 → 直接剔除（哪怕用户勾了也不给）
 *   2. QQ 分组开关 → 关掉的分组不注册
 *   3. 白名单 → 内置安全项 ∪ 用户勾选项
 *
 * 最后与 `available`（`tools.schemas()` 的真实清单）求交集：
 * `restrict` 对未知名字会抛错，而各 profile 注册的工具集合并不相同。
 *
 * @param {{
 *   available: string[],
 *   qqGroups?: { read?: boolean, write?: boolean, admin?: boolean },
 *   internalAllow?: string[],
 *   externalAllow?: string[],
 *   includeSafeInternal?: boolean,
 * }} opts
 * @returns {{ allow: string[], missing: string[], denied: string[] }}
 */
export function resolveAllowed({
  available,
  qqGroups = {},
  internalAllow = [],
  externalAllow = [],
  includeSafeInternal = true,
  includeMemory = false,
}) {
  const have = new Set((available ?? []).map(String))
  const wanted = new Set()

  // 记忆工具只在记忆功能开着时才给（记忆关了给它也没意义）
  if (includeMemory) for (const name of MEMORY_TOOLS) wanted.add(name)

  for (const t of QQ_TOOLS) {
    /**
     * `read` / `write` 默认开，`admin` 默认关。
     *
     * 注意别写成 `qqGroups[group] !== false`：`undefined !== false` 为真，
     * 于是"没配"会被当成"开着"，踢人工具就默认进白名单了。
     */
    const on = qqGroups[t.group] === true || (t.group !== 'admin' && qqGroups[t.group] !== false)
    if (on) wanted.add(t.name)
  }
  if (includeSafeInternal) {
    for (const name of have) if (isSafeInternal(name)) wanted.add(name)
  }
  for (const name of internalAllow ?? []) wanted.add(String(name))
  for (const name of externalAllow ?? []) wanted.add(String(name))

  const allow = []
  const denied = []
  for (const name of wanted) {
    if (isDenied(name)) {
      denied.push(name)
      continue
    }
    allow.push(name)
  }

  // 配了但当前 profile 里没有：留痕而不是让它去 `restrict` 里抛错
  const missing = allow.filter(name => !have.has(name) && !QQ_TOOL_NAMES.includes(name))
  const present = allow.filter(name => have.has(name) || QQ_TOOL_NAMES.includes(name))

  return { allow: present.sort(), missing: missing.sort(), denied: denied.sort() }
}
