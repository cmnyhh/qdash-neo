/**
 * `gateBypass` 的测试：**只关频率，不关资格**。
 *
 * 跑团时玩家的每一句都该有回应，而配额与 `ratePerMinute` 是防刷屏用的。
 * 但白名单、群开关、是否点名是"能不能跟它说话"，这些在任何时候都不能放开 ——
 * 一旦放开，"开了跑团插件就等于对全群无条件响应"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Gates } from '../src/pipeline/gates.js'
import { QdashNeoService } from '../src/service.js'
import { Store } from '../src/store/db.js'

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-bypass-'))
  const store = new Store(join(dir, 't.db'))
  const service = new QdashNeoService(
    {},
    { onebot: { selfId: '999' }, identity: { aliases: ['测试'] } },
    { log: () => {}, createUserMessage: text => ({ text }) },
  )
  service.store = store
  return {
    service,
    dispose() {
      service.clearTimers?.()
      service.outbox?.stop?.()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ---------------- 登记表本身 ---------------- */

test('gateBypass：set 之后 has 为 true，clear 之后为 false', () => {
  const s = mk()
  try {
    assert.equal(s.service.gateBypassApi.has('g:1'), false)

    assert.equal(s.service.gateBypassApi.set('g:1', { reason: '跑团' }), true)
    assert.equal(s.service.gateBypassApi.has('g:1'), true)

    assert.equal(s.service.gateBypassApi.clear('g:1'), true)
    assert.equal(s.service.gateBypassApi.has('g:1'), false)
    assert.equal(s.service.gateBypassApi.clear('g:1'), false, '重复 clear 返回 false')
  } finally {
    s.dispose()
  }
})

test('gateBypass：只影响登记过的会话', () => {
  const s = mk()
  try {
    s.service.gateBypassApi.set('g:1', { reason: '跑团' })
    assert.equal(s.service.gateBypassApi.has('g:1'), true)
    assert.equal(s.service.gateBypassApi.has('g:2'), false, '别的群不受影响')
  } finally {
    s.dispose()
  }
})

test('gateBypass：空 chatKey 不登记', () => {
  const s = mk()
  try {
    assert.equal(s.service.gateBypassApi.set(''), false)
    assert.equal(s.service.gateBypassApi.has(''), false)
    assert.deepEqual(s.service.gateBypassApi.list(), [])
  } finally {
    s.dispose()
  }
})

test('gateBypass：list 返回当前在豁免的会话与原因', () => {
  const s = mk()
  try {
    s.service.gateBypassApi.set('g:1', { reason: '跑团：谁在敲墙' })
    const list = s.service.gateBypassApi.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].chatKey, 'g:1')
    assert.equal(list[0].reason, '跑团：谁在敲墙')
    assert.ok(list[0].until > Date.now(), 'TTL 应该是未来时间')
  } finally {
    s.dispose()
  }
})

/* ---------------- 随机闸 ---------------- */

test('skipByChance：豁免的会话不掷骰子', () => {
  const s = mk()
  try {
    // 设成 0 = 必被拦，用来对比
    s.service.replyChance = 0
    const ev = { chatKey: 'g:1', atMe: false, kind: 'group' }

    assert.equal(s.service.skipByChance(ev, [ev]), true, '没豁免时被随机闸拦住')

    s.service.gateBypassApi.set('g:1', { reason: '跑团' })
    assert.equal(s.service.skipByChance(ev, [ev]), false, '豁免后放行')
  } finally {
    s.dispose()
  }
})

/* ---------------- 配额与限流闸 ---------------- */

test('gates.trigger：bypassQuota 跳过配额，bypassRate 跳过限流', () => {
  const g = new Gates({
    policy: {
      groupEnabled: true,
      groupTrigger: 'agent',
      groupReplyQuota: { maxReplies: 1, windowMinutes: 10 },
      ratePerMinute: 1,
    },
  })
  const ev = { kind: 'group', chatKey: 'g:1', groupId: '1', userId: '1', text: '我检查书架' }

  // 先用掉配额与限流
  assert.equal(g.trigger(ev).ok, true)
  g.recordReply('g:1')

  assert.equal(g.trigger(ev).ok, false, '配额用完 + 限流都满了')
  assert.equal(g.trigger(ev, { bypassQuota: true }).ok, false, '只跳配额仍然被限流拦')
  assert.equal(g.trigger(ev, { bypassRate: true }).ok, false, '只跳限流仍然被配额拦')
  assert.equal(
    g.trigger(ev, { bypassQuota: true, bypassRate: true }).ok,
    true,
    '两个都跳才放行',
  )
})

test('gates.trigger：豁免不动资格类闸门（群开关 / 白名单）', () => {
  const g = new Gates({
    policy: { groupEnabled: false, groupTrigger: 'agent' },
  })
  const ev = { kind: 'group', chatKey: 'g:1', groupId: '1', userId: '1', text: 'x' }

  /**
   * **这条是本次改动的底线。**
   *
   * 如果豁免能连群开关一起跳过，"装个跑团插件"就等于"这个群无视所有策略"。
   */
  assert.equal(g.trigger(ev, { bypassQuota: true, bypassRate: true }).ok, true, '群开关不在这里管')

  // 真正该拦的是 ingest（群开关在那里）
  assert.equal(g.ingest(ev).ok, false, '群关着时 ingest 就拦掉了')
})

test('gates.trigger：mention 档下豁免也要求点名', () => {
  const g = new Gates({
    policy: { groupEnabled: true, groupTrigger: 'mention', groupReplyQuota: { maxReplies: 99 } },
  })
  const ev = { kind: 'group', chatKey: 'g:1', groupId: '1', userId: '1', text: '随便说一句', atMe: false }

  assert.equal(
    g.trigger(ev, { bypassQuota: true, bypassRate: true }).ok,
    false,
    '**豁免不改变"要不要点名"**',
  )
})
