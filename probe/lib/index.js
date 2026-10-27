/**
 * qdn-probe v9 — v8 + M0 剩余两项运行时验证
 *
 * v9 在 v8 的基础上加了两项（见 lib/m0-2.js 与 docs/qdash-neo/05-施工计划.md §M0-1）：
 *   ① `approval/request` 与 `tool/call` 的时序（放行 + 拒绝各跑一次，按会话日志 seq 定序）
 *   ② 同 session 双持有者的报错形态（create 两次同 id，再看 dispose 后能否重建）
 * v8 的行为（路由/事件/假模型/dt 工具）全部保留，只是 turn 计数改成每实例独立。
 *
 * qdn-probe v8 — 可移植版（假 provider + 真工具执行）
 *
 * 与 v7 的唯一区别：**不再写死本机绝对路径**。
 *   - dsh-llm 的入口：运行时从 DSH 启动脚本往上找 node_modules
 *   - 日志输出：$QDN_PROBE_LOG，缺省落到系统临时目录
 *   - agent 的 cwd：$QDN_PROBE_CWD，缺省用进程 cwd
 *
 * 找不到 dsh-llm 时不静默降级：打一条显眼的 WARN，跳过假模型那部分，
 * 其余探针（路由、事件钩子、审批钩子）照常跑。要它真的跑起来就设
 * QDN_DSH_LLM=/abs/path/to/node_modules/@deepseek-ai/dsh-llm/lib/index.js
 */
import { appendFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installApprovalProbes, runApprovalOrdering, runDoubleHolder } from './m0-2.js'

export const name = 'qdn-probe'
export const inject = ['agents', 'tools', 'webServer', 'settings', 'llm']

// ---------------------------------------------------------------- 路径发现

/**
 * 定位 DSH 自己的 @deepseek-ai/dsh-llm。
 *
 * 为什么不能直接 `import '@deepseek-ai/dsh-llm'`：探针被复制到
 * `~/.dsh/profiles/web/node_modules/qdn-probe/`，那个 node_modules 里只有它自己，
 * 没有 @deepseek-ai/*，裸包名解析不到。所以从**宿主进程的入口脚本**往上找。
 */
