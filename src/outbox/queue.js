/**
 * 出站队列（M2 版）。
 *
 * 队列本身**只管一条一条发**，不认识"分条"这件事：一次回复拆成几条是调用方
 * （service.onAssistant → planReply）决定的，每条各自入队、各自落库、各自结算。
 * 这样每个分片在 messages 表里都有自己的状态，控制台才看得出"第 3 片死了"；
 * 若在队列内部拆，服务层只能事后补行，会出现"已经发出去、库里还没有这一行"的缺口。
 *
 * 保留的约束：
 *   - 同 chat 串行，间隔 ≥ perChatIntervalMs（默认 1200ms）
 *   - 全局并发上限
 *   - 失败退避 1s → 4s → 15s，3 次进死信；**死信不清空**
 *
 * 闸门的打戳时刻（M2 修）：`chatGate` 必须在**投递彻底结束**之后才打，
 * 而不是取件时。取件时打戳的语义是"取件后 1200ms 就能取下一条"，
 * 于是一条 QQ 回包要 2s 时，下一条在它返回后立刻就能发 —— 实际间隔接近 0，
 * 验收里那句"间隔 ≥ 1200ms"就变成假通过。
 */

export class Outbox {
  /**
   * @param {{ send: (chatKey: string, text: string) => Promise<unknown>, log: Function,
   *           onSent?: Function, onDead?: Function, perChatIntervalMs?: number,
   *           concurrency?: number, maxAttempts?: number, now?: () => number }} deps
   *        now 只为测试注入（默认 Date.now），别在生产里传
   */
  constructor({
    send,
    log,
    onSent,
    onDead,
    perChatIntervalMs = 1200,
    concurrency = 3,
    maxAttempts = 3,
    now = Date.now,
  }) {
    this.send = send
    this.log = log
    this.onSent = onSent
    this.onDead = onDead
    this.perChatIntervalMs = perChatIntervalMs
    this.concurrency = concurrency
    this.maxAttempts = maxAttempts
    this.now = now

    /** @type {Array<{ id: number, chatKey: string, text: string, attempts: number, nextAt: number }>} */
    this.queue = []
    /** @type {Map<string, number>} chatKey → 下一次可发时间 */
    this.chatGate = new Map()
    /** @type {Set<string>} 正在发的 chat */
    this.busy = new Set()
    this.seq = 0
    this.running = false
    this.timer = null
    this.inflight = 0
  }

  start() {
    if (this.running) return
    this.running = true
    this.tick()
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * @param {string} chatKey
   * @param {string} text
   * @param {object} [meta] 原样挂在队列项上（存 qqMsgId 之类的关联信息）
   */
  enqueue(chatKey, text, meta = {}) {
    this.queue.push({ id: ++this.seq, chatKey, text, meta, attempts: 0, nextAt: this.now() })
  }

  /**
   * 入队一条**消息段**（发图、发表情这类非纯文本）。
   *
   * 为什么不直接调 OneBot：那会绕过限流、分条、ledger、死信重试 ——
   * 而这几样正是"机器人不会自己刷屏"的唯一保障。
   *
   * @param {string} chatKey
   * @param {object[]} segments OneBot 消息段数组
   * @param {object} [meta]
   */
  enqueueSegments(chatKey, segments, meta = {}) {
    if (!Array.isArray(segments) || !segments.length) return
    this.queue.push({ id: ++this.seq, chatKey, text: '', segments, meta, attempts: 0, nextAt: this.now() })
  }

  get size() {
    return this.queue.length
  }

  async tick() {
    if (!this.running) return
    const now = this.now()

    while (this.inflight < this.concurrency) {
      const idx = this.queue.findIndex(item => {
        if (item.nextAt > now) return false
        if (this.busy.has(item.chatKey)) return false
        const gate = this.chatGate.get(item.chatKey) ?? 0
        return gate <= now
      })
      if (idx < 0) break

      const [item] = this.queue.splice(idx, 1)
      this.busy.add(item.chatKey)
      this.inflight += 1
      // 闸门在 deliver 的 finally 里打（见文件头）—— 这里不能打，否则慢 send 会架空间隔
      this.deliver(item)
    }

    this.timer = setTimeout(() => this.tick(), 100)
  }

  async deliver(item) {
    try {
      if (Array.isArray(item.segments) && item.segments.length) {
        if (typeof this.sendSegments !== 'function') throw new Error('出站队列不支持消息段')
        await this.sendSegments(item.chatKey, item.segments)
      } else {
        await this.send(item.chatKey, item.text)
      }
      this.log('debug', `qdash-neo: 出站成功 ${item.chatKey} #${item.id}`)
      this.onSent?.(item)
    } catch (err) {
      item.attempts += 1
      if (item.attempts >= this.maxAttempts) {
        this.log('error', `qdash-neo: 出站进死信 ${item.chatKey} #${item.id} msg=${err?.message}`, err)
        this.onDead?.(item, err)
      } else {
        const backoff = [1000, 4000, 15000][item.attempts - 1] ?? 15000
        item.nextAt = this.now() + backoff
        this.queue.push(item)
        this.log('warn', `qdash-neo: 出站失败，${backoff}ms 后重试 ${item.chatKey} #${item.id} msg=${err?.message}`)
      }
    } finally {
      this.busy.delete(item.chatKey)
      this.inflight -= 1
      // 成功、失败、进死信、回推重试都走这里：语义是"上一条彻底结束之后再等一个 interval"
      this.chatGate.set(item.chatKey, this.now() + this.perChatIntervalMs)
    }
  }
}
