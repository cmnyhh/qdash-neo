/**
 * 控制台后端测试：`node --test test/console.test.js`
 *
 * 用真实 `node:http` 监听 127.0.0.1:0，而不是 mock req/res：
 * 鉴权、Host、cookie、静态资源这些行为**只有过一遍真 HTTP 才算验过**。
 *
 * 重点不是"页面好不好看"，而是这四条：
 *   1. 没有口令 = 拿不到任何数据（连 meta 都不给）
 *   2. Host 不是本机 = 一律 403（DNS rebinding 防护）
 *   3. 静态资源只认白名单（路径穿越在映射表里就不存在）
 *   4. 数据面形状稳定：字段改名会让前端静默白屏，测试必须钉住
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConfigStore } from '../src/config/runtime.js'
import { Persona } from '../src/persona/index.js'
import { SESSION_COOKIE, resolvePassword } from '../src/console/auth.js'
import { ConsoleServer } from '../src/console/server.js'
import { Store } from '../src/store/db.js'

const TOKEN = 'test-token-123'

function fakeService(store, over = {}) {
  return {
    store,
    client: { selfId: '999', nickname: '小助手', healthy: () => true, wsUrl: 'ws://127.0.0.1:3001' },
    status() {
      return {
        started: true,
        onebot: { healthy: true, url: 'ws://127.0.0.1:3001' },
        stats: { inbound: 3, replied: 1 },
        queue: 2,
        chats: 1,
        groupTrigger: 'judge',
        quota: { windowMinutes: 10, maxReplies: 3 },
        judge: { enabled: true, threshold: 0.6, botNames: ['小助手'] },
        context: { chats: 1, lines: 4 },
        batching: { windowMs: 5000, maxWaitMs: 20_000, maxMessages: 20, atLookaheadMs: 2000, pending: [] },
        memory: { enabled: false },
        daily: { enabled: false, days: 3, backfillDays: 3, running: false, last: null },
        persona: { enabled: false, hasCard: false, hintChars: 0 },
        console: { enabled: true, mount: '/qdash-neo', registered: true, error: null },
      }
    },
    ...over,
  }
}

function seed(store) {
  const ts = Date.now()
  store.upsertChat({ chatKey: 'g:1', kind: 'group', chatId: '1', title: '群 1' })
  store.insertMessage({ chatKey: 'g:1', qqMsgId: 'a', direction: 'in', senderId: '1', senderName: '甲', text: '被挡掉的', state: 'dropped:policy', ts: ts - 3000 })
  store.insertMessage({ chatKey: 'g:1', qqMsgId: 'b', direction: 'in', senderId: '1', senderName: '甲', text: '在吗', state: 'context', ts: ts - 2000 })
  store.insertMessage({ chatKey: 'g:1', qqMsgId: 'c', direction: 'out', text: '发不出去', state: 'dead', ts: ts - 1000 })
  store.insertMessage({ chatKey: 'g:1', qqMsgId: 'd', direction: 'out', text: '答一句', state: 'sent', ts })
  store.recordJudgement({ chatKey: 'g:1', qqMsgId: 'b', layer: 'llm', verdict: 'silent', score: 0.2, code: 'chatter', reason: '闲聊', costMs: 1800, batchSize: 2, msgIds: ['a', 'b'], ts })
  store.recordUsage({ chatKey: 'g:1', inTokens: 100, outTokens: 10, cost: 0.001, stage: 'answer', ts })
  store.recordUsage({ chatKey: 'g:1', inTokens: 50, outTokens: 5, cost: 0.0005, stage: 'judge', ts })
}

/**
 * 起一套真 HTTP。所有请求走 `http.request` 而不是 fetch：
 * 只有这样才能自由设置 `Host`（DNS rebinding 那条用例必须伪造 Host）。
 */
/**
 * 给控制台写接口用的小 schema（形状与真 schemastery 一致：可调用 + dict/meta）。
 * 只放两个段：一个可写字段、一个"部署层锁"字段（wsUrl 由 base 覆盖）。
 */
