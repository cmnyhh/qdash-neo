/**
 * chatKey ↔ agent 会话的映射与生命周期。
 *
 * 两条硬事实决定了这里的写法（2026-10-26 实测，见 docs/qdash-neo/00 §三）：
 *
 * 1. `ctx.agents.create()` 对**已存在的 session id** 一律拒绝，而且两种失败形态不同：
 *      - 内存里有 live 持有者 → 普通 `Error`，无 `code`/无自定义字段
 *      - 只有磁盘记录（上次进程留下的）→ `SessionAlreadyExistsError`（带 `sessionId`）
 *    所以「有记录」时正确动作是 `resume()`，不是 `create()`。
 * 2. `handle.dispose()` 会把 session 从内存移除（`ctx.agents.get()` 变成 absent），
 *    但**磁盘记录还在** → dispose 之后 create 同一个 id 仍然失败。所以 dispose 不能当暂停用。
 *
 * 结论：`ensure()` 必须是「内存查活 → create → 撞记录就 resume」+ 自建互斥。
 * 互斥不是优化：两条并发消息同时进 ensure，会同时 create 同一个 id。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 默认 agent 工作目录：`~/.dsh/workspaces/qdash-neo`。
 *
 * 为什么不是宿主 cwd：那是 DSH 的安装目录，agent 在里面执行工具会污染程序文件。
 * 为什么不是仓库路径：插件装进 profile 后 `import.meta.url` 指向 `node_modules`，
 * 推导不出仓库根；而 DSH 的数据目录结构是稳定的跨机器约定。
 *
 * 目录名同时就是 DSH 侧的工作区名 —— 叫 `qdash-neo` 是刻意的。
 */
function defaultWorkspaceDir() {
  return join(homedir(), '.dsh', 'workspaces', 'qdash-neo')
}

export class SessionRouter {
  /**
   * @param {object} ctx DSH 上下文
   * @param {{ config: object, log: Function, createUserMessage: Function, store?: object,
   *           groupSetup?: (agentCtx: object, agent: object) => void }} deps
   *   `groupSetup` 只在群会话（`g:`）的 create/resume 时作为 `setup` 传入 ——
   *   它拿到的是 **agent 作用域**的 ctx，`tools.guard()` 只有在那里注册才只影响这个会话
   *   （dsh-agent `CreateAgentOptions.setup`，types/index.d.ts:85-103）。
   */
  constructor(ctx, { config, log, createUserMessage, store, groupSetup = null }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.createUserMessage = createUserMessage
    this.store = store
    this.groupSetup = groupSetup
    /** @type {Map<string, Promise<object>>} chatKey → 正在进行的 ensure */
    this.inflight = new Map()
    /** @type {Map<string, object>} chatKey → AgentHandle（用来 dispose） */
    this.handles = new Map()
  }

  static sessionIdOf(chatKey) {
    return `qq:${chatKey}`
  }

  /**
   * DSH 把 sessionId 编码成目录名：`:` → `~003A`（非 `[A-Za-z0-9._-]` 一律 `~XXXX`）。
   * 例：`qq:u:10001` → `qq~003Au~003A10001`。
   * @param {string} sessionId
   */
  static encodeSessionId(sessionId) {
    return String(sessionId ?? '').replace(
      /[^A-Za-z0-9._-]/g,
      /**
       * **十六进制必须大写。**
       *
       * DSH 生成的目录名是 `qq~003Ag~003A1129813323`（**大写 A**），
       * 而 `toString(16)` 给的是小写 —— Linux 文件系统区分大小写，于是
       * 路径永远对不上，`existsSync` 恒为 false。
       *
       * 后果：`rebuildSession` 每次"成功"地删了 **0 个目录**，
       * 会话历史一点没少，上下文一路涨到 `prompt is too long: 1061352 tokens`。
       * 而日志写的是"重建会话（xxx）删除了 0 个目录"—— **0 这个数字太容易被略过**。
       *
       * 这是"重建一直是假的"的第二个原因（第一个是写死 `homedir()`）。
       */
      c => `~${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`,
    )
  }

