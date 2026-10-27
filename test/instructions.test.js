/**
 * AGENTS.md 同步。
 *
 * 这里守的核心是**两个块的所有权分离**：用户内容块可以被清空，但插件规则块
 * 必须独立存活 —— 否则"用户清空系统提示"会顺手删掉 `[[SILENT]]` 约定与
 * `memory_add` 引导，功能静默失效且没有任何报错。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BLOCK_BEGIN,
  BLOCK_END,
  MEMORY_RULE,
  RULES_BEGIN,
  RULES_END,
  SILENT_RULE,
  SEND_RULE,
  renderBlock,
  renderInstructionsBlock,
  renderRulesBlock,
  syncInstructions,
} from '../src/session/instructions.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-instr-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('指令块：用户文本为空时不产生用户块', () => {
  assert.equal(renderInstructionsBlock(''), '')
  assert.equal(renderInstructionsBlock('   '), '')
  assert.equal(renderInstructionsBlock('你是鲸鱼').includes(BLOCK_BEGIN), true)
})

test('指令块：规则块独立于用户文本（两个都关才为空）', () => {
  // 发送规则**无条件**写：模型不知道「正文不发」就会把话丢在落库里
  const alwaysOn = renderRulesBlock({ silentRule: false, memoryRule: false })
  assert.equal(alwaysOn.includes(SEND_RULE), true, '这条不跟开关走')
  assert.equal(alwaysOn.includes(MEMORY_RULE), false, '可关的仍然可关')
  const only = renderRulesBlock({ silentRule: true })
  assert.equal(only.includes(RULES_BEGIN), true)
  assert.equal(only.includes(SILENT_RULE), true)
  assert.equal(only.includes(MEMORY_RULE), false, '没开记忆就不该有记忆引导')
  // 块内要有"会覆盖"的提示，手改之前就能看到
  assert.match(only, /自动维护/)
})

test('指令同步：两个块都写入，块外内容原样保留', () =>
  withDir(dir => {
    writeFileSync(join(dir, 'AGENTS.md'), '# 我自己的说明\n\n别动这段。\n', 'utf8')

    const r = syncInstructions({
      cwd: dir,
      text: '单次发言控制在 30 字内',
      silentRule: true,
      memoryRule: true,
    })
    assert.equal(r.ok, true)
    assert.equal(r.action, 'updated')

    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.match(text, /# 我自己的说明/, '用户手写内容必须保留')
    assert.match(text, /别动这段/)
    assert.ok(text.includes(BLOCK_BEGIN) && text.includes(BLOCK_END), '用户块')
    assert.ok(text.includes(RULES_BEGIN) && text.includes(RULES_END), '规则块')
    assert.match(text, /30 字内/)
    assert.match(text, /\[\[SILENT\]\]/)
    assert.match(text, /memory_add/)
  }))

test('指令同步：清空系统提示只删用户块，规则块必须留下（回归）', () =>
  withDir(dir => {
    // 先写全
    syncInstructions({ cwd: dir, text: '先写一段', silentRule: true, memoryRule: true })
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.ok(before.includes(BLOCK_BEGIN))

    // 再清空用户文本
    const r = syncInstructions({ cwd: dir, text: '', silentRule: true, memoryRule: true })
    assert.equal(r.ok, true)

    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.equal(after.includes(BLOCK_BEGIN), false, '用户块该被删掉')
    assert.equal(after.includes('先写一段'), false)
    // 这是重点：清空用户提示不该连功能规则一起删
    assert.ok(after.includes(RULES_BEGIN), '规则块必须独立存活')
    assert.match(after, /\[\[SILENT\]\]/)
    assert.match(after, /memory_add/)
  }))

test('指令同步：规则全关 + 用户文本为空 → 文件被清空而不是留空块', () =>
  withDir(dir => {
    syncInstructions({ cwd: dir, text: 'x', silentRule: true, memoryRule: true })
    const r = syncInstructions({ cwd: dir, text: '', silentRule: false, memoryRule: false })
    assert.equal(r.ok, true)
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.equal(text.includes(SILENT_RULE), false, '可关的块要消失')
    assert.equal(text.includes(SEND_RULE), true, '发送规则常驻，不随开关走')
  }))

test('指令同步：内容没变时是 unchanged，不重复写盘', () =>
  withDir(dir => {
    const args = { cwd: dir, text: '一样的', silentRule: true, memoryRule: true }
    const first = syncInstructions(args)
    assert.equal(first.action, 'created')
    const second = syncInstructions(args)
    assert.equal(second.action, 'unchanged')
    // 反复同步不该攒空行
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('\n\n\n'), false)
  }))

test('指令同步：目录不存在时自动创建', () =>
  withDir(dir => {
    const nested = join(dir, 'a', 'b')
    const r = syncInstructions({ cwd: nested, text: 'hi', silentRule: false, memoryRule: false })
    assert.equal(r.ok, true)
    assert.equal(existsSync(join(nested, 'AGENTS.md')), true)
  }))

test('指令同步：cwd 为空返回失败而不是抛错', () => {
  const r = syncInstructions({ cwd: '', text: 'x' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /cwd/)
})

test('renderBlock 兼容入口：用户块在前、规则块在后', () => {
  const both = renderBlock('我的设定', { silentRule: true, memoryRule: false })
  assert.ok(both.indexOf(BLOCK_BEGIN) < both.indexOf(RULES_BEGIN))
  assert.equal(both.includes(MEMORY_RULE), false)
})

test('指令同步：无论文件原有顺序如何，同步后固定为「用户块 → 规则块」', () =>
  withDir(dir => {
    // 手写一个反序的文件（规则块在前）
    writeFileSync(
      join(dir, 'AGENTS.md'),
      `${RULES_BEGIN}\n旧规则\n${RULES_END}\n\n${BLOCK_BEGIN}\n旧设定\n${BLOCK_END}\n`,
      'utf8',
    )
    const r = syncInstructions({ cwd: dir, text: '新设定', silentRule: true, memoryRule: false })
    assert.equal(r.ok, true)
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.ok(text.indexOf(BLOCK_BEGIN) < text.indexOf(RULES_BEGIN), '顺序要固定成 用户 → 规则')
    assert.equal(text.includes('旧设定'), false, '旧内容要被替换')
    assert.equal(text.includes('旧规则'), false, '旧规则块要被替换')
    assert.match(text, /新设定/)
  }))

test('指令同步：顺带创建 .git 标记（缺了它 DSH 跳过整个 baseline）', () =>
  withDir(dir => {
    assert.equal(existsSync(join(dir, '.git')), false)
    syncInstructions({ cwd: dir, text: 'x', silentRule: true, memoryRule: false })
    assert.equal(existsSync(join(dir, '.git')), true, '没有 .git 时 AGENTS.md 不会被读')
  }))

test('指令同步：发送规则常驻，所以总会有内容可写', () =>
  withDir(dir => {
    syncInstructions({ cwd: dir, text: '', silentRule: false, memoryRule: false })
    assert.equal(existsSync(join(dir, 'AGENTS.md')), true, '发送规则常驻，文件一定会写')
  }))