function tinySchema() {
  const resolve = (node, input = {}) => {
    const out = {}
    for (const [k, child] of Object.entries(node.dict)) {
      const has = Object.prototype.hasOwnProperty.call(input, k)
      if (child.type === 'object') {
        out[k] = resolve(child, has ? input[k] : {})
        continue
      }
      out[k] = has ? structuredClone(input[k]) : structuredClone(child.meta?.default)
    }
    return out
  }
  const root = v => resolve(root, v ?? {})
  root.type = 'object'
  root.meta = { description: '测试配置' }
  root.dict = {
    policy: {
      type: 'object',
      meta: { description: '准入策略' },
      dict: {
        whitelist: { type: 'array', meta: { default: [] }, toString: () => '' },
        groupEnabled: { type: 'boolean', meta: { default: false }, toString: () => '' },
      },
    },
    onebot: {
      type: 'object',
      meta: { description: 'OneBot 连接' },
      dict: { wsUrl: { type: 'string', meta: { default: 'ws://127.0.0.1:3001' }, toString: () => '' } },
    },
  }
  return root
}

async function harness({
  consoleConfig = {},
  store = null,
  serviceOver = {},
  configSchema = null,
  configBase = null,
  // 口令来源：默认写进 config（改口令接口会拒绝），true 时改由 kv 承载（可改）
  passwordFromKv = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-console-'))
  const st = store ?? new Store(join(dir, 't.db'))
  const applied = []
  const configStore = configSchema
    ? new ConfigStore({ schema: configSchema, base: configBase ?? configSchema({}), store: st, log: () => {} })
    : null
  // 人格对象：控制台的 /api/persona 直接用它（真 Persona，不是桩）
  const persona = new Persona({ store: st, config: { persona: { enabled: true, text: '', judgeHint: '' } }, log: () => {} })
  const service = fakeService(st, {
    personaOf: () => persona,
    ...(configStore ? { configStore, applyConfig: next => applied.push(next) } : {}),
    ...serviceOver,
  })
  const server = new ConsoleServer({
    service,
    // 用 attach 模式跑：测试里的路径都是 `/qdash-neo/...`（standalone 挂在根上，路径会变）
    config: {
      console: {
        enabled: true,
        mode: 'attach',
        mount: '/qdash-neo',
        username: 'admin',
        password: passwordFromKv ? '' : TOKEN,
        pollMs: 5000,
        allowedHosts: [],
        ...consoleConfig,
      },
    },
    log: () => {},
  })
  service.console = server
  // 口令改由 kv 承载：source 会是 'kv'，改口令接口才允许写
  if (passwordFromKv) st.kvSet('console:password', TOKEN)
  const httpServer = http.createServer((req, res) => server.handle(req, res))
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  server.port = httpServer.address().port

  /**
   * @param {string} path
   * @param {{ method?: string, headers?: object, host?: string, body?: unknown }} [opts]
   *   body 传对象会被 JSON.stringify；传字符串原样发（用来测"非法 JSON"）
   */
  function request(path, { method = 'GET', headers = {}, host = `127.0.0.1:${server.port}`, body = null } = {}) {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    const finalHeaders = { ...headers, host }
    if (payload) finalHeaders['content-length'] = String(payload.length)
    return new Promise((resolve, reject) => {
      const req = http.request(
        // agent:false 关掉 keep-alive：否则 dispose 里的 close() 要等空闲连接超时（5s/次），
        // 几十个请求叠起来就是"测试跑完卡住"的观感，而且 close 可能永远等不到
        { host: '127.0.0.1', port: server.port, method, path, headers: finalHeaders, agent: false },
        res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json })
          })
        },
      )
      req.on('error', reject)
      req.end(payload ?? undefined)
    })
  }

  /** 脚本入口：Bearer 口令（不经过登录页） */
  const auth = { authorization: `Bearer ${TOKEN}` }

  /**
   * 浏览器入口：走真登录接口拿会话 cookie。
   * @returns {Promise<{ res: object, cookie: string, raw: string }>}
   */
  async function login({ username = 'admin', password = TOKEN } = {}) {
    const res = await request('/qdash-neo/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { username, password },
    })
    const raw = String(res.headers['set-cookie'] ?? '')
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw)
    return { res, raw, cookie: m ? `${SESSION_COOKIE}=${m[1]}` : '' }
  }

  return {
    server,
    store: st,
    service,
    applied,
    configStore,
    request,
    auth,
    login,
    async dispose() {
      // 先掐掉所有连接再 close：有半开连接时 close 的回调永远不来
      httpServer.closeAllConnections?.()
      await new Promise(resolve => httpServer.close(() => resolve()))
      st.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('控制台：/health 免口令，其他接口一律 401', async () => {
  const h = await harness()
  try {
    const health = await h.request('/qdash-neo/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)

    const meta = await h.request('/qdash-neo/api/meta')
    assert.equal(meta.status, 401)
    assert.equal(meta.json.error.code, 'unauthorized')
    assert.doesNotMatch(meta.text, /test-token/, '401 响应体不能回显任何口令')

    const wrong = await h.request('/qdash-neo/api/overview', { headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)
  } finally {
    await h.dispose()
  }
})

test('登录：未登录的页面请求 302 到 /login，API 请求 401 并给 loginUrl', async () => {
  const h = await harness()
  try {
    const page = await h.request('/qdash-neo/')
    assert.equal(page.status, 302)
    assert.equal(page.headers.location, '/qdash-neo/login')

    const api = await h.request('/qdash-neo/api/meta')
    assert.equal(api.status, 401)
    assert.equal(api.json.error.code, 'unauthorized')
    assert.equal(api.json.loginUrl, '/qdash-neo/login')

    // 登录页与它自己的静态资源必须免鉴权，否则鸡生蛋
    const loginPage = await h.request('/qdash-neo/login')
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.text, /id="login-form"/)
    const css = await h.request('/qdash-neo/assets/theme.css')
    assert.equal(css.status, 200)
    const js = await h.request('/qdash-neo/assets/login.js')
    assert.equal(js.status, 200)

    // 但不该把控制台本体漏出去
    const app = await h.request('/qdash-neo/assets/app.js')
    assert.equal(app.status, 302)
  } finally {
    await h.dispose()
  }
})

test('登录：错口令 401、对口令 200 并下发 HttpOnly 会话 cookie，登出后失效', async () => {
  const h = await harness()
  try {
    const bad = await h.login({ password: 'wrong' })
    assert.equal(bad.res.status, 401)
    assert.equal(bad.res.json.error.code, 'bad-credentials')
    assert.equal(bad.cookie, '')
    // 不区分用户名错/口令错：区分等于送一个用户名字典
    const badUser = await h.login({ username: 'root' })
    assert.equal(badUser.res.status, 401)
    assert.equal(badUser.res.json.error.code, 'bad-credentials')

    const ok = await h.login()
    assert.equal(ok.res.status, 200)
    assert.equal(ok.res.json.ok, true)
    assert.equal(ok.res.json.redirect, '/qdash-neo/')
    assert.match(ok.raw, new RegExp(`${SESSION_COOKIE}=`))
    assert.match(ok.raw, /HttpOnly/)
    assert.match(ok.raw, /SameSite=Strict/)
    assert.match(ok.raw, /Path=\/qdash-neo/)
    assert.doesNotMatch(ok.raw, new RegExp(TOKEN), 'cookie 里不能是口令本身')

    const meta = await h.request('/qdash-neo/api/meta', { headers: { cookie: ok.cookie } })
    assert.equal(meta.status, 200)
    assert.equal(meta.json.ok, true)
    assert.equal(meta.json.bot.nickname, '小助手')
    assert.doesNotMatch(meta.text, /test-token/, 'meta 不能把口令带出去')

    // 伪造/过期会话一样进不去
    const forged = await h.request('/qdash-neo/api/meta', { headers: { cookie: `${SESSION_COOKIE}=deadbeef` } })
    assert.equal(forged.status, 401)

    const out = await h.request('/qdash-neo/logout', { method: 'POST', headers: { cookie: ok.cookie } })
    assert.equal(out.status, 200)
    assert.match(String(out.headers['set-cookie'] ?? ''), /Max-Age=0/)
    const after = await h.request('/qdash-neo/api/meta', { headers: { cookie: ok.cookie } })
    assert.equal(after.status, 401, '登出必须真的销毁服务端会话')
  } finally {
    await h.dispose()
  }
})

test('登录：失败次数过多 429（本机端口也是可被扫的）', async () => {
  const h = await harness()
  try {
    for (let i = 0; i < 8; i += 1) await h.login({ password: `wrong-${i}` })
    const blocked = await h.login({ password: 'wrong-9' })
    assert.equal(blocked.res.status, 429)
    assert.equal(blocked.res.json.error.code, 'too-many-attempts')
    // 被限流之后，正确口令也要等一分钟 —— 否则限流形同虚设
    const stillBlocked = await h.login()
    assert.equal(stillBlocked.res.status, 429)
  } finally {
    await h.dispose()
  }
})

test('控制台：Bearer 头也能过（脚本/curl 用），Host 不在白名单一律 403', async () => {
  const h = await harness()
  try {
    const ok = await h.request('/qdash-neo/api/meta', { headers: h.auth })
    assert.equal(ok.status, 200)

    const evil = await h.request('/qdash-neo/api/meta', { headers: h.auth, host: 'attacker.example' })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.error.code, 'forbidden-host')

    const allowed = await harness({ consoleConfig: { allowedHosts: ['my-nas.lan'] } })
    try {
      const lan = await allowed.request('/qdash-neo/api/meta', { headers: allowed.auth, host: 'my-nas.lan:3080' })
      assert.equal(lan.status, 200, '显式配了的 Host 要放行（局域网场景）')
    } finally {
      await allowed.dispose()
    }
  } finally {
    await h.dispose()
  }
})

test('控制台：静态资源走白名单，方法只允许 GET/HEAD', async () => {
  const h = await harness()
  try {
    // 走 cookie 流程之后的常态：带会话就不要再带 token（带 token 会 302，那是换 cookie 用的一次性动作）
    const page = await h.request('/qdash-neo/', { headers: h.auth })
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /text\/html/)
    assert.match(page.text, /qdash-neo 控制台/)
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/)
    assert.equal(page.headers['x-frame-options'], 'DENY')

    const js = await h.request('/qdash-neo/assets/app.js', { headers: h.auth })
    assert.equal(js.status, 200)
    assert.match(String(js.headers['content-type']), /javascript/)

    const css = await h.request('/qdash-neo/assets/theme.css', { headers: h.auth })
    assert.equal(css.status, 200)
    assert.match(String(css.headers['content-type']), /text\/css/)

    for (const bad of ['/qdash-neo/assets/../../package.json', '/qdash-neo/assets/nope.js', '/qdash-neo/../etc/passwd']) {
      const res = await h.request(bad, { headers: h.auth })
      assert.equal(res.status, 404, `${bad} 必须 404`)
    }

    const post = await h.request('/qdash-neo/api/overview', { method: 'POST', headers: h.auth })
    assert.equal(post.status, 405)
    assert.equal(post.json.error.code, 'method-not-allowed')

    const head = await h.request('/qdash-neo/api/meta', { method: 'HEAD', headers: h.auth })
    assert.equal(head.status, 200)
    assert.equal(head.text, '', 'HEAD 不返回正文')
  } finally {
    await h.dispose()
  }
})

