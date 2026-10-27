/**
 * qdash-neo 插件入口。
 *
 * 形态是本项目不能推翻的决定之一（AGENTS.md §4.1）：**这就是一个 DSH 插件**，
 * 三件套 `name` / `inject` / `apply`，不另造 FeatureModule。
 *
 * 能力面：`ctx.provide('qdashNeo', service)` —— 卸载时随 fiber 自动注销（cordis Service 语义）。
 *
 * 用 ESM JS 而不是 TS 的原因：仓库里没有构建链，而 docs 的 05 又要求每个里程碑
 * 以可执行验证结束。探针（probe/）已经证明 DSH 直接吃 ESM JS；换成 TS 只多了
 * 一层 tsc，M1 拿不到任何收益。
 */
import { createConfig } from './config.js'
import { ConfigStore } from './config/runtime.js'
import { ConsoleServer } from './console/server.js'
import { hostImport } from './host.js'
import { QdashNeoService } from './service.js'

export const name = 'qdash-neo'

/**
 * `sessionPersistence` 是 `resume()` 的硬依赖（00 §六.2）——
 * 少了它，重启后既有会话接不回来。
 *
 * `llm` 是判定器（judge/llm.js 的 `ctx.llm.stream`）的硬依赖。
 * cordis 的 inject 是强制的：没声明就读属性会抛 `cannot get property "llm" without inject`
 * （2026-10-26 装进真 DSH 实测踩到 —— 单测里 ctx 是假的，永远不会暴露这一条）。
 */
/**
 * cordis 下**没声明的服务连读属性都会抛**，`?.` / `??` 都拦不住。
 *
 * - `tools`：控制台要列出"当前注册了哪些工具"才能画白名单勾选页；也是 `setup(agentCtx.tools)` 的前提
 * - `attachments`：**读图必需**。`dsh-web-app` 的 bundle 里带 `dsh-attachment-local`，
 *   所以 web profile 一定有这个服务。此前故意没加、改用 try/catch 探测，
 *   结果是探测永远拿到 null —— 工具明明传对了图 id，也只能回"看不了图"。
 *   （2026-10-26 真实踩到，用户发图后一直是"没有可用的图片通道"。）
 */
export const inject = [
  'agents',
  'sessionPersistence',
  'settings',
  'llm',
  'tools',
  'attachments',
  'webServer',
]

/** schemastery schema，宿主要用它做校验 + 派生控制台表单 */
export const Config = await createConfig()

const { createUserMessage } = await hostImport('@deepseek-ai/dsh-llm')

/**
 * 日志适配：优先用宿主 logger，退化到 console，但**永远带上 level 和上下文**。
 * @param {object} ctx
 */
function makeLogger(ctx) {
  let base = null
  try {
    if (typeof ctx.logger === 'function') base = ctx.logger('qdash-neo')
  } catch {
    base = null
  }
  return (level, ...args) => {
    const fn = base && typeof base[level] === 'function' ? base[level].bind(base) : console[level] ?? console.log
    fn(...args)
    // 宿主的 logger 不一定落到 stdout（web profile 里就看不到），
    // 开发期用 QDN_DEBUG=1 额外打一份到 stdout，否则插件"装了没反应"没法查。
    if (process.env.QDN_DEBUG) console.log(`[qdash-neo][${level}]`, ...args.map(a => (a instanceof Error ? a.stack : a)))
  }
}

/**
 * 把控制台挂到宿主端口的前缀上。
 *
 * `register` 在 `(kind, path)` 重复时**直接抛错**（路由是组合级契约）。
 * 这里不 rethrow：控制台挂了不该让整只插件起不来 —— 但必须记 error 并让
 * `status().console.error` 看得见，否则表现就是"控制台 404 但没有任何报错"。
 *
 * @param {object} ctx
 * @param {ConsoleServer} server
 * @param {Function} log
 * @returns {() => void} disposer
 */
