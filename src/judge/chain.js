/**
 * 判定链 —— 群消息「要不要说话」的唯一决策点。
 *
 * 编排顺序（每一层都能独立否决，且**任何异常都归到 silent**）：
 *
 *   启发式 ── reply  ────────────────────────→ 返回 reply（@ / 叫名字，确定性信号）
 *        ├── silent ────────────────────────→ 返回 silent（空/过短）
 *        └── unsure → 成本闸（频控/冷却）→ 模型判定 → 阈值分档 → reply / silent
 *
 * 三条不可动摇的约束：
 *   1. **宁可沉默不可乱回**：超时、解析失败、没有 provider、频控命中 —— 全部 silent，
 *      并把原因落进 `judgements` 表，控制台以后要能看见"为什么没回"。
 *   2. **判定自身的钱单独记**：`usage.stage='judge'`，不和回答混在一起。
 *   3. 不抛异常给调用方（service 的串行链不该被判定拖垮），但**必须留痕**。
 */
import { REASON } from '../pipeline/gates.js'
import { heuristic, heuristicBatch } from './heuristics.js'
import { JudgeParseError, JudgeTimeoutError, llmJudge } from './llm.js'

/**
 * @typedef {object} Judgement
 * @property {'reply'|'silent'|'defer'} verdict
 *   `defer` = 判定层放弃决定权，交给对话层（只有 `judge.onUnsure='agent'` 会产生）
 * @property {number} score
 * @property {string} reason
 * @property {'heuristic'|'llm'} layer
 * @property {number} [costMs]
 * @property {string} [memory] 模型顺手记下的一句话（只有 llm 层会有）
 */