test('控制台：本机以外的挂载前缀不会误吞', async () => {
  const h = await harness()
  try {
    // 不在挂载前缀下的路径一律 404（`/qdash-neox` 不能被 `/qdash-neo` 前缀吞掉）
    assert.equal((await h.request('/qdash-neox/api/meta')).status, 404)
    assert.equal((await h.request('/other')).status, 404)
  } finally {
    await h.dispose()
  }
})

test('控制台 API：总览带运行态、今日用量、判定分布、死信数', async () => {
  const h = await harness()
  seed(h.store)
  try {
    const res = await h.request('/qdash-neo/api/overview', { headers: h.auth })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.status.onebot.healthy, true)
    assert.equal(res.json.usage.today.total.calls, 2, '两条 usage 都算进今天')
    assert.equal(res.json.usage.today.stages.judge.calls, 1)
    assert.ok(Array.isArray(res.json.usage.days) && res.json.usage.days.length >= 1, '总览要给迷你柱 7 天序列')
    assert.equal(res.json.judgements.stats24h.total, 1)
    assert.equal(res.json.judgements.recent.length, 1)
    assert.equal(res.json.dead.total, 1)
    assert.equal(res.json.dead.recent[0].text, '发不出去')
  } finally {
    await h.dispose()
  }
})

