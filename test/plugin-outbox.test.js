import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PluginOutbox } from '../src/plugin/outbox.js'

/**
 * 插件发消息的测试重点：
 *
 *   1. **来源标记不可伪造** —— 审计里要分得清「模型发的」还是「插件发的」
 *   2. 空参数在入口就拒（不要等到队列里报一个看不懂的错）
 *   3. 插件名要校验（它会进 meta 与日志）
 */

function mkBox() {
  const calls = []
  const box = new PluginOutbox({
    deliver: {
      text: (k, t, m) => calls.push({ kind: 'text', k, t, m }),
      segments: (k, s, m) => calls.push({ kind: 'segments', k, s, m }),
    },
  })
  return { box, calls }
}

test('插件发消息：来源标记由句柄定死，调用方改不了', () => {
  const { box, calls } = mkBox()
  const api = box.forPlugin('todo')
  api.sendText({ chatKey: 'g:1', text: '该喝水了' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].k, 'g:1')
  assert.equal(calls[0].t, '该喝水了')
  assert.equal(calls[0].m.fromTool, 'plugin:todo', '标记必须带插件名，否则审计里分不清是谁发的')
})

test('插件发消息：发段消息要带可读标签', () => {
  const { box, calls } = mkBox()
  const api = box.forPlugin('shots')
  api.sendSegments({ chatKey: 'g:2', segments: [{ type: 'image', data: { file: 'a.png' } }], text: '[图片] 截图' })

  assert.equal(calls[0].kind, 'segments')
  assert.equal(calls[0].m.text, '[图片] 截图')
  assert.equal(calls[0].m.fromTool, 'plugin:shots')
})

test('插件发消息：两个插件各自标记，不会串', () => {
  const { box, calls } = mkBox()
  box.forPlugin('a').sendText({ chatKey: 'g:1', text: 'A' })
  box.forPlugin('b').sendText({ chatKey: 'g:1', text: 'B' })

  assert.equal(calls[0].m.fromTool, 'plugin:a')
  assert.equal(calls[1].m.fromTool, 'plugin:b')
})

test('插件发消息：插件名不合法直接拒', () => {
  const { box } = mkBox()
  for (const bad of ['', 'A', '1x', 'a b', 'a:b', 'a;drop']) {
    assert.throws(() => box.forPlugin(bad), /不合法/, `「${bad}」应该被拒`)
  }
  assert.ok(box.forPlugin('todo_list_2'), '合法名字要能拿到句柄')
})

test('插件发消息：空 chatKey / 空 text 在入口就拒', () => {
  const { box, calls } = mkBox()
  const api = box.forPlugin('todo')
  assert.throws(() => api.sendText({ chatKey: '', text: 'x' }), /chatKey/)
  assert.throws(() => api.sendText({ chatKey: 'g:1', text: '   ' }), /text/)
  assert.throws(() => api.sendText({}), /chatKey/)
  assert.equal(calls.length, 0, '被拒的调用不该进队列')
})

test('插件发消息：segments 必须是非空数组', () => {
  const { box } = mkBox()
  const api = box.forPlugin('todo')
  assert.throws(() => api.sendSegments({ chatKey: 'g:1', segments: [] }), /segments/)
  assert.throws(() => api.sendSegments({ chatKey: 'g:1', segments: null }), /segments/)
})

test('插件发消息：队列未就绪时报可读错误', () => {
  const box = new PluginOutbox({})
  const api = box.forPlugin('todo')
  assert.throws(() => api.sendText({ chatKey: 'g:1', text: 'x' }), /出站队列未就绪/)
})
