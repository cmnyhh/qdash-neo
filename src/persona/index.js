/**
 * 人格（角色卡）—— 插件层注入。
 *
 * 为什么不用 DSH 的 `@deepseek-ai/dsh-persona`：
 * 那套是 preset 里的静态配置，模型能看到、**插件读不到**。而判定层（judge）必须知道
 * "这个角色爱不爱接话"，否则通用判据「纯闲聊不该插话」会把一个本来话多的角色
 * 判成一潭死水（实测：纯闲聊 10 条 0 回复）。
 *
 * 一份人设，两条消费链路：
 *   - `card(chatKey)` 完整角色卡 → 拼进回复 prompt（模型的「我是谁」）
 *   - `hint(chatKey)` 给判定用   → 拼进判定 prompt（判定器的「他什么脾气」）
 *
 * **默认两边都给全文**：单一真相源，不会出现"改了角色卡忘了改摘要"这种
 * 判据按过期人格走的 bug —— 这类问题几乎查不出来。
 * `judgeHint` 是**可选优化**：只想在判定里放性格、不想带身世外貌时再配。
 *
 * 存储优先级：kv（控制台按群改） → 静态配置。默认关闭。
 */

import { PersonaCards, normalizeAliases } from './cards.js'

/** kv 里按群存人设的两把钥匙 */
const KV_CARD = chatKey => `persona:${chatKey}`
const KV_HINT = chatKey => `persona_hint:${chatKey}`

export class Persona {
  /**
   * @param {{ store?: object|null, config?: object|null, log?: Function }} [opts]
   */
  constructor({ store = null, config = null, log = () => {} } = {}) {
    this.store = store
    this.log = log
    /** 静态配置里的完整角色卡（配置兜底） */
    this.cardConfig = ''
    /** 静态配置里的性格摘要 */
    this.hintConfig = ''
    /** 兜底别名（配置层）。卡里写了别名时以卡为准 */
    this.aliasesConfig = []
    this.enabled = false
    /**
     * 卡库（多张角色卡 + 当前选中）。和静态配置的分工：
     * 卡库是"运行期偏好"，config 是"部署层兜底"，同一时刻只有一处生效。
     */
    this.book = new PersonaCards({ store, log })
    this.applyConfig(config)
  }

  /** 热更新（控制台改配置后调） */
  applyConfig(config) {
    const c = config?.persona ?? {}
    this.enabled = c.enabled === true
    this.cardConfig = String(c.text ?? '').trim()
    this.hintConfig = String(c.judgeHint ?? '').trim()
    // 兜底别名：没选卡（或卡里没写别名）时才用它
    this.aliasesConfig = normalizeAliases(config?.identity?.aliases ?? [], this.log)
    return this
  }

  /**
   * "机器人还叫什么" —— 跟随当前人格卡。
   *
   * 为什么不看 `enabled`：别名决定的是**路由**（叫到名字就走直接回复），
   * 与人设内容无关。关掉人格只该停掉 prompt 注入，不该让"叫名字"失效。
   *
   * @param {string} [chatKey] 目前别名不按会话区分，留着参数是为了和 card/hint 同形
   * @returns {string[]}
   */
  aliases() {
    const active = this.book.activeCard()
    if (active?.aliases?.length) return [...active.aliases]
    return [...(this.aliasesConfig ?? [])]
  }

  /**
   * 完整角色卡，给回复链路。
   * @param {string} chatKey
   * @returns {string} 关闭或没配时返回空串
   */
  card(chatKey) {
    if (!this.enabled) return ''
    // 优先级：按群覆盖 → 当前人格卡 → 部署层静态人设
    const stored = this.readKv(KV_CARD(chatKey))
    if (stored) return stored
    const active = this.book.activeCard()
    if (active?.text) return active.text
    return this.cardConfig
  }

  /**
   * 性格摘要，给判定链路。
   * @param {string} chatKey
   * @returns {string} 没配摘要时直接用角色卡全文（单一真相源）
   */
  hint(chatKey) {
    if (!this.enabled) return ''
    const stored = this.readKv(KV_HINT(chatKey))
    if (stored) return stored
    const active = this.book.activeCard()
    if (active?.hint) return active.hint
    if (this.hintConfig) return this.hintConfig
    // 默认用全文：单一真相源。摘要是可选优化，不配就不存在"摘要过期"的风险
    return this.card(chatKey)
  }

  /**
   * 控制台写入。空字符串表示清掉这一项（回落到静态配置）。
   * @param {string} chatKey @param {string} card @param {string} [hint]
   * @returns {boolean} 是否写成功
   */
  set(chatKey, card, hint = '') {
    if (!this.store || typeof this.store.kvSet !== 'function') return false
    try {
      this.store.kvSet(KV_CARD(chatKey), String(card ?? ''))
      this.store.kvSet(KV_HINT(chatKey), String(hint ?? ''))
      return true
    } catch (err) {
      this.log('error', `qdash-neo: 写入人设失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
      return false
    }
  }

  /** 清掉这个群的覆盖值（回落到静态配置） */
  clear(chatKey) {
    return this.set(chatKey, '', '')
  }

  /** 控制台 / 状态用：这个群实际生效的人设 */
  snapshot(chatKey) {
    const card = this.card(chatKey)
    const hint = this.hint(chatKey)
    const active = this.book.activeCard()
    let source = 'none'
    if (this.readKv(KV_CARD(chatKey))) source = 'kv'
    else if (active?.text) source = 'card'
    else if (card) source = 'config'
    return {
      enabled: this.enabled,
      hasCard: Boolean(card),
      cardChars: card.length,
      hint,
      source,
      activeId: active?.id ?? '',
      activeName: active?.name ?? '',
      cardCount: this.book.all().length,
    }
  }

  /** @param {string} key */
  readKv(key) {
    if (!this.store || typeof this.store.kvGet !== 'function') return ''
    try {
      return String(this.store.kvGet(key, '') ?? '').trim()
    } catch (err) {
      // 读不出来就当没配 —— 但必须留痕，静默降级是原项目吃了苦头的坑
      this.log('error', `qdash-neo: 读取人设失败 ${key} name=${err?.name} msg=${err?.message}`, err)
      return ''
    }
  }
}
