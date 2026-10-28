/**
 * 入站闸门，拆成两段：
 *
 *   ingest  —— **能不能听见**（去重 / 群开关 / 空消息）。白名单不在这里拦，
 *              否则判定拿不到语境：群里其他人说的话必须进上下文缓冲。
 *   trigger —— **可能开口吗**（白名单 / @ 要求 / 限流 / 回复配额）。
 *
 * 两段的 reason 都落库（`dropped:<reason>`），这样"为什么没回"永远查得到。
 * 纯逻辑 + 可注入时钟，不在这里做任何 I/O，方便单测。
 */

export const REASON = {
  // ingest
  DUPLICATE: 'duplicate',
  GROUP_DISABLED: 'group-disabled',
  GROUP_NOT_ALLOWED: 'group-not-allowed',
  EMPTY: 'empty',
  // trigger
  WHITELIST_EMPTY: 'whitelist-empty',
  NOT_WHITELISTED: 'not-whitelisted',
  NOT_MENTIONED: 'not-mentioned',
  RATE_LIMITED: 'rate-limited',
  QUOTA_EXCEEDED: 'quota-exceeded',
  /** 会话在沉睡期（模型自己要求休息，或配置的随机沉睡） */
  SLEEPING: 'sleeping',
  /** 过了所有闸门，但被 `policy.replyChance` 掷掉了 */
  SKIPPED_BY_CHANCE: 'skipped-by-chance',
  // judge
  JUDGE_SILENT: 'judge-silent',
  JUDGE_ERROR: 'judge-error',
  JUDGE_DISABLED: 'judge-disabled',
  JUDGE_UNAVAILABLE: 'judge-unavailable',
  JUDGE_RATE_LIMITED: 'judge-rate-limited',
  /** 启发式不确定，但配置要求交给对话层自决（judge.onUnsure='agent'） */
  DEFER_TO_AGENT: 'defer-to-agent',
  /** 启发式不确定，配置要求一律不回（judge.onUnsure='silent'） */
  ON_UNSURE_SILENT: 'on-unsure-silent',
}

const DEDUPE_TTL_MS = 10 * 60 * 1000
const DEDUPE_MAX = 2000

/** 称呼去重 + 下限 2 字：单字别名（如"白"）几乎命中所有句子，等于关掉 mention 档 */
const normalizeNames = names =>
  [...new Set((names ?? []).map(n => String(n ?? '').trim()).filter(n => n.length >= 2))]

export class Gates {
  /**
   * @param {object} config 插件 Config
   * @param {{ now?: () => number }} [deps] 注入时钟，测试用
   */
  constructor(config, { now = Date.now } = {}) {
    this.now = now

    /** @type {Map<string, number>} messageId → 首次见到的时间 */
    this.seen = new Map()
    /** @type {Map<string, number[]>} chatKey → 放行时间戳（分钟级限流） */
    this.passes = new Map()
    /** @type {Map<string, number[]>} chatKey → 真正开口的时间戳（回复配额） */
    this.replies = new Map()
    /** @type {string[]} 运行时昵称（get_login_info 之后才有） */
    this.botNames = []
    /** @type {string[]} 配置里的 `identity.aliases` */
    this.aliases = []
    /** @type {string[]} 上面两者的并集，`mention` 档判断"是不是在叫我"用 */
    this.names = []

    this.applyConfig(config)
  }

  /**
   * 控制台热更新用：只换策略参数，**不动**已有计数
   * （去重表、限流窗口、回复配额都是运行时事实，重置等于给用户"清零重来"的后门）。
   * @param {object} config
   */
  applyConfig(config) {
    const policy = config?.policy ?? {}
    this.config = config
    this.whitelist = new Set((policy.whitelist ?? []).map(String))
    /** `*` = 开发期全放行（会打 warn）。空数组才是"一条都不回"的默认安全态 */
    this.allowAll = this.whitelist.has('*')
    this.groupEnabled = policy.groupEnabled === true
    /** 群号白名单：空 = 机器人所在的群都允许说话（前提是 groupEnabled） */
    this.groupWhitelist = new Set((policy.groupWhitelist ?? []).map(String))
    /**
     * 群内触发策略三档：mention（默认，安全）/ all / judge。
     * 值非法时回落到旧的 groupMentionOnly，避免旧 patch 静默失效。
     * @type {'mention'|'all'|'judge'}
     */
    /**
     * 四档：mention / all / judge / **agent**。
     *
     * `agent` = 不判定，群消息直接交给对话层自决（模型用 SILENT_MARKER 表达"不说"）。
     * 这一档的存在理由：独立 LLM 判定层先不上时，"要不要接话"由模型在**同一次调用**里
     * 判断并输出，省掉一次额外请求，也避免判定与回复口径不一致。
     */
    this.groupTrigger = ['mention', 'all', 'judge', 'agent'].includes(policy.groupTrigger)
      ? policy.groupTrigger
      : policy.groupMentionOnly === false
        ? 'all'
        : 'mention'
    this.ratePerMinute = Number.isFinite(policy.ratePerMinute) ? policy.ratePerMinute : 20
    this.quotaWindowMs = (Number.isFinite(policy.groupReplyQuota?.windowMinutes) ? policy.groupReplyQuota.windowMinutes : 10) * 60_000
    this.quotaMax = Number.isFinite(policy.groupReplyQuota?.maxReplies) ? policy.groupReplyQuota.maxReplies : 3

    // 别名来自配置，热更新立刻生效；运行时昵称由 service 在登录后 setBotNames 注入
    this.aliases = normalizeNames(config?.identity?.aliases)
    this.refreshNames()
  }

