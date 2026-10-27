/**
 * 把「自定义系统提示」与「插件固定规则」同步进工作区的 `AGENTS.md`。
 *
 * 为什么是 AGENTS.md，而不是直接塞进每条 user message：
 *   - 行为约束属于**系统层**。混在 user message 里，模型会把它当成"对方说的话"的一部分，
 *     长对话里被稀释掉是常见结果
 *   - DSH 没有给插件追加 system prompt 的公开 API（`SystemPromptProjection` 是内核自用的），
 *     而 `dsh-agent-instructions` 会在**首次请求前**把工作区里的 `AGENTS.md`
 *     作为 baseline 指令载入 durable context —— 这就是官方通道
 *
 * **两个块，所有权分开**：
 *
 *   `qdash-neo:rules`         插件所有。沉默约定、记忆引导这类**功能规则**，
 *                             只要对应功能开着就一直在。手改会在下次同步时被覆盖（块内已注明）。
 *   `qdash-neo:instructions`  用户所有。就是配置页里那段「系统提示」，可以为空。
 *
 * 为什么不能合成一个块：合成之后"清空系统提示"会把插件规则一起删掉 ——
 * 于是 `memory_add` 的引导、`[[SILENT]]` 的约定静默消失，功能失效却没有任何报错。
 * 这两件事的生命周期不同，就必须分成两个块。
 *
 * 三条纪律：
 *   1. **只动自己的标记块**。用户手写的其它内容原样保留，插件无权覆盖
 *   2. 用户清空系统提示 = **只删那一个块**，规则块照常维护
 *   3. 写文件失败必须留痕并让调用方知道（返回值带 `ok`/`error`），不静默吞
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 用户内容块（配置页的 systemPrompt） */
export const BLOCK_BEGIN = '<!-- qdash-neo:instructions:begin -->'
export const BLOCK_END = '<!-- qdash-neo:instructions:end -->'

/** 插件规则块（沉默约定 + 记忆引导） */
export const RULES_BEGIN = '<!-- qdash-neo:rules:begin -->'
export const RULES_END = '<!-- qdash-neo:rules:end -->'

/**
 * 插件自带的固定规则：模型怎么表达"不说"。
 *
 * 放这里的理由：它是**跨请求恒定的行为约定**，不是某一条消息的临时要求；
 * 而 user message 里只需要留"这一条你自己判断要不要接"这种**触发语**。
 */
export const SILENT_RULE =
  '当一条消息让你自己判断「要不要插话」时：如果你决定不开口，只输出一行 [[SILENT]]（不要输出任何别的内容）；' +
  '决定开口就正常回复。不要解释这个约定，也不要把它当作聊天内容的一部分。'

/**
 * 发送方式：**必须**告诉模型，否则它会以为"输出即发送"。
 *
 * `onAssistant` 的设计是"工具是唯一出口"——直接输出的正文只落库
 * （`state='unforwarded'`），**不会**发到 QQ。但系统提示里长期没写这一点，
 * 于是模型一旦决定不调工具（比如前面 `qq_speak` 失败、它以为该改用文字），
 * 那一段话就静默消失了：库里有、QQ 没有、日志里也只有一句 info 级的
 * 「未调发送工具，正文不发出」。
 *
 * 这条是**无条件**的，不随配置开关：没有它，模型永远不知道该怎么做。
 */
export const SEND_RULE =
  '你要说的话必须通过 qq_send_message 工具发出去 —— 直接输出的正文不会出现在聊天里，对方收不到。' +
  '想发语音用 qq_speak。' +
  '工具调用失败时，改用 qq_send_message 把话说出去，不要把内容当作普通回复输出。' +
  '不想说话就什么都不做：不要输出解释，也不要输出任何占位标记。'

/**
 * 记忆写入的引导。
 *
 * 为什么写进系统层而不是每条 user message：它是**跨请求恒定**的行为约定
 * （什么时候该记、记成什么粒度），不是某条消息的要求。
 *
 * 没有这段引导，`memory_add` 这个工具大概率不会被调用 —— 模型不会主动
 * 想到"我该记点什么"。所以工具和引导必须成对出现。
 */
export const MEMORY_RULE =
  '遇到值得长期记住的事，用 memory_add 记下来：谁是谁、稳定的偏好、正在推进的事、明确的约定。' +
  '不要记流水账（"他说了你好"），也不要记一次性的情绪或事件。' +
  '话题用 topic，对人的印象用 impression（带 target），想说没说的用 thought。'

/** 块内的所有权声明：让手改的人事先就知道会被覆盖 */
const OWNED_NOTE = '<!-- 本块由 qdash-neo 自动维护，手改会在下次启动或保存配置时被覆盖；要改请用控制台配置页 -->'

/**
 * 用户内容块。为空则返回空串（= 删掉这个块）。
 *
 * @param {string} userText
 */
export function renderInstructionsBlock(userText) {
  const text = String(userText ?? '').trim()
  if (!text) return ''
  return `${BLOCK_BEGIN}\n${text}\n${BLOCK_END}\n`
}

/**
 * 插件规则块。两个规则都关掉时返回空串（= 删掉这个块）。
 *
 * @param {{ silentRule?: boolean, memoryRule?: boolean }} [opts]
 */