test('控制台 API：会话列表与详情能看到死信/丢弃状态，未知会话 404', async () => {
  const h = await harness()
  seed(h.store)
  try {
    const list = await h.request('/qdash-neo/api/chats', { headers: h.auth })
    assert.equal(list.status, 200)
    assert.equal(list.json.chats.length, 1)
    assert.equal(list.json.chats[0].msgCount, 4)
    assert.equal(list.json.chats[0].deadCount, 1)
    assert.equal(list.json.chats[0].last.text, '答一句')
    assert.equal(list.json.status.started, true)

    const detail = await h.request('/qdash-neo/api/chats/g%3A1', { headers: h.auth })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.chat.chatKey, 'g:1')
    assert.deepEqual(detail.json.messages.map(m => m.state), ['dropped:policy', 'context', 'dead', 'sent'])
    assert.equal(detail.json.judgements[0].batchSize, 2)
    assert.deepEqual(detail.json.judgements[0].msgIds, ['a', 'b'])
    assert.equal(detail.json.states.dead, 1)

    const missing = await h.request('/qdash-neo/api/chats/g%3A404', { headers: h.auth })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'not-found')
  } finally {
    await h.dispose()
  }
})

test('控制台 API：判定筛选与非法参数', async () => {
  const h = await harness()
  seed(h.store)
  try {
    const all = await h.request('/qdash-neo/api/judgements', { headers: h.auth })
    assert.equal(all.json.rows.length, 1)

    const filtered = await h.request('/qdash-neo/api/judgements?layer=gate', { headers: h.auth })
    assert.equal(filtered.json.rows.length, 0, '没有 gate 层的行就返回空，不是 500')

    const bad = await h.request('/qdash-neo/api/judgements?verdict=maybe', { headers: h.auth })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'bad-request')

    const clamped = await h.request('/qdash-neo/api/chats?limit=9999', { headers: h.auth })
    assert.equal(clamped.status, 200)
    const weird = await h.request('/qdash-neo/api/chats?limit=abc', { headers: h.auth })
    assert.equal(weird.status, 200)
  } finally {
    await h.dispose()
  }
})

