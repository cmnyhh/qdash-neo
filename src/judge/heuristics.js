/**
 * 零成本启发式 —— 判定链的第一层。
 *
 * 为什么必须有这一层：群消息量远大于私聊，把每句都丢给模型判一次，成本按消息数乘。
 * 确定的事（被 @、被叫名字）用规则判掉，只有模棱两可的才花钱问模型。
 *
 * 这一层的取舍来自原项目（`evaluateWakeTriggerV2`）：
 *   - @ 和"叫名字"是确定性信号，直接回
 *   - 关键词只做"值得考虑"，不做"必须回"（原项目把关键词当触发条件，误触发率高）
 *   - 短英文词要走词边界，否则 `DS` 会命中 `ADS`/`DSL`（它踩过，注释里写了）
 *
 * 纯函数，无 I/O，可单测。
 */

/** @typedef {{ verdict: 'reply'|'silent'|'unsure', score: number, reason: string, layer: 'heuristic' }} HeuristicVerdict */

const QUESTION_HINTS = [
  '？', '?', '吗', '呢', '怎么', '为什么', '为啥', '如何',
  '是不是', '能不能', '要不要', '有没有', '什么时候', '哪儿', '哪里', '谁',
]

/**
 * 短英文/数字走词边界，避免子串误命中。
 * @param {string} text
 * @param {string} keyword
 */
export function matchKeyword(text, keyword) {
  if (!keyword) return false
  if (/^[a-z0-9]{1,5}$/i.test(keyword)) {
    return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  }
  return text.includes(keyword)
}

/**
 * @param {{ inbound: object, config: object, botNames?: string[] }} input
 * @returns {HeuristicVerdict}
 */
export function heuristic({ inbound, config, botNames = [] }) {
  const text = String(inbound.text ?? '').trim()

  if (inbound.atMe) return { verdict: 'reply', score: 0.98, reason: '被 @', layer: 'heuristic' }

  const name = botNames
    .filter(n => typeof n === 'string' && n.trim().length >= 2)
    .find(n => text.includes(n.trim()))
  if (name) return { verdict: 'reply', score: 0.9, reason: `提到名字「${name.trim()}」`, layer: 'heuristic' }

  const keywords = config?.policy?.groupTriggerKeywords ?? []
  const hit = keywords.find(k => matchKeyword(text, String(k)))
  if (hit) return { verdict: 'unsure', score: 0.65, reason: `命中关键词「${hit}」`, layer: 'heuristic' }

  if (!text) return { verdict: 'silent', score: 0.1, reason: '没有可回应的文本', layer: 'heuristic' }
  if (text.length <= 1) return { verdict: 'silent', score: 0.15, reason: '内容过短', layer: 'heuristic' }
  if (QUESTION_HINTS.some(h => text.includes(h))) {
    return { verdict: 'unsure', score: 0.55, reason: '像是问句', layer: 'heuristic' }
  }

  return { verdict: 'unsure', score: 0.35, reason: '普通闲聊', layer: 'heuristic' }
}

const RANK = { silent: 0, unsure: 1, reply: 2 }

/**
 * 一批连续发言（批窗口攒起来的）走启发式。
 *
 * 取批次里**最强**的那条作为结论：批里只要有一条 @ 我，就必须回 ——
 * 不能因为后面还有人在闲聊就把 @ 稀释成"普通闲聊"。
 * 理由里带上"第几条"，否则 `judgements` 里看不出是哪句话触发的。
 *
 * @param {{ batch: object[], config: object, botNames?: string[] }} input
 * @returns {HeuristicVerdict & { hitIndex: number }}
 */
export function heuristicBatch({ batch, config, botNames = [] }) {
  if (!batch?.length) {
    return { verdict: 'silent', score: 0, reason: '空批次', layer: 'heuristic', hitIndex: 0 }
  }

  let best = null
  batch.forEach((inbound, index) => {
    const h = heuristic({ inbound, config, botNames })
    if (!best || RANK[h.verdict] > RANK[best.verdict]) best = { ...h, index }
  })

  const prefix = batch.length > 1 ? `批次 ${batch.length} 条，第 ${best.index + 1} 条：` : ''
  return { ...best, reason: `${prefix}${best.reason}`, hitIndex: best.index }
}
