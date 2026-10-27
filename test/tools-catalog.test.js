/**
 * 工具目录的纯判定层。
 *
 * 这里守的是**安全边界**：高危工具无论在配置里怎么写都不能进白名单，
 * 而"配了但当前 profile 没有"的项必须变成留痕而不是抛错
 * （`tools.restrict` 对未知名字会抛，那会让整个会话建不起来）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DENY_PATTERNS,
  QQ_TOOL_NAMES,
  QQ_TOOLS,
  isDenied,
  isSafeInternal,
  qqToolsOf,
  resolveAllowed,
} from '../src/tools/catalog.js'

test('工具目录：QQ 工具名唯一、都有分组与说明', () => {
  const names = QQ_TOOLS.map(t => t.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const t of QQ_TOOLS) {
    assert.ok(t.title, `${t.name} 缺标题`)
    assert.ok(t.description, `${t.name} 缺说明`)
    assert.ok(['read', 'write', 'admin'].includes(t.group), `${t.name} 分组非法`)
  }
  // 写类必须标 sideEffect，否则出站侧没法判断"本回合已经发过消息"
  for (const t of QQ_TOOLS.filter(t => t.group !== 'read')) {
    assert.equal(t.sideEffect, true, `${t.name} 写类工具必须标 sideEffect`)
  }
})

test('工具目录：踢人归管理组（默认不在读/写组）', () => {
  assert.equal(qqToolsOf('admin').includes('qq_kick'), true)
  assert.equal(qqToolsOf('read').includes('qq_kick'), false)
  assert.equal(qqToolsOf('write').includes('qq_kick'), false)
})

test('高危判定：bash / pwsh / 写文件 / subagent 一律拒绝', () => {
  for (const name of [
    'bash',
    'bash_persistent',
    'pwsh',
    'terminal',
    'str_replace_editor',
    'fs_write',
    'fs_delete',
    'subagent',
    'subagent_control',
    'workflow',
    'ralph',
    'cordis',
  ]) {
    assert.equal(isDenied(name), true, `${name} 应该被拒`)
  }
  // 只读类不该被误杀
  for (const name of ['fs_read', 'fs_search', 'web_search', 'todo', 'ask_user']) {
    assert.equal(isDenied(name), false, `${name} 不该被误杀`)
  }
  // 自家 QQ 工具不受内置高危名单影响
  for (const name of QQ_TOOL_NAMES) assert.equal(isDenied(name), false, `${name} 被误判成高危`)
})

test('高危判定：名字为空按拒绝处理（宁可不给）', () => {
  assert.equal(isDenied(''), true)
  assert.equal(isDenied(null), true)
})

test('安全内置：只读类进默认白名单，执行类不进', () => {
  for (const name of ['fs_read', 'fs_list', 'web_fetch', 'todo', 'goal', 'session_query']) {
    assert.equal(isSafeInternal(name), true, `${name} 应该算安全项`)
  }
  for (const name of ['bash', 'fs_write', 'str_replace_editor']) {
    assert.equal(isSafeInternal(name), false, `${name} 不该算安全项`)
  }
})

test('白名单求交集：与真实清单求交，缺的进 missing 而不是让 restrict 抛错', () => {
  const available = ['fs_read', 'web_search', 'todo', 'bash', 'mcp__foo__bar']
  const r = resolveAllowed({
    available,
    qqGroups: { read: true, write: true, admin: false },
    internalAllow: ['todo', 'fs_write'], // fs_write 高危，todo 已在安全项里
    externalAllow: ['mcp__foo__bar', 'mcp__ghost__tool'], // 后者当前不存在
  })

  // 高危即便被勾选也不出现
  assert.equal(r.allow.includes('fs_write'), false)
  assert.equal(r.allow.includes('bash'), false)
  assert.equal(r.denied.includes('fs_write'), true)

  // 只读内置自动进白名单
  assert.equal(r.allow.includes('fs_read'), true)
  assert.equal(r.allow.includes('web_search'), true)

  // 外部工具：存在的进白名单，不存在的进 missing
  assert.equal(r.allow.includes('mcp__foo__bar'), true)
  assert.equal(r.missing.includes('mcp__ghost__tool'), true)

  // QQ 工具永远认为自己"存在"（由插件注册），不进 missing
  assert.equal(r.allow.includes('qq_get_image'), true)
  assert.equal(r.missing.some(n => n.startsWith('qq_')), false)
})

test('白名单：关掉读/写分组后对应 QQ 工具消失，踢人默认不在', () => {
  const base = resolveAllowed({ available: [] })
  assert.equal(base.allow.includes('qq_get_image'), true, '读能力默认开')
  assert.equal(base.allow.includes('qq_send_message'), true, '写能力默认开')
  assert.equal(base.allow.includes('qq_kick'), false, '管理能力默认关')

  const readOnly = resolveAllowed({ available: [], qqGroups: { read: true, write: false } })
  assert.equal(readOnly.allow.includes('qq_get_image'), true)
  assert.equal(readOnly.allow.includes('qq_send_message'), false)

  const admin = resolveAllowed({ available: [], qqGroups: { admin: true } })
  assert.equal(admin.allow.includes('qq_kick'), true, '显式打开管理能力后才出现')
})

test('白名单：全部关闭时只剩空集，不会"因为没配所以全给"', () => {
  const r = resolveAllowed({
    available: ['fs_read', 'web_search'],
    qqGroups: { read: false, write: false, admin: false },
    includeSafeInternal: false,
    internalAllow: [],
    externalAllow: [],
  })
  assert.deepEqual(r.allow, [])
  assert.deepEqual(r.missing, [])
})

test('DENY_PATTERNS 覆盖到名字变体（不能靠精确名清单）', () => {
  assert.ok(DENY_PATTERNS.some(re => re.test('bash') && re.test('BASH')))
  assert.ok(DENY_PATTERNS.some(re => re.test('pwsh_persistent')))
})
