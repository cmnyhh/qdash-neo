import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JudgeChain } from '../src/judge/chain.js'

/**
 * 插件判定器的测试重点：
 *
 *   1. **抛错不拖垮判定链** —— 一个坏插件最多让它那一段不起作用，
 *      不该让整个机器人对所有群消息闭嘴
 *   2. 认不出的返回值按弃权处理（宁可继续问下一个）
 *   3. 注册期就要挡住保留字与重名
 */

function mkChain(over = {}) {
  const logs = []
  const chain = new JudgeChain(
    {},
    {
      config: {
        judge: { enabled: true, onUnsure: 'llm', provider: 'x', model: 'm' },
        policy: {},
        agent: { model: 'm' },
        ...over,
      },
      log: (level, msg) => logs.push({ level, msg }),
    },
  )
  return { chain, logs }
}

/** 走到插件层需要 heuristic 返回 unsure：一条普通闲聊即可 */
const CHAT = {
  kind: 'group',
  chatKey: 'g:1',
  groupId: '1',
  userId: '1',
  messageId: '1',
  senderName: '甲',
  text: '今天天气还行',
  atMe: false,
}

test('插件判定器：给出 reply 就成为结论，且 layer 标成 plugin', async () => {
  const { chain } = mkChain()
  chain.registerProvider({
    name: 'keywords',
    provider: () => ({ verdict: 'reply', score: 0.9, reason: '命中关键词' }),
  })

  const j = await chain.decide({ inbound: CHAT })
  assert.equal(j.verdict, 'reply')
  assert.equal(j.layer, 'plugin')
  assert.match(j.reason, /判定器 keywords/)
  assert.match(j.reason, /命中关键词/)
})

test('插件判定器：弃权（返回 null）之后继续往下走', async () => {
  const { chain } = mkChain()
  chain.registerProvider({ name: 'a', provider: () => null })
  chain.registerProvider({ name: 'b', provider: () => ({ verdict: 'silent', reason: '不相关' }) })

  const j = await chain.decide({ inbound: CHAT })
  assert.equal(j.verdict, 'silent')
  assert.match(j.reason, /判定器 b/, 'a 弃权后应该轮到 b')
})

test('插件判定器：抛错只跳过它自己，不影响后续', async () => {
  const { chain, logs } = mkChain()
  chain.registerProvider({
    name: 'broken',
    provider: () => {
      throw new Error('炸了')
    },
  })
  chain.registerProvider({ name: 'ok', provider: () => ({ verdict: 'reply' }) })

  const j = await chain.decide({ inbound: CHAT })
  assert.equal(j.verdict, 'reply', '坏插件不能让整条链挂掉')
  assert.match(j.reason, /判定器 ok/)
  assert.ok(
    logs.some(l => l.level === 'warn' && /判定器「broken」抛错/.test(l.msg)),
    '要留痕，否则"为什么它没生效"只能靠猜',
  )
})

test('插件判定器：认不出的 verdict 按弃权处理', async () => {
  const { chain } = mkChain()
  chain.registerProvider({ name: 'weird', provider: () => ({ verdict: 'maybe' }) })
  chain.registerProvider({ name: 'ok', provider: () => ({ verdict: 'reply' }) })

  const j = await chain.decide({ inbound: CHAT })
  assert.match(j.reason, /判定器 ok/, 'maybe 不是结论，不能当决定用')
})

test('插件判定器：全弃权时退回内核（不会卡住）', async () => {
  const { chain } = mkChain()
  chain.registerProvider({ name: 'a', provider: () => null })
  const j = await chain.decide({ inbound: CHAT })
  // 没配模型时 available() 会给出 silent，关键是它**有结论**
  assert.ok(j.verdict, '必须有结论，不能返回 undefined')
  assert.notEqual(j.layer, 'plugin')
})

test('插件判定器：保留字与重名在注册期就拒', () => {
  const { chain } = mkChain()
  for (const bad of ['heuristic', 'llm', 'plugin']) {
    assert.throws(() => chain.registerProvider({ name: bad, provider: () => null }), /保留字/)
  }
  chain.registerProvider({ name: 'dup', provider: () => null })
  assert.throws(() => chain.registerProvider({ name: 'dup', provider: () => null }), /已注册/)
  assert.throws(() => chain.registerProvider({ name: 'x' }), /provider/)
  assert.throws(() => chain.registerProvider({ provider: () => null }), /name/)
})

test('插件判定器：disposer 之后不再参与', async () => {
  const { chain } = mkChain()
  const off = chain.registerProvider({ name: 'tmp', provider: () => ({ verdict: 'reply' }) })
  off()
  const j = await chain.decide({ inbound: CHAT })
  assert.notEqual(j.layer, 'plugin')
})
