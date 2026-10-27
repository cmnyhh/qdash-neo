/**
 * 从宿主（DSH 进程）里解析 `@deepseek-ai/*` 包。
 *
 * 为什么不能直接 `import '@deepseek-ai/schemastery'`：插件被装进
 * `~/.dsh/profiles/<profile>/node_modules/qdash-neo/`，那个 node_modules 里通常
 * 没有 `@deepseek-ai/*`，裸包名解析不到（探针踩过同一个坑，见 probe/lib/index.js）。
 *
 * 所以从**宿主进程的入口脚本**往上逐级找 node_modules。
 * 换机器不用改代码：找不到就抛一条能看懂的错，而不是静默降级。
 */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CACHE = new Map()

/**
 * 候选目录列表。
 *
 * @param {string} name 包名
 * @param {string[]} [argvList] 默认取 `process.argv.slice(1)`；测试可注入
 */
export function candidateDirs(name, argvList = process.argv.slice(1)) {
  const out = []
  const extra = process.env.QDN_HOST_MODULES
  if (extra) for (const root of extra.split(delimiter)) if (root) out.push(join(root, name))

  for (const argvPath of argvList) {
    /**
     * 两条路径都要试：原样 + realpath。
     *
     * `dsh` 装在全局时是**符号链接**（`/usr/bin/dsh -> .../dsh/lib/bin.js`），
     * 而 Node 不会把 `argv[1]` 解析成真实路径 —— 于是 `dirname` 落在 `/usr/bin`，
     * 向上永远到不了 `.../dsh/node_modules/@deepseek-ai/*`。
     *
     * 本机一直是 `node .../dsh/lib/bin.js` 直跑，所以从没暴露过这条。
     * （2026-10-26 装到服务器才踩到：插件 entry 加载失败，报"解析不到宿主包"。）
     */
    const bases = [argvPath]
    try {
      const real = realpathSync(argvPath)
      if (real !== argvPath) bases.push(real)
    } catch {
      /* 路径不存在就只用原样 */
    }

    for (const base of bases) {
      let dir = dirname(base)
      for (let i = 0; i < 8; i++) {
        out.push(join(dir, 'node_modules', name))
        const up = dirname(dir)
        if (up === dir) break
        dir = up
      }
    }
  }
  return out
}

/**
 * 解析宿主包，返回可 import 的绝对 file:// URL。
 * @param {string} name 包名，例如 '@deepseek-ai/schemastery'
 * @returns {string} file:// URL
 */
export function resolveHost(name) {
  const hit = CACHE.get(name)
  if (hit) return hit

  for (const dir of candidateDirs(name)) {
    const pkg = join(dir, 'package.json')
    if (!existsSync(pkg)) continue
    let url
    try {
      url = pathToFileURL(createRequire(pkg).resolve(name)).href
    } catch (err) {
      // exports 字段把入口藏起来时退到 lib/index.js，但要把原因留在错里
      const fallback = join(dir, 'lib', 'index.js')
      if (!existsSync(fallback)) {
        throw new Error(`qdash-neo: 找到 ${pkg} 却无法解析入口：${err.message}`)
      }
      url = pathToFileURL(fallback).href
    }
    CACHE.set(name, url)
    return url
  }

  throw new Error(
    `qdash-neo: 解析不到宿主包 ${name}。` +
      `插件需要在 DSH 进程内运行（或在 QDN_HOST_MODULES 里指明宿主 node_modules 根目录）。`,
  )
}

/**
 * 动态 import 宿主包。
 * @param {string} name 包名
 */
export async function hostImport(name) {
  return import(resolveHost(name))
}
