/**
 * 控制台 HTTP 入口。
 *
 * 两种形态（`console.mode`）：
 *   standalone（默认）—— 自己 `listen` 一个端口，路径挂在 **根 `/`**；
 *   attach            —— 挂到宿主 `ctx.webServer` 的前缀 `console.mount` 下（旧形态）。
 *
 * 独立端口是默认值的理由：端口归自己，宿主的端口规划/反代不用为它让路；
 * 也不会因为插件加载顺序抢不到 `webServer` 而静默 404。
 *
 * 处理顺序固定，**不能调换**：
 *   Host 校验 → 剥离前缀 → `/health` → 登录页（免鉴权）→ 会话/Bearer → 方法/路由 → 静态白名单 → 404
 * 先把 Host 拦掉再谈口令：DNS rebinding 的前提就是"Host 不是本机"，
 * 反过来先校验口令只会给攻击者一个可探测的入口。
 *
 * 鉴权是**登录式**：表单 → `POST /login` → 会话 cookie（HttpOnly/SameSite=Strict）。
 * 口令不进 URL —— `?token=` 会留在浏览历史、Referer 和反代日志里。
 * 脚本走 `Authorization: Bearer <口令>`，不经过登录页。
 *
 * 写接口刻意只开两条，且**按路由**放行方法：
 *   POST /api/config                            改运行层配置
 *   POST /api/tabs/<id>/actions/<actionId>      执行插件声明的动作
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname } from 'node:path'

import * as api from './api.js'
import {
  LoginThrottle,
  SessionStore,
  clearSessionCookieHeader,
  consoleUrl,
  hostAllowed,
  normalizeMount,
  readBearer,
  readSessionId,
  resolvePassword,
  sessionCookieHeader,
  setPassword,
  MIN_PASSWORD_LEN,
  tokenMatches,
} from './auth.js'
import { TabRegistry } from './tabs.js'

/**
 * 静态资源白名单：**只认这几条**，不做目录读取。
 * 目录读取 + 拼接即使用 `normalize` 也很难穷举穿越姿势，白名单从根上消灭这一类问题。
 * ⚠️ 新增前端文件必须同步加进来，否则加载 404（页面上表现为"某个按钮没反应"）。
 */
const STATIC = {
  '': 'index.html',
  'index.html': 'index.html',
  'login.html': 'login.html',
  'setup.html': 'setup.html',
  'assets/app.js': 'assets/app.js',
  'assets/blocks.js': 'assets/blocks.js',
  'assets/login.js': 'assets/login.js',
  'assets/setup.js': 'assets/setup.js',
  'assets/theme.css': 'assets/theme.css',
  // brand-mark：抠掉背景后的图形方版（侧栏 + favicon）；brand-logo：完整图形 + 词标（登录页）
  'assets/brand-mark.png': 'assets/brand-mark.png',
  'assets/brand-logo.png': 'assets/brand-logo.png',
}

/** 登录页要用的静态资源必须在**鉴权之前**放行，否则鸡生蛋：不登录看不到登录页 */
const PUBLIC_STATIC = new Set([
  'login.html',
  'assets/login.js',
  // 首次设置页与登录页同构：都是免鉴权的独立静态文件
  'setup.html',
  'assets/setup.js',
  'assets/theme.css',
  'assets/brand-mark.png',
  'assets/brand-logo.png',
])

/** 请求体上限：配置 patch 是几十个字段，64KB 已经宽松到离谱 */
const MAX_BODY_BYTES = 64 * 1024

const TAB_ACTION_RE = /^\/api\/tabs\/([^/]+)\/actions\/([^/]+)$/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

// 注意 `form-action 'none'`：登录表单不能用原生 submit，必须 fetch（前端 login.js 就是这么做的）
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

const PUBLIC_DIR = new URL('./public/', import.meta.url)

