/**
 * 控制台鉴权：**登录式会话** + Bearer 脚本凭据 + Host 白名单。
 *
 * 四条约束，都不是可选项：
 *   1. **除 `/health` 和登录页外都要已登录** —— 控制台能看见全部聊天记录，裸奔等于把群聊公开
 *   2. **必须校验 Host** —— 否则 DNS rebinding 能让外部页面借用浏览器访问 127.0.0.1
 *   3. **口令不出现在 URL 里** —— `?token=` 会留在浏览历史、Referer 和反代日志里；
 *      改成表单登录 + `HttpOnly` 会话 cookie，脚本走 `Authorization: Bearer`
 *   4. **口令不进日志/响应体** —— 只在启动时打印一次（生成的口令），之后只认会话
 *
 * 为什么会话存在内存而不是 sqlite：重启即失效是**特性**而不是缺陷 —— 进程重启往往意味着
 * 配置/代码换过一轮，这时候让旧会话继续有效是在帮倒忙。代价是重启后要重新登录一次。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** kv 里的键：生成的口令落库后重启不变，否则每次重启都要去日志里找新口令 */
export const PASSWORD_KEY = 'console:password'
/** 会话 cookie 名。前缀带 qdn_，避免和宿主自己的 cookie 撞 */
export const SESSION_COOKIE = 'qdn_sid'

/** 默认只放行本机：控制台是运维面，默认暴露到局域网是错的那一边 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 归一化挂载路径。返回 `''` 表示"挂在根"（独立端口模式）。
 *
 * - 空串 → 默认 `/qdash-neo`（attach 模式的历史默认值）
 * - 补前导 `/`、去尾部 `/`（`register` 的 path 不能有尾斜杠）
 * - `/` → `''`
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMount(raw) {
  const text = String(raw ?? '').trim() || '/qdash-neo'
  if (text === '/') return ''
  const withLeading = text.startsWith('/') ? text : `/${text}`
  return withLeading.replace(/\/+$/, '')
}

/**
 * 读/生成口令。
 *
 * 顺序：Config（部署方显式配的）→ kv（上次生成的）→ 新生成并落库。
 * store 不可用时退回内存口令：控制台此时本来也会 503，但不能因为拿不到库就崩。
 *
 * @param {{ store?: object|null, config?: object, log?: Function }} deps
 * @returns {{ password: string, source: 'config'|'kv'|'generated'|'memory' }}
 */
export function resolvePassword({ store = null, config = null, log = () => {} } = {}) {
  const configured = String(config?.console?.password ?? '').trim()
  if (configured) return { password: configured, source: 'config' }

  if (!store) return { password: '', source: 'unset' }

  try {
    const saved = String(store.kvGet(PASSWORD_KEY, '') ?? '').trim()
    if (saved) return { password: saved, source: 'kv' }
    /**
     * **不再自动生成随机口令。**
     *
     * 原来的做法是生成一串 16 字节 hex 打进启动日志，让用户去搜。问题是：
     * 大部分人不会去看日志（他们通过面板装插件、压根不知道日志在哪），
     * 于是"控制台"对他们等于不存在。
     *
     * 现在改成 `unset`：首次访问时放行一个设置页，让用户**自己定**。
     * 窗口期风险由监听地址兜住 —— `console.host` 默认 `127.0.0.1`，
     * 只有本机能访问到设置页。
     */
    return { password: '', source: 'unset' }
  } catch (err) {
    // 读不到 kv 不该让控制台整个挂掉，但必须留痕
    log('warn', `qdash-neo: 控制台口令读取失败 name=${err?.name} msg=${err?.message}`)
    return { password: '', source: 'unset' }
  }
}

/** 口令最短长度。8 位是底线，再短就是"随便一猜就中" */
export const MIN_PASSWORD_LEN = 8

/**
 * 首次设置口令。
 *
 * 只在 `resolvePassword()` 返回 `unset` 时可用 —— 调用方负责判断，
 * 因为这个函数本身不知道当前是不是首次（它只负责写）。
 *
 * @param {object} store
 * @param {string} password
 * @returns {string} 设好的口令
 */
export function setPassword(store, password) {
  if (!store?.kvSet) throw new Error('存储未就绪，无法保存口令')
  const p = String(password ?? '')
  if (p.length < MIN_PASSWORD_LEN) throw new Error(`口令至少 ${MIN_PASSWORD_LEN} 位`)
  store.kvSet(PASSWORD_KEY, p)
  return p
}

/** `a=1; b=2` → `{a:'1', b:'2'}`；坏值跳过，不抛 */
export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      out[k] = part.slice(idx + 1).trim()
    }
  }
  return out
}

/** 定长摘要后再比：避免长度差异泄露口令长度，也让比较是常量时间 */
function digest(value) {
  return createHash('sha256').update(String(value ?? '')).digest()
}

/** @param {string} given @param {string} expected */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false
  return timingSafeEqual(digest(given), digest(expected))
}

