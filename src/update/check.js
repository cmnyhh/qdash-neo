import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * **主框架自己的版本，直接读本包的 `package.json`。**
 *
 * 不能用 `require('@cmnyhh/qdash-neo/package.json')` —— 本地开发时这个包
 * 并没有装进自己的 `node_modules`，会解析失败。而线上它装在 profile 的
 * `node_modules` 里，两种环境路径不同，只有相对路径是稳的。
 */
export const SELF_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()

/**
 * 自动更新检测。
 *
 * **只检测，不安装。**
 *
 * 为什么不自动更新：这个进程自己重启自己，正在处理的消息会丢；新版有 bug
 * 也没有回滚；`pnpm install` 失败时依赖可能被删了一半 —— 比不更新更糟。
 * 而且 profile 里写的是 `^0.1.11`，`pnpm install` 会顺带升掉所有 0.1.x，
 * 你只想修一个插件，可能连带到别的。
 *
 * 所以这里只回答一个问题：**现在跑的版本，和 npm 上的最新版差多少。**
 * 要不要装、什么时候装，由人决定。
 */

/** 要盯的包。装了哪个才查哪个，没装就跳过。 */
export const WATCHED = [
  '@cmnyhh/qdash-neo',
  '@cmnyhh/qdash-neo-plugin-bili',
  '@cmnyhh/qdash-neo-plugin-sticker',
  '@cmnyhh/qdash-neo-plugin-voice',
]

/**
 * 读某个包当前安装的版本。
 *
 * 直接 `require('<pkg>/package.json')`：这些包和本模块在同一个 `node_modules`
 * 里（都是 profile 的依赖），所以解析得到。没装就返回空串，调用方跳过。
 *
 * @param {string} name
 * @returns {string}
 */
export function currentVersionOf(name) {
  try {
    return String(require(`${name}/package.json`)?.version ?? '')
  } catch {
    return ''
  }
}

/**
 * 比版本号。
 *
 * 只处理 `major.minor.patch` 的数字部分 —— 这几个包都用标准 semver，
 * 不需要为一次比较引入 `semver` 依赖。预发布标签（`-beta`）按"更旧"处理。
 *
 * @returns {number} 正数表示 a 更新
 */
export function compareVersion(a, b) {
  const parse = v =>
    String(v ?? '')
      .split('-')[0]
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  // 数字一样时：带 -xxx 后缀的算更旧（1.0.0-beta < 1.0.0）
  const sa = String(a ?? '').includes('-') ? 1 : 0
  const sb = String(b ?? '').includes('-') ? 1 : 0
  return sb - sa
}

/**
 * 查一个包在 registry 上的 latest 版本。
 *
 * 失败一律返回空串 —— 网络不通、镜像挂了、包不存在，都不该影响主流程。
 *
 * @param {string} name
 * @param {{ registry?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function latestVersionOf(name, { registry = 'https://registry.npmmirror.com', timeoutMs = 6000 } = {}) {
  const base = String(registry || 'https://registry.npmmirror.com').replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(name)}/latest`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!r.ok) return ''
    const j = await r.json()
    return String(j?.version ?? '')
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查所有关注的包。
 *
 * @param {{ registry?: string, timeoutMs?: number, names?: string[] }} [opts]
 * @returns {Promise<Array<{ name: string, current: string, latest: string, behind: boolean }>>}
 */
export async function checkUpdates({ registry, timeoutMs, names = WATCHED, selfVersion = '' } = {}) {
  const rows = names
    .map(name => ({
      name,
      // 主框架用外面传进来的版本（见 `SELF_VERSION` 的说明），插件才去 resolve
      current: name === '@cmnyhh/qdash-neo' && selfVersion ? selfVersion : currentVersionOf(name),
    }))
    // 没装的包不查：profile 里只装一部分插件是常态
    .filter(r => r.current)

  const withLatest = await Promise.all(
    rows.map(async r => {
      const latest = await latestVersionOf(r.name, { registry, timeoutMs })
      return { ...r, latest, behind: Boolean(latest) && compareVersion(latest, r.current) > 0 }
    }),
  )

  return withLatest.filter(r => r.latest)
}
