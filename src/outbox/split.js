/**
 * 出站分条（M2）—— 纯函数，不碰 store、不碰网络，单测直接打。
 *
 * 为什么按**字素**（grapheme）而不是 `String.length` 切：
 *   - `'😀'.length === 2`（代理对）、`'👨‍👩‍👧'.length === 8`（ZWJ 序列），按长度切会切出半个字符，
 *     QQ 上显示成 `�`;
 *   - 按长度算 500 字，带表情的回复实际只能装 250 个字，用户看到的是"怎么这么短就断了"。
 * `Intl.Segmenter(..., {granularity:'grapheme'})` 一次 O(n)，800 字量级可忽略；
 * 实例是模块级单例（新建一次约几十微秒，但每次回复都建没意义）。
 *
 * 断点优先级：空行 → 换行 → 句末标点 → 逗号顿号 → 空格 → 硬切。
 * 且断点必须落在窗口 **40% 之后**：否则第一句特别长时，前一段只剩二三十个字，
 * 一条消息被碎成"嗯。"这种，比直接硬切更难看。
 */
import { toPlainText } from './clean.js'

const DEFAULT_MAX_CHARS = 500
const DEFAULT_MAX_SEGMENTS = 5
/** 句末：切在句号之后比切在逗号之后自然 */
const SENTENCE_END = '。！？…；.!?;'
/** 句中：退而求其次，但至少不是词中间 */
const CLAUSE_END = '，、,:'

let segmenter
let segmenterWarned = false

/**
 * @param {string} text
 * @param {Function} [onWarn]
 * @returns {string[]} 字素数组
 */
function graphemesOf(text, onWarn) {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
        : null
  }
  if (segmenter) return Array.from(segmenter.segment(text), s => s.segment)
  if (!segmenterWarned) {
    segmenterWarned = true
    onWarn?.('Intl.Segmenter 不可用，退化为按码点分条（组合 emoji 可能被拆开）')
  }
  return Array.from(text)
}

/**
 * 在 `window.slice(0, limit)` 里找一个断点，返回"这一片切到第几个字素"（含断点本身）。
 * @param {string[]} gs
 * @param {number} limit
 * @returns {number}
 */
function findBreak(gs, limit) {
  const window = gs.slice(0, limit)
  const minKeep = Math.max(1, Math.ceil(limit * 0.4))
  const levels = [
    i => window[i] === '\n' && window[i - 1] === '\n',
    i => window[i] === '\n',
    i => SENTENCE_END.includes(window[i]),
    i => CLAUSE_END.includes(window[i]),
    i => window[i] === ' ',
  ]
  for (const hit of levels) {
    for (let i = window.length - 1; i >= minKeep; i -= 1) {
      if (hit(i)) return i + 1
    }
  }
  return limit
}

/**
 * @param {string} text
 * @param {{ maxChars?: number, maxSegments?: number, onWarn?: Function }} [opts]
 * @returns {{ parts: string[], truncated: boolean, droppedChars: number }}
 */
export function splitText(text, { maxChars, maxSegments, onWarn } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS
  const maxParts =
    Number.isFinite(maxSegments) && maxSegments > 0 ? Math.floor(maxSegments) : DEFAULT_MAX_SEGMENTS

  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const trimmed = normalized.trim()
  if (!trimmed) return { parts: [], truncated: false, droppedChars: 0 }

  const gs = graphemesOf(trimmed, onWarn)
  if (gs.length <= limit) return { parts: [trimmed], truncated: false, droppedChars: 0 }

  const parts = []
  let rest = gs
  while (rest.length > 0 && parts.length < maxParts) {
    if (rest.length <= limit) {
      parts.push(rest.join(''))
      rest = []
      break
    }
    const cut = findBreak(rest, limit)
    const chunk = rest.slice(0, cut).join('').trim()
    rest = rest.slice(cut)
    // 下一片不要以空白/空行起头（QQ 里会多出一条只有一个换行的空气泡）
    let skip = 0
    while (skip < rest.length && /\s/.test(rest[skip])) skip += 1
    if (skip > 0) rest = rest.slice(skip)
    if (chunk) parts.push(chunk)
  }

  if (rest.length === 0) return { parts, truncated: false, droppedChars: 0 }

  // 到上限还没吃完：丢弃剩余并**在末条标注**。静默截断是最难被发现的一类问题
  // （用户只会觉得"它怎么说到一半"），标注 + 日志两处都留
  const droppedChars = rest.length
  parts[parts.length - 1] = `${parts[parts.length - 1]}\n…（已省略 ${droppedChars} 字）`
  return { parts, truncated: true, droppedChars }
}

