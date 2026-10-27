/**
 * M0-1 剩余两项运行时验证（docs/qdash-neo/05-施工计划.md §M0-1）
 *
 *   ① `approval/request` 与 `tool/call` 的时序 —— 决定「审批超时被拒」对模型是否可见
 *   ② 同 session 双持有者的报错形态 —— 决定 `ensure()` 要不要自建互斥
 *
 * 判据不靠"看着像"，靠会话日志里的 seq：
 *   - `approval/asked` / `approval/decided` 是**会话事件**（dsh-user-approval/lib/index.js:132,139），
 *     和 `tool/call` 同在一条 append-only 日志里，seq 直接定序。
 *   - 「模型可见 = 已记录」（docs/qdash-neo/00 事实核查表 §一.3），所以 `tool/result` 的
 *     content 就是模型能看到的东西，不用猜。
 *
 * 触发审批的办法：不注册新工具，直接给现有工具 `working_directory` 在
 * `tools/pre-execute` 里返回 `{kind:'ask'}`（dsh-tools/lib/types/index.d.ts:445-460）。
 * 这样探针不依赖 defineTool 的 schema 转换，少一条出错路径。
 *
 * 应答延迟故意的：只有延迟才能看出 tool/call 是在审批**之前**还是**之后**落盘。
 */

const APPROVAL_TOOL = 'working_directory'

/**
 * 每轮用新的 session id 后缀。
 * 原因就是本次探针发现的事实：`create()` 对**已存在的 session id** 一律拒绝
 * （内存里存在 → plain Error；磁盘上有记录 → SessionAlreadyExistsError），
 * 所以固定 id 会让第二次运行全部撞车。
 */
const RUN = process.env.QDN_PROBE_RUN || String(Date.now())

/** 关心的日志事件（其余类型太多，会淹掉结论） */
const KEY_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'approval/policy',
])

const sleep = ms => new Promise(r => setTimeout(r, ms))

const sidOf = agent => {
  try {
    return agent?.session?.header?.id ?? '(无 session)'
  } catch {
    return '(读 session 出错)'
  }
}

const seqOf = agent => {
  try {
    return agent?.session?.seq
  } catch {
    return undefined
  }
}

/** 带超时的 await：DSH 的某些路径可能永不 settle，探针不能被挂死。 */
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`timeout: ${label} 超过 ${ms}ms 未返回`)
    }),
  ])
}

// ------------------------------------------------------------ 安装钩子

/**
 * 装三个钩子：pre-execute 制造 ask、approval/request 应答、并把每次进入的 seq 打点。
 * session id 里带 `reject` 的一律拒，其余放行 —— 一个进程里跑两种结论。
 */
export function installApprovalProbes(ctx, log, { delayMs = 1200 } = {}) {
  const approvalService = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
  log(`approval 服务存在: ${approvalService ? 'yes' : 'NO —— ask 会退化成 deny'}`)

  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      if (exec.name !== APPROVAL_TOOL) return next()
      log(
        `>>> PRE-EXECUTE ask tool=${exec.name} callId=${exec.callId} sid=${sidOf(exec.agent)} seq=${seqOf(exec.agent)}`,
      )
      return {
        kind: 'ask',
        reason: 'qdn-probe: M0 审批时序验证',
        displayReason: { en: 'qdn-probe approval', 'zh-CN': '探针审批' },
      }
    },
    { prepend: true },
  )
  log('hook tools/pre-execute OK')

  ctx.on(
    'approval/request',
    async req => {
      const sid = sidOf(req.agent)
      const decision = /reject/i.test(sid) ? 'rejected' : 'allowed-once'
      log(
        `>>> APPROVAL/REQUEST enter sid=${sid} tool=${req.toolName} callId=${req.callId} seq=${seqOf(req.agent)}`,
      )
      log(`    req.keys=${Object.keys(req || {}).join(',')} signal=${req.signal ? 'yes' : 'no'}`)
      await sleep(delayMs)
      log(`>>> APPROVAL/REQUEST answer=${decision} 延迟=${delayMs}ms 答时 seq=${seqOf(req.agent)}`)
      return decision
    },
    { prepend: true },
  )
  log('hook approval/request OK')
}