function findDshLlm() {
  const tries = []
  if (process.env.QDN_DSH_LLM) tries.push(process.env.QDN_DSH_LLM.replace(/[\\/]lib[\\/]index\.js$/, ''))

  for (const argvPath of process.argv.slice(1)) {
    let dir = dirname(argvPath)
    for (let i = 0; i < 8; i++) {
      tries.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm'))
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }

  for (const candidate of tries) {
    const entry = join(candidate, 'lib', 'index.js')
    if (!existsSync(entry)) continue
    try {
      // 用 package.json 的解析规则再确认一次（能处理 exports 字段）
      return createRequire(join(candidate, 'package.json')).resolve('@deepseek-ai/dsh-llm')
    } catch {
      return entry
    }
  }
  return null
}

const llmEntry = findDshLlm()
let LlmAdapter = null
let createUserMessage = null
if (llmEntry) {
  const mod = await import(pathToFileURL(llmEntry).href)
  LlmAdapter = mod.LlmAdapter
  createUserMessage = mod.createUserMessage
}

// ---------------------------------------------------------------- 日志

const OUT = process.env.QDN_PROBE_LOG || join(tmpdir(), 'qdn-probe.log')
const WORKDIR = process.env.QDN_PROBE_CWD || process.cwd()
const T0 = Date.now()
const log = (...a) => {
  const line = `[P8 +${String(Date.now() - T0).padStart(5)}ms] ${a
    .map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')}`
  console.log(line)
  try {
    appendFileSync(OUT, line + '\n')
  } catch {}
}
const safe = (fn, label) => {
  try {
    return fn()
  } catch (e) {
    log(`ERR ${label}:`, e && e.message)
    return undefined
  }
}
const safeAsync = (fn, label) =>
  Promise.resolve()
    .then(fn)
    .catch(e => {
      log(`ERR ${label}: code=${e && e.code} name=${e && e.name} msg=${e && e.message}`)
      return undefined
    })

// ---------------------------------------------------------------- 假模型

const PROVIDER = 'qdn-fake'
const PROVIDER_ALLOW = 'qdn-fake-allow'
const PROVIDER_REJECT = 'qdn-fake-reject'
const MODEL = 'fake-1'
let turns = 0

// 找不到 dsh-llm 时用空基类占位：这个类永远不会被实例化（apply 会提前返回），
// 但模块本身必须能被 import 成功，否则整个探针都装不上。
const AdapterBase = LlmAdapter || class {}

class FakeAdapter extends AdapterBase {
  constructor({ label = 'main', forceTool } = {}) {
    super()
    this.label = label
    this.forceTool = forceTool
    this.turn = 0
  }
  providerInfo(provider) {
    return { id: provider, name: `QDN Fake (${this.label})` }
  }
  async listModels(provider) {
    return [{ id: MODEL, name: MODEL, provider }]
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      description: 'probe fake model',
      context: { contextWindow: 128000 },
      defaultMaxTokens: 4096,
    }
  }
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: o => this.stream(o) }
  }
  async *stream(options) {
    this.turn += 1
    turns += 1
    const tools = (options.tools || []).map(t => t.name)
    log(`--- STREAM[${this.label}] turn#${this.turn} tools=${tools.length}`)
    log('    offered:', tools.join(',') || 'NONE')

    if (this.turn === 1 && tools.length) {
      const target = (this.forceTool && tools.includes(this.forceTool))
        ? this.forceTool
        : ['Bash', 'working_directory', 'Read'].find(n => tools.includes(n)) || tools[0]
      const args =
        target === 'Bash'
          ? JSON.stringify({ command: 'echo qdn-probe-ok' })
          : target === 'working_directory'
            ? JSON.stringify({})
            : JSON.stringify({ file_path: 'package.json' })
      const id = 'call_probe_1'
      log(`    -> emit tool-call ${target}(${args})`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: target, argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: target, arguments: args },
      }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'probe done'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ---------------------------------------------------------------- 插件体

export function apply(ctx) {
  log('================ V8 APPLY ================')
  log('dsh-llm entry:', llmEntry || '(NOT FOUND)')
  log('log file    :', OUT)
  log('workdir     :', WORKDIR)

  if (!LlmAdapter) {
    log('!!! WARN dsh-llm 未找到，假 provider 与 agents 验证全部跳过')
    log('!!! WARN 修法：设 QDN_DSH_LLM=<dsh>/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
    log('!!! WARN （其余探针：路由、事件钩子、审批钩子，仍然会跑）')
  }

  // ---- 事件序列（与 dsh-llm 无关，始终挂）
  safe(() => {
    ctx.on('session/event', (session, ev) => {
      const sid = (session && session.header && session.header.id) || '?'
      let extra = ''
      try {
        if (ev && ev.type === 'turn/end') {
          extra = 'REASON=' + JSON.stringify(ev.data && ev.data.reason)
        } else if (ev && ev.type === 'assistant/message') {
          const m = ev.data && ev.data.message
          extra = JSON.stringify({
            usage: ev.data && ev.data.usage,
            blocks: ((m && m.content) || []).map(c => c.type),
          })
        } else if (ev && ev.type === 'assistant/attempt') {
          extra = 'attempt(stream=' + typeof (ev.data && ev.data.stream) + ')'
        } else if (ev && /tool|error/i.test(ev.type)) {
          extra = JSON.stringify(ev.data).slice(0, 400)
        }
      } catch (e) {
        extra = 'dump-err ' + e.message
      }
      log(`>>> EV ${ev && ev.type}`, extra, `[sid=${sid}]`)
    })
  }, 'session/event')

  // ---- 审批钩子（M0-1 第①项：制造一次 ask、并给应答加延迟来看时序）
  if (!safe(() => (installApprovalProbes(ctx, log, { delayMs: 1200 }), true), 'approval hooks')) return

  if (!LlmAdapter) {
    log('================ V9 DONE (degraded) ================')
    return
  }

  for (const [prov, label] of [
    [PROVIDER, 'main'],
    [PROVIDER_ALLOW, 'allow'],
    [PROVIDER_REJECT, 'reject'],
  ]) {
    const reg = safe(
      () => ctx.llm.registerAdapter([prov], new FakeAdapter({ label, forceTool: 'working_directory' })),
      `llm.registerAdapter(${prov})`,
    )
    log(
      `registerAdapter(${prov}) returned:`,
      typeof reg,
      reg && typeof reg.replace === 'function' ? '(has .replace)' : '',
    )
  }

  // 加时间戳：create() 对已存在的 session id 会拒绝（见 m0-2.js RUN 的注释），
  // 固定 id 会让第二次运行整个 v8 段失败。
  const SESSION_ID = `qdn-probe:v8-${Date.now()}`
  let started = false
  const RESULTS = {}

  const runV8 = async () => {
    const ac = ctx.agents
    const h = await safeAsync(
      () =>
        ac.create({
          sessionId: SESSION_ID,
          agentOptions: { provider: PROVIDER, model: MODEL },
          meta: { cwd: WORKDIR },
        }),
      'create v8',
    )
    if (!h) return
    const ag = h.agent
    log('agent.options:', JSON.stringify(ag.options))

    const msg = createUserMessage({
      content: [{ type: 'text', text: '执行 echo qdn-probe-ok' }],
      source: { kind: 'user' },
    })
    log('msg id:', msg.id)

    const ret = safe(() => ag.followup(msg), 'followup')
    log('followup ->', ret === undefined ? '(void)' : JSON.stringify(ret))

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const st = safe(() => ag.status, 'poll')
      if (st === 'idle' && i > 1) {
        log(`settled at ${i + 1}s`)
        break
      }
    }

    log('FINAL status:', safe(() => ag.status, 'st'))
    log('FINAL phase:', safe(() => JSON.stringify(ag.phase), 'phase'))
    log('STREAM turns:', turns)

    await safeAsync(() => ag.whenIdle(), 'whenIdle')
    log('whenIdle awaited OK')

    // dispose 语义复核：dispose 会移除 session（不能当暂停用）
    const before = safe(() => ac.get(SESSION_ID) !== undefined, 'get before')
    safe(() => h.dispose(), 'dispose')
    await new Promise(r => setTimeout(r, 500))
    const after = safe(() => ac.get(SESSION_ID) !== undefined, 'get after')
    log(`dispose 语义：before=${before ? 'present' : 'absent'} after=${after ? 'present' : 'absent'}`)
  }

  const run = async () => {
    if (started) return
    started = true
    const t0 = Date.now()
    log('---------------- V9 READY ----------------')

    await safeAsync(runV8, 'runV8')

    // ① 审批与 tool/call 的时序（放行 + 拒绝各一次）
    RESULTS.approval = await safeAsync(
      () =>
        runApprovalOrdering(ctx, {
          log,
          t0,
          model: MODEL,
          workdir: WORKDIR,
          createUserMessage,
          providers: { allow: PROVIDER_ALLOW, reject: PROVIDER_REJECT },
        }),
      'runApprovalOrdering',
    )

    // ② 同 session 双持有者
    RESULTS.dup = await safeAsync(
      () => runDoubleHolder(ctx, { log, provider: PROVIDER_ALLOW, model: MODEL, workdir: WORKDIR }),
      'runDoubleHolder',
    )

    log('================ V9 VERDICT ================')
    log('① 放行:', JSON.stringify(RESULTS.approval?.allow))
    log('① 拒绝:', JSON.stringify(RESULTS.approval?.reject))
    log('② 双持有者:', JSON.stringify(RESULTS.dup))
    log('================ V9 ALL DONE ================')
  }

  ctx.on('ready', () => {
    run().catch(e => log('ERR run:', e && e.message))
  })
  // 兜底：有些场景 ready 早于本插件 apply，给一个定时重试
  setTimeout(() => {
    run().catch(e => log('ERR run(t):', e && e.message))
  }, 14000)

  log('================ V9 DONE ================')
}