function mountConsole(ctx, server, log) {
  if (!server.enabled) return () => {}

  // 独立端口（默认）：自己监听，完全不碰宿主端口 —— 端口规划、反代、插件加载顺序都与它无关
  if (server.mode === 'standalone') {
    server
      .start()
      .then(port => {
        log('info', `qdash-neo: 控制台已监听 ${server.listenHost}:${port} —— 打开 ${server.announceUrl()}`)
        // Host 全开时明说一句：这层放开了 DNS rebinding 防护
        if ((server.config?.console?.allowedHosts ?? []).map(String).includes('*')) {
          log(
            'warn',
            'qdash-neo: 控制台 Host 白名单为 *（放行任意 Host）。反代时免配置，但放弃了 DNS rebinding 防护；' +
              '想恢复就把它改成具体域名',
          )
        }

        const info = server.passwordInfoOrResolve()
        if (info.source === 'unset') {
          /**
           * 还没设口令：**首次访问时由用户自己设**，不再生成随机口令。
           *
           * 原来会生成一串 hex 打进日志，但大部分人不会去看日志（他们通过面板装插件，
           * 根本不知道日志在哪），于是控制台对他们等于不存在。
           */
          log(
            'info',
            `qdash-neo: 控制台尚未设置口令，首次打开 ${server.announceUrl()} 会让你自行设定`,
          )
        } else if (info.source === 'config') {
          log('info', 'qdash-neo: 控制台口令来自配置（console.password）')
        } else {
          log('info', 'qdash-neo: 控制台口令已设定过，不再重复打印')
        }
      })
      .catch(err => {
        server.error = `${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim()
        log(
          'error',
          `qdash-neo: 控制台端口监听失败 ${server.listenHost}:${server.listenPort} ${server.error}`,
          err,
        )
      })
    return () => {
      server.stop().catch(err => log('error', `qdash-neo: 控制台关闭失败 ${err?.name} ${err?.message}`, err))
    }
  }

  // attach：挂在宿主 webServer 的前缀下（反代已经在宿主端口后面的场景）
  const web = ctx.webServer
  if (!web || typeof web.register !== 'function') {
    server.error = 'ctx.webServer 不可用（宿主没提供或 inject 未生效）'
    log('error', `qdash-neo: 控制台未挂载 —— ${server.error}`)
    return () => {}
  }
  try {
    const dispose = web.register({
      kind: 'prefix',
      path: server.mount,
      handler: (req, res) => server.handle(req, res),
    })
    server.registered = true
    server.port = web.port ?? null
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (err) {
    server.error = `${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim()
    log('error', `qdash-neo: 控制台挂载失败 mount=${server.mount} ${server.error}`, err)
    return () => {}
  }
}

/**
 * @param {object} ctx DSH 上下文
 * @param {object} config 已按 Config 校验过的配置
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx)
  const service = new QdashNeoService(ctx, config ?? {}, { log, createUserMessage })
  const consoleServer = new ConsoleServer({ service, config: config ?? {}, log })
  // 让 status() 能如实报"控制台开没开、挂没挂上、错在哪"
  service.console = consoleServer

  /**
   * 运行层配置：`base` 就是 patch 解析出来的这一份，**不可变**；
   * 用户层要等 store 就绪才能读，所以先建对象、`start()` 之后 attach。
   */
  const configStore = new ConfigStore({ schema: Config, base: config ?? {}, store: null, log })
  service.configStore = configStore

  /**
   * **只 provide 白名单门面，不是整个 service。**
   *
   * 早先直接把实例交出去，插件能碰 `deliver` / `client` / `sleepUntil`
   * —— `capabilities` 那张表因此只是说明书，不是约束。
   * 门面是 `service.api`（白名单代理），键在 `PLUGIN_API_KEYS`。
   */
  ctx.provide('qdashNeo', service.api)

  // 显式释放 socket / sqlite / 监听器：多个 disposer 并发执行，所以合在一个 effect 里
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => service.stop())
  }
  const disposeConsole = mountConsole(ctx, consoleServer, log)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeConsole)
  }

  Promise.resolve()
    .then(() => service.start())
    .then(() => {
      // store 就绪：接上配置的持久层，并把上次在控制台改过的值重新生效 ——
      // 不重放的话，重启后控制台显示"新的"、实际行为却是旧的，这是最难查的一类不一致
      configStore.attachStore(service.store)
      const effective = configStore.effective()
      if (configStore.revision > 0) {
        service.applyConfig(effective)
        consoleServer.syncConfig(effective)
        log('info', `qdash-neo: 已重放控制台配置 revision=${configStore.revision}`)
      }
      // attach 模式的地址在监听成功后才有意义；standalone 由 mountConsole 自己打（避免重复）
      if (consoleServer.registered && consoleServer.mode !== 'standalone') {
        log('info', `qdash-neo: 控制台已挂载 ${consoleServer.mount} —— 打开 ${consoleServer.announceUrl()}`)
      }
    })
    .catch(err => log('error', `qdash-neo: 启动失败 name=${err?.name} msg=${err?.message}`, err))

  log('info', 'qdash-neo: 插件已加载')
}