// ------------------------------------------------------------ 会话日志

function eventsOf(session) {
  if (typeof session.ownEvents === 'function') return session.ownEvents()
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

function describe(ev) {
  const d = ev.data || {}
  switch (ev.type) {
    case 'tool/call':
      return `name=${d.name} callId=${d.callId}`
    case 'tool/result': {
      // 注意：真实事件把结果包在 data.message 里，data.content 可能是 undefined
      const raw = d.content ?? d.message?.content
      const text = raw === undefined ? '(无 content 字段)' : JSON.stringify(raw)
      return `callId=${d.callId ?? d.message?.toolCallId} isError=${d.isError ?? d.message?.isError} content=${String(text).slice(0, 500)}`
    }
    case 'approval/asked':
      return `tool=${d.toolName} callId=${d.callId} reason=${String(d.reason).slice(0, 60)}`
    case 'approval/decided':
      return `outcome=${d.outcome}`
    case 'approval/policy':
      return `policy=${d.policy}`
    case 'turn/end':
      return `reason=${JSON.stringify(d.reason)}`
    case 'assistant/message':
      return `usage=${JSON.stringify(d.usage)} blocks=${(d.message?.content || []).map(c => c.type).join('+')}`
    default:
      return ''
  }
}

/**
 * 打整条日志（只打关键事件）+ 给出时序结论。
 * @returns 结论对象，便于上层汇总
 */
export function dumpSessionLog(session, log, label, t0) {
  const events = eventsOf(session)
  log(`---- ${label}：会话日志（关键事件）----`)
  for (const ev of events) {
    if (!KEY_EVENTS.has(ev.type)) continue
    const dt = typeof ev.time === 'number' ? ` +${ev.time - t0}ms` : ''
    log(`  seq=${ev.seq}${dt} ${ev.type} ${describe(ev)}`)
  }

  const first = type => events.find(e => e.type === type)?.seq
  const toolCall = first('tool/call')
  const asked = first('approval/asked')
  const result = first('tool/result')
  const decided = first('approval/decided')

  const verdict = {
    sessionId: sidOf({ session }),
    toolCallSeq: toolCall,
    approvalAskedSeq: asked,
    approvalDecidedSeq: decided,
    toolResultSeq: result,
  }

  if (toolCall === undefined || asked === undefined) {
    verdict.ordering = 'INCOMPLETE（缺少 tool/call 或 approval/asked，看上面的日志）'
  } else if (toolCall < asked) {
    verdict.ordering = `tool/call 先落盘（seq ${toolCall} < ${asked}）→ 审批在 tool/call 之后，拒绝也会产生 tool/result`
  } else {
    verdict.ordering = `approval/asked 先落盘（seq ${asked} < ${toolCall}）→ 审批在 tool/call 之前，被拒时没有 tool/call`
  }
  log(`>>>> 结论 ${label}: ${verdict.ordering}`)
  return verdict
}

// ------------------------------------------------------------ ① 审批时序

async function drive(ctx, { sessionId, provider, model, workdir, createUserMessage, log, label }) {
  log(`==== ${label}: create ${sessionId} (provider=${provider}) ====`)
  const handle = await withTimeout(
    ctx.agents.create({
      sessionId,
      agentOptions: { provider, model },
      meta: { cwd: workdir },
    }),
    15000,
    `create ${sessionId}`,
  )
  log(`create ok: handle.keys=${Object.keys(handle || {}).join(',')}`)
  const agent = handle.agent
  const seqBefore = seqOf(agent)
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: '请调用 working_directory 看当前目录' }],
      source: { kind: 'user' },
    }),
  )
  log('followup 已入队，等 turn 结束')

  // 不能直接 await whenIdle()：followup 刚入队时 agent 还是 idle，会立刻返回。
  // 判据用「seq 变过 + status 回到 idle 且连续稳定」。
  let stable = 0
  let lastSeq = seqBefore
  for (let i = 0; i < 300; i++) {
    await sleep(100)
    const s = seqOf(agent)
    const st = agent.status
    if (s !== lastSeq) {
      lastSeq = s
      stable = 0
      continue
    }
    if (st === 'idle' && s !== seqBefore) stable += 1
    if (stable >= 3) {
      log(`settled after ${(i + 1) * 100}ms, seq ${seqBefore} -> ${s}`)
      break
    }
  }
  log(`status=${agent.status} seq=${seqOf(agent)}`)
  return handle
}

