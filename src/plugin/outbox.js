/**
 * 插件发消息的门面。
 *
 * 插件**不能**自己拼 OneBot 请求，必须走这条 —— 内核的出站队列在这里做了
 * 分条、限流（`perChatIntervalMs`）、死信重试、落库（`messages` 表）与审计。
 * 绕过去等于绕开全部这些，而且控制台里会看不到它发过什么。
 *
 * 为什么用 `forPlugin(name)` 而不是 `sendText({ plugin: 'x' })`：
 * **来源标记必须不可伪造**。审计里要能分清「这条是模型发的还是插件发的」，
 * 如果由调用方自己传名字，插件可以冒充内核工具，出事时查不到是谁。
 * 和 `storage.forFeature(name)` 是同一个思路。
 */

/** 插件名规则，和 storage / settings 保持一致 */
const NS_RE = /^[a-z][a-z0-9_]{0,31}$/

export class PluginOutbox {
  /**
   * @param {{
   *   deliver?: {
   *     text?: (chatKey: string, text: string, meta?: object) => any,
   *     segments?: (chatKey: string, segments: object[], meta?: object) => any,
   *   },
   * }} deps
   *   由 service 注入，分别指向 `enqueueOut` 与 `enqueueSegmentsOut`。
   */
  constructor({ deliver = {} } = {}) {
    this.deliver = deliver
  }

  /**
   * 取一个带来源标记的发送句柄。
   *
   * @param {string} plugin 插件自己的名字
   * @returns {{ sendText: Function, sendSegments: Function }}
   */
  forPlugin(plugin) {
    const p = String(plugin ?? '').trim()
    if (!NS_RE.test(p)) {
      throw new Error(`插件名「${p}」不合法：只允许小写字母开头、a-z0-9_、最长 32`)
    }
    /** 与内核工具的标记格式一致，控制台与日志里一眼能看出是谁发的 */
    const tag = `plugin:${p}`
    /**
     * 闭包捕获，不用 `this`。
     *
     * 返回的是普通对象字面量，方法简写里的 `this` 指向**那个句柄对象**，
     * 不是 `PluginOutbox` —— 写成 `this.deliver.text(...)` 会抛
     * `Cannot read property 'text' of undefined`，而错误位置看起来像调用方写错了。
     */
    const deliver = this.deliver ?? {}

    return {
      /**
       * 发一条文本。
       *
       * @param {{ chatKey: string, text: string }} req
       * @returns {{ ok: boolean, queued: boolean }}
       */
      sendText({ chatKey, text } = {}) {
        const key = String(chatKey ?? '').trim()
        const body = String(text ?? '').trim()
        if (!key) throw new Error('outbox.sendText 需要 chatKey')
        if (!body) throw new Error('outbox.sendText 需要非空 text')
        if (typeof deliver.text !== 'function') throw new Error('出站队列未就绪')
        deliver.text(key, body, { fromTool: tag })
        return { ok: true, queued: true }
      },

      /**
       * 发消息段（图片 / 语音 / 表情）。
       *
       * `text` 是**给人看的标签**（如 `[图片] 截图`），会写进 `messages`；
       * 不传的话落到 `[非文本消息]`，控制台里就只剩一行看不出内容的东西。
       *
       * @param {{ chatKey: string, segments: object[], text?: string }} req
       * @returns {{ ok: boolean, queued: boolean }}
       */
      sendSegments({ chatKey, segments, text } = {}) {
        const key = String(chatKey ?? '').trim()
        if (!key) throw new Error('outbox.sendSegments 需要 chatKey')
        if (!Array.isArray(segments) || segments.length === 0) {
          throw new Error('outbox.sendSegments 需要非空的 segments 数组')
        }
        if (typeof deliver.segments !== 'function') throw new Error('出站队列未就绪')
        deliver.segments(key, segments, {
          text: String(text ?? '').trim(),
          fromTool: tag,
        })
        return { ok: true, queued: true }
      },
    }
  }
}
