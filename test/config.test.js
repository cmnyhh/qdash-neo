/**
 * 运行层配置单测：`node --test test/config.test.js`
 *
 * 这里的 schema 是**手搓的假 schemastery**，不是真包：
 *   1. 仓库不依赖 `@deepseek-ai/schemastery`（它是宿主的 peer），测试里拿不到
 *   2. 我们只依赖它四个公开行为：可调用、`dict`、`meta`、`inner`、`toString()`
 *      —— 这四条已用真包实测过（见 docs 记的 2026-10-26 结论）
 *
 * 重点不在"函数能跑"，而在四条容易事后翻车的语义：
 *   - 没用户层时 effective() 必须与 base 逐字段相等（否则上线即行为漂移）
 *   - 锁的判定（base ≠ 默认值）
 *   - 校验失败**不落库**（写一半的配置比不写更糟）
 *   - 改回默认值时删键，而不是存一份和默认值一样的垃圾
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConfigError, ConfigStore } from '../src/config/runtime.js'
import { Store } from '../src/store/db.js'

// ---------------- 假 schema（形状与真 schemastery 一致） ----------------

function leaf(type, meta = {}, extra = {}) {
  return { type, meta, toString: () => '', ...extra }
}

function objectNode(dict, description = '') {
  return { type: 'object', meta: { description }, dict }
}

function resolve(node, input) {
  if (node.type !== 'object') return input
  const out = {}
  for (const [k, child] of Object.entries(node.dict)) {
    const has = input && Object.prototype.hasOwnProperty.call(input, k)
    const v = has ? input[k] : undefined
    if (child.type === 'object') {
      out[k] = resolve(child, v ?? {})
      continue
    }
    if (v === undefined) {
      out[k] = child.meta?.default === undefined ? undefined : structuredClone(child.meta.default)
      continue
    }
    // 刻意做一点真校验：非法类型必须被拒，否则测不出"校验失败不落库"
    if (child.type === 'boolean' && typeof v !== 'boolean') throw new Error(`${k} 必须是布尔值`)
    if (child.type === 'number' && typeof v !== 'number') throw new Error(`${k} 必须是数字`)
    if (child.type === 'string' && typeof v !== 'string') throw new Error(`${k} 必须是字符串`)
    if (child.type === 'array' && !Array.isArray(v)) throw new Error(`${k} 必须是数组`)
    if (child.type === 'union') {
      const allowed = [...String(child.toString()).matchAll(/"([^"]*)"/g)].map(m => m[1])
      if (!allowed.includes(v)) throw new Error(`${k} 取值非法：${v}`)
    }
    out[k] = structuredClone(v)
  }
  return out
}

function makeSchema() {
  const root = v => resolve(root, v ?? {})
  root.type = 'object'
  root.meta = { description: '测试配置' }
  root.dict = {
    onebot: objectNode({
      wsUrl: leaf('string', { default: 'ws://127.0.0.1:3001', description: 'WS 地址' }),
      token: leaf('string', { default: '', role: 'secret' }),
      // selfId 会被挪进「身份与人格」，这里要有它才测得到
      selfId: leaf('string', { default: '' }),
    }, 'OneBot 连接'),
    policy: objectNode({
      whitelist: leaf('array', { default: [], description: '私聊白名单' }, { inner: { type: 'string' } }),
      groupEnabled: leaf('boolean', { default: false }),
      groupTrigger: leaf('union', { default: 'mention' }, { toString: () => '"mention" | "all" | "judge"' }),
      quota: leaf('number', { default: 3 }),
    }, '准入策略'),
    // 「身份」与人格在控制台上合成一组；identity 只有 aliases（现已归人格卡，不上表单）
    identity: objectNode({ aliases: leaf('array', { default: [] }, { inner: { type: 'string' } }) }, '机器人身份'),
    persona: objectNode(
      {
        enabled: leaf('boolean', { default: false }),
        text: leaf('string', { default: '' }),
        judgeHint: leaf('string', { default: '' }),
      },
      '人格',
    ),
    // 只用来验证 applies=restart 档位（库路径换不了热的）
    store: objectNode({ path: leaf('string', { default: '' }) }, '存储'),
  }
  return root
}

const BASE = makeSchema()({})

function withStore(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-cfg-'))
  const store = new Store(join(dir, 't.db'))
  const logs = []
  const cs = new ConfigStore({
    schema: over.schema === undefined ? makeSchema() : over.schema,
    base: over.base ?? BASE,
    store: over.store === undefined ? store : over.store,
    log: (level, msg) => logs.push({ level, msg }),
  })
  return {
    cs,
    store,
    logs,
    dispose() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ---------------- 合并与锁 ----------------

test('配置：没有用户层时 effective() 与 base 逐字段相等（上线不漂移）', () => {
  const c = withStore()
  try {
    assert.deepEqual(c.cs.effective(), BASE)
    assert.equal(c.cs.revision, 0)
    const d = c.cs.describe()
    assert.equal(d.writable, true)
    // 所有字段都应标记为 default 来源，且没有锁
    const fields = d.groups.flatMap(g => g.fields)
    assert.ok(fields.length >= 5)
    assert.equal(fields.every(f => f.locked === false && f.source === 'default'), true)
  } finally {
    c.dispose()
  }
})

test('配置：base 与默认值不同 ⇒ 该字段被锁，来源标 deploy', () => {
  const base = { ...BASE, policy: { ...BASE.policy, whitelist: ['10001'] } }
  const c = withStore({ base })
  try {
    const d = c.cs.describe()
    const f = d.groups.flatMap(g => g.fields).find(x => x.path === 'policy.whitelist')
    assert.equal(f.locked, true)
    assert.equal(f.source, 'deploy')
    assert.deepEqual(f.value, ['10001'])
    // 没被覆盖的字段仍然可改
    const other = d.groups.flatMap(g => g.fields).find(x => x.path === 'policy.groupEnabled')
    assert.equal(other.locked, false)
  } finally {
    c.dispose()
  }
})

test('配置：锁字段拒绝写入，并指出是哪些字段', () => {
  const base = { ...BASE, policy: { ...BASE.policy, groupTrigger: 'judge' } }
  const c = withStore({ base })
  try {
    assert.throws(
      () => c.cs.update({ patch: { 'policy.groupTrigger': 'all' }, revision: 0 }),
      err => {
        assert.ok(err instanceof ConfigError)
        assert.equal(err.code, 'config-locked')
        assert.deepEqual(err.fields, ['policy.groupTrigger'])
        return true
      },
    )
    assert.equal(c.cs.revision, 0)
  } finally {
    c.dispose()
  }
})

// ---------------- 写入 ----------------

test('配置：改未锁字段 → 立即生效、落 kv、revision 递增', () => {
  const c = withStore()
  try {
    const r = c.cs.update({ patch: { 'policy.groupEnabled': true, 'policy.whitelist': ['7'] }, revision: 0 })
    assert.equal(r.revision, 1)
    assert.equal(r.changed.length, 2)
    assert.equal(c.cs.effective().policy.groupEnabled, true)
    assert.deepEqual(c.cs.effective().policy.whitelist, ['7'])
    assert.equal(c.store.kvGet('cfg:policy.groupEnabled'), 'true')
    assert.equal(c.store.kvGet('cfg:revision'), '1')
    // 新实例（模拟重启）能读回来
    const again = new ConfigStore({ schema: makeSchema(), base: BASE, store: c.store })
    assert.equal(again.revision, 1)
    assert.equal(again.effective().policy.groupEnabled, true)
  } finally {
    c.dispose()
  }
})

test('配置：改回默认值 → 删掉覆盖键，而不是存一份和默认值一样的值', () => {
  const c = withStore()
  try {
    c.cs.update({ patch: { 'policy.groupEnabled': true }, revision: 0 })
    assert.equal(c.store.kvGet('cfg:policy.groupEnabled'), 'true')
    c.cs.update({ patch: { 'policy.groupEnabled': false }, revision: 1 })
    assert.equal(c.store.kvGet('cfg:policy.groupEnabled'), null, '改回默认值必须撤销覆盖')
    assert.equal(c.cs.effective().policy.groupEnabled, false)
  } finally {
    c.dispose()
  }
})

test('配置：revision 不匹配 → 409，不动任何值', () => {
  const c = withStore()
  try {
    c.cs.update({ patch: { 'policy.groupEnabled': true }, revision: 0 })
    assert.throws(
      () => c.cs.update({ patch: { 'policy.groupEnabled': false }, revision: 0 }),
      err => {
        assert.equal(err.code, 'config-conflict')
        assert.equal(err.status, 409)
        return true
      },
    )
    assert.equal(c.cs.effective().policy.groupEnabled, true, '冲突时不能半写')
  } finally {
    c.dispose()
  }
})

test('配置：非法值 → 400 且不落库（写一半比不写更糟）', () => {
  const c = withStore()
  try {
    assert.throws(
      () => c.cs.update({ patch: { 'policy.groupTrigger': '瞎写的档位' }, revision: 0 }),
      err => {
        assert.equal(err.code, 'config-invalid')
        return true
      },
    )
    assert.equal(c.cs.revision, 0)
    assert.equal(c.store.kvGet('cfg:policy.groupTrigger'), null)
    assert.equal(c.cs.effective().policy.groupTrigger, 'mention')
  } finally {
    c.dispose()
  }
})

test('配置：未知字段被拒（拼错路径不能被静默忽略）', () => {
  const c = withStore()
  try {
    assert.throws(
      () => c.cs.update({ patch: { 'policy.whitelistt': ['1'] }, revision: 0 }),
      err => {
        assert.equal(err.code, 'config-unknown-field')
        assert.deepEqual(err.fields, ['policy.whitelistt'])
        return true
      },
    )
  } finally {
    c.dispose()
  }
})

test('配置：密钥字段不回显，只回答"设没设"；空串表示不改', () => {
  const base = { ...BASE, onebot: { ...BASE.onebot, token: 'secret-token' } }
  const c = withStore({ base })
  try {
    const f = c.cs.describe().groups.flatMap(g => g.fields).find(x => x.path === 'onebot.token')
    assert.equal(f.type, 'secret')
    assert.equal(f.hasValue, true)
    assert.equal('value' in f, false, '响应体里绝不能出现口令')
    // 空串 = 不改（表单重设时才传新值）
    const r = c.cs.update({ patch: { 'onebot.token': '' }, revision: 0 })
    assert.equal(r.changed.length, 0)
    assert.equal(c.cs.describe().groups.flatMap(g => g.fields).find(x => x.path === 'onebot.token').hasValue, true)
  } finally {
    c.dispose()
  }
})

test('配置审计：密钥字段只记 ***，不落明文', () => {
  const c = withStore()
  try {
    c.cs.update({ patch: { 'onebot.token': 'super-secret-value' }, revision: 0, actor: 'tester' })
    const rows = c.cs.audit(10)
    const row = rows.find(r => r.path === 'onebot.token')
    assert.ok(row, '审计要记得"改过"这个事实')
    // 审计表是给控制台看的：存明文等于把口令和 token 摊在页面上
    assert.equal(row.from, '"***"')
    assert.equal(row.to, '"***"')
    assert.equal(JSON.stringify(rows).includes('super-secret-value'), false)
  } finally {
    c.dispose()
  }
})

test('配置：分组按使用者的心智模型归，重组不丢字段也不重复', () => {
  const c = withStore()
  try {
    const d = c.cs.describe()
    const keys = d.groups.map(g => g.key)
    const flat = d.groups.flatMap(g => g.fields)
    const byKey = new Map(d.groups.map(g => [g.key, g]))
    const pathsOf = key => (byKey.get(key)?.fields ?? []).map(f => f.path)

    // 原来按段名分组，identity / onebot 各自成页；现在按用途归
    assert.equal(keys.includes('identity'), false, 'identity 不该单独占一页导航')
    assert.equal(keys.includes('onebot'), false, 'onebot 只剩两个字段，不该独立成页')

    // 机器人 QQ 号与连接参数同组：都是"怎么连上、以谁的身份"
    assert.ok(pathsOf('connect').includes('onebot.selfId'))
    assert.ok(pathsOf('connect').includes('onebot.wsUrl'))

    // 人格组仍叫 persona（前端靠这个 key 渲染专用编辑器）
    assert.equal(byKey.get('persona').label, '人格与提示')
    assert.ok(pathsOf('persona').includes('persona.enabled'))

    // 兜底别名归人格卡，不上表单（否则用户分不清哪份生效）
    assert.equal(flat.some(f => f.path === 'identity.aliases'), false)

    // 重组的两条不变式：路径唯一、一个都没少
    const paths = flat.map(f => f.path)
    assert.equal(new Set(paths).size, paths.length, '同一个字段不能出现在两个组里')
    const declared = c.cs.fields.filter(f => f.path !== 'identity.aliases').map(f => f.path)
    assert.deepEqual([...paths].sort(), [...declared].sort(), '重组不能丢字段')
  } finally {
    c.dispose()
  }
})

test('配置：生效档位分三档（live / reconnect / restart），不假装能热改也不一律锁死', () => {
  const c = withStore()
  try {
    const fields = c.cs.describe().groups.flatMap(g => g.fields)
    // OneBot 三件套：保存后自动重连，不再是"需重启 + 字段变灰"
    assert.equal(fields.find(f => f.path === 'onebot.wsUrl').applies, 'reconnect')
    assert.equal(fields.find(f => f.path === 'policy.groupEnabled').applies, 'live')
    // 库路径这类真没法热换的，仍然明确标 restart
    assert.equal(fields.find(f => f.path === 'store.path').applies, 'restart')
  } finally {
    c.dispose()
  }
})

test('配置：union 字段带可选值（前端据此画下拉）', () => {
  const c = withStore()
  try {
    const f = c.cs.describe().groups.flatMap(g => g.fields).find(x => x.path === 'policy.groupTrigger')
    assert.equal(f.type, 'enum')
    assert.deepEqual(f.options, ['mention', 'all', 'judge'])
  } finally {
    c.dispose()
  }
})

// ---------------- 审计与降级 ----------------

test('配置：每次变更写审计（谁、哪个字段、从什么到什么）', () => {
  const c = withStore()
  try {
    c.cs.update({ patch: { 'policy.groupEnabled': true }, revision: 0, actor: '127.0.0.1' })
    c.cs.update({ patch: { 'policy.quota': 5 }, revision: 1, actor: '127.0.0.1' })
    const rows = c.store.listConfigAudit(10)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(r => r.path).sort(), ['policy.groupEnabled', 'policy.quota'])
    const quota = rows.find(r => r.path === 'policy.quota')
    assert.equal(quota.from, '3')
    assert.equal(quota.to, '5')
    assert.equal(quota.actor, '127.0.0.1')
    // 审计尾部随 describe 一起给前端
    assert.equal(c.cs.audit(5).length, 2)
  } finally {
    c.dispose()
  }
})

test('配置：没有 store 时 writable=false 且写入 503（不给"改了没生效"的错觉）', () => {
  const cs = new ConfigStore({ schema: makeSchema(), base: BASE, store: null, log: () => {} })
  assert.equal(cs.writable, false)
  assert.equal(cs.describe().writable, false)
  assert.throws(
    () => cs.update({ patch: { 'policy.groupEnabled': true }, revision: 0 }),
    err => {
      assert.equal(err.code, 'config-not-ready')
      assert.equal(err.status, 503)
      return true
    },
  )
  // 内存里仍然能算 effective（只读展示不该 503）
  assert.deepEqual(cs.effective(), BASE)
})

test('配置：attachStore 之后能接上（控制台先建、service.start 后才有 DB）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-cfg2-'))
  const store = new Store(join(dir, 't.db'))
  try {
    const cs = new ConfigStore({ schema: makeSchema(), base: BASE, store: null })
    assert.equal(cs.writable, false)
    cs.attachStore(store)
    assert.equal(cs.writable, true)
    cs.update({ patch: { 'policy.quota': 9 }, revision: 0 })
    assert.equal(store.kvGet('cfg:policy.quota'), '9')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：schema 缺失时降级为"全部可改"并留痕（不抛）', () => {
  const c = withStore({ schema: null })
  try {
    const d = c.cs.describe()
    assert.deepEqual(d.groups, [])
    assert.equal(c.logs.some(l => l.level === 'warn'), true)
    assert.deepEqual(c.cs.effective(), BASE)
  } finally {
    c.dispose()
  }
})
