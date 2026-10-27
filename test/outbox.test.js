/**
 * 出站形态单测：`node --test test/outbox.test.js`
 *
 * 三组：
 *   A 分条质量   —— 断点优先级、字素安全、上限与截断标注
 *   B Markdown   —— 该去的符号去掉、不该动的结构留住、幂等
 *   C 队列行为   —— 同会话串行**且间隔从上一条完成起算**、跨会话并行、退避/死信、timer 清理
 *
 * 时间相关的用例刻意用毫秒级参数（interval 300ms、假 send 200ms）：
 * 不能 sleep 1200ms，否则这套测试自己就要跑十几秒；也不能只测"顺序对不对"，
 * 那正是旧实现能通过的假象（旧实现取件时打戳，慢 send 时实际间隔接近 0）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toPlainText } from '../src/outbox/clean.js'
import { ReplyLedger } from '../src/outbox/ledger.js'
import { Outbox } from '../src/outbox/queue.js'
import { planReply, splitText } from '../src/outbox/split.js'

const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' })
const glen = s => Array.from(seg.segment(s)).length

/** 半个代理对 / 被拆散的 ZWJ 序列的特征：单独出现的代理项 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

async function waitFor(fn, timeoutMs = 4000, stepMs = 10) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fn()) return
    await new Promise(r => setTimeout(r, stepMs))
  }
  throw new Error('waitFor 超时：条件始终没成立')
}

function makeLog() {
  const lines = []
  return { lines, log: (level, msg) => lines.push({ level, msg }) }
}

// ---------------- A 分条质量 ----------------

test('分条：短文本原样返回，不拆不多字', () => {
  const r = splitText('你好呀', { maxChars: 500, maxSegments: 5 })
  assert.deepEqual(r.parts, ['你好呀'])
  assert.equal(r.truncated, false)
  assert.equal(r.droppedChars, 0)
})

test('分条：空输入与纯空白返回空数组（不产生空气泡）', () => {
  assert.deepEqual(splitText('', {}).parts, [])
  assert.deepEqual(splitText('   \n\n  ', {}).parts, [])
  assert.deepEqual(planReply('   ', {}).parts, [])
})

test('分条：800 字无标点 → 按 maxChars 硬切，内容一字不丢', () => {
  const text = '字'.repeat(800)
  const r = splitText(text, { maxChars: 500, maxSegments: 5 })
  assert.equal(r.parts.length, 2)
  assert.equal(r.truncated, false)
  assert.equal(glen(r.parts[0]), 500)
  assert.equal(r.parts.join(''), text)
})

test('分条：优先空行（段落边界比句子边界更自然）', () => {
  const a = '第一段'.repeat(20) // 60 字
  const b = '第二段'.repeat(20)
  const r = splitText(`${a}\n\n${b}`, { maxChars: 70, maxSegments: 5 })
  assert.equal(r.parts.length, 2)
  assert.equal(r.parts[0], a)
  assert.equal(r.parts[1], b)
})

test('分条：没有空行时切在句末标点之后', () => {
  const text = `${'甲'.repeat(30)}。${'乙'.repeat(30)}。${'丙'.repeat(30)}。`
  const r = splitText(text, { maxChars: 65, maxSegments: 5 })
  assert.ok(r.parts.length >= 2)
  // 每一片（除最后一片）都以句子结束符收尾，而不是把一句话劈开
  for (const p of r.parts.slice(0, -1)) assert.match(p, /[。！？…；.!?;]$/)
})

test('分条：断点太靠前（< 窗口 40%）就不采用，宁可硬切', () => {
  // 第 10 个字后有句号，之后 490 个字没有标点：
  // 若按"找到断点就切"，第一片只有 10 个字 —— 这就是碎片化
  const text = `${'甲'.repeat(9)}。${'乙'.repeat(490)}`
  const r = splitText(text, { maxChars: 500, maxSegments: 5 })
  assert.equal(glen(r.parts[0]), 500)
})

test('分条：emoji 不被切碎（ZWJ 家族 / 国旗 / 代理对完整）', () => {
  const family = '👨‍👩‍👧‍👦'
  const flag = '🇨🇳'
  const text = `${family.repeat(300)}${flag.repeat(300)}`
  const r = splitText(text, { maxChars: 100, maxSegments: 5 })
  for (const p of r.parts) {
    assert.equal(LONE_SURROGATE.test(p), false, `出现半个代理对：${JSON.stringify(p)}`)
    // ZWJ 序列必须整体落在同一片里：切开后会出现以 ZWJ 开头/结尾的残片
    assert.equal(p.startsWith('\u200d'), false, 'ZWJ 残片在片首')
    assert.equal(p.endsWith('\u200d'), false, 'ZWJ 残片在片尾')
  }
  // 前几片正好 100 个字素（硬切），说明是按字素而不是按 UTF-16 长度算的
  assert.equal(glen(r.parts[0]), 100)
})

test('分条：超过 maxSegments 的部分丢弃，且末条明确标注省略了多少字', () => {
  const text = '字'.repeat(1000)
  const r = splitText(text, { maxChars: 100, maxSegments: 2 })
  assert.equal(r.parts.length, 2)
  assert.equal(r.truncated, true)
  assert.ok(r.droppedChars > 0)
  assert.match(r.parts.at(-1), /…（已省略 \d+ 字）$/)
})

test('分条：参数非法时回落到默认值，不抛也不死循环', () => {
  const text = '字'.repeat(700)
  for (const bad of [0, -1, NaN, undefined, null]) {
    const r = splitText(text, { maxChars: bad, maxSegments: bad })
    assert.ok(r.parts.length >= 1)
    assert.ok(r.parts.every(p => p.length > 0))
  }
})

// ---------------- B Markdown 清洗 ----------------

test('清洗：围栏代码块去掉围栏行，内容保留', () => {
  const out = toPlainText('看这个：\n```js\nconst a = 1\nconsole.log(a)\n```\n完事')
  assert.equal(out, '看这个：\nconst a = 1\nconsole.log(a)\n完事')
})

test('清洗：标题 / 粗体 / 斜体 / 行内代码 / 删除线', () => {
  const out = toPlainText('## 结论\n**重点**是 _这个_ 和 `code`，还有 ~~删掉~~ 的')
  assert.equal(out, '结论\n重点是 这个 和 code，还有 删掉 的')
})

test('清洗：链接与图片保留 URL（QQ 里点不开，但人要看得到地址）', () => {
  assert.equal(
    toPlainText('详见 [文档](https://example.com/a) 和 ![图](https://example.com/i.png)'),
    '详见 文档 (https://example.com/a) 和 图 (https://example.com/i.png)',
  )
})

test('清洗：引用去符号、分割线整行删、列表换中点、有序列表保号', () => {
  const out = toPlainText('> 引用一句\n---\n- 甲\n- 乙\n1. 一\n2. 二')
  assert.equal(out, '引用一句\n· 甲\n· 乙\n1. 一\n2. 二')
})

test('清洗：代码里的 **kwargs / a * b 不能被当成语法吃掉', () => {
  assert.equal(toPlainText('def f(**kwargs)'), 'def f(**kwargs)')
  assert.equal(toPlainText('a * b * c'), 'a * b * c')
})

test('清洗：表格竖线保留（QQ 里唯一还剩的结构线索）', () => {
  assert.equal(toPlainText('| 项 | 值 |\n| --- | --- |\n| a | 1 |'), '| 项 | 值 |\n| --- | --- |\n| a | 1 |')
})

test('清洗：幂等 —— 洗两遍与洗一遍结果相同', () => {
  const sample = [
    '# 标题',
    '**粗** `code` [链接](https://x.y) ~~删~~',
    '```',
    'code **not bold**',
    '```',
    '- 列表',
    '> 引用',
    '',
    '',
    '',
    '尾巴',
  ].join('\n')
  const once = toPlainText(sample)
  assert.equal(toPlainText(once), once)
})

test('清洗：3 个以上空行压成一个，首尾空白去掉', () => {
  assert.equal(toPlainText('\n\n甲\n\n\n\n乙\n\n'), '甲\n\n乙')
})

// ---------------- C 队列行为 ----------------

test('队列：同会话串行，且间隔从上一条**发送完成**起算（慢 send 也守得住）', async () => {
  const { lines, log } = makeLog()
  const stamps = []
  const outbox = new Outbox({
    send: async () => {
      stamps.push(Date.now())
      await new Promise(r => setTimeout(r, 200)) // QQ 回包慢的那一类
    },
    log,
    perChatIntervalMs: 300,
  })
  outbox.start()
  outbox.enqueue('g:1', 'a')
  outbox.enqueue('g:1', 'b')
  try {
    await waitFor(() => stamps.length === 2)
  } finally {
    outbox.stop()
  }
  // 旧实现（取件时打戳）大约是 100ms，会在这里挂掉
  assert.ok(
    stamps[1] - stamps[0] >= 280,
    `相邻两条间隔 ${stamps[1] - stamps[0]}ms，应 ≥ 300ms（从上一条完成起算）`,
  )
  assert.equal(lines.filter(l => l.level === 'error').length, 0)
})

test('队列：不同会话互不阻塞（各自闸门独立）', async () => {
  const { log } = makeLog()
  const stamps = []
  const outbox = new Outbox({
    send: async () => {
      stamps.push(Date.now())
      await new Promise(r => setTimeout(r, 20))
    },
    log,
    perChatIntervalMs: 400,
  })
  outbox.start()
  outbox.enqueue('g:1', 'a')
  outbox.enqueue('g:2', 'b')
  try {
    await waitFor(() => stamps.length === 2)
  } finally {
    outbox.stop()
  }
  assert.ok(Math.abs(stamps[1] - stamps[0]) < 150, '两个会话的首条应该几乎同时发出')
})

test('队列：并发上限生效（concurrency=1 时同一时刻只有一条在飞）', async () => {
  const { log } = makeLog()
  let live = 0
  let maxLive = 0
  let done = 0
  const outbox = new Outbox({
    send: async () => {
      live += 1
      maxLive = Math.max(maxLive, live)
      await new Promise(r => setTimeout(r, 30))
      live -= 1
      done += 1
    },
    log,
    concurrency: 1,
    perChatIntervalMs: 0,
  })
  outbox.start()
  outbox.enqueue('g:1', 'a')
  outbox.enqueue('g:2', 'b')
  outbox.enqueue('g:3', 'c')
  try {
    await waitFor(() => done === 3)
  } finally {
    outbox.stop()
  }
  assert.equal(maxLive, 1)
})

test('队列：失败退避回推队列，达到 maxAttempts 才进死信且只回调一次', async () => {
  const { lines, log } = makeLog()
  const dead = []
  const outbox = new Outbox({
    send: async () => {
      throw new Error('假发送失败')
    },
    log,
    maxAttempts: 3,
  })
  outbox.start()
  outbox.enqueue('g:1', 'a', { qqMsgId: 'x' })
  try {
    // 第一次失败后应当带着退避重新排队（1s 后），而不是直接死信
    await waitFor(() => lines.some(l => l.level === 'warn'))
    assert.equal(dead.length, 0)
    assert.equal(outbox.size, 1)
  } finally {
    outbox.stop()
  }
})

test('队列：maxAttempts=1 时第一次失败就死信，回调带原错误', async () => {
  const { log } = makeLog()
  const dead = []
  const outbox = new Outbox({
    send: async () => {
      throw new Error('一次性失败')
    },
    log,
    maxAttempts: 1,
    onDead: item => dead.push(item),
  })
  outbox.start()
  outbox.enqueue('g:1', 'a', { qqMsgId: 'x' })
  try {
    await waitFor(() => dead.length === 1)
  } finally {
    outbox.stop()
  }
  assert.equal(dead.length, 1)
  assert.equal(dead[0].meta.qqMsgId, 'x')
})

test('队列：stop() 后不再取件，timer 已清（否则 node --test 退不出进程）', async () => {
  const { log } = makeLog()
  const sent = []
  const outbox = new Outbox({ send: async (k, t) => sent.push(t), log, perChatIntervalMs: 0 })
  outbox.start()
  outbox.stop()
  outbox.enqueue('g:1', 'a')
  await new Promise(r => setTimeout(r, 250))
  assert.equal(sent.length, 0)
  assert.equal(outbox.timer, null)
  assert.equal(outbox.running, false)
})

test('队列：meta 原样透传给 onSent（分片靠它回写）', async () => {
  const { log } = makeLog()
  const got = []
  const outbox = new Outbox({
    send: async () => {},
    log,
    onSent: item => got.push(item.meta),
    perChatIntervalMs: 0,
    maxAttempts: 1,
  })
  outbox.start()
  outbox.enqueue('g:1', 'a', { qqMsgId: 'r:1', replyId: 'r', index: 0, total: 2 })
  try {
    await waitFor(() => got.length === 1)
  } finally {
    outbox.stop()
  }
  assert.deepEqual(got[0], { qqMsgId: 'r:1', replyId: 'r', index: 0, total: 2 })
})

// ---------------- ReplyLedger ----------------

test('结算表：最后一片结算完才 done，期间累计成功数', () => {
  const ledger = new ReplyLedger()
  ledger.track('r', { chatKey: 'g:1', text: '全文', total: 3 })
  assert.deepEqual(ledger.settle('r', true), { done: false, sent: 1, total: 3, chatKey: 'g:1', text: '全文' })
  assert.equal(ledger.settle('r', true).sent, 2)
  const last = ledger.settle('r', true)
  assert.equal(last.done, true)
  assert.equal(last.sent, 3)
  assert.equal(ledger.size, 0)
})

test('结算表：全部死信时 done 但 sent=0（调用方据此不写上下文）', () => {
  const ledger = new ReplyLedger()
  ledger.track('r', { chatKey: 'g:1', text: '全文', total: 2 })
  ledger.settle('r', false)
  const last = ledger.settle('r', false)
  assert.equal(last.done, true)
  assert.equal(last.sent, 0)
})

test('结算表：未登记的 replyId 不炸也不假装完成', () => {
  const ledger = new ReplyLedger()
  assert.deepEqual(ledger.settle('nope', true), { done: false, sent: 0, total: 0, chatKey: '', text: '' })
})

test('结算表：超过上限丢最旧并留痕（回复链路不能无限记账）', () => {
  const { lines, log } = makeLog()
  const ledger = new ReplyLedger({ limit: 2, log })
  ledger.track('a', { total: 1 })
  ledger.track('b', { total: 1 })
  ledger.track('c', { total: 1 })
  assert.equal(ledger.size, 2)
  assert.equal(ledger.settle('a', true).done, false)
  assert.equal(lines.filter(l => l.level === 'warn').length, 1)
})

/* ---------------- 分条模式（2026-10-26 新增 line） ---------------- */