  /**
   * 登录昵称 / QQ 号注入。和 `identity.aliases` 合并成"被点名"的全集。
   * **judge 必须拿到同一份名单**，否则会出现"闸门放进来、判定却判成 unsure"的白花钱。
   * @param {string[]} names
   */
  setBotNames(names) {
    this.botNames = normalizeNames(names)
    this.refreshNames()
    return this
  }

  refreshNames() {
    this.names = [...new Set([...this.botNames, ...this.aliases])]
  }

  /**
   * 这条消息有没有叫机器人的名字。
   * @param {string} text
   * @returns {string} 命中的称呼，没命中返回空串
   */
  named(text) {
    const t = String(text ?? '')
    if (!t) return ''
    return this.names.find(n => t.includes(n)) ?? ''
  }

  /**
   * 第一段：这条消息值不值得进上下文。
   * @param {import('../onebot/normalize.js').Inbound} ev
   * @returns {{ ok: boolean, reason?: string, note?: string }}
   */
  ingest(ev) {
    const t = this.now()

    // 去重最先做：QQ 侧重发、多实例同时收，都会撞这里
    if (ev.messageId) {
      if (this.seen.has(ev.messageId)) return { ok: false, reason: REASON.DUPLICATE }
      this.remember(ev.messageId, t)
    }

    if (ev.kind === 'group') {
      if (!this.groupEnabled) return { ok: false, reason: REASON.GROUP_DISABLED }
      if (this.groupWhitelist.size > 0 && !this.groupWhitelist.has(String(ev.groupId ?? ''))) {
        return { ok: false, reason: REASON.GROUP_NOT_ALLOWED, note: `群 ${ev.groupId} 不在群白名单` }
      }
    }

    /**
     * **纯图片、纯 @ 都算"有内容"。**
     *
     * 早先这里只放行了图片，于是「只 @ 了某个人、一个字没说」的消息
     * 被当成空消息丢掉 —— 而那条消息的语义很明确：**在叫别人，不是在叫它**。
     *
     * 丢掉它的后果是模型看不到这次 @：
     *   - 「@黑色、影」单独发 → 整条消失
     *   - 连带上一条的语境一起断掉，看起来像"有人莫名不说话"
     */
    const hasAt = Boolean(ev.atMe) || (Array.isArray(ev.atTargets) && ev.atTargets.length > 0)
    if (!ev.text && !ev.hasImage && !hasAt) {
      return { ok: false, reason: REASON.EMPTY }
    }

    return { ok: true }
  }

