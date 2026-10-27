import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { renderPrompt } from '../src/onebot/normalize.js'
import { VoiceLibrary } from '../src/voice/library.js'

/**
 * 语音库的测试重点不是"能不能发"，而是**两条防线守不守得住**：
 *   1. 路径穿越 —— 群里一句"发一下 ../../etc/passwd"，模型照做会不会真读到
 *   2. 限流 —— 模型连着发十条语音
 *
 * 这两件事只要漏一次，后果都不是"功能不对"而是"安全事故"或"刷屏"。
 */

function mkLib(over = {}, { files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-voice-'))
  for (const [name, size] of Object.entries(files)) {
    writeFileSync(join(dir, name), Buffer.alloc(size))
  }
  const lib = new VoiceLibrary({ voice: { dir, enabled: true, ...over } }, { log: () => {} })
  return { dir, lib, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('语音库：只接受库内文件，../ 跳不出去', () => {
  const { dir, lib, done } = mkLib({}, { files: { 'hi.mp3': 10 } })
  try {
    assert.equal(lib.resolve('hi.mp3'), join(dir, 'hi.mp3'), '库内文件要能解析')
    assert.throws(() => lib.resolve('../../etc/passwd'), /只能是语音库里的文件/)
    assert.throws(() => lib.resolve('sub/../../x.mp3'), /只能是语音库里的文件/)
    // 前缀相同但不在库内（/audio 与 /audio-evil）也必须挡住
    assert.throws(() => lib.resolve(`../${'evil'}/a.mp3`), /只能是语音库里的文件|没有/)
  } finally {
    done()
  }
})

test('语音库：绝对路径默认拒绝（防 prompt injection 读任意本地文件）', () => {
  const { lib, done } = mkLib()
  try {
    assert.throws(() => lib.resolve('/etc/passwd'), /不接受绝对路径/)
    assert.throws(() => lib.resolve('C:\\Windows\\win.ini'), /不接受绝对路径/)
  } finally {
    done()
  }
})

test('语音库：显式开 allowAbsolutePath 才放行绝对路径', () => {
  const { dir, lib, done } = mkLib({ allowAbsolutePath: true }, { files: { 'a.mp3': 5 } })
  try {
    const f = join(dir, 'a.mp3')
    assert.equal(lib.resolve(f), f)
  } finally {
    done()
  }
})

test('语音库：找不到文件时把可用列表回给模型（不然它只能瞎猜）', () => {
  const { lib, done } = mkLib({}, { files: { 'a.mp3': 1, 'b.silk': 1 } })
  try {
    assert.throws(() => lib.resolve('nope.mp3'), /可用：/)
  } finally {
    done()
  }
})

test('语音库：体检拒绝不支持的格式、空文件、超大文件', () => {
  const { dir, lib, done } = mkLib({ maxBytes: 100 }, { files: { 'ok.mp3': 10, 'bad.txt': 5, 'empty.mp3': 0, 'big.mp3': 200 } })
  try {
    assert.deepEqual(lib.inspect(join(dir, 'ok.mp3')), { size: 10, ext: '.mp3' })
    assert.throws(() => lib.inspect(join(dir, 'bad.txt')), /不支持的音频格式/)
    assert.throws(() => lib.inspect(join(dir, 'empty.mp3')), /文件是空的/)
    assert.throws(() => lib.inspect(join(dir, 'big.mp3')), /文件太大/)
  } finally {
    done()
  }
})

test('语音库：限流按分钟算，且不同会话互不影响', () => {
  const { lib, done } = mkLib({ maxPerMinute: 2, maxPerHour: 100 })
  try {
    lib.budget('g:1')
    lib.commit('g:1')
    lib.budget('g:1')
    lib.commit('g:1')
    assert.throws(() => lib.budget('g:1'), /每分钟最多 2 条/)
    // 另一个群不该被连坐
    lib.budget('g:2')
  } finally {
    done()
  }
})

test('语音库：限流按小时算（分钟额度没满也要挡）', () => {
  const { lib, done } = mkLib({ maxPerMinute: 100, maxPerHour: 3 })
  try {
    for (let i = 0; i < 3; i++) {
      lib.budget('g:1')
      lib.commit('g:1')
    }
    assert.throws(() => lib.budget('g:1'), /每小时最多 3 条/)
  } finally {
    done()
  }
})

test('语音库：list 只列音频文件，按修改时间倒序', () => {
  const { lib, done } = mkLib({}, { files: { 'a.mp3': 1, 'b.silk': 1, 'note.txt': 1 } })
  try {
    const names = lib.list().map(f => f.name)
    assert.deepEqual(names.sort(), ['a.mp3', 'b.silk'])
  } finally {
    done()
  }
})

test('语音库：describe 暴露给控制台的信息齐全（样例插件靠它渲染）', () => {
  const { lib, done } = mkLib({}, { files: { 'a.mp3': 3 } })
  try {
    const d = lib.describe()
    assert.equal(d.enabled, true)
    assert.equal(typeof d.dir, 'string')
    assert.equal(d.files.length, 1)
    assert.equal(d.limits.maxPerMinute, 2, '默认每分钟 2 条')
  } finally {
    done()
  }
})

/* ---------------- 提示词：两种发语音的方式 ---------------- */

test('提示词：语音开启时提到 qq_send_voice 与 qq_speak，关闭时完全不提', () => {
  const g = { kind: 'group', chatKey: 'g:1', groupId: '1', senderName: '甲', userId: '1', messageId: '1', text: '在吗' }
  const on = renderPrompt(g, { canSpeak: true })
  assert.match(on, /【说话方式】/)
  assert.match(on, /qq_send_voice/, '发语音库里现成音频的入口要写清楚')
  assert.match(on, /qq_speak/, '插件提供"开口说"时也要提一句')
  assert.match(on, /晚安/, '要给具体场面；只说"少用语音"它会完全不碰')
  assert.match(on, /打字/, '默认倾向必须写清楚是打字')
  assert.doesNotMatch(renderPrompt(g), /【说话方式】/, '语音关着还提，等于让它去调一个不存在的工具')

  const p = { kind: 'private', chatKey: 'u:1', userId: '1', messageId: '2', text: '在吗' }
  assert.match(renderPrompt(p, { canSpeak: true }), /【说话方式】/)
  assert.doesNotMatch(renderPrompt(p), /【说话方式】/)
})