  /**
   * 删掉磁盘上的会话记录（`~/.dsh/sessions/<cwd目录>/<编码后的 id>/`）。
   *
   * 为什么不按 cwd 自己算出目录名：那要复刻 DSH 的路径编码规则（盘符、分隔符、大小写），
   * 算错就是删到别处或删不掉。这里只在第一层（每个 cwd 一个目录）里找同名子目录。
   *
   * @param {string} sessionId
   * @param {{ log?: Function }} [opts]
   * @returns {string[]} 实际删掉的目录
   */
  static removeStoredSession(sessionId, { log = () => {} } = {}) {
    /**
     * **必须优先用 `DSH_HOME`，不能只看 `homedir()`。**
     *
     * 线上 `DSH_HOME=/opt/dsh-home-official`，而会话实际落在
     * `/opt/dsh-home-official/sessions/...`。早先这里写死
     * `homedir()/.dsh/sessions`，于是每次"删会话"都在删一个**不存在的目录**，
     * `removed.length` 恒为 0 —— 而调用方看到"成功"，以为重建了。
     *
     * 后果很严重：`chats` 表里的记录删了，磁盘上的 agent 历史还在，
     * 下次 `createOrResume` 又把那几百轮历史 resume 回来 ——
     * 上下文一路涨到 `prompt is too long: 1061352 tokens`。
     */
    const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
    const encoded = SessionRouter.encodeSessionId(sessionId)
    const removed = []
    let cwdDirs
    try {
      cwdDirs = readdirSync(root, { withFileTypes: true })
    } catch (err) {
      // 目录不存在 = 本来就没有记录，不是错误
      if (err?.code !== 'ENOENT') {
        log('warn', `qdash-neo: 读 sessions 目录失败 ${root} name=${err?.name} msg=${err?.message}`)
      }
      return removed
    }
    for (const dirent of cwdDirs) {
      if (!dirent.isDirectory()) continue
      const target = join(root, dirent.name, encoded)
      if (!existsSync(target)) continue
      try {
        rmSync(target, { recursive: true, force: true })
        removed.push(target)
      } catch (err) {
        log('warn', `qdash-neo: 删除会话目录失败 ${target} name=${err?.name} msg=${err?.message}`)
      }
    }
    return removed
  }

  /**
   * 释放单个会话的句柄（内存），磁盘记录保持不动。
   * `dispose()` 之后 `ctx.agents.get(id)` 变 absent，但磁盘记录还在 —— 所以重建要走 resume。
   * @param {string} chatKey
   */
  async release(chatKey) {
    const handle = this.handles.get(chatKey)
    this.handles.delete(chatKey)
    if (!handle || typeof handle.dispose !== 'function') return false
    try {
      await handle.dispose()
      return true
    } catch (err) {
      this.log('warn', `qdash-neo: 释放会话失败 ${chatKey} name=${err?.name} msg=${err?.message}`)
      return false
    }
  }

  /**
   * 传给 `ctx.agents.create/resume` 的模型绑定。
   *
   * `AgentOptions` 支持四个字段（dsh-agent `runtime-types.d.ts`）：
   * provider / model / reasoningEffort / maxTokens。
   * 后两个是**可选**：空值表示"不表态，用 provider 默认"。
   * 注意 `reasoningEffort` 是 branded id，传空串会被 adapter 当成非法值 ——
   * 所以只在非空时才放进去。
   */
  agentOptions() {
    const a = this.config?.agent ?? {}
    const out = {
      provider: a.provider || undefined,
      model: a.model || undefined,
    }
    const effort = String(a.reasoningEffort ?? '').trim()
    if (effort) out.reasoningEffort = effort
    if (Number.isFinite(a.maxTokens) && a.maxTokens > 0) out.maxTokens = a.maxTokens
    return out
  }

  /**
   * 会话元信息。`cwd` **不写死**：配置留空就用默认工作区目录，且每次现算。
   *
   * 必须每次确保目录存在：`resume` 会因为它不存在直接失败
   * （`working-directory: directory does not exist`），而失败点在 agent 创建期，
   * 表现是"消息进来了但永远不回复"，非常难往 cwd 上想。
   */
  meta() {
    const a = this.config?.agent ?? {}
    const cwd = String(a.cwd ?? '').trim() || defaultWorkspaceDir()
    try {
      mkdirSync(cwd, { recursive: true })
    } catch (err) {
      this.log('warn', `qdash-neo: 创建 agent 工作目录失败 ${cwd} name=${err?.name} msg=${err?.message}`)
    }
    return { cwd }
  }