  /**
   * 第二段：可能开口吗。
   *
   * **白名单的语义**（三段不同，容易记混，这里一次写清）：
   *   - 私聊：白名单决定回不回，空 = 一条都不回
   *   - 群 `mention`：@ 就回，不看白名单（否则群里只有主人 @ 才有用）
   *   - 群 `all`：只回白名单成员（"每句都回"的主语是白名单成员，不是群里所有人）
   *   - 群 `judge`：谁说的不重要，由判定按语境决定
   * 这条语义变化写在 docs/qdash-neo/03-内核实现要点.md §2。
   *
   * @param {import('../onebot/normalize.js').Inbound} ev
   * @param {{ requireMention?: boolean }} [opts] 默认按 `groupTrigger` 推导；测试可显式覆盖
   * @returns {{ ok: boolean, reason?: string, note?: string }}
   */
  trigger(ev, { requireMention = this.groupTrigger === 'mention' } = {}) {
    const t = this.now()

    if (ev.kind === 'private') {
      // 白名单为空时一条都不回，但必须把原因写清楚（原项目"静默不响应"排查了两天）
      if (this.whitelist.size === 0) {
        return { ok: false, reason: REASON.WHITELIST_EMPTY, note: '白名单为空，当前不响应任何私聊' }
      }
      if (!this.allowAll && !this.whitelist.has(ev.userId)) {
        return { ok: false, reason: REASON.NOT_WHITELISTED, note: `sender ${ev.userId} 不在白名单` }
      }
    }

    if (ev.kind === 'group') {
      if (requireMention) {
        // 「叫名字」和「@」都是确定性的点名信号：放进来之后启发式直接给 reply，
        // 不会产生模型调用。差别只在时序强度 —— @ 会提前封口批窗口，别名不会
        // （见 service.enqueueBatch）：叫一声未必是专门找它，插话把握比 @ 小。
        if (!ev.atMe && !this.named(ev.text)) {
          return { ok: false, reason: REASON.NOT_MENTIONED, note: '既没 @ 也没叫它的名字' }
        }
      }
      /**
       * all 档不再要求"个人也在白名单里"，**前提是群被显式加白**。
       *
       * 之前的写法是 `all` 一律要求 `policy.whitelist.has(userId)`，于是
       * "群已经加白了，还要把每个人再单独加一遍" —— 同一个意图配两处，
       * 而且用户根本想不到个人白名单会作用在群里（它本来是私聊白名单）。
       *
       * 安全边界保留在另一半：`groupWhitelist` **为空**时（= 机器人所在的群全放行）
       * 仍然要求个人白名单，否则"所有群 + all"就是一台刷屏机器。
       * 到这一步时 ingest 已经保证：groupWhitelist 非空 ⇒ 当前群必然命中。
       */
      const groupExplicitlyAllowed = this.groupWhitelist.size > 0
      if (
        this.groupTrigger === 'all' &&
        !this.allowAll &&
        !groupExplicitlyAllowed &&
        !this.whitelist.has(ev.userId)
      ) {
        return {
          ok: false,
          reason: REASON.NOT_WHITELISTED,
          note: 'groupTrigger=all 未配群白名单时只回私聊白名单里的成员（加群白名单即可全群生效）',
        }
      }
      if (!this.allowReply(ev.chatKey)) {
        return {
          ok: false,
          reason: REASON.QUOTA_EXCEEDED,
          note: `${this.quotaWindowMs / 60_000} 分钟内已开口 ${this.quotaMax} 次`,
        }
      }
    }

    if (this.ratePerMinute > 0) {
      const hits = (this.passes.get(ev.chatKey) ?? []).filter(ts => t - ts < 60_000)
      if (hits.length >= this.ratePerMinute) {
        this.passes.set(ev.chatKey, hits)
        return { ok: false, reason: REASON.RATE_LIMITED }
      }
      hits.push(t)
      this.passes.set(ev.chatKey, hits)
    }

    return { ok: true }
  }

  /** 配额检查（只对群生效；私聊不该被限到 3 条/10 分钟） */
  allowReply(chatKey) {
    if (this.quotaMax <= 0) return true
    const t = this.now()
    const hits = (this.replies.get(chatKey) ?? []).filter(ts => t - ts < this.quotaWindowMs)
    this.replies.set(chatKey, hits)
    return hits.length < this.quotaMax
  }

  /**
   * 记一次开口。
   * 注意记的是"允许模型说话"的次数，不是发出的消息条数 ——
   * 一轮回复可能被 M2 的分条拆成多条，按条数计会让配额随分条规则漂移。
   */
  recordReply(chatKey) {
    const hits = this.replies.get(chatKey) ?? []
    hits.push(this.now())
    this.replies.set(chatKey, hits)
  }

  remember(key, t) {
    this.seen.set(key, t)
    if (this.seen.size <= DEDUPE_MAX) return
    // 环形淘汰：删掉最老的一批，避免无界增长
    const overflow = this.seen.size - DEDUPE_MAX
    let i = 0
    for (const k of this.seen.keys()) {
      this.seen.delete(k)
      if (++i >= overflow) break
    }
  }

  /** 清掉过期记录，长时间运行时由 service 定时调用 */
  sweep() {
    const t = this.now()
    for (const [k, ts] of this.seen) if (t - ts > DEDUPE_TTL_MS) this.seen.delete(k)
    for (const [k, hits] of this.passes) {
      const alive = hits.filter(ts => t - ts < 60_000)
      if (alive.length) this.passes.set(k, alive)
      else this.passes.delete(k)
    }
    for (const [k, hits] of this.replies) {
      const alive = hits.filter(ts => t - ts < this.quotaWindowMs)
      if (alive.length) this.replies.set(k, alive)
      else this.replies.delete(k)
    }
  }
}
