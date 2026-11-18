/**
 * `message/outbound` 事件的测试。
 *
 * 这个事件是给**记录类插件**用的（跑团记 log、审计、导出），所以测的重点是：
 *   - 字段够不够（订阅方靠 `from` 区分来源、靠 `kind` 区分文本和图片）
 *   - **订阅方炸了会不会连累发消息**
 *
 * 为什么单独一个文件而不是塞进 `service.test.js`：
 * 那个文件 1700+ 行、自带一整套 `makeService`，而这里只需要"能调 `enqueueOut`"
 * 的最小装配。混在一起会让两套装配互相干扰。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { QdashNeoService } from '../src/service.js'
import { Store } from '../src/store/db.js'

const CHAT = 'g:777'

/** 最小装配：只要能落库 + 调 enqueueOut，不启动 WS / 不建 DSH 会话 */
function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-out-'))
  const store = new Store(join(dir, 't.db'))
  const logs = []
  const service = new QdashNeoService(
    {},
    {
      onebot: { selfId: '999' },
      identity: { aliases: ['测试机器人'] },
    },
    {
      log: (level, msg) => logs.push({ level, msg }),
      createUserMessage: text => ({ text }),
    },
  )
  service.store = store

  return {
    service,
    store,
    logs,
    dispose() {
      // 和 service.test.js 一样：不清定时器，node --test 会一直等它到期
      service.clearTimers?.()
      service.outbox?.stop?.()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('出站事件：enqueueOut 触发 message/outbound，字段齐全', () => {
  const s = mk()
  try {
    const seen = []
    const off = s.service.on('message/outbound', ev => seen.push(ev))

    s.service.enqueueOut(CHAT, '你顺着一道窄梯下去，空气里有铁锈味。', { fromTool: 'plugin:coc' })

    assert.equal(seen.length, 1, '一次 enqueueOut 应该 emit 一次')
    assert.equal(seen[0].chatKey, CHAT)
    assert.equal(seen[0].text, '你顺着一道窄梯下去，空气里有铁锈味。')
    assert.equal(seen[0].kind, 'text')
    assert.equal(seen[0].from, 'plugin:coc', '订阅方靠它区分"谁说的"')
    assert.ok(seen[0].ts > 0, '要带时间戳，记录要按它排序')

    off()
    s.service.enqueueOut(CHAT, '第二条')
    assert.equal(seen.length, 1, '退订后不该再收到')
  } finally {
    s.dispose()
  }
})

test('出站事件：段消息用 label 当 text，kind 是 segments', () => {
  const s = mk()
  try {
    const seen = []
    s.service.on('message/outbound', ev => seen.push(ev))

    s.service.enqueueSegmentsOut(CHAT, [{ type: 'image', data: { file: 'a.png' } }])

    assert.equal(seen.length, 1)
    assert.equal(seen[0].kind, 'segments')
    /**
     * **必须是 `[图片]` 这种人话，不是段数组。**
     * 订阅方（跑团记录）要把这行直接写进 log，给它一个段数组没法用。
     */
    assert.equal(seen[0].text, '[图片]')
  } finally {
    s.dispose()
  }
})

test('出站事件：没传 fromTool 时 from 是空串，不是 undefined', () => {
  const s = mk()
  try {
    const seen = []
    s.service.on('message/outbound', ev => seen.push(ev))

    s.service.enqueueOut(CHAT, '内核自己发的一条')

    assert.equal(seen[0].from, '', '空串让订阅方能直接比较，不用写 ?? 兜底')
  } finally {
    s.dispose()
  }
})

test('出站事件：监听器抛错不影响消息落库', () => {
  const s = mk()
  try {
    s.service.on('message/outbound', () => {
      throw new Error('订阅方炸了')
    })

    s.service.enqueueOut(CHAT, '还是要落库', { qqMsgId: 'qdn-out-1' })

    const row = s.store.messageByQqId(CHAT, 'qdn-out-1')
    assert.ok(row, '监听器抛错不该让消息凭空消失')
    assert.equal(row.text, '还是要落库')
    assert.equal(row.direction, 'out')

    // 抛错要留痕，否则"我的记录插件为什么少了一条"永远查不出来
    assert.ok(
      s.logs.some(l => l.level === 'warn' && /监听器出错/.test(l.msg)),
      '监听器抛错应该记一条 warn',
    )
  } finally {
    s.dispose()
  }
})

test('出站事件：分片各发一次，不合并', () => {
  const s = mk()
  try {
    const seen = []
    s.service.on('message/outbound', ev => seen.push(ev.text))

    s.service.enqueueOut(CHAT, '第一片', { replyId: 'r1', total: 2 })
    s.service.enqueueOut(CHAT, '第二片', { replyId: 'r1', total: 2 })

    /**
     * **记录本来就该逐条。** 如果这里合并成一条，订阅方还得自己再拆一次，
     * 而它拿不到"怎么拆"的依据（分片边界只有调用方知道）。
     */
    assert.deepEqual(seen, ['第一片', '第二片'])
  } finally {
    s.dispose()
  }
})
