/**
 * 一次回复的分片结算表（M2）。
 *
 * 解决的问题：`rememberOutbound` 每调用一次就往群上下文里 append 一条。
 * 一条 800 字的回复拆成 5 片之后，如果按片回写，20 条的上下文窗口会被自己的话吃掉 5 格，
 * `self` 记忆也会存成 5 条碎片（"我答过什么"变成一串断句）。
 *
 * 语义：一次回复 = 一个 replyId = N 片。每片成功/死信都会 `settle` 一次，
 * 只有**最后一片结算完**才返回 `done: true`，调用方此时拿完整原文回写一次。
 * 片与片之间同会话串行（Outbox 保证），所以结算顺序天然按序，不需要额外排序。
 *
 * 有界：结算完立刻删除；超过 limit 丢最旧并留痕（回复链路不能因为记账无限长）。
 */
export class ReplyLedger {
  /**
   * @param {{ limit?: number, log?: Function }} [deps]
   */
  constructor({ limit = 500, log } = {}) {
    this.limit = limit
    this.log = log ?? (() => {})
    /** @type {Map<string, { chatKey: string, text: string, total: number, sent: number, settled: number }>} */
    this.items = new Map()
  }

  /**
   * @param {string} replyId
   * @param {{ chatKey?: string, text?: string, total?: number }} info  text = 要回写的完整原文
   */
  track(replyId, { chatKey = '', text = '', total = 1 } = {}) {
    if (!replyId) return
    const count = Number.isFinite(total) && total > 0 ? Math.floor(total) : 1
    this.items.set(replyId, { chatKey, text, total: count, sent: 0, settled: 0 })
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value
      this.items.delete(oldest)
      this.log('warn', `qdash-neo: 回复结算表超过 ${this.limit} 条，丢弃最旧的 ${oldest}`)
    }
  }

  /**
   * @param {string} replyId
   * @param {boolean} ok 这一片是否真的发出去了
   * @returns {{ done: boolean, sent: number, total: number, chatKey: string, text: string }}
   *          done=true 表示这条回复已全部结算（条目已删除）
   */
  settle(replyId, ok) {
    const entry = this.items.get(replyId)
    // 未登记的 replyId（例如热更新前入队的老片）：不炸，也不假装结算完成
    if (!entry) return { done: false, sent: 0, total: 0, chatKey: '', text: '' }

    entry.settled += 1
    if (ok) entry.sent += 1

    if (entry.settled < entry.total) {
      return { done: false, sent: entry.sent, total: entry.total, chatKey: entry.chatKey, text: entry.text }
    }
    this.items.delete(replyId)
    return { done: true, sent: entry.sent, total: entry.total, chatKey: entry.chatKey, text: entry.text }
  }

  /** 主动放弃（入队失败、停机清理） */
  drop(replyId) {
    this.items.delete(replyId)
  }

  get size() {
    return this.items.size
  }

  clear() {
    this.items.clear()
  }
}