export class ConsoleServer {
  /**
   * @param {{ service: object, config?: object, log?: Function, tabRegistry?: TabRegistry }} deps
   */
  constructor({ service, config = null, log = () => {}, tabRegistry = null }) {
    this.service = service
    this.config = config ?? {}
    this.log = log

    const cc = this.config?.console ?? {}
    this.mode = cc.mode === 'attach' ? 'attach' : 'standalone'
    // 独立模式挂在根：端口已经是专用入口了，再加一层 /qdash-neo 只是多打几个字
    this.mount = this.mode === 'attach' ? normalizeMount(cc.mount) : ''
    this.enabled = cc.enabled !== false
    this.listenHost = String(cc.host ?? '127.0.0.1').trim() || '127.0.0.1'
    this.listenPort = Number.isFinite(cc.port) ? Number(cc.port) : 7800

    this.registered = false
    this.error = null
    /** @type {number|null} 实际监听端口（0 = 让系统分配，测试用） */
    this.port = null
    this.startedAt = Date.now()

    /** @type {{ password: string, source: string }|null} 首次用到时才解析（等 store 就绪） */
    this.passwordInfo = null
    this.sessions = new SessionStore({ ttlMs: (Number.isFinite(cc.sessionHours) ? cc.sessionHours : 12) * 3600_000 })
    this.throttle = new LoginThrottle()
    this.staticCache = new Map()
    /** @type {import('node:http').Server|null} */
    this.httpServer = null
    this.sweepTimer = null
    /**
     * 插件选项卡注册表。放在这里而不是 service 上，是因为它的消费方只有控制台；
     * 插件通过 `ctx.qdashNeo.console.registerTab()` 拿到（`console` 就是本对象）。
     */
    this.tabs = tabRegistry ?? new TabRegistry({ log })
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 独立端口模式：自己监听。失败要抛出去，由调用方记 error —— 静默不监听等于"控制台消失"。
   */
  async start() {
    if (!this.enabled || this.mode !== 'standalone' || this.httpServer) return this.port
    const server = createServer((req, res) => this.handle(req, res))
    await new Promise((resolve, reject) => {
      const onError = err => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.listenPort, this.listenHost)
    })
    this.httpServer = server
    this.port = server.address()?.port ?? this.listenPort
    this.registered = true
    // 会话过期清理：长期挂着的实例不清理会慢慢涨
    this.sweepTimer = setInterval(() => this.sessions.sweep(), 60_000)
    this.sweepTimer.unref?.()
    return this.port
  }