test('控制台 API：用量按天×阶段聚合，死信接口独立可查', async () => {
  const h = await harness()
  seed(h.store)
  try {
    const usage = await h.request('/qdash-neo/api/usage?days=7', { headers: h.auth })
    assert.equal(usage.status, 200)
    assert.equal(usage.json.total.calls, 2)
    assert.equal(usage.json.byStage.answer.calls, 1)
    assert.equal(usage.json.byStage.judge.calls, 1)
    assert.equal(usage.json.byDay.length, 1)
    assert.ok(usage.json.judgeShare > 0)

    const dead = await h.request('/qdash-neo/api/dead', { headers: h.auth })
    assert.equal(dead.json.total, 1)
    assert.equal(dead.json.rows[0].chatKey, 'g:1')
  } finally {
    await h.dispose()
  }
})

test('控制台：store 未就绪是 503（不是 500，也不能假装成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-console-nr-'))
  const server = new ConsoleServer({
    service: fakeService(null),
    config: { console: { enabled: true, mode: 'attach', mount: '/qdash-neo', password: TOKEN } },
    log: () => {},
  })
  const httpServer = http.createServer((req, res) => server.handle(req, res))
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  const call = path =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` }, agent: false },
        res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  try {
    const res = await call('/qdash-neo/api/overview')
    assert.equal(res.status, 503)
    assert.equal(res.json.error.code, 'not-ready')
  } finally {
    // keep-alive 连接不断开时 close 的回调永远不来 —— 这正是"测试跑完卡住"的真凶
    httpServer.closeAllConnections?.()
    await new Promise(resolve => httpServer.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('控制台口令：配置优先；留空时首启生成并落 kv，重启不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdn-token-'))
  const store = new Store(join(dir, 't.db'))
  try {
    const fromConfig = resolvePassword({ store, config: { console: { password: 'explicit' } } })
    assert.equal(fromConfig.source, 'config')
    assert.equal(fromConfig.password, 'explicit')

    const first = resolvePassword({ store, config: { console: { password: '' } } })
    assert.equal(first.source, 'generated')
    assert.ok(first.password.length >= 16)

    const second = resolvePassword({ store, config: { console: { password: '' } } })
    assert.equal(second.source, 'kv')
    assert.equal(second.password, first.password, '重启后口令必须一样，否则每次都要重新登录')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- 写接口（M3 第二阶段） ----------------
   这一组不是"能保存就行"，而是**每一种非法写请求都有确定的拒绝码**：
   写接口是控制台唯一能改变内核行为的地方，含糊的失败会直接变成"改了没生效"。 */

const JSON_HEADERS = { 'content-type': 'application/json' }

test('写接口：POST 无口令 401，URL 口令 401，跨源 403，非 JSON 415', async () => {
  const h = await harness({ configSchema: tinySchema() })
  try {
    const noAuth = await h.request('/qdash-neo/api/config', { method: 'POST', headers: JSON_HEADERS, body: { patch: {} } })
    assert.equal(noAuth.status, 401)

    // 口令不再接受走 URL：能改东西的入口不能从地址栏触发（`?token=` 已经是历史）
    const viaQuery = await h.request(`/qdash-neo/api/config?token=${TOKEN}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: { patch: { 'policy.groupEnabled': true }, revision: 0 },
    })
    assert.equal(viaQuery.status, 401)
    assert.equal(viaQuery.json.error.code, 'unauthorized')

    const crossOrigin = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS, origin: 'http://attacker.example' },
      body: { patch: { 'policy.groupEnabled': true }, revision: 0 },
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.json.error.code, 'forbidden-origin')

    // 表单提交只能发三种 content-type，挡掉它就挡掉整类 CSRF
    const formPost = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: '{"patch":{}}',
    })
    assert.equal(formPost.status, 415)
    assert.equal(formPost.json.error.code, 'unsupported-media-type')

    // 同源 Origin 必须放行，否则正常页面反而写不了
    const sameOrigin = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS, origin: `http://127.0.0.1:${h.server.port}` },
      body: { patch: { 'policy.groupEnabled': true }, revision: 0 },
    })
    assert.equal(sameOrigin.status, 200)
  } finally {
    await h.dispose()
  }
})