/**
 * 跑一次「放行」一次「拒绝」，两次都返回日志结论。
 * @returns {{allow: object, reject: object}}
 */
export async function runApprovalOrdering(ctx, opts) {
  const { log, t0, providers } = opts
  const out = {}

  const allow = await drive(ctx, {
    ...opts,
    provider: providers.allow,
    sessionId: `qdn-probe:m0-allow-${RUN}`,
    label: '① 放行',
  })
  out.allow = dumpSessionLog(allow.agent.session, log, '① 放行', t0)

  const reject = await drive(ctx, {
    ...opts,
    provider: providers.reject,
    sessionId: `qdn-probe:m0-reject-${RUN}`,
    label: '① 拒绝',
  })
  out.reject = dumpSessionLog(reject.agent.session, log, '① 拒绝', t0)

  // 拒绝时模型到底看见什么：把 tool/result 和 turn/end 单独放大
  const rejEvents = eventsOf(reject.agent.session)
  const rejResult = rejEvents.find(e => e.type === 'tool/result')
  const rejTurnEnd = rejEvents.find(e => e.type === 'turn/end')
  log('>>>> 拒绝场景：模型可见内容 = ')
  log(`     tool/result: ${rejResult ? JSON.stringify(rejResult.data).slice(0, 600) : '(没有 tool/result 事件)'}`)
  log(`     turn/end   : ${rejTurnEnd ? JSON.stringify(rejTurnEnd.data).slice(0, 300) : '(没有 turn/end)'}`)

  await allow.dispose?.()
  await reject.dispose?.()
  return out
}

// ------------------------------------------------------------ ② 双持有者

function errShape(e) {
  if (!e) return '(无错误)'
  const own = Object.getOwnPropertyNames(e).filter(k => !['stack', 'message'].includes(k))
  return [
    `ctor=${e.constructor?.name}`,
    `name=${e.name}`,
    `code=${e.code ?? '(none)'}`,
    `message=${e.message}`,
    `ownProps=${own.join(',') || '(none)'}`,
  ].join(' ')
}