/**
 * 一次回复的完整出站计划：先清 Markdown（否则 `**` 既占长度预算，断点还可能落在一对符号中间），
 * 再分条。
 *
 * @param {string} text
 * @param {{ split?: boolean, plainText?: boolean, maxChars?: number, maxSegments?: number,
 *           onWarn?: Function }} [opts]
 * @returns {{ parts: string[], truncated: boolean, droppedChars: number, text: string }}
 *          text = 清洗后的全文（未截断时等于 parts.join('\n')，供调用方回写上下文用）
 */
export function planReply(text, { split = 'smart', plainText = true, maxChars, maxSegments, onWarn } = {}) {
  const cleaned = plainText ? toPlainText(text) : String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!cleaned) return { parts: [], truncated: false, droppedChars: 0, text: '' }

  const mode = resolveMode(split)
  if (mode === 'off') return { parts: [cleaned], truncated: false, droppedChars: 0, text: cleaned }

  const r =
    mode === 'line'
      ? splitByLine(cleaned, { maxChars, maxSegments, onWarn })
      : splitText(cleaned, { maxChars, maxSegments, onWarn })
  return { ...r, text: cleaned }
}

/**
 * 拆条模式的归一化。历史配置里 `split` 是 boolean，这里一并接住 ——
 * 旧库里 `split: false` 不该因为换了类型就变成"按语义拆"。
 *
 * @param {unknown} raw
 * @returns {'smart'|'line'|'off'}
 */
export function resolveMode(raw) {
  if (raw === false || raw === 'off' || raw === 'none') return 'off'
  if (raw === 'line') return 'line'
  // true / 'smart' / undefined / 非法值：都用默认的语义拆
  return 'smart'
}

/**
 * 按换行拆：**每一行一条**，空行只当分隔符。
 *
 * 为什么不是"按空行分段"：模型分段写的时候，一段里通常还有软换行；
 * 用户要的是"多拆几次发"，按空行拆往往还是一大坨。
 *
 * 单行超长时仍然按 `maxChars` 再切（否则会撞 QQ 的单条长度上限），
 * 拆分沿用 `splitText` 的断点规则。总条数受 `maxSegments` 限制。
 *
 * @param {string} text
 * @param {{ maxChars?: number, maxSegments?: number, onWarn?: Function }} [opts]
 */
export function splitByLine(text, { maxChars, maxSegments, onWarn } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS
  const maxParts =
    Number.isFinite(maxSegments) && maxSegments > 0 ? Math.floor(maxSegments) : DEFAULT_MAX_SEGMENTS

  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  if (lines.length === 0) return { parts: [], truncated: false, droppedChars: 0 }

  /** @type {string[]} */
  const parts = []
  for (const line of lines) {
    // 单行超长：先按语义切，占满剩余额度
    if (Array.from(line).length > limit) {
      const left = maxParts - parts.length
      if (left <= 0) break
      const r = splitText(line, { maxChars: limit, maxSegments: left, onWarn })
      parts.push(...r.parts)
      continue
    }
    parts.push(line)
    if (parts.length >= maxParts) break
  }

  if (parts.length < lines.length && parts.length >= maxParts) {
    // 被条数上限截断：算清丢了多少字，标注在末条（静默丢内容最难被发现）
    const kept = new Set(parts)
    const droppedLines = lines.filter(l => !kept.has(l))
    const droppedChars = droppedLines.reduce((n, l) => n + Array.from(l).length, 0)
    parts[parts.length - 1] = `${parts[parts.length - 1]}\n…（已省略 ${droppedChars} 字）`
    return { parts, truncated: true, droppedChars }
  }
  return { parts, truncated: false, droppedChars: 0 }
}