  preset() {
    const p = this.config?.agent?.preset
    return p ? { agentPreset: p } : {}
  }

  /**
   * 拿到该 chat 的 live agent（幂等）。
   * @param {string} chatKey
   */
  async ensure(chatKey) {
    const cached = this.handles.get(chatKey)
    if (cached && this.isLive(cached)) return cached.agent

    const running = this.inflight.get(chatKey)
    if (running) return running

    const task = this.createOrResume(chatKey).finally(() => this.inflight.delete(chatKey))
    this.inflight.set(chatKey, task)
    return task
  }

  isLive(handle) {
    try {
      return handle?.agent?.status !== undefined
    } catch {
      return false
    }
  }

  async createOrResume(chatKey) {
    const sessionId = SessionRouter.sessionIdOf(chatKey)

    // 先看内存：跨插件/跨模块都可能已经有人建过
    const existing = this.ctx.agents.get(sessionId)
    if (existing) {
      this.log('debug', `qdash-neo: 复用已有 agent ${sessionId}`)
      return existing
    }

    const setup = this.setupFor(chatKey)
    const options = {
      sessionId,
      agentOptions: this.agentOptions(),
      meta: { ...this.meta(), ...this.preset() },
      ...(setup ? { setup } : {}),
    }

    try {
      const handle = await this.ctx.agents.create(options)
      this.handles.set(chatKey, handle)
      this.log('info', `qdash-neo: 新建会话 ${sessionId}`)
      return handle.agent
    } catch (err) {
      if (err?.name !== 'SessionAlreadyExistsError') {
        // 失败必须可见：把结构化字段和原因一起打出来，别只 `String(err)`
        this.log('error', `qdash-neo: 建会话失败 ${sessionId} name=${err?.name} code=${err?.code} msg=${err?.message}`, err)
        throw err
      }
      this.log('info', `qdash-neo: ${sessionId} 磁盘上已有记录，改走 resume`)
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        /**
         * **必须带 meta**：resume 会用磁盘记录里的 cwd，而记录可能指向一个已经
         * 不存在的目录（仓库改名/删目录之后就会这样），报
         * `working-directory: directory does not exist` 然后整条链路不回复。
         * 传当前 meta 让 cwd 以配置为准。
         */
        meta: { ...this.meta(), ...this.preset() },
        ...(setup ? { setup } : {}),
      })
      this.handles.set(chatKey, handle)
      return handle.agent
    }
  }

  /** 群会话才装 groupSetup：私聊是主人自己，不需要降权 */
  setupFor(chatKey) {
    if (!this.groupSetup) return null
    /**
     * 群和私聊都挂。
     *
     * 早期只给群挂（因为群里有非白名单成员，文本不可信）；现在改成了正面白名单，
     * "能调用的工具都是安全的"这件事与群/私聊无关 —— 而高危项在任何会话都不给
     * （用户定的口径：全局禁）。私聊少挂一遍只会让"同一个机器人两副面孔"。
     */
    return agentCtx => this.groupSetup(agentCtx, chatKey)
  }

  /**
   * 投递一条消息。
   * @param {string} chatKey
   * @param {string} text
   */
  async deliver(chatKey, text) {
    const agent = await this.ensure(chatKey)
    agent.followup(
      this.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    return agent
  }

  /** 暂停语义：不是 dispose（会丢会话），是 cancel */
  cancel(chatKey) {
    const handle = this.handles.get(chatKey)
    return handle?.agent?.cancel?.({ keepInbox: true })
  }

  async release(chatKey) {
    const handle = this.handles.get(chatKey)
    this.handles.delete(chatKey)
    if (handle) await handle.dispose()
  }

  async releaseAll() {
    for (const key of [...this.handles.keys()]) await this.release(key)
  }
}
