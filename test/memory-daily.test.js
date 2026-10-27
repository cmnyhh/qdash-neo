/**
 * 日总结单测：`node --test test/memory-daily.test.js`
 *
 * 验的是"每天归纳一次"这件事的**硬约束**，不是模型归纳得好不好：
 *   - 同一天重复跑只能有一条（补跑/重启都可能触发）
 *   - 当天没消息就跳过，不白调模型
 *   - 失败要带原因返回（调用方写 kv 留痕），不能静默
 *   - 消息很多时首尾各取一半 —— 早上定的结论不能被"只取最近"丢掉
 *   - 注入只取早于原文窗口的日子，否则同一段对话会出现两次
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dayStart, localDay, nextDay, summarizeDay } from '../src/memory/daily.js'
import { Memory } from '../src/memory/index.js'
import { Store } from '../src/store/db.js'

const DAY = '2026-10-25'

/** 假 llm：按顺序吐出给定文本，记录收到的 prompt */
const fakeCtx = (text, sink = {}) => ({
  llm: {
    stream: opts => {
      sink.prompt = opts?.messages?.[0]?.content?.[0]?.text ?? ''
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
})

function setup(dailyOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-daily-'))
  const store = new Store(join(dir, 't.db'))
  const config = {
    memory: { enabled: true, daily: { enabled: true, ...dailyOver } },
    judge: { provider: 'fake', model: 'fake-1' },
  }
  return {
    dir,
    store,
    config,
    deps: { store, config, log: () => {} },
    dispose() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const say = (store, { id, text, ts, direction = 'in', state = 'context' }) =>
  store.insertMessage({
    chatKey: 'g:1',
    qqMsgId: id,
    direction,
    senderId: direction === 'in' ? '1' : '',
    senderName: direction === 'in' ? '甲' : '',
    text,
    state: direction === 'out' ? 'sent' : state,
    ts,
  })

test('日总结：日期工具按本地日历走（跨月、跨年）', () => {
  assert.equal(localDay(dayStart('2026-10-25')), '2026-10-25')
  assert.equal(nextDay('2026-10-31'), '2026-11-01')
  assert.equal(nextDay('2026-12-31'), '2027-01-01')
  assert.ok(dayStart(nextDay('2026-10-25')) > dayStart('2026-10-25'))
})

test('日总结：归纳写入 daily，同一天重跑覆盖而不是新增', async () => {
  const s = setup()
  try {
    const ts = dayStart(DAY) + 3600_000
    say(s.store, { id: 'a', text: '今天部署到哪一步了', ts })
    say(s.store, { id: 'b', text: '已经上预发，明天上生产', ts: ts + 1000, direction: 'out' })

    const r1 = await summarizeDay(fakeCtx('聊了部署进度，决定明天上生产'), s.deps, 'g:1', DAY)
    assert.equal(r1.ok, true)
    const row = s.store.getDailySummary('g:1', DAY)
    assert.equal(row.kind, 'daily')
    assert.equal(row.target, DAY)
    assert.match(row.text, /明天上生产/)

    const r2 = await summarizeDay(fakeCtx('重跑一次'), s.deps, 'g:1', DAY)
    assert.equal(r2.ok, true)
    const count = s.store.db
      .prepare(`select count(*) as c from memories where chat_key = 'g:1' and kind = 'daily'`)
      .get().c
    assert.equal(count, 1, '同一天只能有一条总结（补跑/重启都会再触发）')
    assert.match(s.store.getDailySummary('g:1', DAY).text, /重跑一次/)
  } finally {
    s.dispose()
  }
})

test('日总结：当天没消息就跳过，不调模型', async () => {
  const s = setup()
  let calls = 0
  const ctx = { llm: { stream: () => { calls += 1; throw new Error('不该调模型') } } }
  try {
    const res = await summarizeDay(ctx, s.deps, 'g:1', DAY)
    assert.equal(res.ok, true)
    assert.equal(res.skipped, true)
    assert.equal(calls, 0)
    assert.equal(s.store.getDailySummary('g:1', DAY), null)
  } finally {
    s.dispose()
  }
})

test('日总结：模型报错时返回原因，不写库（调用方据此留痕）', async () => {
  const s = setup()
  try {
    say(s.store, { id: 'a', text: '随便说一句', ts: dayStart(DAY) + 1000 })
    const ctx = {
      llm: {
        stream: () => (async function* () {
          throw new Error('网关 502')
        })(),
      },
    }
    const res = await summarizeDay(ctx, s.deps, 'g:1', DAY)
    assert.equal(res.ok, false)
    assert.match(res.reason, /502/)
    assert.equal(s.store.getDailySummary('g:1', DAY), null, '失败不能留下半截总结')
  } finally {
    s.dispose()
  }
})

test('日总结：消息过多时首尾各取一半，早上定的结论不会被丢掉', async () => {
  const s = setup({ maxMessages: 4 })
  const sink = {}
  try {
    const base = dayStart(DAY)
    for (let i = 0; i < 10; i++) say(s.store, { id: `m${i}`, text: `第${i}句`, ts: base + i * 1000 })

    const res = await summarizeDay(fakeCtx('摘要', sink), s.deps, 'g:1', DAY)
    assert.equal(res.ok, true)
    assert.match(sink.prompt, /第0句/, '最早的那句必须保留')
    assert.match(sink.prompt, /第9句/, '最新的那句必须保留')
    assert.doesNotMatch(sink.prompt, /第5句/, '中间的应当被裁掉')
    assert.match(sink.prompt, /只展示最早与最近/, '必须告诉模型这是部分内容')
  } finally {
    s.dispose()
  }
})

test('日总结：注入只取早于原文窗口的日子（不与原文重复）', () => {
  const s = setup({ days: 3 })
  try {
    s.store.upsertDailySummary({ chatKey: 'g:1', day: '2026-10-24', text: '前天的总结' })
    s.store.upsertDailySummary({ chatKey: 'g:1', day: '2026-10-25', text: '昨天的总结' })
    const m = new Memory({ store: s.store, config: s.config })

    const all = m.render('g:1')
    assert.match(all, /最近几天/)
    assert.match(all, /昨天的总结/)

    // 原文窗口覆盖到 10-25 中午 → 那天的总结不能再出现一次
    const scoped = m.render('g:1', { beforeTs: dayStart('2026-10-25') + 3600_000 })
    assert.doesNotMatch(scoped, /昨天的总结/)
    assert.match(scoped, /前天的总结/)
  } finally {
    s.dispose()
  }
})

test('日总结：关闭时不注入（开关只看 daily.enabled）', () => {
  const s = setup({ enabled: false })
  try {
    s.store.upsertDailySummary({ chatKey: 'g:1', day: '2026-10-24', text: '前天的总结' })
    const m = new Memory({ store: s.store, config: s.config })
    assert.equal(m.render('g:1'), '', 'daily 关了就不该出现在 prompt 里')
  } finally {
    s.dispose()
  }
})
