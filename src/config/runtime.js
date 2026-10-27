/**
 * 运行层配置（M3 第二阶段）：让控制台能改配置，且改完**下一条消息就按新值走**。
 *
 * 三层，合并顺序 `base ← user`，锁在最前面：
 *   - `base`   `apply(ctx, config)` 拿到的对象（默认值 + patch 覆盖），**不可变**，只读
 *   - `user`   控制台写进来的覆盖，落 kv（键 `cfg:<点路径>`）
 *   - `lock`   base 与"纯默认值快照"不等的字段 = 部署方在 patch 里显式指定 = 锁死
 *              即使用户层有旧值也不采用，并在 describe 里标 `ignoredByLock`
 *
 * 为什么锁的判定不查 DSH 的 `ctx.settings.describe()`：
 * 那是 DSH 自己按插件 entry 派生的 settings，它读的 provider 与我们的 `Config` 不是同一个来源，
 * 拿它的 `base` 来判断"我们这个字段被 patch 覆盖过"会得到两个真实来源。
 * 而 `schema({})`（schemastery 的 Schema 本身是可调用函数）能直接给出纯默认值，
 * 与 base 逐叶子比对就是确定性的，且**可单测**。
 *
 * 一个已知边界：patch 里把某字段写成与默认值相同的值（例如显式写 `enabled: true`）
 * 与"没写"无法区分 —— 这时视为未锁。文档里要承认这一条，而不是假装能区分。
 */
import { isDeepStrictEqual } from 'node:util'

import { flattenSchema, getPath, listGroups, setPath } from './schema-form.js'

/** 配置相关的错误：带稳定的 code，控制台据此决定 HTTP 状态与提示文案 */
export class ConfigError extends Error {
  /**
   * @param {string} code `config-conflict` | `config-locked` | `config-invalid` | `config-unknown-field`
   * @param {string} message
   * @param {{ status?: number, fields?: string[] }} [opts]
   */
  constructor(code, message, { status = 400, fields = null } = {}) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.status = status
    this.fields = fields
  }
}

/** 深拷贝：base 必须不可变，任何写路径都不能把引用泄回配置对象 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 不上控制台表单的字段（仍在 schema 与 patch 里，只是不给编辑）。
 *
 * `identity.aliases` 是"兜底别名"：别名已经归人格卡（每张卡一组），
 * 这份只在没选卡时生效。摆在界面上会让人分不清哪份在起作用。
 */
/**
 * 配置页的分组归属（**呈现层**，schema 与落盘键一概不动）。
 *
 * 顺序即导航顺序；`xxx.*` 表示"该前缀下全部字段"。
 * 分组的依据是**使用者的心智模型**，不是代码里的段名 ——
 * 所以 `agent.systemPrompt` 归到「人格与提示」，`outbound.intervalMs` 归到「频率与配额」。
 */
const GROUP_LAYOUT = [
  {
    key: 'connect',
    label: '连接与身份',
    paths: ['onebot.wsUrl', 'onebot.token', 'onebot.selfId'],
  },
  {
    key: 'persona',
    label: '人格与提示',
    paths: [
      'persona.enabled',
      'persona.text',
      'persona.judgeHint',
      'agent.systemPrompt',
      'agent.promptInMessage',
      'agent.silentRule',
      'agent.memoryRule',
    ],
  },
  {
    key: 'model',
    label: '模型',
    paths: [
      'agent.provider',
      'agent.model',
      'agent.reasoningEffort',
      'agent.maxTokens',
      'agent.cwd',
      'agent.preset',
    ],
  },
  {
    key: 'access',
    label: '谁能触发',
    paths: [
      'policy.whitelist',
      'policy.groupEnabled',
      'policy.groupWhitelist',
      'policy.groupTrigger',
      'policy.groupTriggerKeywords',
      'policy.groupMentionOnly',
      'policy.groupToolGuard',
    ],
  },
  {
    key: 'pacing',
    label: '频率与配额',
    paths: [
      'policy.replyChance',
      'policy.ratePerMinute',
      'policy.groupReplyQuota.windowMinutes',
      'policy.groupReplyQuota.maxReplies',
      'policy.sleep.*',
      'outbound.intervalMs',
    ],
  },
  {
    key: 'outbound',
    label: '出站形态',
    paths: [
      'outbound.split',
      'outbound.maxChars',
      'outbound.maxSegments',
      'outbound.plainText',
      'proactive.enabled',
      'proactive.quietHours',
      'proactive.maxPerDay',
    ],
  },
  { key: 'tools', label: '工具', paths: ['tools.*'] },
  { key: 'judge', label: '群内判定（可选）', paths: ['judge.*'] },
  { key: 'memory', label: '社交记忆', paths: ['memory.*'] },
  { key: 'console', label: '控制台与存储', paths: ['console.*', 'store.path'] },
]

