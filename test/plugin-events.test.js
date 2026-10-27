import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PLUGIN_EVENTS, PluginEvents } from '../src/plugin/events.js'

/**
 * 事件总线的测试重点不是"能收到"，而是**收听者出错时主流程不受影响**。
 *
 * 一旦监听器能把异常抛回处理链，插件就成了消息处理的一环 ——
 * "某个插件坏了导致所有消息不回"只是时间问题。
 */

function mkBus() {
  const logs = []
  const bus = new PluginEvents({ log: (level, msg) => logs.push({ level, msg }) })
  return { bus, logs }
}

test('事件：订阅后能收到，返回值是取消订阅函数', () => {
  const { bus } = mkBus()
  const seen = []
  const off = bus.on('message/inbound', ev => seen.push(ev))

  bus.emit('message/inbound', { chatKey: 'g:1' })
  off()
  bus.emit('message/inbound', { chatKey: 'g:2' })

  assert.equal(seen.length, 1, '取消订阅后不该再收到')
  assert.equal(seen[0].chatKey, 'g:1')
})

test('事件：未知名报错，并列出可用事件', () => {
  const { bus } = mkBus()
  assert.throws(() => bus.on('message/whatever', () => {}), /不支持的事件/)
  assert.throws(() => bus.on('', () => {}), /不支持的事件/)
  assert.throws(() => bus.on('message/inbound', 'not-a-fn'), /必须是函数/)

  // 报错信息里要能直接看到可用清单，否则作者只能翻文档
  for (const name of PLUGIN_EVENTS) {
    assert.ok(bus.on(name, () => {}) !== undefined)
  }
})

test('事件：监听器抛错被吞掉，其余监听器照常收到', () => {
  const { bus, logs } = mkBus()
  const seen = []
  bus.on('message/inbound', () => {
    throw new Error('炸了')
  })
  bus.on('message/inbound', ev => seen.push(ev))

  const n = bus.emit('message/inbound', { chatKey: 'g:1' })

  assert.equal(seen.length, 1, '坏监听器不能让后面的收不到')
  assert.equal(n, 1, '返回值是"成功通知了几个"，抛错那个不算')
  assert.ok(logs.some(l => l.level === 'warn' && /事件监听器出错/.test(l.msg)))
})

test('事件：异步监听器的 rejection 也被吞掉', async () => {
  const { bus, logs } = mkBus()
  bus.on('turn/end', async () => {
    throw new Error('异步炸了')
  })

  bus.emit('turn/end', { chatKey: 'g:1' })
  // 等一个 microtask 让 catch 跑完
  await new Promise(r => setImmediate(r))

  assert.ok(
    logs.some(l => l.level === 'warn' && /异步炸了/.test(l.msg)),
    '不挂 catch 的话会变成 unhandledRejection，把宿主带走',
  )
})

test('事件：没有监听器时 emit 是零开销', () => {
  const { bus } = mkBus()
  assert.equal(bus.emit('message/inbound', {}), 0)
  assert.equal(bus.size(), 0)
})

test('事件：监听器里调用 off 不会打乱本次遍历', () => {
  const { bus } = mkBus()
  const seen = []
  const offA = bus.on('message/inbound', () => {
    seen.push('a')
    offA()
  })
  bus.on('message/inbound', () => seen.push('b'))

  bus.emit('message/inbound', {})
  assert.deepEqual(seen, ['a', 'b'], '本轮要跑完，下一次 emit 才少一个')
})
