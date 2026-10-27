import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PluginSettings } from '../src/plugin/settings.js'
import { PluginStorage } from '../src/plugin/storage.js'
import { Store } from '../src/store/db.js'

/**
 * 插件存储与运行时配置的测试重点：
 *
 *   1. **命名空间隔离** —— 插件 A 不能读写插件 B 的数据，更不能碰到内核的 `cfg:policy.*`
 *   2. **名字校验** —— 插件名会进键前缀，不校验就等于允许拼 SQL / 拼出别人的前缀
 *   3. **LIKE 通配坑** —— `kvList` 是 `LIKE '前缀%'`，而 `_` 在 LIKE 里是单字符通配符
 *   4. 存储未就绪时给**可读错误**，不是 `Cannot read property of null`
 */

function mkStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-plug-'))
  const store = new Store(join(dir, 'p.db'))
  return {
    store,
    done: () => {
      try {
        store.close?.()
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

/* ---------------- storage ---------------- */

test('插件存储：基本读写与 JSON 往返', () => {
  const { store, done } = mkStore()
  try {
    const s = new PluginStorage({ getStore: () => store }).forFeature('todo')
    assert.equal(s.get('none'), null)
    assert.equal(s.get('none', 'fb'), 'fb')

    s.set('a', { list: [1, 2], ok: true })
    assert.deepEqual(s.get('a'), { list: [1, 2], ok: true })

    s.set('n', 0)
    assert.equal(s.get('n'), 0, '0 不能被当成"没存过"')

    s.del('a')
    assert.equal(s.get('a'), null)
  } finally {
    done()
  }
})

test('插件存储：名字不合法直接拒绝（名字会进键前缀）', () => {
  const st = new PluginStorage({ getStore: () => null })
  for (const bad of ['', 'A', '1abc', 'a b', 'a:b', 'a;drop', 'x'.repeat(33)]) {
    assert.throws(() => st.forFeature(bad), /不合法/, `「${bad}」应该被拒`)
  }
  assert.ok(st.forFeature('todo_list_2'), '合法名字要能注册')
})

test('插件存储：键里的 % 被拒绝（kvList 走 LIKE）', () => {
  const { store, done } = mkStore()
  try {
    const s = new PluginStorage({ getStore: () => store }).forFeature('todo')
    assert.throws(() => s.set('a%b', 1), /%/)
  } finally {
    done()
  }
})

test('插件存储：命名空间隔离，下划线名字不会被 LIKE 通配串到', () => {
  const { store, done } = mkStore()
  try {
    const st = new PluginStorage({ getStore: () => store })
    const a = st.forFeature('todo_list')
    // 名字全小写才合法，所以用 todozlist 模拟 LIKE 里的 `_` 命中同长度名字
    const b = st.forFeature('todozlist')

    a.set('k', 'A')
    b.set('k', 'B')

    assert.equal(a.get('k'), 'A')
    assert.equal(b.get('k'), 'B')
    assert.deepEqual(
      a.list().map(x => x.key),
      ['k'],
      'a 只能看到自己的键 —— 否则别人的数据会串进来',
    )
  } finally {
    done()
  }
})

test('插件存储：list 与 clear 只影响自己', () => {
  const { store, done } = mkStore()
  try {
    const st = new PluginStorage({ getStore: () => store })
    const a = st.forFeature('aaa')
    const b = st.forFeature('bbb')
    a.set('x', 1)
    a.set('y', 2)
    b.set('x', 9)

    assert.deepEqual(a.list().map(i => i.key).sort(), ['x', 'y'])
    assert.equal(a.clear(), 2)
    assert.deepEqual(a.list(), [])
    assert.equal(b.get('x'), 9, 'clear 不能碰别人的数据')
  } finally {
    done()
  }
})

test('插件存储：store 未就绪时报可读错误', () => {
  const s = new PluginStorage({ getStore: () => null }).forFeature('todo')
  assert.throws(() => s.get('a'), /存储未就绪/)
  assert.throws(() => s.set('a', 1), /存储未就绪/)
})

/* ---------------- settings ---------------- */

test('插件 settings：默认值 + 增量写 + reset', () => {
  const { store, done } = mkStore()
  try {
    const reg = new PluginSettings({ getStore: () => store })
    const s = reg.register({ plugin: 'demo', key: 'ui', defaults: { a: 1, b: 'x' } })

    assert.deepEqual(s.get(), { a: 1, b: 'x' }, '没写过时是默认值')
    s.set({ a: 2 })
    assert.deepEqual(s.get(), { a: 2, b: 'x' }, '增量合并，没传的保持原值')
    s.reset()
    assert.deepEqual(s.get(), { a: 1, b: 'x' }, 'reset 回到默认')
  } finally {
    done()
  }
})

test('插件 settings：schema 校验在写入时就拦，不是等下次读', () => {
  const { store, done } = mkStore()
  try {
    const reg = new PluginSettings({ getStore: () => store })
    // 用一个最小的假 schema：超过 10 就拒，缺省补 1
    const schema = v => {
      const n = Number(v?.n ?? 1)
      if (n > 10) throw new Error('太大')
      return { n }
    }
    const s = reg.register({ plugin: 'demo', key: 'limit', schema })

    assert.deepEqual(s.get(), { n: 1 }, 'schema 要能补默认值')
    assert.deepEqual(s.set({ n: 5 }), { n: 5 })
    assert.throws(() => s.set({ n: 99 }), /太大/, '非法值要在写的时候炸')
    assert.deepEqual(s.get(), { n: 5 }, '写入失败不能污染已存的值')
  } finally {
    done()
  }
})

test('插件 settings：和内核的 cfg:* 命名空间隔离', () => {
  const { store, done } = mkStore()
  try {
    store.kvSet('cfg:policy.replyChance', '0.95')
    const reg = new PluginSettings({ getStore: () => store })
    const s = reg.register({ plugin: 'demo', key: 'policy.replyChance', defaults: { nope: true } })

    assert.equal(s.get().nope, true, '插件读到的是自己那一份')
    s.set({ nope: false })
    assert.equal(store.kvGet('cfg:policy.replyChance'), '0.95', '插件的写不能覆盖内核配置')
  } finally {
    done()
  }
})

test('插件 settings：名字和 key 不合法直接拒', () => {
  const reg = new PluginSettings({ getStore: () => null })
  assert.throws(() => reg.register({ plugin: 'Demo', key: 'x' }), /不合法/)
  assert.throws(() => reg.register({ plugin: 'demo', key: 'a b' }), /不合法/)
  assert.throws(() => reg.register({ plugin: 'demo', key: '' }), /不合法/)
})

test('插件 settings：存坏的 JSON 时退回默认值，不让插件起不来', () => {
  const { store, done } = mkStore()
  try {
    store.kvSet('cfg:demo:ui', '{ 这不是 json')
    const reg = new PluginSettings({ getStore: () => store, log: () => {} })
    const s = reg.register({ plugin: 'demo', key: 'ui', defaults: { a: 1 } })
    assert.deepEqual(s.get(), { a: 1 })
  } finally {
    done()
  }
})

/* ---------------- storage.dir ---------------- */

test('插件目录：跟着 DSH_HOME 走，自动创建', () => {
  const home = mkdtempSync(join(tmpdir(), 'qdn-home-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const st = new PluginStorage({ getStore: () => null })
    const d = st.dir('todo')
    assert.ok(existsSync(d), '目录要真的建出来')
    assert.ok(d.startsWith(home), '必须落在 DSH_HOME 下，不能跑到 cwd 里')
    assert.ok(d.endsWith(join('qdash-plugins', 'todo')))

    const sub = st.dir('todo', 'mp3')
    assert.ok(existsSync(sub))
    assert.ok(sub.startsWith(d), '子目录要在插件目录里')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('插件目录：子目录不能跳出，名字必须合法', () => {
  const st = new PluginStorage({ getStore: () => null })
  for (const bad of ['..', '../x', 'a/b', '.']) {
    assert.throws(() => st.dir('todo', bad), /不合法/, `子目录「${bad}」应该被拒`)
  }
  assert.throws(() => st.dir('Todo'), /不合法/, '名字不转小写，大写要报错')
  assert.throws(() => st.dir('a;drop'), /不合法/)
})