const HIDDEN_FIELDS = new Set([
  'identity.aliases',
  // LLM 判定还没调优好：先把"启发式不确定时怎么办"收起来，默认交给对话层自决。
  // 字段仍在 schema 与 patch 里（部署层可以显式覆盖），只是不给普通用户看到。
  'judge.onUnsure',
  // 口令改走顶栏「口令」弹窗（写 kv），配置页不再提供第二个入口 ——
  // 两个入口改的是同一个概念的不同层，用户分不清哪个生效
  'console.password',
])

export class ConfigStore {
  /** describe() 缓存：按 revision 失效，轮询不必每次重算 */
  #describeCache = null

  /**
   * @param {{ schema?: any, base?: object, store?: object|null, log?: Function }} deps
   *   `store` 可以是 null（控制台未就绪/单测）：此时只在内存里生效，不落盘。
   */
  constructor({ schema = null, base = {}, store = null, log = () => {} } = {}) {
    this.schema = schema
    this.base = isPlainObject(base) ? clone(base) : {}
    this.store = store
    this.log = log

    /** @type {Map<string, unknown>} path → 用户层值 */
    this.user = new Map()
    this.revision = 0
    this.updatedAt = 0

    this.fields = flattenSchema(schema, { onWarn: msg => this.log('warn', `qdash-neo: ${msg}`) })
    this.defaults = this.#defaultsSnapshot()
    this.locks = this.#computeLocks()
    this.#load()
  }

  /** 能不能落盘：不能落盘时前端必须禁用保存（否则"改了"只是内存里的错觉） */
  get writable() {
    return Boolean(this.store)
  }

  /** store 可能在构造后才就绪（控制台先建、service.start 后才有 DB）：补一次加载 */
  attachStore(store) {
    if (!store || this.store === store) return
    this.store = store
    this.#load()
    this.#describeCache = null
  }

  // ---------------- 只读面 ----------------

