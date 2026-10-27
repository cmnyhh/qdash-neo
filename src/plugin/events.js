/**
 * 插件可订阅的内核事件。
 *
 * **只读**：监听器不能阻断、不能改写事件，也不能影响主流程。要介入必须走
 * `tools.register()`（加能力）或 `voice.hooks.onSendVoice`（改发送行为）。
 *
 * 为什么这么设计：事件是**旁听**用的。一旦允许在事件里返回 false 阻断消息，
 * 插件就成了消息处理链的一环，那么"某个插件装坏导致所有消息不回"就只是时间问题。
 */

/** 可用事件。新增时同步 docs，否则插件作者只能靠猜 */
export const PLUGIN_EVENTS = ['message/inbound', 'message/dropped', 'turn/end']

const EVENT_SET = new Set(PLUGIN_EVENTS)

export class PluginEvents {
  /** @param {{ log?: Function }} [deps] */
  constructor({ log = () => {} } = {}) {
    this.log = log
    /** @type {Map<string, Set<Function>>} event → handlers */
    this.handlers = new Map()
    /** 统计：控制台排查"我的插件为什么没收到事件"时能看到 */
    this.emitted = 0
  }

  /**
   * 订阅一个事件。
   *
   * @param {string} event `message/inbound` / `message/dropped` / `turn/end`
   * @param {(payload: object) => any} handler
   * @returns {() => void} 取消订阅
   */
  on(event, handler) {
    const name = String(event ?? '').trim()
    /**
     * 未知事件直接报错，而不是静默接受。
     * 静默的话，插件写错名字会表现为"监听器从来不触发"，而这种问题
     * 几乎不会被怀疑到拼写上 —— 只会去猜"是不是内核没发这个事件"。
     */
    if (!EVENT_SET.has(name)) {
      throw new Error(`不支持的事件「${name}」，可用：${PLUGIN_EVENTS.join(', ')}`)
    }
    if (typeof handler !== 'function') throw new Error('监听器必须是函数')

    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name).add(handler)

    return () => {
      this.handlers.get(name)?.delete(handler)
    }
  }

  /**
   * 发事件。**同步调用、fire-and-forget**。
   *
   * 监听器抛错一律吞掉并记 warn —— 一个坏插件不该让机器人停止收消息。
   * 异步监听器返回的 Promise 也挂 catch，否则会变成 unhandledRejection 把宿主带走。
   *
   * @param {string} event
   * @param {object} payload
   * @returns {number} **成功**通知了几个监听器（抛错的不算 —— 那个数才是"有多少插件
   *   真的看到了这条消息"）
   */
  emit(event, payload) {
    const set = this.handlers.get(event)
    if (!set || set.size === 0) return 0

    this.emitted += 1
    let count = 0

    // 复制一份再遍历：监听器里调 off() 时不会打乱迭代
    for (const fn of [...set]) {
      try {
        const ret = fn(payload)
        if (ret && typeof ret.catch === 'function') {
          ret.catch(err => this.#warn(event, err))
        }
        count += 1
      } catch (err) {
        this.#warn(event, err)
      }
    }
    return count
  }

  /** 当前订阅数（控制台/测试用） */
  size(event = null) {
    if (event) return this.handlers.get(event)?.size ?? 0
    let n = 0
    for (const set of this.handlers.values()) n += set.size
    return n
  }

  #warn(event, err) {
    this.log(
      'warn',
      `qdash-neo: 事件监听器出错 event=${event} name=${err?.name} msg=${err?.message}`,
    )
  }
}