export function renderRulesBlock({ silentRule = true, memoryRule = false } = {}) {
  const parts = []
  // 发送方式无条件写：模型不知道"正文不发"，就会把话丢在落库里
  parts.push(SEND_RULE)
  if (silentRule) parts.push(SILENT_RULE)
  if (memoryRule) parts.push(MEMORY_RULE)
  if (!parts.length) return ''
  return `${RULES_BEGIN}\n${OWNED_NOTE}\n\n${parts.join('\n\n')}\n${RULES_END}\n`
}

/**
 * 兼容入口：拼出"用户块 + 规则块"的完整文本。
 *
 * 拆块之后同步逻辑不再用它，但保留它给测试与排查用 —— 一眼能看出文件该长什么样。
 * @param {string} userText
 * @param {{ silentRule?: boolean, memoryRule?: boolean }} [opts]
 */
export function renderBlock(userText, opts = {}) {
  return `${renderInstructionsBlock(userText)}${renderRulesBlock(opts)}`
}

/**
 * 移除一个标记块（连块后那个换行一起吃掉，否则反复同步会攒出一串空行）。
 *
 * @param {string} source
 * @param {string} begin
 * @param {string} end
 */
function removeBlock(source, begin, end) {
  if (!source.includes(begin) || !source.includes(end)) return source
  return source.replace(new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`), '')
}

/**
 * 确保 cwd 被 DSH 认成「项目根」。
 *
 * `dsh-agent-instructions` 的 `DEFAULT_PROJECT_ROOT_MARKERS = [".git"]` —— 它从 cwd
 * 向上找 `.git`，**找不到就跳过整个 workspace baseline**，AGENTS.md 写得再对也从不被读。
 *
 * 我们的 cwd 是数据目录（`~/.dsh/workspaces/qdash-neo`），天然没有 `.git`。
 * 实测后果：系统提示从第一版起就没生效过，会话记录里连一个字节都搜不到。
 *
 * 这里建一个**空目录**当标记。不需要是合法 git 仓库 —— 它只是被当成 marker 用。
 * 副作用很小：群会话的工具白名单里本来就没有 bash / 写文件，不会被误当成可提交的仓库。
 *
 * @param {string} dir
 * @param {Function} log
 */
function ensureProjectMarker(dir, log) {
  const marker = join(dir, '.git')
  if (existsSync(marker)) return true
  try {
    mkdirSync(marker, { recursive: true })
    log('info', `qdash-neo: 已创建 ${marker}（DSH 只认 .git 作项目根标记，缺了它 AGENTS.md 不会被读）`)
    return true
  } catch (err) {
    log('warn', `qdash-neo: 创建项目标记失败 ${marker} name=${err?.name} msg=${err?.message}`)
    return false
  }
}

/**
 * 同步到 `<cwd>/AGENTS.md`：两个块各自替换/删除/追加，块外内容不动。
 *
 * @param {{
 *   cwd: string,
 *   text?: string,
 *   silentRule?: boolean,
 *   memoryRule?: boolean,
 *   log?: Function,
 * }} opts
 * @returns {{ ok: boolean, file: string, action: 'created'|'updated'|'removed'|'unchanged'|'failed', error?: string }}
 */
export function syncInstructions({ cwd, text = '', silentRule = true, memoryRule = false, log = () => {} }) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return { ok: false, file: '', action: 'failed', error: 'cwd 为空' }

  const file = join(dir, 'AGENTS.md')
  const userBlock = renderInstructionsBlock(text)
  const rulesBlock = renderRulesBlock({ silentRule, memoryRule })

  // 先确保 DSH 会把这个目录当成项目根，否则下面写的文件永远不会被读
  if (userBlock || rulesBlock) ensureProjectMarker(dir, log)

  let current = ''
  if (existsSync(file)) {
    try {
      current = readFileSync(file, 'utf8')
    } catch (err) {
      log('error', `qdash-neo: 读取 ${file} 失败 name=${err?.name} msg=${err?.message}`)
      return { ok: false, file, action: 'failed', error: err?.message ?? '读取失败' }
    }
  }

  /**
   * 先把两个块都摘掉，再按**固定顺序**（用户块 → 规则块）追加。
   *
   * 为什么不就地替换：那样块的位置取决于"它上一次写在哪"，历史遗留的顺序会一直保留 ——
   * 同一个配置在不同机器上产出不同文件，排查时容易误判成"同步没生效"。
   * 摘掉重排的代价只是块总在文件末尾，而用户手写的内容（通常在开头）不受影响。
   */
  const base = removeBlock(removeBlock(current, BLOCK_BEGIN, BLOCK_END), RULES_BEGIN, RULES_END)
    .replace(/\n+$/, '')
  const appended = [userBlock, rulesBlock].filter(Boolean).join('\n')
  const next = appended ? (base ? `${base}\n\n${appended}` : appended) : base

  if (next === current) return { ok: true, file, action: 'unchanged' }

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, next, 'utf8')
  } catch (err) {
    log('error', `qdash-neo: 写入 ${file} 失败 name=${err?.name} msg=${err?.message}`)
    return { ok: false, file, action: 'failed', error: err?.message ?? '写入失败' }
  }

  // action 描述的是用户块（规则块是附属品，单独报出来只会让日志变吵）
  const action = userBlock ? (current ? 'updated' : 'created') : next.trim() ? 'updated' : 'removed'
  log(
    'info',
    `qdash-neo: 指令已同步到 ${file}（${action}；用户块=${userBlock ? '有' : '无'} 规则块=${rulesBlock ? '有' : '无'}）`,
  )
  return { ok: true, file, action }
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