test('写接口：GET 能读描述，POST 能改，改完 revision 递增且调用了 applyConfig', async () => {
  const schema = tinySchema()
  // 模拟"部署方在 patch 里显式写了 wsUrl"：该字段必须显示为锁定 + 需重启
  const base = schema({})
  base.onebot.wsUrl = 'ws://real.example:7777'
  const h = await harness({ configSchema: schema, configBase: base })
  try {
    const before = await h.request('/qdash-neo/api/config', { headers: h.auth })
    assert.equal(before.status, 200)
    assert.equal(before.json.ok, true)
    assert.equal(before.json.revision, 0)
    assert.equal(before.json.writable, true)
    assert.equal(before.json.groups.length, 2)
    assert.deepEqual(before.json.audit, [])

    // wsUrl 在 base 里被显式写过，应显示为锁定
    const wsUrl = before.json.groups.flatMap(g => g.fields).find(f => f.path === 'onebot.wsUrl')
    assert.equal(wsUrl.locked, true)
    // OneBot 三件套现在是 reconnect（保存后自动重连），不再是"需重启 + 字段灰掉"
    assert.equal(wsUrl.applies, 'reconnect')

    const saved = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { patch: { 'policy.whitelist': ['10001'] }, revision: 0 },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.revision, 1)
    assert.equal(saved.json.changed.length, 1)
    assert.equal(saved.json.changed[0].path, 'policy.whitelist')
    assert.deepEqual(saved.json.describe.groups.flatMap(g => g.fields).find(f => f.path === 'policy.whitelist').value, ['10001'])

    assert.equal(h.store.kvGet('cfg:policy.whitelist'), '["10001"]', '必须真的落盘，否则重启就丢')
    assert.equal(h.applied.length, 1, '保存后必须立刻走热更新链路')
    assert.deepEqual(h.applied[0].policy.whitelist, ['10001'])
    assert.equal(saved.json.audit.length, 1)
  } finally {
    await h.dispose()
  }
})

test('写接口：revision 冲突 409、非法 JSON 400、超大 body 413', async () => {
  const h = await harness({ configSchema: tinySchema() })
  try {
    await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { patch: { 'policy.groupEnabled': true }, revision: 0 },
    })

    const stale = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { patch: { 'policy.groupEnabled': false }, revision: 0 },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'config-conflict')

    const broken = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: '{"patch":',
    })
    assert.equal(broken.status, 400)

    const huge = await h.request('/qdash-neo/api/config', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: JSON.stringify({ patch: { 'policy.whitelist': ['x'.repeat(70 * 1024)] }, revision: 1 }),
    })
    assert.equal(huge.status, 413)
    assert.equal(huge.json.error.code, 'payload-too-large')
  } finally {
    await h.dispose()
  }
})