  async stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    const server = this.httpServer
    this.httpServer = null
    this.registered = false
    if (!server) return
    await new Promise(resolve => server.close(() => resolve()))
  }

  /**
   * 插件注册选项卡的入口（04 §2.4 的 `ctx.qdashNeo.console.registerTab`）。
   * 抛错时不吞：插件该知道自己的 id 撞了，内核同时会在插件页展示原因。
   * @param {object} desc
   */
  registerTab(desc) {
    return this.tabs.register(desc)
  }

  /** 配置热更新后同步一份：pollMs / allowedHosts 都是每次请求现读这里的 */
  syncConfig(next) {
    if (!next || typeof next !== 'object') return
    const before = this.config?.console ?? {}
    /**
     * **合并**而不是整体替换。
     *
     * effective 通常是完整配置，但调用方也可能只给一部分（测试里的最小 schema、
     * 未来的局部下发）。整体替换在缺 `console` 段时会把口令配置抹掉 ——
     * 表现是"保存一次配置就被踢回登录页"，而且因为口令被重新生成，旧 token 全失效。
     */
    this.config = {
      ...this.config,
      ...next,
      console: { ...before, ...(next.console ?? {}) },
    }
    const cc = this.config.console
    this.sessions.ttlMs = (Number.isFinite(cc.sessionHours) ? cc.sessionHours : 12) * 3600_000
    if (Array.isArray(cc.allowedHosts)) this.allowedHosts = cc.allowedHosts

    /**
     * 口令/用户名变了要让解析缓存失效。
     *
     * `passwordInfoOrResolve()` 的结果是缓存的（避免每次请求都查 kv），
     * 不在这里清掉的话「改口令 → 还是得用旧口令登录，直到重启」——
     * 表现成"改了没生效"，而且重启才好的问题最难联想到缓存。
     */
    if (String(before.password ?? '') !== String(cc.password ?? '')) {
      this.passwordInfo = null
    }
    if (String(before.username ?? '') !== String(cc.username ?? '')) {
      this.log('info', `qdash-neo: 控制台用户名已改为 ${cc.username ?? 'admin'}（已登录的会话仍然有效）`)
    }
  }

  /** 给 `service.status().console` 用：**不含口令**，状态快照不该带秘密 */
  snapshot() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      mount: this.mount,
      host: this.listenHost,
      port: this.port ?? (this.mode === 'standalone' ? this.listenPort : null),
      registered: this.registered,
      error: this.error,
      passwordSource: this.passwordInfo?.source ?? null,
      sessions: this.sessions.size,
      tabs: this.tabs?.size ?? 0,
      configRevision: this.service?.configStore?.revision ?? 0,
      url: this.mode === 'standalone' ? consoleUrl({ port: this.port ?? this.listenPort }) : null,
    }
  }

  /** 启动日志用。**不包含口令**：地址可以被复制分享而不泄密 */
  announceUrl() {
    if (this.mode === 'standalone') return consoleUrl({ port: this.port ?? this.listenPort })
    return consoleUrl({ port: this.port ?? 3081, mount: this.mount })
  }

  /** 首次调用时解析口令：store 在 `service.start()` 之后才存在 */
  passwordInfoOrResolve() {
    if (!this.passwordInfo) {
      this.passwordInfo = resolvePassword({
        store: this.service?.store ?? null,
        config: this.config,
        log: this.log,
      })
    }
    return this.passwordInfo
  }

  /* ---------------- 请求处理 ---------------- */

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  handle(req, res) {
    this.#securityHeaders(res)
    Promise.resolve()
      .then(() => this.#route(req, res))
      .catch(err => {
        if (res.headersSent) {
          this.log('error', `qdash-neo: 控制台响应中途失败 ${err?.name} ${err?.message}`, err)
          try {
            res.destroy()
          } catch {
            /* 连接已经没了 */
          }
          return
        }
        const mapped = this.#mapError(err)
        this.log(
          'error',
          `qdash-neo: 控制台请求失败 ${req.method} ${req.url} -> ${mapped.code} ${err?.name} ${err?.message}`,
          err,
        )
        this.#json(res, mapped.status, { ok: false, error: { code: mapped.code, message: mapped.message } })
      })
      .finally(() => {
        // 提前返回（401/403/405）时请求体可能没被读完。不排掉会留下半开连接：
        // 客户端那头表现是"这个请求之后一直等"，服务端 close() 也永远等不到回调
        if (!req.readableEnded) req.resume()
      })
  }

  /** @param {import('node:http').ServerResponse} res */
  #securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', CSP)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #route(req, res) {
    if (!hostAllowed(req, this.config?.console?.allowedHosts ?? [])) {
      this.#json(res, 403, { ok: false, error: { code: 'forbidden-host', message: '拒绝非本机来源的访问（Host 不在白名单）' } })
      return
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    const url = new URL(String(req.url ?? '/'), 'http://console.invalid')
    const sub = this.#strip(url.pathname)
    if (sub == null) {
      this.#json(res, 404, { ok: false, error: { code: 'not-found', message: '路径不在控制台挂载点下' } })
      return
    }

    // 健康检查免鉴权：反代/监控探活不该需要口令，且它不泄露任何数据
    if (sub === '/health') {
      this.#json(res, 200, { ok: true, uptimeMs: Date.now() - this.startedAt, mode: this.mode })
      return
    }

    /**
     * 首次使用：口令还没设过。
     *
     * 只放行设置页与设置接口，其余一律跳过去。**必须放在登录判断之前** ——
     * 否则用户会被引到登录页，而那里他不可能知道口令（我们不再生成随机口令了）。
     *
     * 这么设计是因为「大部分人不看启动日志」：他们通过面板装插件，
     * 根本不知道日志在哪，于是控制台对他们等于不存在。
     */
    if (this.#needsSetup()) {
      if (sub === '/setup') {
        await this.#handleSetup(req, res, method)
        return
      }
      if (sub === '/api/setup') {
        await this.#handleSetupPost(req, res, method)
        return
      }
      if (isPublicStatic(sub)) {
        this.#serveStatic(req, res, sub, method)
        return
      }
      if (sub.startsWith('/api')) {
        this.#json(res, 409, {
          ok: false,
          error: { code: 'setup-required', message: '首次使用，请先设置控制台口令' },
          setupUrl: `${this.mount}/setup`.replace(/\/{2,}/g, '/'),
        })
        return
      }
      res.statusCode = 302
      res.setHeader('Location', `${this.mount}/setup`.replace(/\/{2,}/g, '/'))
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }

    // 登录页本身免鉴权，否则鸡生蛋
    if (sub === '/login') {
      await this.#handleLogin(req, res, method)
      return
    }
    if (sub === '/logout') {
      await this.#handleLogout(req, res, method)
      return
    }

    // 登录页自己的 css/js 必须免鉴权 —— 否则页面能打开但样式与脚本 302，看起来像"页面坏了"
    if (isPublicStatic(sub)) {
      this.#serveStatic(req, res, sub, method)
      return
    }

    const authed = this.#isAuthed(req)
    if (!authed) {
      // 页面请求跳登录（浏览器可读），API 请求给 401（前端据此跳转，脚本能看懂）
      if (sub.startsWith('/api')) {
        this.#json(res, 401, {
          ok: false,
          error: { code: 'unauthorized', message: '需要先登录控制台' },
          loginUrl: `${this.mount}/login`.replace(/\/{2,}/g, '/'),
        })
        return
      }
      const isPage = method === 'GET' || method === 'HEAD'
      if (isPage) {
        res.statusCode = 302
        res.setHeader('Location', `${this.mount || ''}/login`.replace(/\/{2,}/g, '/'))
        res.setHeader('Cache-Control', 'no-store')
        res.end()
        return
      }
      this.#json(res, 401, { ok: false, error: { code: 'unauthorized', message: '需要先登录控制台' } })
      return
    }

    // 已登录还去登录页：送回首页，避免"登录成功但停在登录页"
    const isRead = method === 'GET' || method === 'HEAD'
    const isConfigWrite = method === 'POST' && sub === '/api/config'
    const isPersonaWrite = method === 'POST' && sub === '/api/persona'
    const isChatWrite = method === 'POST' && sub === '/api/chats'
    const isAccountWrite = method === 'POST' && sub === '/api/account/password'
    /** 插件工具开关：服务端自己取 revision，前端只表达意图 */
    const isToolWrite = method === 'POST' && sub === '/api/tools/plugin'
    const isTabAction = method === 'POST' && TAB_ACTION_RE.test(sub)

    if (
      !isRead &&
      !isConfigWrite &&
      !isPersonaWrite &&
      !isChatWrite &&
      !isAccountWrite &&
      !isToolWrite &&
      !isTabAction
    ) {
      const allow = TAB_ACTION_RE.test(sub)
        ? 'POST'
        : sub === '/api/config' || sub === '/api/persona' || sub === '/api/chats'
          ? 'GET, HEAD, POST'
          : 'GET, HEAD'
      res.setHeader('Allow', allow)
      this.#json(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `这个地址不接受 ${method}（允许 ${allow}）` },
      })
      return
    }

    // 写路由收到读方法：给 405 + Allow，而不是掉到 404。
    // 404 会让人以为"接口不存在"，从而去翻文档而不是改方法。
    if (isRead && TAB_ACTION_RE.test(sub)) {
      res.setHeader('Allow', 'POST')
      this.#json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '选项卡动作只接受 POST' } })
      return
    }

    if (isConfigWrite) {
      const body = await this.#readJson(req)
      const actor = String(body?.actor ?? '').trim() || this.#clientIp(req)
      const payload = api.configUpdate({ service: this.service, server: this, body: { ...body, actor } })
      this.#json(res, 200, payload)
      return
    }

    if (isToolWrite) {
      const body = await this.#readJson(req)
      const actor = String(body?.actor ?? '').trim() || this.#clientIp(req)
      const payload = api.pluginToolToggle({
        service: this.service,
        server: this,
        body: { ...body, actor },
      })
      this.#json(res, 200, payload)
      return
    }

    if (isPersonaWrite) {
      const body = await this.#readJson(req)
      const payload = api.personaUpdate({ service: this.service, body })
      this.#json(res, 200, payload)
      return
    }

    if (isChatWrite) {
      const body = await this.#readJson(req)
      const payload = await api.chatsUpdate({ service: this.service, body })
      this.#json(res, 200, payload)
      return
    }

    if (isAccountWrite) {
      const body = await this.#readJson(req)
      const payload = api.accountPassword({ server: this, body })
      this.#json(res, 200, payload)
      return
    }

    if (isTabAction) {
      const m = TAB_ACTION_RE.exec(sub)
      let tabId
      let actionId
      try {
        tabId = decodeURIComponent(m[1])
        actionId = decodeURIComponent(m[2])
      } catch {
        throw new api.ApiError('bad-request', '选项卡或动作 id 的编码非法', 400)
      }
      const body = await this.#readJson(req)
      const payload = await api.tabAction({ server: this, id: tabId, actionId, body })
      this.#json(res, 200, payload)
      return
    }

    if (sub === '/api' || sub.startsWith('/api/')) {
      const payload = await this.#dispatchApi(sub.slice('/api'.length), url)
      this.#json(res, 200, payload, method === 'HEAD')
      return
    }

    this.#serveStatic(req, res, sub, method)
  }

  /* ---------------- 登录 ---------------- */

  /**
   * `GET /login` 出登录页；`POST /login` 校验口令建会话。
   *
   * 失败一律回 401 并**不区分**"用户名错"和"口令错"—— 区分等于送一个用户名字典。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  /** 口令还没设过（首次使用）。空口令 = unset，不是"空密码可登录" */
  #needsSetup() {
    const info = this.passwordInfoOrResolve()
    return !String(info?.password ?? '').trim()
  }

  /**
   * 首次设置页。
   *
   * 页面本身再判一次 `#needsSetup()`：两个人同时打开设置页时，
   * 后提交的那个必须被挡掉 —— 否则它能把你刚设的口令改掉。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  async #handleSetup(req, res, method) {
    if (!this.#needsSetup()) {
      res.statusCode = 302
      res.setHeader('Location', `${this.mount}/login`.replace(/\/{2,}/g, '/'))
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }
    if (method === 'HEAD') {
      res.statusCode = 200
      res.end()
      return
    }
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET, HEAD')
      this.#json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '设置页只接受 GET' } })
      return
    }
    /**
     * 走静态文件，**不内联**。
     *
     * 控制台 CSP 是 `script-src 'self'; style-src 'self'`，内联的 `<style>` 与 `<script>`
     * 会被直接拒绝。第一版把整页内联在常量里，结果页面没有任何样式、按钮也没有反应 ——
     * 浏览器控制台里只有 CSP 违规提示，从服务端完全看不出问题。
     */
    this.#serveStatic(req, res, '/setup.html', method)
  }

  /**
   * 提交新口令。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  async #handleSetupPost(req, res, method) {
    if (!this.#needsSetup()) {
      this.#json(res, 409, {
        ok: false,
        error: { code: 'already-setup', message: '口令已经设置过了，请直接登录' },
      })
      return
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      this.#json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只接受 POST' } })
      return
    }

    /**
     * 跨站提交校验。
     *
     * `allowedHosts` 默认全开（`*`），DNS rebinding 的防线只剩这一道：
     * 浏览器发跨站请求时**一定**带 `Origin`，而它不会等于当前 Host；
     * curl / 脚本不带 `Origin`，放行 —— 它们本来就是可信调用方。
     *
     * 没有这道的话，"未设口令 + Host 全开"等于把控制台交给任意网页。
     */
    const origin = String(req.headers?.origin ?? '').trim()
    if (origin) {
      const host = String(req.headers?.host ?? '').trim()
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) {
        this.log('warn', `qdash-neo: 拒绝跨站设置口令 origin=${origin} host=${host}`)
        this.#json(res, 403, {
          ok: false,
          error: { code: 'cross-origin', message: '拒绝跨站请求；请在控制台页面上操作' },
        })
        return
      }
    }

    const body = await this.#readBody(req)
    try {
      setPassword(this.service?.store ?? null, String(body.password ?? ''))
    } catch (err) {
      this.#json(res, 400, { ok: false, error: { code: 'bad-password', message: String(err?.message ?? err) } })
      return
    }

    // 清缓存：下一次解析就走 kv，不再走 unset 分支
    this.passwordInfo = null
    this.log('info', 'qdash-neo: 控制台口令已由用户在首次设置页设定')
    this.#json(res, 200, { ok: true, redirect: `${this.mount}/login`.replace(/\/{2,}/g, '/') })
  }

  async #handleLogin(req, res, method) {
    if (method === 'GET' || method === 'HEAD') {
      if (this.#isAuthed(req)) {
        res.statusCode = 302
        res.setHeader('Location', `${this.mount}/`.replace(/\/{2,}/g, '/'))
        res.end()
        return
      }
      this.#serveStatic(req, res, '/login.html', method)
      return
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST')
      this.#json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '登录只接受 GET/POST' } })
      return
    }

    const ip = this.#clientIp(req)
    if (this.throttle.blocked(ip)) {
      this.log('warn', `qdash-neo: 登录失败次数过多，暂时拒绝 ${ip}`)
      this.#json(res, 429, { ok: false, error: { code: 'too-many-attempts', message: '尝试次数过多，请一分钟后再试' } })
      return
    }

    const body = await this.#readBody(req)
    const expected = this.passwordInfoOrResolve()
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const expectUser = String(this.config?.console?.username ?? 'admin').trim() || 'admin'

    if (!tokenMatches(password, expected.password) || username !== expectUser) {
      this.throttle.fail(ip)
      this.log('warn', `qdash-neo: 控制台登录失败 user=${username || '(空)'} from=${ip}`)
      this.#json(res, 401, { ok: false, error: { code: 'bad-credentials', message: '用户名或口令不正确' } })
      return
    }

    this.throttle.reset(ip)
    const { sid } = this.sessions.create()
    res.setHeader(
      'Set-Cookie',
      sessionCookieHeader({
        sid,
        mount: this.mount,
        secure: this.#isSecure(req),
        maxAgeSeconds: Math.floor(this.sessions.ttlMs / 1000),
      }),
    )
    res.setHeader('Cache-Control', 'no-store')
    this.log('info', `qdash-neo: 控制台登录成功 user=${expectUser} from=${ip}`)
    this.#json(res, 200, { ok: true, redirect: `${this.mount}/`.replace(/\/{2,}/g, '/'), user: expectUser })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  async #handleLogout(req, res, method) {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      this.#json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '登出只接受 POST' } })
      return
    }
    const sid = readSessionId(req)
    if (sid) this.sessions.destroy(sid)
    res.setHeader('Set-Cookie', clearSessionCookieHeader({ mount: this.mount }))
    res.setHeader('Cache-Control', 'no-store')
    this.#json(res, 200, { ok: true, redirect: `${this.mount}/login`.replace(/\/{2,}/g, '/') })
  }

  /**
   * 会话 cookie 或 Bearer，二者其一即可。
   * @param {import('node:http').IncomingMessage} req
   */
  #isAuthed(req) {
    if (this.sessions.verify(readSessionId(req))) return true
    const bearer = readBearer(req)
    if (!bearer) return false
    return tokenMatches(bearer, this.passwordInfoOrResolve().password)
  }

  /* ---------------- 读体 / 静态 / 错误 ---------------- */

  /**
   * 原样把 body 读成 Buffer，两层防护：
   *   1. 体积上限 —— 同步解析大 JSON 会卡住整个宿主进程，不是只卡这个标签页
   *   2. Content-Type 白名单 —— 登录页是表单（urlencoded），API 是 JSON
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<Buffer>}
   */
  async #readRaw(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        throw new api.ApiError('payload-too-large', `请求体超过上限 ${MAX_BODY_BYTES} 字节`, 413)
      }
      chunks.push(buf)
    }
    if (size === 0) throw new api.ApiError('bad-request', '请求体为空', 400)
    return Buffer.concat(chunks)
  }

  /**
   * 登录接口的体：`application/json` 或 `application/x-www-form-urlencoded`（登录页是普通表单，无 JS 也能用）。
   * @param {import('node:http').IncomingMessage} req
   */
  async #readBody(req) {
    const type = String(req.headers['content-type'] ?? '').toLowerCase()
    const raw = await this.#readRaw(req)
    const text = raw.toString('utf8')
    if (type.startsWith('application/json')) {
      try {
        return JSON.parse(text)
      } catch {
        throw new api.ApiError('bad-request', '请求体不是合法 JSON', 400)
      }
    }
    if (type.startsWith('application/x-www-form-urlencoded')) {
      /** @type {Record<string,string>} */
      const out = {}
      for (const [k, v] of new URLSearchParams(text)) out[k] = v
      return out
    }
    throw new api.ApiError('unsupported-media-type', '只接受 application/json 或表单提交', 415)
  }

  /**
   * 写接口的体：**只收 JSON**，并把三层防护做全：
   *   1. `Content-Type: application/json` —— 挡掉"表单跨站提交"那一整类（form 只能发三种 content-type）
   *   2. `Origin` 存在时必须同源 —— cookie 是 SameSite=Strict，但反向代理场景下它可能失效
   *   3. 体积上限
   *
   * @param {import('node:http').IncomingMessage} req
   */
  async #readJson(req) {
    const type = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!type.startsWith('application/json')) {
      throw new api.ApiError('unsupported-media-type', '写接口只接受 application/json', 415)
    }

    const origin = req.headers.origin
    if (origin && !this.#sameOrigin(String(origin), req)) {
      throw new api.ApiError('forbidden-origin', `拒绝跨源写请求（Origin=${origin}）`, 403)
    }

    const text = (await this.#readRaw(req)).toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new api.ApiError('bad-request', '请求体不是合法 JSON', 400)
    }
  }

  /** @param {string} origin @param {import('node:http').IncomingMessage} req */
  #sameOrigin(origin, req) {
    try {
      return new URL(origin).host === String(req.headers.host ?? '')
    } catch {
      return false // 连 origin 都不合法：当作跨源
    }
  }

  /** 独立模式挂在根：`/api/x` 原样返回；attach 模式剥掉前缀，不在前缀下返回 null */
  #strip(pathname) {
    if (!this.mount) return pathname
    if (pathname === this.mount) return '/'
    if (pathname.startsWith(`${this.mount}/`)) return pathname.slice(this.mount.length)
    return null
  }

  /**
   * 静态资源：只认 `STATIC` 里的键，其余 404。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} sub
   * @param {string} method
   */
  #serveStatic(req, res, sub, method) {
    const key = sub === '/' ? '' : sub.replace(/^\//, '')
    const file = STATIC[key]
    if (!file) {
      this.#json(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个页面' } })
      return
    }
    let buf = this.staticCache.get(file)
    if (!buf) {
      try {
        buf = readFileSync(new URL(file, PUBLIC_DIR))
        this.staticCache.set(file, buf)
      } catch (err) {
        this.log('error', `qdash-neo: 静态资源读取失败 file=${file} name=${err?.name} msg=${err?.message}`, err)
        this.#json(res, 500, { ok: false, error: { code: 'static-missing', message: '静态资源缺失' } })
        return
      }
    }
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
    /**
     * 一律 `no-cache`（不是 no-store）：允许浏览器存副本，但每次都要回来确认。
     *
     * 之前资源给的是 `max-age=60`，结果是"改了前端、刷新还是旧界面"——
     * 排查时会被当成后端没生效。控制台是本机页面，多半秒的协商开销比这种误导划算得多。
     */
    res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'no-cache')
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(buf)
  }

  /** @param {import('node:http').IncomingMessage} req */
  #isSecure(req) {
    if (req.socket && /** @type {any} */ (req.socket).encrypted) return true
    return String(req.headers?.['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
  }

  /**
   * 客户端 IP，用于登录限流与审计。
   *
   * 反代之后 `remoteAddress` 恒为 `127.0.0.1` —— 直接拿它当限流键，
   * **一个人输错几次就把所有人都锁了**（所有人都被算成同一个来源）。
   *
   * 所以只在来源是回环时才采信 `X-Forwarded-For`：那时请求必然来自同机的
   * 反代进程，而不是外部。直连场景下这个头可以被任意伪造，不能信。
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  #clientIp(req) {
    const remote = String(req.socket?.remoteAddress ?? '').trim()
    const isLoopback =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (isLoopback) {
      const xff = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
      if (xff) return xff
    }
    return remote || 'unknown'
  }

  async #dispatchApi(name, url) {
    const q = url.searchParams
    const ctx = { service: this.service, config: this.config, query: q, server: this }

    if (name === '' || name === '/') return api.meta({ ...ctx, mount: this.mount, tokenSource: this.passwordInfoOrResolve().source })
    if (name === '/meta') return api.meta({ ...ctx, mount: this.mount, tokenSource: this.passwordInfoOrResolve().source })
    if (name === '/config' || name === '/config/describe') return api.configDescribe(ctx)
    if (name === '/tools') return api.toolsCatalog(ctx)
    if (name === '/persona') return api.persona(ctx)
    if (name === '/tabs') return api.tabs(ctx)
    // 异步：listModels 要逐个 provider 去问宿主
    if (name === '/llm') return api.llm(ctx)
    if (name === '/overview') return api.overview(ctx)
    if (name === '/chats') return api.chats(ctx)
    if (name === '/judgements') return api.judgements(ctx)
    if (name === '/usage') return api.usage(ctx)
    if (name === '/dead') return api.dead(ctx)

    if (name.startsWith('/chats/')) {
      let key
      try {
        key = decodeURIComponent(name.slice('/chats/'.length))
      } catch {
        throw new api.ApiError('bad-request', '会话 key 的编码非法', 400)
      }
      return api.chat({ ...ctx, key })
    }

    throw new api.ApiError('not-found', `没有这个接口：${name}`, 404)
  }

  /** @param {Error & { status?: number, code?: string }} err */
  #mapError(err) {
    if (err instanceof api.ApiError) {
      return { status: err.status ?? 500, code: err.code ?? 'error', message: err.message }
    }
    const message = String(err?.message ?? err ?? '未知错误')
    if (/database is not open|database is closed/i.test(message)) {
      return { status: 503, code: 'kernel-stopped', message: '内核已停止（数据库已关闭）' }
    }
    return { status: 500, code: 'internal-error', message: '控制台内部错误（详情见内核日志）' }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {object} payload
   * @param {boolean} [headOnly]
   */
  #json(res, status, payload, headOnly = false) {
    const body = Buffer.from(JSON.stringify(payload))
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', String(body.length))
    if (headOnly) {
      res.end()
      return
    }
    res.end(body)
  }
}

/** 供测试/外部判断某个路径是否免鉴权（登录页资源） */
export function isPublicStatic(sub) {
  const key = sub === '/' ? '' : String(sub).replace(/^\//, '')
  return PUBLIC_STATIC.has(key)
}


