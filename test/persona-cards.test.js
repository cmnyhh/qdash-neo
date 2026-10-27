/**
 * 人格卡库：多张卡 + 当前选中 + 与静态配置的优先级。
 *
 * 这里测的是**存储与优先级**，不是 UI。三条容易写错的语义：
 *   1. 第一张卡自动设为当前（否则存完发现没生效，还得再点一次）
 *   2. 删掉当前卡时 active 要清空（回落部署层人设），不能自动跳到别的卡
 *   3. 优先级是 按群覆盖 → 当前卡 → 部署层静态人设
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Persona } from '../src/persona/index.js'
import { PersonaCards } from '../src/persona/cards.js'
import { Store } from '../src/store/db.js'

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-cards-'))
  const store = new Store(join(dir, 't.db'))
  const logs = []
  const log = (level, msg) => logs.push({ level, msg })
  try {
    return fn({ store, log, logs, dir })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('卡库：保存第一张卡会自动设为当前，再存第二张不会抢', () => {
  withStore(({ store, log }) => {
    const book = new PersonaCards({ store, log })

    const a = book.save({ name: '鲸鱼助手', text: '你是一只鲸鱼' })
    assert.equal(a.ok, true)
    assert.equal(book.all().length, 1)
    assert.equal(book.activeId(), a.card.id, '第一张卡必须自动生效')

    const b = book.save({ name: '冷面客服', text: '你只回答，不寒暄' })
    assert.equal(b.ok, true)
    assert.equal(book.all().length, 2)
    assert.equal(book.activeId(), a.card.id, '存第二张不该把当前的换掉')
  })
})

test('卡库：切换当前卡后 activeCard 跟着变；切到不存在的 id 要拒绝', () => {
  withStore(({ store, log }) => {
    const book = new PersonaCards({ store, log })
    const a = book.save({ name: 'A', text: '甲' }).card
    const b = book.save({ name: 'B', text: '乙' }).card

    assert.equal(book.activate(b.id).ok, true)
    assert.equal(book.activeCard().name, 'B')

    const bad = book.activate('nope')
    assert.equal(bad.ok, false)
    assert.match(bad.error, /不存在/)
    assert.equal(book.activeCard().name, 'B', '失败不能顺手把当前卡改掉')
  })
})

test('卡库：删掉当前卡后 active 清空（回落部署层），不自动跳到别的卡', () => {
  withStore(({ store, log }) => {
    const book = new PersonaCards({ store, log })
    const a = book.save({ name: 'A', text: '甲' }).card
    book.save({ name: 'B', text: '乙' })

    assert.equal(book.remove(a.id).ok, true)
    assert.equal(book.all().length, 1)
    assert.equal(book.activeId(), '', '删掉当前卡必须把 active 清空')
    assert.equal(book.activeCard(), null)
  })
})

test('卡库：没有名字的卡拒绝保存（列表里会变成一行空白）', () => {
  withStore(({ store, log }) => {
    const book = new PersonaCards({ store, log })
    const res = book.save({ name: '   ', text: '内容' })
    assert.equal(res.ok, false)
    assert.match(res.error, /名字/)
    assert.equal(book.all().length, 0)
  })
})

test('卡库：超过上限拒绝，且给出可操作的原因', () => {
  withStore(({ store, log }) => {
    const book = new PersonaCards({ store, log })
    for (let i = 1; i <= 20; i += 1) {
      assert.equal(book.save({ name: `卡${i}`, text: 'x' }).ok, true)
    }
    const over = book.save({ name: '第21张', text: 'x' })
    assert.equal(over.ok, false)
    assert.match(over.error, /最多存 20 张/)
  })
})

test('卡库：库里是坏 JSON 时按空库处理并留痕（不崩、不静默）', () => {
  withStore(({ store, log, logs }) => {
    store.kvSet('persona:cards', '{不是 JSON')
    const book = new PersonaCards({ store, log })
    assert.deepEqual(book.all(), [])
    assert.ok(
      logs.some(l => l.level === 'error' && l.msg.includes('人格卡库')),
      '解析失败必须进日志，否则表现为"我的卡全没了"',
    )
  })
})

test('人格：优先级是 按群覆盖 → 当前卡 → 部署层静态人设', () => {
  withStore(({ store, log }) => {
    const config = { persona: { enabled: true, text: '部署层人设', judgeHint: '' } }
    const p = new Persona({ store, config, log })
    assert.equal(p.card('g:1'), '部署层人设', '没有卡时回落静态配置')

    const a = p.book.save({ name: 'A', text: '卡 A 的内容' }).card
    assert.equal(p.card('g:1'), '卡 A 的内容')
    assert.equal(p.snapshot('g:1').source, 'card')

    p.set('g:1', '这个群专用人设')
    assert.equal(p.card('g:1'), '这个群专用人设', '按群覆盖优先级最高')
    assert.equal(p.snapshot('g:1').source, 'kv')

    p.clear('g:1')
    assert.equal(p.card('g:1'), '卡 A 的内容')

    assert.equal(p.snapshot('g:1').activeId, a.id, '取消选中前快照应指向当前卡')

    p.book.activate('')
    assert.equal(p.card('g:1'), '部署层人设')
    assert.equal(p.book.activeId(), '')
    assert.equal(p.snapshot('g:1').activeId, '')
  })
})

test('别名：跟着卡走，换卡就换一组；卡里没写才回落配置兜底', () => {
  withStore(({ store, log }) => {
    const config = { persona: { enabled: true }, identity: { aliases: ['兜底名'] } }
    const p = new Persona({ store, config, log })
    assert.deepEqual(p.aliases(), ['兜底名'], '没选卡时用兜底')

    const a = p.book.save({ name: 'A', text: '甲', aliases: ['小白', '鲸鱼'] }).card
    assert.deepEqual(p.aliases(), ['小白', '鲸鱼'])

    const b = p.book.save({ name: 'B', text: '乙', aliases: ['客服酱'] }).card
    p.book.activate(b.id)
    assert.deepEqual(p.aliases(), ['客服酱'], '换卡即换别名')

    p.book.activate('')
    assert.deepEqual(p.aliases(), ['兜底名'], '取消选卡回落兜底')
    assert.ok(a.id)
  })
})

test('别名：单字、重复、超长一律被清掉（否则"我"会被当成点名）', () => {
  withStore(({ store, log }) => {
    const p = new Persona({ store, config: { persona: { enabled: true } }, log })
    p.book.save({ name: 'C', text: '丙', aliases: ['鲸', '鲸鱼', '鲸鱼', '  ', 'x'.repeat(30)] })
    assert.deepEqual(p.aliases(), ['鲸鱼'])
  })
})

test('别名：人格开关关着也照样生效（它管路由，不管 prompt）', () => {
  withStore(({ store, log }) => {
    const p = new Persona({ store, config: { persona: { enabled: false } }, log })
    p.book.save({ name: 'D', text: '丁', aliases: ['小D'] })
    assert.equal(p.card('g:1'), '', '人设不注入')
    assert.deepEqual(p.aliases(), ['小D'], '但"叫名字"要还认得')
  })
})

test('人格：开关关着时卡内容不生效（但卡还在）', () => {
  withStore(({ store, log }) => {
    const p = new Persona({ store, config: { persona: { enabled: false, text: '', judgeHint: '' } }, log })
    p.book.save({ name: 'A', text: '卡 A' })
    assert.equal(p.card('g:1'), '')
    assert.equal(p.hint('g:1'), '')
    assert.equal(p.book.all().length, 1, '关掉开关不该删卡')
  })
})

test('人格：卡的摘要优先于角色卡全文，没摘要就回落全文（单一真相源）', () => {
  withStore(({ store, log }) => {
    const p = new Persona({ store, config: { persona: { enabled: true, text: '', judgeHint: '' } }, log })
    p.book.save({ name: '有摘要', text: '很长的身世外貌口癖', hint: '话少但护短' })
    assert.equal(p.hint('g:1'), '话少但护短')

    p.book.activate('')
    p.book.save({ name: '没摘要', text: '很长的人设' })
    assert.equal(p.hint('g:1'), '很长的人设', '没摘要时用全文，避免摘要过期')
  })
})