test('分条：line 模式每行一条，空行只当分隔（模型分段写时才是它想要的）', () => {
  const text = '（耳朵朝那边偏了偏）\n\n三杯下肚，话自然就多了。\n\n至于「复活」二字……\n\n我听着。'
  const r = planReply(text, { split: 'line', maxChars: 500, maxSegments: 10 })
  assert.deepEqual(r.parts, ['（耳朵朝那边偏了偏）', '三杯下肚，话自然就多了。', '至于「复活」二字……', '我听着。'])
  assert.equal(r.truncated, false)
})

test('分条：旧配置的 boolean 仍然按原意工作（false = 不拆，true = 语义拆）', () => {
  const text = '第一行。\n第二行。'
  assert.equal(planReply(text, { split: false }).parts.length, 1, 'split:false 不能因为换了类型就变成会拆')
  assert.equal(planReply(text, { split: 'off' }).parts.length, 1)
  assert.equal(planReply(text, { split: true, maxChars: 5, maxSegments: 10 }).parts.length > 1, true)
  assert.equal(planReply(text, { split: 'line', maxSegments: 10 }).parts.length, 2)
})

test('分条：line 模式撞到 maxSegments 时在末条标注省略（静默丢内容最难查）', () => {
  const text = ['一', '二', '三', '四'].join('\n')
  const r = planReply(text, { split: 'line', maxSegments: 2, maxChars: 500 })
  assert.equal(r.parts.length, 2)
  assert.equal(r.truncated, true)
  assert.match(r.parts[1], /已省略/)
})

test('分条：line 模式下单行超长仍按语义再切，不撞单条上限', () => {
  const long = '这是一句很长的话。'.repeat(40)
  const r = planReply(`短行\n${long}`, { split: 'line', maxChars: 50, maxSegments: 10 })
  assert.equal(r.parts[0], '短行')
  assert.ok(r.parts.length > 1)
  for (const p of r.parts) assert.ok(Array.from(p).length <= 60, `分片超长: ${Array.from(p).length}`)
})
