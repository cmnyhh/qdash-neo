/**
 * 独立控制台进程 —— 不依赖 DSH 宿主，专门用来长期挂着调试。
 *
 * 和插件内运行时**共用同一套代码**：真 `ConsoleServer` + 真 sqlite + 真 `ConfigStore`，
 * 只有 service 是桩（没有 OneBot、没有 agent 会话）。所以在这里改的配置会真的落库，
 * 也能真的验证表单/锁/审计/选项卡 —— 但它不会替你连 QQ。
 *
 * 用法：
 *   node scripts/console-standalone.mjs                 # 默认 127.0.0.1:7800
 *   QDN_CONSOLE_PORT=7810 node scripts/console-standalone.mjs
 *   QDN_HOST_MODULES=/path/to/dsh/node_modules node scripts/console-standalone.mjs
 *
 * 为什么要 QDN_HOST_MODULES：表单是从 `@deepseek-ai/schemastery` 派生的，
 * 而本仓库不带这个依赖（它是宿主 peer）。找不到时降级成"无字段、只读"，
 * 并在日志里明说 —— 不静默假装配置页坏了。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PORT = Number(process.env.QDN_CONSOLE_PORT ?? 7800)
const HOST = String(process.env.QDN_CONSOLE_HOST ?? '127.0.0.1')

const log = (level, msg, err) => {
  const line = `[console:${level}] ${msg}`
  if (err && level === 'error') console.error(line, err)
  else console.log(line)
}

/**
 * 猜宿主 node_modules（schemastery 只在宿主里，本仓库不带）。
 *
 * 顺序：环境变量 → 当前目录往上找（在 dsh-run 里跑时能命中）→ `~/.dsh/profiles/*`。
 * 都找不到就让 schema=null：控制台其余部分照常，配置页退化成空表单 —— 不静默崩，也不假装有字段。
 */
function hasSchemastery(nm) {
  return existsSync(join(nm, '@deepseek-ai', 'schemastery', 'package.json'))
}

function findHostModules() {
  const explicit = String(process.env.QDN_HOST_MODULES ?? '').trim()
  if (explicit) return explicit

  let dir = process.cwd()
  for (let i = 0; i < 8; i += 1) {
    const nm = join(dir, 'node_modules')
    if (hasSchemastery(nm)) return nm
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }

  const profiles = join(homedir(), '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const nm = join(profiles, name, 'node_modules')
      if (hasSchemastery(nm)) return nm
    }
  }
  return ''
}

const hostModules = findHostModules()
if (hostModules) process.env.QDN_HOST_MODULES = hostModules

const { ConfigStore } = await import('../src/config/runtime.js')
const { ConsoleServer } = await import('../src/console/server.js')
const { Persona } = await import('../src/persona/index.js')
const { Store } = await import('../src/store/db.js')

// schemastery 拿不到就让 schema=null：配置页退化成"没有字段"，但面板/选项卡照常
let schema = null
let config = {}
try {
  const { createConfig } = await import('../src/config.js')
  schema = await createConfig()
  config = schema({})
} catch (err) {
  log('warn', `拿不到 schemastery（${err?.message ?? err}），配置页将是空表单；设置 QDN_HOST_MODULES 指到 DSH 的 node_modules 可解决`)
}

/**
 * 默认用**独立的库**：和宿主共用一个 sqlite 文件时，两边同时写会 SQLITE_BUSY，
 * 而且调试改的配置会污染生产那份。想共享就显式 `QDN_DB=...`。
 */
const dbPath =
  String(process.env.QDN_DB ?? '').trim() || join(homedir(), '.dsh', 'storages', 'qdash-console-standalone.db')

const store = new Store(dbPath)
const configStore = new ConfigStore({ schema, base: config, store, log })
// 真 Persona：卡库读写走同一套 kv，独立进程里也能建卡/切卡（只是没有 QQ 侧消费方）
const persona = new Persona({ store, config, log })

/** 桩 service：字段形状要够控制台用，不假装在线 */
const service = {
  store,
  configStore,
  client: null,
  start() {},
  stop() {},
  personaOf() {
    return persona
  },
  applyConfig(next) {
    // 真 service 里有这一句；桩漏掉的话，控制台改了 persona.enabled 也不会反映到
    // /api/persona 的「当前生效」上 —— 表现就是"开关打开了但界面还说关着"
    persona.applyConfig(next)
    log('info', `已下发配置 revision=${configStore.revision}（本进程没有会话，只影响控制台自身）`)
  },
  status() {
    return {
      started: false,
      onebot: null,
      stats: { inbound: 0, dropped: 0, silent: 0, deferred: 0, replied: 0, batched: 0, errors: 0 },
      queue: 0,
      pendingReplies: 0,
      configRevision: configStore.revision,
      chats: 0,
      groupTrigger: 'mention',
      quota: { windowMinutes: 10, maxReplies: 3 },
      judge: { enabled: true, threshold: 0.6, botNames: [] },
      context: { chats: 0, lines: 0 },
      batching: { windowMs: 0, maxWaitMs: 0, maxMessages: 0, atLookaheadMs: 0, pending: [] },
      memory: { enabled: false },
      daily: { enabled: false, days: 0, backfillDays: 0, running: false, last: null },
      persona: { enabled: false, hasCard: false, hintChars: 0 },
      console: server.snapshot(),
    }
  },
}

const server = new ConsoleServer({
  service,
  config: {
    ...config,
    console: {
      ...(config.console ?? {}),
      mode: 'standalone',
      port: PORT,
      host: HOST,
      // 环境变量优先：调试实例常常想用固定口令，而不是去日志里翻生成的那个
      ...(process.env.QDN_CONSOLE_USER ? { username: process.env.QDN_CONSOLE_USER } : {}),
      ...(process.env.QDN_CONSOLE_PASSWORD ? { password: process.env.QDN_CONSOLE_PASSWORD } : {}),
      ...(process.env.QDN_CONSOLE_HOSTS ? { allowedHosts: process.env.QDN_CONSOLE_HOSTS.split(',') } : {}),
    },
  },
  log,
})
service.console = server
configStore.attachStore(store)
// 重放上次在控制台改过的配置（真宿主里由 index.js 做），否则重启后 persona 开关状态对不上
persona.applyConfig(configStore.effective())

// 演示用的选项卡：证明四块渲染与动作链路是通的（真插件会自己注册）
server.registerTab({
  id: 'demo',
  title: '演示',
  order: 90,
  owner: 'scripts/console-standalone.mjs',
  layout: [
    {
      type: 'status',
      title: '进程',
      items: [
        { label: '模式', value: 'standalone（无 DSH 宿主）' },
        { label: '数据库', value: store.path ?? '(默认)', },
        { label: '配置版本', value: `r${configStore.revision}`, tone: 'ok' },
      ],
    },
    {
      type: 'actions',
      title: '操作',
      actions: [{ id: 'ping', label: '点我', run: () => ({ ok: true, at: Date.now() }) }],
    },
  ],
})

await server.start()
const info = server.passwordInfoOrResolve()
log('info', `控制台已监听 ${HOST}:${server.port} —— 打开 ${server.announceUrl()}`)
log('info', `登录用户名 ${process.env.QDN_CONSOLE_USER ?? 'admin'}｜口令：${info.password}（来源 ${info.source}）`)
log('info', `数据库：${dbPath}${process.env.QDN_DB ? '（显式指定）' : '（独立库，不与宿主共享）'}`)

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return
    closing = true
    log('info', `收到 ${signal}，关闭中…`)
    await server.stop()
    store.close()
    process.exit(0)
  })
}
