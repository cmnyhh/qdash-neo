import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { candidateDirs } from '../src/host.js'
import { defaultDbPath } from '../src/store/db.js'

/**
 * 这两条都是在服务器上真实炸过的问题，本地开发永远看不到：
 *
 * 1. `dsh` 全局安装时 `/usr/bin/dsh` 是符号链接，Node 不解析 `argv[1]`，
 *    于是 `dirname` 落在 `/usr/bin`，向上找不到 `.../dsh/node_modules/@deepseek-ai/*`
 *    → 插件 entry 加载失败（表现是"装上了但没生效"）。
 * 2. 数据库硬编码 `~/.dsh`，不跟 `DSH_HOME` → 自定义 DSH_HOME 的部署会写错地方。
 */

test('host：argv 是符号链接时，候选里要包含真实路径的祖先链', t => {
  const root = mkdtempSync(join(tmpdir(), 'qdn-host-'))
  const realDir = join(root, 'real', 'dsh', 'lib')
  mkdirSync(realDir, { recursive: true })
  const realBin = join(realDir, 'bin.js')
  writeFileSync(realBin, '')

  const shimDir = join(root, 'bin')
  mkdirSync(shimDir, { recursive: true })
  const link = join(shimDir, 'dsh')
  try {
    symlinkSync(realBin, link)
  } catch {
    t.skip('平台不允许创建符号链接（Windows 需要开发者模式或管理员）')
    return
  }

  const dirs = candidateDirs('@deepseek-ai/schemastery', [link])

  // 沿 realpath 向上必须能找到 real/dsh/node_modules/...，
  // 否则 /usr/bin/dsh 这种 shim 场景必然解析失败。
  const hit = dirs.some(
    d => d.includes(join('real', 'dsh')) && d.endsWith(join('node_modules', '@deepseek-ai', 'schemastery')),
  )
  assert.ok(hit, '符号链接的 argv 也要能沿真实路径向上找宿主依赖')
})

test('host：普通路径照旧（加 realpath 不能丢掉原路径）', () => {
  const dirs = candidateDirs('some-pkg', [join(tmpdir(), 'qdn-x', 'a', 'bin.js')])
  assert.ok(dirs.length >= 2, '至少要覆盖向上的若干级目录')
  assert.ok(
    dirs.some(d => d.endsWith(join('node_modules', 'some-pkg'))),
    '候选应以 <dir>/node_modules/<name> 结尾',
  )
})

test('db：默认路径跟随 DSH_HOME，没设才回落到 ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  try {
    const fakeHome = join(tmpdir(), 'qdn-dsh-home')
    process.env.DSH_HOME = fakeHome
    const p = defaultDbPath()
    assert.ok(p.startsWith(fakeHome), `应落在 DSH_HOME 下，实际 ${p}`)
    assert.ok(p.endsWith(join('storages', 'qdash-neo.db')))

    delete process.env.DSH_HOME
    assert.ok(defaultDbPath().includes(join('.dsh', 'storages')), '没设 DSH_HOME 时回落到 ~/.dsh')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