function clamp01(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

export class JudgeChain {
  /**
   * @param {object} ctx DSH 上下文（需要 `ctx.llm`）
   * @param {{ config: object, log: Function, store?: object, now?: () => number }} deps
   */
  constructor(ctx, { config, log, store = null, now = Date.now }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.store = store
    this.now = now

    this.applyConfig(config)

    /** @type {string[]} 机器人自己的昵称，由 service 从 get_login_info 注入 */
    this.botNames = []
    /** @type {Map<string, number[]>} chatKey → 模型判定调用时间戳（成本闸） */
    this.calls = new Map()
    /** @type {Map<string, number>} chatKey → 冷却截止时间（上一次判定失败） */
    this.cooldownUntil = new Map()
    this.stats = { total: 0, reply: 0, silent: 0, llmCalls: 0, llmErrors: 0, rateLimited: 0, batched: 0 }
  }

  /** 控制台热更新：阈值/超时/频控改了立刻生效，不动已有的调用计数与冷却 */
  applyConfig(config) {
    this.config = config
    const jc = config?.judge ?? {}
    this.enabled = jc.enabled !== false

    // onUnsure 三态。空值与非法值都退回默认的 agent 并留痕 —— 配置写错不该静默改变行为
    const raw = String(jc.onUnsure ?? '').trim().toLowerCase()
    if (!raw) {
      this.onUnsure = 'agent'
    } else if (raw === 'llm' || raw === 'agent' || raw === 'silent') {
      this.onUnsure = raw
    } else {
      this.onUnsure = 'agent'
      this.log('warn', `qdash-neo: judge.onUnsure 取值非法（${raw}），按 agent 处理`)
    }

    this.threshold = clamp01(jc.threshold, 0.6)
    this.timeoutMs = Number.isFinite(jc.timeoutMs) ? jc.timeoutMs : 8000
    this.maxPerMinute = Number.isFinite(jc.maxPerMinute) ? jc.maxPerMinute : 6
    this.errorCooldownMs = Number.isFinite(jc.errorCooldownMs) ? jc.errorCooldownMs : 60_000
  }

  setBotNames(names) {
    this.botNames = [...new Set((names ?? []).map(n => String(n ?? '').trim()).filter(n => n.length >= 2))]
  }

  /** 模型层是否可用（缺 provider/model 时不能硬调，否则每条都是一次报错） */
  available() {
    if (!this.enabled) return { ok: false, reason: REASON.JUDGE_DISABLED, note: '判定器已关闭（judge.enabled=false）' }
    const provider = this.config?.judge?.provider || this.config?.agent?.provider
    const model = this.config?.judge?.model || this.config?.agent?.model
    const hasLlm = typeof this.ctx?.llm?.stream === 'function'
    if (!hasLlm || !provider || !model) {
      return {
        ok: false,
        reason: REASON.JUDGE_UNAVAILABLE,
        note: `判定器不可用 llm=${hasLlm} provider=${provider || '(空)'} model=${model || '(空)'}`,
      }
    }
    return { ok: true }
  }

  /**
   * 成本闸：滑窗频控 + 失败冷却。命中就**不进模型**，直接静默。
   * @param {string} chatKey
   * @returns {{ ok: boolean, reason?: string, note?: string }}
   */
  costGate(chatKey) {
    const t = this.now()
    const until = this.cooldownUntil.get(chatKey) ?? 0
    if (until > t) {
      return {
        ok: false,
        reason: REASON.JUDGE_ERROR,
        note: `判定失败冷却中，还剩 ${Math.ceil((until - t) / 1000)}s`,
      }
    }

    if (this.maxPerMinute > 0) {
      const hits = (this.calls.get(chatKey) ?? []).filter(ts => t - ts < 60_000)
      if (hits.length >= this.maxPerMinute) {
        this.calls.set(chatKey, hits)
        return {
          ok: false,
          reason: REASON.JUDGE_RATE_LIMITED,
          note: `每分钟最多判定 ${this.maxPerMinute} 次，本条未判`,
        }
      }
      hits.push(t)
      this.calls.set(chatKey, hits)
    }
    return { ok: true }
  }

  /**
   * @param {{ inbound: object, contextText?: string, batch?: object[]|null, personaHint?: string }} input
   *   `batch` 有值表示这是批窗口攒起来的**一串连续发言**，只产出一个结论。
   *   `personaHint` 是性格摘要：有它时判据从"通用管家"切成"这个角色想不想接话"。
   * @returns {Promise<Judgement>}
   */
  async decide({ inbound, contextText = '', batch = null, personaHint = '' }) {
    const grouped = Array.isArray(batch) && batch.length > 0
    const h = grouped
      ? heuristicBatch({ batch, config: this.config, botNames: this.botNames })
      : heuristic({ inbound, config: this.config, botNames: this.botNames })
    const meta = {
      batchSize: grouped ? batch.length : 1,
      msgIds: grouped ? batch.map(e => e.messageId).filter(Boolean) : [inbound.messageId].filter(Boolean),
    }
    const prefix = grouped && batch.length > 1 ? `批次 ${batch.length} 条：` : ''

    // 确定性信号：不需要花钱，也不需要阈值（heuristicBatch 的 reason 已带"第几条"）
    if (h.verdict !== 'unsure') {
      return this.commit(inbound, { ...h, costMs: 0 }, meta)
    }

    // 判定器整体关掉 → 一律不回。这是保守默认，优先于 onUnsure
    if (!this.enabled) {
      return this.commit(
        inbound,
        {
          verdict: 'silent',
          score: h.score,
          reason: `${prefix}判定器已关闭（judge.enabled=false）`,
          layer: 'heuristic',
          costMs: 0,
          code: REASON.JUDGE_DISABLED,
        },
        meta,
      )
    }

    // 模型层不参与时，决定权往哪走。放在 available() 之前：
    // 这两种模式本来就不需要 provider/model，不该被"判定器不可用"拦下。
    if (this.onUnsure === 'agent') {
      return this.commit(
        inbound,
        {
          verdict: 'defer',
          score: h.score,
          reason: `${prefix}启发式不确定，交给对话层自决`,
          layer: 'heuristic',
          costMs: 0,
          code: REASON.DEFER_TO_AGENT,
        },
        meta,
      )
    }
    if (this.onUnsure === 'silent') {
      return this.commit(
        inbound,
        {
          verdict: 'silent',
          score: h.score,
          reason: `${prefix}启发式不确定，按配置一律不回`,
          layer: 'heuristic',
          costMs: 0,
          code: REASON.ON_UNSURE_SILENT,
        },
        meta,
      )
    }

    const usable = this.available()
    if (!usable.ok) {
      return this.commit(
        inbound,
        { verdict: 'silent', score: h.score, reason: `${prefix}${usable.note}`, layer: 'heuristic', costMs: 0, code: usable.reason },
        meta,
      )
    }

    const gate = this.costGate(inbound.chatKey)
    if (!gate.ok) {
      return this.commit(
        inbound,
        { verdict: 'silent', score: h.score, reason: `${prefix}${gate.note}`, layer: 'heuristic', costMs: 0, code: gate.reason },
        meta,
      )
    }

    const started = this.now()
    try {
      const res = await llmJudge(this.ctx, {
        inbound,
        contextText,
        botNames: this.botNames,
        batch: grouped ? batch : [],
        config: this.config,
        log: this.log,
        personaHint,
      })
      this.stats.llmCalls += 1

      // 阈值分档：模型说"该回"但分数不够，仍然沉默（保守优先）
      const verdict = res.verdict === 'reply' && res.score >= this.threshold ? 'reply' : 'silent'
      const note = res.verdict === 'reply' && verdict === 'silent'
        ? `${res.reason || '模型倾向回复'}（分数 ${res.score.toFixed(2)} < 阈值 ${this.threshold}）`
        : res.reason || `模型分数 ${res.score.toFixed(2)}`

      this.recordUsage(inbound.chatKey, res.usage, res.costMs ?? this.now() - started)
      return this.commit(
        inbound,
        {
          verdict,
          score: res.score,
          reason: `${prefix}${note}`,
          layer: 'llm',
          costMs: res.costMs ?? this.now() - started,
          memory: res.memory ?? '',
        },
        meta,
      )
    } catch (err) {
      this.stats.llmErrors += 1
      // 冷却只给"持续性问题"（超时 / 传输 / 流错误 / 截断）：
      // 一次空输出或半截 JSON 可能只是网关抽风，让整群静默 60s 的代价比再判一次大得多。
      // 花费这边有 maxPerMinute 兜着，不靠冷却。
      if (!(err instanceof JudgeParseError)) {
        this.cooldownUntil.set(inbound.chatKey, this.now() + this.errorCooldownMs)
      }
      const kind = err instanceof JudgeTimeoutError ? '超时' : '失败'
      const note = `判定${kind}：${err?.name ?? 'Error'} ${err?.message ?? String(err)}`
      this.log('warn', `qdash-neo: ${note} ${inbound.chatKey} msg=${inbound.messageId} batch=${meta.batchSize}`)
      return this.commit(
        inbound,
        {
          verdict: 'silent',
          score: h.score,
          reason: `${prefix}${note}`,
          layer: 'llm',
          costMs: this.now() - started,
          code: REASON.JUDGE_ERROR,
        },
        meta,
      )
    }
  }

  /**
   * 批窗口一次判定多条。`inbound` 是这一批的**代表消息**（最后一条 / 其中被 @ 的那条），
   * 回复也回给它 —— 模型看到的却是整串发言，不会答非所问。
   * @param {{ inbound: object, batch: object[], contextText?: string, personaHint?: string }} input
   */
  async decideBatch({ inbound, batch, contextText = '', personaHint = '' }) {
    return this.decide({ inbound, contextText, batch, personaHint })
  }

  /** 判定自身的花费单独记账（stage='judge'），不和回答混在一起 */
  recordUsage(chatKey, usage, costMs) {
    if (!this.store || !usage) return
    try {
      this.store.recordUsage({
        chatKey,
        model: this.config?.judge?.model || this.config?.agent?.model || '',
        provider: this.config?.judge?.provider || this.config?.agent?.provider || '',
        inTokens: usage.inputTokens ?? 0,
        outTokens: usage.outputTokens ?? 0,
        stage: 'judge',
      })
    } catch (err) {
      this.log('error', `qdash-neo: 判定 usage 落库失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
    }
  }

  /**
   * 落库 + 一行结论。判定结果必须可查，这是"为什么没回"的唯一线索。
   * @param {object} inbound
   * @param {Judgement & { code?: string }} j
   * @param {{ batchSize?: number, msgIds?: string[] }} [meta] 一次判定覆盖了哪几条消息
   * @returns {Judgement}
   */
  commit(inbound, j, meta = {}) {
    const batchSize = meta.batchSize ?? 1
    this.stats.total += 1
    this.stats[j.verdict] += 1
    if (batchSize > 1) this.stats.batched += 1
    if (j.costMs && j.costMs > 0) this.stats.lastCostMs = j.costMs

    if (this.store) {
      try {
        this.store.recordJudgement({
          chatKey: inbound.chatKey,
          qqMsgId: inbound.messageId || null,
          layer: j.layer,
          verdict: j.verdict,
          score: Number.isFinite(j.score) ? j.score : null,
          reason: j.reason ?? '',
          code: j.code ?? null,
          costMs: Number.isFinite(j.costMs) ? j.costMs : null,
          batchSize,
          msgIds: meta.msgIds ?? null,
        })
      } catch (err) {
        this.log('error', `qdash-neo: 判定落库失败 ${inbound.chatKey} msg=${inbound.messageId} name=${err?.name} msg=${err?.message}`, err)
      }
    }

    const score = Number.isFinite(j.score) ? j.score.toFixed(2) : '?'
    const line = `qdash-neo: 判定 ${inbound.chatKey} msg=${inbound.messageId} -> ${j.verdict} layer=${j.layer} score=${score} 原因=${j.reason}${j.code ? ` code=${j.code}` : ''}`
    if (j.verdict === 'reply') this.log('info', line)
    else this.log('debug', line)

    return {
      verdict: j.verdict, score: j.score, reason: j.reason ?? '', code: j.code ?? '',
      layer: j.layer, costMs: j.costMs, memory: j.memory ?? '',
    }
  }

  /** 判定的运行时快照，service.status() 用 */
  snapshot() {
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      available: this.available().ok,
      botNames: [...this.botNames],
      ...this.stats,
    }
  }
}