test('写接口：方法允许表按路由给（GET 打动作接口 405，DELETE 打配置 405）', async () => {
  const h = await harness({ configSchema: tinySchema() })
  try {
    const del = await h.request('/qdash-neo/api/config', { method: 'DELETE', headers: h.auth })
    assert.equal(del.status, 405)
    assert.equal(del.headers.allow, 'GET, HEAD, POST')

    const getAction = await h.request('/qdash-neo/api/tabs/demo/actions/ping', { headers: h.auth })
    assert.equal(getAction.status, 405)
    assert.equal(getAction.headers.allow, 'POST')

    // 只读接口仍然只接受 GET/HEAD：不能因为开了写口子就整体放开
    const postOverview = await h.request('/qdash-neo/api/overview', { method: 'POST', headers: { ...h.auth, ...JSON_HEADERS }, body: {} })
    assert.equal(postOverview.status, 405)
    assert.equal(postOverview.headers.allow, 'GET, HEAD')
  } finally {
    await h.dispose()
  }
})

test('选项卡：/api/tabs 为空时形状完整，注册后出现在列表里，动作可执行', async () => {
  const h = await harness({ configSchema: tinySchema() })
  try {
    const emptyList = await h.request('/qdash-neo/api/tabs', { headers: h.auth })
    assert.equal(emptyList.status, 200)
    assert.deepEqual(emptyList.json.tabs, [])
    assert.ok(emptyList.json.status, '形状要带 status：顶部状态带只认它')

    h.server.registerTab({
      id: 'demo',
      title: '演示',
      order: 10,
      owner: 'test',
      layout: [
        { type: 'status', items: [{ label: '状态', value: '就绪' }] },
        { type: 'actions', actions: [{ id: 'ping', label: '点我', run: payload => ({ pong: payload ?? null }) }] },
      ],
    })

    const list = await h.request('/qdash-neo/api/tabs', { headers: h.auth })
    assert.equal(list.json.tabs.length, 1)
    assert.equal(list.json.tabs[0].id, 'demo')
    assert.equal(JSON.stringify(list.json).includes('function'), false, '动作函数不能出现在响应里')

    const run = await h.request('/qdash-neo/api/tabs/demo/actions/ping', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { hello: 1 },
    })
    assert.equal(run.status, 200)
    assert.deepEqual(run.json.result, { pong: { hello: 1 } })

    const missing = await h.request('/qdash-neo/api/tabs/ghost/actions/ping', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: {},
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'tab-not-found')
  } finally {
    await h.dispose()
  }
})

test('改口令：旧口令错 401、太短 400、成功后旧口令失效新口令可用', async () => {
  const h = await harness({ passwordFromKv: true })
  const NEW = 'new-password-1'
  try {
    const short = await h.request('/qdash-neo/api/account/password', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { current: TOKEN, next: '123' },
    })
    assert.equal(short.status, 400)
    assert.equal(short.json.error.code, 'weak-password')

    const wrong = await h.request('/qdash-neo/api/account/password', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { current: 'nope', next: NEW },
    })
    assert.equal(wrong.status, 401, '会话被劫持时不能只凭 cookie 就换口令')
    assert.equal(wrong.json.error.code, 'bad-credentials')

    const ok = await h.request('/qdash-neo/api/account/password', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { current: TOKEN, next: NEW },
    })
    assert.equal(ok.status, 200)

    assert.equal((await h.login({ password: TOKEN })).res.status, 401, '旧口令必须失效')
    assert.equal((await h.login({ password: NEW })).res.status, 200, '新口令要能登')
  } finally {
    await h.dispose()
  }
})

test('改口令：口令来自部署层配置时拒绝（写 kv 不会生效，收下就是骗人）', async () => {
  const h = await harness()
  try {
    const res = await h.request('/qdash-neo/api/account/password', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { current: TOKEN, next: 'new-password-1' },
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.error.code, 'password-from-deploy')
    assert.match(res.json.error.message, /patch/)
  } finally {
    await h.dispose()
  }
})

