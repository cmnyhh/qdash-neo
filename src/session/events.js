/**
 * 出站侧：`session/event` → 文本 + 用量。
 *
 * 只认 `assistant/message`（已提交的整条消息），不接 delta ——
 * delta 走的是 `agent/assistant-stream`，瞬态不写日志，只该用于打字机效果（00 §2.6）。
 *
 * 事件是 **post-commit fire-and-forget、不保证处理时序**（00 §一.3），
 * 所以这里只做"提取"，串行化交给 service。
 */

import { SILENT_MARKER, parseLaterMarker, parseSleepMarker } from '../consts.js'

const PREFIX = 'qq:'

/** @param {any} message AssistantMessage */
export function textOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim()
}

/**
 * 挂监听。返回 disposer（其实挂在 ctx 上会随 fiber 自动回收，显式返回是为了测试）。
 *
 * @param {object} ctx
 * @param {{ log: Function, onReply: (chatKey: string, text: string, event: object) => void,
 *           onUsage?: Function, onSilent?: (chatKey: string, event: object) => void }} deps
 *   `onSilent` 在模型主动选择不开口（输出 SILENT_MARKER）时回调，用来记账/落库。
 */
export function attachSessionEvents(ctx, { log, onReply, onUsage, onSilent, onSleep, onLater }) {
  const handler = (session, event) => {
    try {
      const sessionId = session?.header?.id
      // 多会话必须自己过滤：这一层收的是全宿主的会话事件
      if (typeof sessionId !== 'string' || !sessionId.startsWith(PREFIX)) return

      const chatKey = sessionId.slice(PREFIX.length)

      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message)
        const usage = event.data?.usage
        if (usage && typeof onUsage === 'function') onUsage(chatKey, usage, event)
        if (!text) return
        // interrupted 是中途取消的前缀消息，不该当正常回复发出去
        if (event.data?.interrupted) {
          log('info', `qdash-neo: ${chatKey} 中途中止的回复已丢弃`)
          return
        }
        // 判定层放弃决定权时（judge.onUnsure='agent'），沉默由模型用标记表达。
        // 严格相等而不是 includes：宁可多发一条，也不要把正常回复误吞掉。
        if (text === SILENT_MARKER) {
          log('debug', `qdash-neo: ${chatKey} 模型选择不开口，本次不发送`)
          if (typeof onSilent === 'function') onSilent(chatKey, event)
          return
        }
        /**
         * 模型自己要求休息。
         *
         *   `[[SLEEP]]`      → `-1`，交给 `onSleep` 用配置的短期安静
         *   `[[SLEEP:300]]`  → 指定的秒数
         *
         * 判据是 `!== 0`（0 表示"不是标记"），不能再用 `> 0`——
         * 否则不带数字的 `[[SLEEP]]` 会被当成普通文本，原样发到群里。
         */
        const sleepSeconds = parseSleepMarker(text)
        if (sleepSeconds !== 0) {
          const human = sleepSeconds > 0 ? `${sleepSeconds} 秒` : '短期安静（按配置）'
          log('info', `qdash-neo: ${chatKey} 模型要求休息 ${human}`)
          if (typeof onSleep === 'function') onSleep(chatKey, sleepSeconds, event)
          return
        }
        /**
         * 模型给自己排个期：`[[LATER:30|备忘]]` → 到点再唤起它一次。
         *
         * 本条不发（它只是在排期，不是在说话）。到点后说不说由它重新判断。
         */
        const later = parseLaterMarker(text)
        if (later) {
          log('info', `qdash-neo: ${chatKey} 模型排期 ${later.minutes} 分钟后再看看${later.hint ? `（备忘：${later.hint}）` : ''}`)
          if (typeof onLater === 'function') onLater(chatKey, later, event)
          return
        }
        onReply(chatKey, text, event)
      }
    } catch (err) {
      // 观察者异常会被宿主隔离，但不打出来就永远查不到
      log('error', `qdash-neo: session/event 处理失败 type=${event?.type}`, err)
    }
  }

  ctx.on('session/event', handler)
  return () => ctx.off?.('session/event', handler)
}
