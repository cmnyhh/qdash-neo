/**
 * OneBot 客户端：`restart()` 的状态复位。
 *
 * 这里**不打真 WS**，用一个 FakeSocket 记录 url / headers / 关闭动作。
 * 要证的不是"能连上"（那需要真 SnowLuma），而是"换地址后没有脏状态残留"：
 *   - 旧 socket 必须被关掉，且它的回调不能再影响新连接
 *   - tokenMode 要回到 header（否则换新口令后永远只试 query）
 *   - backoff 要回到 1s（否则首连失败要等 30s）
 *   - lastHeartbeat / selfId 要清（否则 healthy() 说谎、"别回自己"按旧号判断）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeEvent } from '../src/onebot/normalize.js'

/** 最小 WebSocket 替身：够 OneBotClient 用即可 */
class FakeSocket {
  constructor(url, opts = {}) {
    this.url = url
    this.opts = opts
    this.listeners = new Map()
    this.closed = false
    FakeSocket.instances.push(this)
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeAllListeners() {
    this.listeners.clear()
  }

  fire(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  close(code = 1000) {
    this.closed = true
    this.fire('close', { code })
  }
}
FakeSocket.instances = []

const { OneBotClient } = await import('../src/onebot/client.js')

function makeClient() {
  globalThis.WebSocket = FakeSocket
  FakeSocket.instances = []
  const logs = []
  const client = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:3001',
    token: 'token-a',
    log: (level, msg) => logs.push({ level, msg }),
  })
  return { client, logs }
}

test('客户端：restart 换地址后新连接用新 url 与新口令（header 形态）', () => {
  const { client } = makeClient()
  client.start()
  const first = client.ws
  assert.equal(first.url, 'ws://127.0.0.1:3001')
  assert.equal(first.opts.headers.authorization, 'Bearer token-a')

  client.restart({ wsUrl: 'ws://onebot.example.com:7777', token: 'token-b' })

  assert.notEqual(client.ws, first, '必须是新连接对象')
  assert.equal(first.closed, true, '旧 socket 要被关掉，不是晾着')
  assert.equal(first.listeners.size, 0, '旧 socket 的监听要摘干净，否则 close 回调会跑旧逻辑')
  assert.equal(client.ws.url, 'ws://onebot.example.com:7777')
  assert.equal(client.ws.opts.headers.authorization, 'Bearer token-b')
})

test('客户端：restart 复位 tokenMode / backoff / 心跳 / 身份（这五处是最容易漏的）', () => {
  const { client } = makeClient()
  client.start()
  // 模拟跑了一阵之后的状态：鉴权降级过、退避到 30s、心跳新鲜、身份是旧号
  client.tokenMode = 'query'
  client.backoff = 30_000
  client.lastHeartbeat = Date.now()
  client.selfId = '111'
  client.nickname = '旧的'

  client.restart({ wsUrl: 'ws://127.0.0.1:3002', token: 'token-c' })

  assert.equal(client.tokenMode, 'header', '换新口令后必须重新试 header')
  assert.equal(client.backoff, 1000, '退避要复位，否则首连失败要等半分钟')
  assert.equal(client.lastHeartbeat, 0, '心跳时间戳不清 → healthy() 会在没连上时说"在线"')
  assert.equal(client.selfId, '', '旧身份会让"别回自己"按旧号判断')
  assert.equal(client.nickname, '')
  assert.equal(client.timer, null, '不能留下旧的重连定时器')
})

test('客户端：stop 之后 restart 能恢复连接（stopped 要一起复位）', () => {
  const { client } = makeClient()
  client.start()
  client.stop()
  assert.equal(client.stopped, true)

  client.restart({ wsUrl: 'ws://127.0.0.1:3003' })
  assert.equal(client.stopped, false)
  assert.equal(client.ws.url, 'ws://127.0.0.1:3003')
})

test('客户端：restart 不带参数时沿用当前值（只用于手动重连）', () => {
  const { client } = makeClient()
  client.start()
  client.restart()
  assert.equal(client.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(client.token, 'token-a')
})

test('客户端：restart 会 reject 在途请求（不能让人一直等已废弃连接的回复）', async () => {
  const { client } = makeClient()
  client.start()
  // 假装有一个 action 正在等回包
  const pending = new Promise((resolve, reject) => {
    client.pending.set(1, { resolve, reject })
  })
  client.restart({ wsUrl: 'ws://127.0.0.1:3004' })
  await assert.rejects(pending, /重启/)
  assert.equal(client.pending.size, 0)
})

/* ---------------- 拍一拍：要能触发对话 ---------------- */

test('拍一拍：拍自己会转成消息事件（原来 notice 被直接丢弃）', () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', log: () => {} })
  const got = []
  c.on('message', m => got.push(m))
  c.route({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    self_id: 999,
    user_id: 123,
    target_id: 999,
    group_id: 888,
    time: 1700000000,
  })
  assert.equal(got.length, 1, '拍自己必须触发')
  assert.equal(got[0].message_type, 'group')
  assert.equal(String(got[0].user_id), '123')
  assert.match(got[0].raw_message, /拍了拍你/)
  assert.ok(got[0].message_id.startsWith('poke-'), '要有稳定的去重键')

  // 交给真实 normalize：拍一拍等于点名，atMe 必须为真（概率闸门靠它免疫）
  const ev = normalizeEvent(got[0], { selfId: '999' })
  assert.equal(ev.atMe, true, '拍一拍应当视作点名')
  assert.equal(ev.chatKey, 'g:888')
})

test('拍一拍：拍别人不触发（群里互拍很常见，不该唤醒机器人）', () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', log: () => {} })
  const got = []
  c.on('message', m => got.push(m))
  c.route({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    self_id: 999,
    user_id: 123,
    target_id: 456,
    group_id: 888,
    time: 1,
  })
  assert.equal(got.length, 0)
})

test('拍一拍：私聊也能触发，且归到私聊会话', () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', log: () => {} })
  let got = null
  c.on('message', m => {
    got = m
  })
  c.route({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 999, user_id: 123, target_id: 999, time: 2 })
  assert.ok(got, '私聊拍一拍也要有反应')
  const ev = normalizeEvent(got, { selfId: '999' })
  assert.equal(ev.chatKey, 'u:123')
  assert.equal(ev.atMe, true)
})

test('发送：群聊带 replyTo 构造 [reply, text]，私聊忽略引用', async () => {
  const { client } = makeClient()
  const calls = []
  client.call = (action, params) => {
    calls.push({ action, params })
    return Promise.resolve({ ok: true })
  }

  await client.sendText('g:123', '在的', '620459211')
  assert.equal(calls[0].action, 'send_group_msg')
  assert.deepEqual(
    calls[0].params.message,
    [{ type: 'reply', data: { id: '620459211' } }, { type: 'text', data: { text: '在的' } }],
    '引用段要排在文本前面，否则 QQ 当成正文的一部分',
  )

  // 私聊：引用是噪音，对方知道你在回他
  await client.sendText('u:456', '嗯', '620459211')
  assert.equal(calls[1].action, 'send_private_msg')
  assert.deepEqual(calls[1].params.message, [{ type: 'text', data: { text: '嗯' } }])

  // 群聊但不带 replyTo：纯文本
  await client.sendText('g:123', 'hello')
  assert.deepEqual(calls[2].params.message, [{ type: 'text', data: { text: 'hello' } }])
})