export async function runDoubleHolder(ctx, { log, provider, model, workdir }) {
  const SAME = `qdn-probe:m0-dup-${RUN}`
  log('==== ② 双持有者：create 同一 sessionId 两次 ====')
  log(`agents 服务方法: ${Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.agents)).join(',')}`)

  const h1 = await withTimeout(
    ctx.agents.create({ sessionId: SAME, agentOptions: { provider, model }, meta: { cwd: workdir } }),
    15000,
    'create#1',
  )
  log(`create#1 ok status=${h1.agent.status} agentId=${h1.agent.id ?? '(无 id)'}`)

  // 第二次：要么抛错，要么返回一个句柄（后者才危险 —— 两个 driver 抢一条日志）
  let h2 = null
  let err2 = null
  try {
    h2 = await withTimeout(
      ctx.agents.create({ sessionId: SAME, agentOptions: { provider, model }, meta: { cwd: workdir } }),
      15000,
      'create#2',
    )
  } catch (e) {
    err2 = e
  }

  if (err2) {
    log(`create#2 抛错：${errShape(err2)}`)
    // 分类：能不能只靠报错区分「已有 live 持有者」与「真失败」
    const keys = ['code', 'name', 'status', 'reason', 'kind'].filter(k => err2[k] !== undefined)
    log(`    可用于分类的字段: ${keys.length ? keys.join(',') : '(没有结构化字段，只能靠 message 匹配)'}`)
  } else {
    log(`create#2 返回了句柄（未抛错）：同一 agent=${h2.agent === h1.agent} keys=${Object.keys(h2 || {}).join(',')}`)
  }

  // create#1 的持有者是否还活着
  const live = (() => {
    try {
      return ctx.agents.get(SAME)
    } catch (e) {
      log(`ctx.agents.get 抛错：${errShape(e)}`)
      return undefined
    }
  })()
  log(`撞车后 ctx.agents.get(SAME) = ${live ? `present(stats=${live.status})` : 'absent'}`)
  log(`撞车后 h1.agent.status = ${h1.agent.status}`)

  // 释放后再建：区分「有 live 持有者」与「持久化记录存在」两种失败
  for (const h of [h2, h1]) {
    if (h && typeof h.dispose === 'function') {
      try {
        await h.dispose()
      } catch (e) {
        log(`dispose 抛错：${errShape(e)}`)
      }
    }
  }
  await sleep(800)

  const afterDispose = (() => {
    try {
      return ctx.agents.get(SAME)
    } catch {
      return undefined
    }
  })()
  log(`dispose 之后 ctx.agents.get(SAME) = ${afterDispose ? 'present' : 'absent'}`)

  let h3 = null
  let err3 = null
  try {
    h3 = await withTimeout(
      ctx.agents.create({ sessionId: SAME, agentOptions: { provider, model }, meta: { cwd: workdir } }),
      15000,
      'create#3',
    )
    log('dispose 之后 create 同 id：成功')
  } catch (e) {
    err3 = e
    log(`dispose 之后 create 同 id 仍抛错：${errShape(e)}`)
  }
  if (h3) await h3.dispose().catch(e => log(`h3.dispose 抛错：${errShape(e)}`))

  // 对照组：换一个新 id 立刻 create，证明失败不是"store 坏了"
  const CONTROL = `qdn-probe:m0-dup-control-${RUN}`
  let h4 = null
  try {
    h4 = await withTimeout(
      ctx.agents.create({ sessionId: CONTROL, agentOptions: { provider, model }, meta: { cwd: workdir } }),
      15000,
      'create control',
    )
    log('对照：新 id create 成功 → 失败只与"该 id 已被占用"有关')
  } catch (e) {
    log(`对照：新 id create 也失败 → ${errShape(e)}`)
  }
  if (h4) await h4.dispose().catch(() => {})

  // 恢复路径：dispose 之后能不能 resume 回来（这才是 ensure() 重启后该走的路）
  let h5 = null
  let err5 = null
  if (typeof ctx.agents.resume === 'function' && !h3) {
    try {
      h5 = await withTimeout(
        ctx.agents.resume({ resumeSessionId: SAME, agentOptions: { provider, model } }),
        15000,
        'resume',
      )
      log('dispose 之后 resume 同 id：成功 → 重启后的恢复路径是 resume，不是 create')
    } catch (e) {
      err5 = e
      log(`dispose 之后 resume 同 id 也失败：${errShape(e)}`)
    }
    if (h5) await h5.dispose().catch(() => {})
  }

  return {
    threwOnSecond: Boolean(err2),
    errorWhileLive: err2 ? errShape(err2) : null,
    structuredFields: err2 ? ['code', 'name', 'status', 'reason', 'kind'].filter(k => err2[k] !== undefined) : [],
    secondHandleSameAgent: h2 ? h2.agent === h1.agent : null,
    disposeThenCreateOk: Boolean(h3),
    disposeThenCreateError: err3 ? errShape(err3) : null,
    disposeThenResumeOk: Boolean(h5),
    disposeThenResumeError: err5 ? errShape(err5) : null,
  }
}