/**
 * 脚本用的机器凭据：只认 `Authorization: Bearer`。
 *
 * 不再支持 `?token=`：口令进 URL 会留在浏览器历史/Referer/反代日志，
 * 而浏览器侧已经有登录会话了，没必要留这条通道。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} 没有则空串
 */
export function readBearer(req) {
  const auth = String(req.headers?.authorization ?? '')
  if (!/^bearer\s+/i.test(auth)) return ''
  return auth.replace(/^bearer\s+/i, '').trim()
}

/** @param {import('node:http').IncomingMessage} req */
export function readSessionId(req) {
  return parseCookies(req.headers?.cookie)[SESSION_COOKIE] ?? ''
}

/**
 * 会话表（内存）。
 *
 * 滑动续期：每次校验成功就把过期时间往后推，用户一直在用就不会被踢。
 * 有界：`sweep()` 由 server 定时调用，过期条目直接删；不清理的话长期挂着的实例会慢慢涨。
 */
export class SessionStore {
  /** @param {{ ttlMs?: number, now?: () => number }} [opts] */
  constructor({ ttlMs = 12 * 3600_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs
    this.now = now
    /** @type {Map<string, number>} sid → 过期时间 */
    this.items = new Map()
  }

  /** @returns {{ sid: string, expiresAt: number }} */
  create() {
    const sid = randomBytes(24).toString('hex')
    const expiresAt = this.now() + this.ttlMs
    this.items.set(sid, expiresAt)
    return { sid, expiresAt }
  }

  /** 校验并滑动续期 */
  verify(sid) {
    if (!sid) return false
    const expiresAt = this.items.get(sid)
    if (!expiresAt) return false
    const now = this.now()
    if (expiresAt <= now) {
      this.items.delete(sid)
      return false
    }
    this.items.set(sid, now + this.ttlMs)
    return true
  }

  destroy(sid) {
    return this.items.delete(sid)
  }

  /** @returns {number} 清掉多少个 */
  sweep() {
    const now = this.now()
    let removed = 0
    for (const [sid, expiresAt] of this.items) {
      if (expiresAt <= now) {
        this.items.delete(sid)
        removed += 1
      }
    }
    return removed
  }

  get size() {
    return this.items.size
  }
}

/**
 * 登录失败限流：同一 IP 每分钟最多 `max` 次失败。
 *
 * 没有它的话，本机端口上的口令就是一个可无限试的 32 位十六进制串 ——
 * 概率上要试很久，但日志会被刷爆，而且反代后面的实例可能被公网扫到。
 */
export class LoginThrottle {
  /** @param {{ max?: number, windowMs?: number, now?: () => number }} [opts] */
  constructor({ max = 8, windowMs = 60_000, now = Date.now } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    /** @type {Map<string, number[]>} */
    this.hits = new Map()
  }

  /** @returns {boolean} 是否已超出 */
  blocked(key) {
    const now = this.now()
    const hits = (this.hits.get(key) ?? []).filter(ts => now - ts < this.windowMs)
    this.hits.set(key, hits)
    return hits.length >= this.max
  }

  fail(key) {
    const hits = this.hits.get(key) ?? []
    hits.push(this.now())
    this.hits.set(key, hits)
  }

  reset(key) {
    this.hits.delete(key)
  }
}

/** 会话 cookie。HTTPS（反代）时才加 Secure：本机 HTTP 加了会导致 cookie 存不上 */
export function sessionCookieHeader({ sid, mount, secure = false, maxAgeSeconds = 12 * 3600 }) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    `Path=${mount || '/'}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

/** 登出：同名 + Max-Age=0 */
export function clearSessionCookieHeader({ mount }) {
  return `${SESSION_COOKIE}=; Path=${mount || '/'}; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** Host 头去掉端口：`127.0.0.1:3081` / `[::1]:3081` 都要认 */
export function hostName(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end > 0 ? raw.slice(0, end + 1) : raw
  }
  return raw.split(':')[0]
}

/**
 * DNS rebinding 防护：只认本机 + 显式配置的额外 Host。
 *
 * 不校验会怎样：攻击者把自己的域名解析到 127.0.0.1，再用浏览器打开，
 * 同源策略认为是他自己的站点，控制台的 cookie 与页面都会被读到。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} [allowedHosts]
 */
export function hostAllowed(req, allowedHosts = []) {
  const name = hostName(req.headers?.host)
  if (!name) return false
  if (LOOPBACK_HOSTS.has(name)) return true
  return (allowedHosts ?? []).some(h => String(h).trim().toLowerCase() === name)
}

/**
 * 启动日志里那条地址。**不再带口令**：口令单独打印/告知，地址可以被复制分享而不泄密。
 * @param {{ port?: number|string, mount?: string }} p
 */
export function consoleUrl({ port, mount = '' }) {
  const p = Number(port)
  const origin = `http://127.0.0.1:${Number.isFinite(p) && p > 0 ? p : 7800}`
  return `${origin}${mount}/`
}
