/**
 * 跨模块共享的字面量。刻意做成独立小文件，避免 `service ↔ session ↔ onebot` 互相 import。
 */

/**
 * 模型用它表示「现在不想说话」。
 *
 * 只有 `judge.onUnsure='agent'` 时才会要求模型输出它：那种模式下"要不要开口"
 * 由对话层决定，而模型必须有个方式表达"我不说"。出站侧（`session/events.js`）
 * 识别到它就丢弃，不入 outbox、不发 QQ。
 *
 * 用少见的三段方括号，避免和正常聊天内容撞车；匹配时 trim 后严格相等，
 * 不做模糊匹配 —— 宁可多发一条，也不要把正常回复误吞掉。
 */
export const SILENT_MARKER = '[[SILENT]]'

/**
 * 模型用它表示「我要闭麦休息 N 分钟」：`[[SLEEP:30]]`。
 *
 * 为什么让模型自己定时长，而不是插件里 `random()`：它手上有整段对话和当前情绪，
 * 「刚被呛了一句就睡十分钟」「聊得正热就不睡」比均匀随机自然得多。
 * 插件只做三件事：把范围告诉它、认这个标记、到点放它回来。
 */
const SLEEP_RE = /^\s*\[\[SLEEP:(\d{1,4})\]\]\s*$/

/**
 * 解析沉睡标记。
 * @param {string} text
 * @returns {number} 分钟数；不是标记则返回 0
 */
export function parseSleepMarker(text) {
  const m = SLEEP_RE.exec(String(text ?? ''))
  if (!m) return 0
  const minutes = Number(m[1])
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0
}

/**
 * 模型用它表示「过一会儿我自己再来看看」：`[[LATER:30]]`，可以带一句备忘：
 * `[[LATER:30|那个部署后来搞定了吗]]`。
 *
 * **这不是定时发言**。到点只是**再唤起它一次**：说不说、说什么仍然由它决定，
 * 什么都不做是完全正常的。区别很关键 —— 定时强制发言会变成"到点必须找话说"，
 * 那是最像机器人的行为。
 *
 * 带备忘是必要的：隔了半小时，它已经不记得当初为什么排期，
 * 到点只剩"有人让我说话"的印象，就会硬找话题。
 */
const LATER_RE = /^\s*\[\[LATER:(\d{1,4})(?:\|([^\]]{0,120}))?\]\]\s*$/

/**
 * 解析排期标记。
 * @param {string} text
 * @returns {{ minutes: number, hint: string }|null} 不是标记则返回 null
 */
export function parseLaterMarker(text) {
  const m = LATER_RE.exec(String(text ?? ''))
  if (!m) return null
  const minutes = Number(m[1])
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return { minutes, hint: String(m[2] ?? '').trim() }
}