  /** 默认值快照：schema 不可调用时退化为逐字段 meta.default，再不行给空对象并留痕 */
  #defaultsSnapshot() {
    if (this.schema) {
      try {
        const snap = this.schema({})
        if (isPlainObject(snap)) return snap
      } catch (err) {
        this.log('warn', `qdash-neo: 默认值快照解析失败，退化到 meta.default name=${err?.name} msg=${err?.message}`)
      }
    }
    const snap = {}
    for (const f of this.fields) {
      if (f.defaultValue !== undefined) setPath(snap, f.path, clone(f.defaultValue))
    }
    if (this.fields.length === 0) {
      // 安全方向：不知道默认值 ⇒ 认为没有字段被锁 ⇒ 全部可改，但必须留痕
      this.log('warn', 'qdash-neo: 拿不到配置 schema，所有字段按"可改"处理（锁图标不会出现）')
    }
    return snap
  }

  /** @returns {Map<string, true>} 被部署层锁住的字段路径 */
  #computeLocks() {
    const locks = new Map()
    for (const f of this.fields) {
      const fromBase = getPath(this.base, f.path)
      const fromDefault = getPath(this.defaults, f.path)
      if (!isDeepStrictEqual(fromBase, fromDefault)) locks.set(f.path, true)
    }
    return locks
  }

  /** 从 kv 恢复用户层与 revision */
  #load() {
    this.user.clear()
    if (!this.store) return
    for (const f of this.fields) {
      const raw = this.store.kvGet(`cfg:${f.path}`, null)
      if (raw == null) continue
      try {
        this.user.set(f.path, JSON.parse(raw))
      } catch (err) {
        // 坏值不该让控制台起不来，但必须看得见 —— 静默忽略会变成"改了没生效"
        this.log('warn', `qdash-neo: 用户层配置解析失败 ${f.path} name=${err?.name} msg=${err?.message}`)
      }
    }
    const rev = Number(this.store.kvGet('cfg:revision', '0'))
    this.revision = Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0
    const at = Number(this.store.kvGet('cfg:updatedAt', '0'))
    this.updatedAt = Number.isFinite(at) ? at : 0
  }

  /** 合并结果：base 为底，user 覆盖（锁字段以 base 为准） */
  effective() {
    const out = clone(this.base)
    for (const [path, value] of this.user) {
      if (this.locks.has(path)) continue
      setPath(out, path, clone(value))
    }
    return out
  }

  /** 单字段描述：值 + 来源 + 是否锁 + 是否需重启 */
  #fieldDesc(f) {
    const locked = this.locks.has(f.path)
    const hasUser = this.user.has(f.path)
    const baseValue = getPath(this.base, f.path)
    const value = locked || !hasUser ? baseValue : this.user.get(f.path)
    const desc = {
      path: f.path,
      key: f.key,
      // 中文显示名；null 时前端回落到 key
      label: f.label ?? null,
      type: f.type,
      description: f.description,
      applies: f.applies,
      // 多行文本框（系统提示这类多段落内容）
      multiline: Boolean(f.multiline),
      // provider/model 的候选值要前端另拉（schema 里没有），这里只透传来源标记
      optionsFrom: f.optionsFrom ?? null,
      // 静态建议值（可选手填），如思考强度
      suggest: f.suggest ?? null,
      locked,
      // 有用户值却不生效：这类"静默忽略"是最困惑的体验，必须显式回报
      ignoredByLock: locked && hasUser,
      source: locked ? 'deploy' : hasUser ? 'user' : 'default',
      defaultValue: f.defaultValue === undefined ? null : f.defaultValue,
    }
    if (f.options) desc.options = f.options
    if (f.secret) {
      // 密钥永不回显：只回答"设没设"
      const v = String(value ?? '')
      // 控制台口令可能来自 kv（首启生成），config 里是空的 ——
      // 不查一下就会显示"未设置"，而用户明明正在用它登录
      const fromKv =
        f.path === 'console.password' && this.store
          ? String(this.store.kvGet?.('console:password', '') ?? '') !== ''
          : false
      desc.hasValue = v !== '' || fromKv
      desc.type = 'secret'
    } else {
      desc.value = value === undefined ? null : value
    }
    return desc
  }

  /**
   * 给表单的完整描述。按 revision 缓存：叶子几十个，但轮询每 5s 一次，
   * 每次重算没意义。
   */
  describe() {
    if (this.#describeCache) return this.#describeCache

    /**
     * 按 `GROUP_LAYOUT` 重组呈现（**只动呈现层**：schema、落盘键、patch 路径都不变）。
     *
     * 之前是"A 段一个组"，于是出现：`onebot` 只剩 2 项、`agent` 里混着系统提示、
     * 限流散在 `policy` 与 `outbound` 两处、`judge` 15 项却默认用不上。现在按
     * 使用者的心智模型排：怎么连上 → 我是谁 → 用哪个模型 → 谁能让我说话 →
     * 别刷屏 → 怎么分段发 → 可选判定 → 记忆 → 控制台。
     */
    const byPath = new Map()
    for (const f of this.fields) {
      if (HIDDEN_FIELDS.has(f.path)) continue
      byPath.set(f.path, this.#fieldDesc(f))
    }

    const groups = []
    const used = new Set()
    for (const spec of GROUP_LAYOUT) {
      const picked = []
      for (const pattern of spec.paths) {
        if (pattern.endsWith('.*')) {
          const prefix = pattern.slice(0, -1)
          for (const [path, desc] of byPath) {
            if (used.has(path) || !path.startsWith(prefix)) continue
            used.add(path)
            picked.push(desc)
          }
          continue
        }
        const desc = byPath.get(pattern)
        if (!desc || used.has(pattern)) continue
        used.add(pattern)
        picked.push(desc)
      }
      if (picked.length) groups.push({ key: spec.key, label: spec.label, fields: picked })
    }

    // 没有被 layout 覆盖的字段：兜一个"其它"组，避免字段凭空消失
    const orphans = [...byPath.entries()].filter(([path]) => !used.has(path)).map(([, desc]) => desc)
    if (orphans.length) groups.push({ key: '_other', label: '其它', fields: orphans })

    this.#describeCache = {
      revision: this.revision,
      updatedAt: this.updatedAt,
      writable: this.writable,
      groups,
    }
    return this.#describeCache
  }

  /** 最近审计（store 没有该方法时返回空数组，不让控制台因此 500） */
  audit(limit = 20) {
    if (typeof this.store?.listConfigAudit !== 'function') return []
    try {
      return this.store.listConfigAudit(limit)
    } catch (err) {
      this.log('error', `qdash-neo: 读取配置审计失败 name=${err?.name} msg=${err?.message}`, err)
      return []
    }
  }

  // ---------------- 写面 ----------------

  /**
   * 保存用户层覆盖。
   *
   * @param {{ patch: Record<string, unknown>, revision?: number, actor?: string }} input
   * @returns {{ revision: number, changed: Array<{path: string, from: unknown, to: unknown}>, effective: object }}
   */
  update({ patch, revision, actor = '' } = {}) {
    if (!this.store) {
      throw new ConfigError('config-not-ready', '内核尚未就绪（store 还没打开），配置无法落盘', { status: 503 })
    }
    if (!isPlainObject(patch)) {
      throw new ConfigError('config-invalid', '请求体缺少 patch 对象（{ patch: { "a.b": 值 }, revision }）')
    }
    const expected = Number(revision)
    if (!Number.isFinite(expected) || Math.floor(expected) !== this.revision) {
      throw new ConfigError('config-conflict', `配置已被修改（当前 revision=${this.revision}），请刷新后重试`, {
        status: 409,
      })
    }

    const known = new Set(this.fields.map(f => f.path))
    if (Object.keys(patch).length === 0) {
      throw new ConfigError('config-invalid', 'patch 为空，没有要改的字段')
    }

    /**
     * 密钥字段的空串 = "不改"，不是"清空"。
     * 这一步必须在**锁校验之前**做：部署层写了 token 的字段本来就是锁的，
     * 表单把它当空串回传时应当被忽略，而不是报"这个字段改不了"。
     */
    const entries = Object.entries(patch).filter(([path, value]) => {
      const f = this.fields.find(x => x.path === path)
      return !(f?.secret && (value === '' || value == null))
    })
    // 全是"留空不改"的密钥字段：当作成功的空操作，不要报错 ——
    // 用户只是没重填口令，这不是他的错
    if (entries.length === 0) {
      return { revision: this.revision, changed: [], effective: this.effective() }
    }

    const unknown = entries.map(([p]) => p).filter(p => !known.has(p))
    if (unknown.length) {
      throw new ConfigError('config-unknown-field', `未知配置字段：${unknown.join(', ')}`, { fields: unknown })
    }

    const locked = entries.map(([p]) => p).filter(p => this.locks.has(p))
    if (locked.length) {
      throw new ConfigError(
        'config-locked',
        `这些字段由部署层（patch）指定，控制台改不了：${locked.join(', ')}`,
        { fields: locked },
      )
    }

    const before = this.effective()
    const candidate = clone(before)
    for (const [path, value] of entries) {
      setPath(candidate, path, value === undefined ? null : clone(value))
    }

    // 整份校验：单字段过不代表组合过（例如 quota 的两个数要一起看）
    let parsed
    try {
      parsed = this.schema ? this.schema(candidate) : candidate
    } catch (err) {
      throw new ConfigError('config-invalid', `配置校验失败：${err?.message ?? err?.name ?? '未知错误'}`)
    }

    const changed = []
    for (const [path] of entries) {
      const from = getPath(before, path)
      const to = getPath(parsed, path)
      if (!isDeepStrictEqual(from, to)) changed.push({ path, from, to })
    }
    if (changed.length === 0) {
      return { revision: this.revision, changed: [], effective: parsed }
    }

    for (const { path, to } of changed) {
      const defaultAtPath = getPath(this.defaults, path)
      if (isDeepStrictEqual(to, defaultAtPath)) {
        // 改回默认值 = 撤销覆盖，而不是存一份和默认值一样的垃圾
        this.user.delete(path)
        if (typeof this.store.kvDel === 'function') this.store.kvDel(`cfg:${path}`)
        else this.store.kvSet(`cfg:${path}`, '')
      } else {
        this.user.set(path, clone(to))
        this.store.kvSet(`cfg:${path}`, JSON.stringify(to))
      }
    }

    this.revision += 1
    this.updatedAt = Date.now()
    this.store.kvSet('cfg:revision', String(this.revision))
    this.store.kvSet('cfg:updatedAt', String(this.updatedAt))
    this.#describeCache = null

    const at = this.updatedAt
    if (typeof this.store.appendConfigAudit === 'function') {
      for (const c of changed) {
        try {
          // 密钥字段的审计只留"改过"这个事实，不留值 —— 审计表是给控制台看的，
          // 存明文等于把口令和 token 摊在页面上（之前确实这么漏过）
          const isSecret = Boolean(this.fields.find(f => f.path === c.path)?.secret)
          this.store.appendConfigAudit({
            at,
            path: c.path,
            fromValue: isSecret ? '"***"' : JSON.stringify(c.from ?? null),
            toValue: isSecret ? '"***"' : JSON.stringify(c.to ?? null),
            actor,
          })
        } catch (err) {
          // 审计失败不能挡住保存（配置已经落了），但必须留痕
          this.log('error', `qdash-neo: 写配置审计失败 ${c.path} name=${err?.name} msg=${err?.message}`, err)
        }
      }
    }
    this.log(
      'info',
      `qdash-neo: 配置已更新 revision=${this.revision} 字段=${changed.map(c => c.path).join(',')}${actor ? ` from=${actor}` : ''}`,
    )

    return { revision: this.revision, changed, effective: parsed }
  }
}
