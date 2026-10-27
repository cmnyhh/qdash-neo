import assert from 'node:assert/strict'
import test from 'node:test'

import { PluginInstructions } from '../src/plugin/instructions.js'

function mk() {
  const logs = []
  return { reg: new PluginInstructions({ log: (level, msg) => logs.push({ level, msg }) }), logs }
}

test('插件引导：注册不等于生效，要授权才进系统提示', () => {
  const { reg } = mk()
  reg.register({ key: 'sticker', owner: 'p1', text: '看到好图就存' })

  assert.equal(reg.size, 1, '注册了，控制台能看见')
  assert.equal(reg.list().length, 1)
  assert.deepEqual(reg.granted([]), [], '没授权就一条都不注入')
  assert.deepEqual(reg.granted(['p2']), [], '授权的是别的插件，也不注入')

  assert.deepEqual(
    reg.granted(['p1']),
    [{ owner: 'p1', text: '看到好图就存' }],
    '授权之后才拼进 AGENTS.md',
  )
})

test('插件引导：同 key 重复注册是替换，旧 disposer 不该删掉新的', () => {
  const { reg, logs } = mk()
  const d1 = reg.register({ key: 'k', owner: 'p', text: '旧的' })

  const d2 = reg.register({ key: 'k', owner: 'p', text: '新的' })
  assert.equal(reg.size, 1, '同 key 只留一条')
  assert.equal(reg.list()[0].text, '新的')
  assert.ok(logs.some(l => l.level === 'warn'), '替换要留一条 warn，避免掩盖插件 bug')

  // 热重载时序：新注册在前、旧 disposer 在后
  d1()
  assert.equal(reg.size, 1, '旧 disposer 不该把新的删掉')
  d2()
  assert.equal(reg.size, 0)
})

test('插件引导：超长直接拒绝，不静默截断', () => {
  const { reg } = mk()
  const long = 'x'.repeat(PluginInstructions.MAX_TEXT + 1)
  assert.throws(
    () => reg.register({ key: 'k', owner: 'p', text: long }),
    /超过/,
    '截断的话插件作者会以为写进去了',
  )

  assert.throws(() => reg.register({ key: '', owner: 'p', text: 'x' }), /缺少 key/)
  assert.throws(() => reg.register({ key: 'k', owner: 'p', text: '   ' }), /text 为空/)
})

test('插件引导：全局总长有上限，但替换不重复占', () => {
  const { reg } = mk()
  const chunk = 'x'.repeat(1900)
  for (let i = 0; i < 4; i++) reg.register({ key: `k${i}`, owner: 'p', text: chunk })

  // 替换自己那条不该撞上限（旧的那段要被减掉）
  reg.register({ key: 'k0', owner: 'p', text: chunk })

  assert.throws(
    () => reg.register({ key: 'extra', owner: 'p', text: chunk }),
    /总长超过/,
    '提示词有预算，不是"多写点总没坏处"',
  )
})