test('工具目录：没有 ctx.tools 时 ready=false，但 QQ 清单照常返回', async () => {
  const h = await harness()
  try {
    const res = await h.request('/qdash-neo/api/tools', { headers: h.auth })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.ready, false, '测试 harness 没有 ctx.tools')
    // QQ 工具是插件自己的目录，不依赖宿主
    assert.ok(res.json.qq.length >= 15, `QQ 工具应完整（实际 ${res.json.qq.length}）`)
    assert.equal(res.json.qq.some(t => t.name === 'qq_get_image'), true)
    assert.equal(res.json.qq.some(t => t.name === 'qq_kick'), true, '目录里有，但默认不注册')
    assert.deepEqual(res.json.internal, [])
    assert.deepEqual(res.json.external, [])
    assert.deepEqual(res.json.blocked, [])
    assert.equal(res.json.config.qqAdmin, false, '踢人默认关')
  } finally {
    await h.dispose()
  }
})

test('LLM 清单：没有 ctx.llm 时降级成手填（200 + reason，不是 500）', async () => {
  const h = await harness()
  try {
    const res = await h.request('/qdash-neo/api/llm', { headers: h.auth })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.deepEqual(res.json.providers, [])
    assert.deepEqual(res.json.models, {})
    assert.equal(res.json.reason, 'no-llm-service')
  } finally {
    await h.dispose()
  }
})

test('人格卡 API：空库 → 保存自动生效 → 按 id 取全文 → 删除后 active 清空', async () => {
  const h = await harness()
  try {
    const empty = await h.request('/qdash-neo/api/persona', { headers: h.auth })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.cards, [])
    assert.equal(empty.json.activeId, '')

    const saved = await h.request('/qdash-neo/api/persona', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { action: 'save', card: { name: '鲸鱼', text: '你是鲸鱼', hint: '话少但护短' } },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.cards.length, 1)
    assert.equal(saved.json.active.name, '鲸鱼')
    assert.equal(saved.json.effective.source, 'card', '第一张卡要自动生效')
    // 列表只给长度：20 张卡全量下发会把每 5 秒的轮询撑大
    assert.equal(saved.json.cards[0].text, undefined)

    const one = await h.request(`/qdash-neo/api/persona?cardId=${saved.json.cards[0].id}`, { headers: h.auth })
    assert.equal(one.json.editing.text, '你是鲸鱼')
    assert.equal(one.json.editing.hint, '话少但护短')

    const bad = await h.request('/qdash-neo/api/persona', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { action: 'save', card: { name: '   ' } },
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'persona-invalid')

    const del = await h.request('/qdash-neo/api/persona', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { action: 'delete', id: saved.json.cards[0].id },
    })
    assert.equal(del.status, 200)
    assert.equal(del.json.cards.length, 0)
    assert.equal(del.json.activeId, '', '删掉当前卡要清空 active，回落部署层人设')
  } finally {
    await h.dispose()
  }
})

test('人格卡 API：未登录 401、跨源 403、未知操作 400', async () => {
  const h = await harness()
  try {
    const anon = await h.request('/qdash-neo/api/persona', { method: 'POST', headers: JSON_HEADERS, body: { action: 'save' } })
    assert.equal(anon.status, 401)

    const cross = await h.request('/qdash-neo/api/persona', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS, origin: 'http://attacker.example' },
      body: { action: 'save', card: { name: 'x' } },
    })
    assert.equal(cross.status, 403)
    assert.equal(cross.json.error.code, 'forbidden-origin')

    const unknown = await h.request('/qdash-neo/api/persona', {
      method: 'POST',
      headers: { ...h.auth, ...JSON_HEADERS },
      body: { action: 'destroy' },
    })
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.error.message, /未知操作/)
  } finally {
    await h.dispose()
  }
})

test('配置描述：provider/model 字段带 optionsFrom 标记（候选值由前端另拉）', async () => {
  const h = await harness({ configSchema: tinySchema() })
  try {
    // 假 schema 里没有 provider 字段，这条只验证"不会误标"：
    // 真正的 llm.providers 标记由 config.test.js 覆盖 schema-form 的映射规则
    const res = await h.request('/qdash-neo/api/config', { headers: h.auth })
    assert.equal(res.status, 200)
    const fields = res.json.groups.flatMap(g => g.fields)
    assert.equal(fields.every(f => f.optionsFrom === null || typeof f.optionsFrom === 'string'), true)
  } finally {
    await h.dispose()
  }
})
