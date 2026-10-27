/**
 * 控制台数据面。
 *
 * 分工：**运行态**一律读 `service.status()`（它已经在维护那些快照），
 * **历史事实**读 store，**配置**读 `service.configStore`。
 * 这一层只做"取数 + 裁剪形状 + 参数校验 + 错误翻译"：不自己写库、不算业务规则。
 * 唯一的"写"是 `configUpdate`，它也只是转调 ConfigStore，然后触发既有的热更新链路。
 *
 * 所有响应都带 `ok` 字段：前端只认 `ok:false` 走错误横幅，不必猜 HTTP 状态码之外的语义。
 */
import { readFileSync } from 'node:fs'

import { ConfigError } from '../config/runtime.js'
import { localDay } from '../memory/daily.js'
import { MEMORY_TOOLS, QQ_TOOLS, QQ_TOOL_NAMES, isDenied, isSafeInternal } from '../tools/catalog.js'
import { PASSWORD_KEY, tokenMatches } from './auth.js'
import { TabError } from './tabs.js'

/**
 * 读包名/版本用于页脚。直接读文件而不是 `import ... with { type:'json' }`：
 * 后者在打包器/旧 Node 上的支持不一致，而这里只需要两个字符串。
 */
let pkg = { name: 'qdash-neo', version: 'unknown' }
try {
  pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
} catch {
  // 包元信息缺失不该拖垮控制台：页脚显示 unknown，比白屏好
}

export const VERDICTS = ['reply', 'silent', 'defer']
export const LAYERS = ['heuristic', 'llm', 'gate']

/** 带 HTTP 语义的错误：server.js 直接照 status 回，不猜 */
export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function storeOf(service) {
  const store = service?.store
  if (!store) throw new ApiError('not-ready', '内核尚未就绪（store 还没打开）', 503)
  return store
}

/**
 * query 里的数字不可信：夹紧到 [min, max]，非数字回默认。
 *
 * `Number(null) === 0` 这个坑必须显式挡掉：没传 limit 时会被当成 0，
 * 再夹到 min=1，最后每个列表只返回一条 —— 表现是"控制台只显示一条消息"，
 * 排查起来完全不像参数问题。
 */
function intParam(raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

function oneOf(raw, allowed, fallback = null) {
  if (raw == null || raw === '') return fallback
  const v = String(raw)
  if (!allowed.includes(v)) {
    throw new ApiError('bad-request', `参数取值非法：${v}（允许 ${allowed.join('/')}）`, 400)
  }
  return v
}

/** 空对象比 null 好：前端少一处 `?.`，也少一处"忘了判空"的白屏 */
function zeroUsage() {
  return { calls: 0, inTokens: 0, outTokens: 0, cost: 0 }
}

/**
 * `judgementStats()` 的列名是 snake_case（sqlite 直出），前端只认 camelCase。
 * 在服务端统一转换一次：让前端两份数据（overview / judgements）形状完全一致，
 * 否则其中一处忘了映射，表现就是"平均耗时永远显示 —"。
 */
export function normalizeStats(raw) {
  return {
    total: Number(raw?.total ?? 0),
    replied: Number(raw?.replied ?? 0),
    llmCalls: Number(raw?.llm_calls ?? 0),
    batched: Number(raw?.batched ?? 0),
    coveredMsgs: Number(raw?.covered_msgs ?? 0),
    avgCostMs: raw?.avg_cost_ms == null ? null : Number(raw.avg_cost_ms),
  }
}

/** 把 usageSummary 的行按阶段收拢成 today.stages + today.total */
function foldUsage(rows, day = localDay()) {
  const stages = {}
  const total = zeroUsage()
  for (const r of rows) {
    if (r.day !== day) continue
    const s = stages[r.stage] ?? zeroUsage()
    s.calls += r.calls
    s.inTokens += r.inTokens
    s.outTokens += r.outTokens
    s.cost += r.cost
    stages[r.stage] = s

    total.calls += r.calls
    total.inTokens += r.inTokens
    total.outTokens += r.outTokens
    total.cost += r.cost
  }
  return { day, stages, total }
}

/**
 * `/api/meta`：页面启动时只需要这一份就能画外壳。
 *
 * 刻意**不返回 token**：任何响应体里出现口令，都会顺着截图/日志/浏览器插件流出去。
 */
export function meta({ service, config, mount, tokenSource }) {
  const status = service?.status?.() ?? {}
  const judge = status.judge ?? {}
  return {
    ok: true,
    plugin: { name: pkg.name, version: pkg.version },
    mount,
    pollMs: intParam(config?.console?.pollMs, 5000, 1000, 60_000),
    ready: Boolean(service?.store),
    tokenSource,
    bot: {
      selfId: config?.onebot?.selfId || service?.client?.selfId || '',
      nickname: service?.client?.nickname || '',
      names: Array.isArray(judge.botNames) ? judge.botNames : [],
    },
    onebot: status.onebot ?? null,
    // 派生而不是写死：没 store 就写不了，前端据此禁用保存（否则"保存了"只是内存里的错觉）
    readOnly: !service?.configStore?.writable,
    configRevision: service?.configStore?.revision ?? 0,
  }
}

/** `/api/overview`：一屏回答"现在健康吗、今天花了多少、最近判了什么" */
export function overview({ service }) {
  const store = storeOf(service)
  const status = service.status()
  // 取 7 天：总览的迷你柱要按天画，前端再按窗口补零
  const usageRows = store.usageSummary({ days: 7 })
  return {
    ok: true,
    now: Date.now(),
    status,
    usage: { today: foldUsage(usageRows), days: usageRows },
    judgements: {
      stats24h: normalizeStats(store.judgementStats()),
      recent: store.listJudgements({ limit: 5 }),
    },
    dead: { total: store.countDeadLetters(), recent: store.listDeadLetters({ limit: 5 }) },
  }
}

/** `/api/chats` */
export function chats({ service, query }) {
  const store = storeOf(service)
  return {
    ok: true,
    // 每个视图都带运行态 + 今日用量：顶部状态带靠它保持最新，省掉一次额外的 overview 请求
    status: service.status(),
    usage: { today: foldUsage(store.usageSummary({ days: 1 })) },
    chats: store.chatSummaries({ limit: intParam(query?.get('limit'), 50, 1, 200) }),
  }
}

/**
 * `/api/chats/:key`：一个会话的全部证据。
 *
 * 消息一次取 50 条、判定 100 条，前端按 `qq_msg_id` 关联 —— 不做 N+1，
 * 也不做服务端 join（批量判定一行覆盖多条消息，join 反而更难读）。
 */
export function chat({ service, key, query }) {
  const store = storeOf(service)
  const chatKey = String(key ?? '').trim()
  if (!chatKey) throw new ApiError('bad-request', '缺少会话 key', 400)

  const row = store.getChat(chatKey)
  if (!row) throw new ApiError('not-found', `没有这个会话：${chatKey}`, 404)

  const memories = store.listMemories(chatKey, { perKind: 30 })
  const daily = memories
    .filter(m => m.kind === 'daily')
    .map(m => ({ day: m.target, text: m.text, ts: m.last_seen_at }))
    .sort((a, b) => String(b.day).localeCompare(String(a.day)))
    .slice(0, intParam(query?.get('days'), 5, 1, 30))

  return {
    ok: true,
    status: service.status(),
    usage: { today: foldUsage(store.usageSummary({ days: 1 })) },
    chat: {
      chatKey: row.chat_key,
      kind: row.kind,
      chatId: row.chat_id,
      title: row.title ?? '',
      status: row.status ?? '',
      sessionId: row.session_id ?? '',
      preset: row.preset ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    states: store.messageStateCounts(chatKey),
    messages: store.listMessages(chatKey, { limit: intParam(query?.get('limit'), 50, 1, 200) }),
    judgements: store.listJudgements({ chatKey, limit: 100 }),
    memory: {
      counts: store.memoryStats(chatKey),
      daily,
    },
  }
}

/** `/api/judgements`：全站流水，可按会话/结论/层筛 */
export function judgements({ service, query }) {
  const store = storeOf(service)
  const chatKey = String(query?.get('chatKey') ?? '').trim() || null
  return {
    ok: true,
    status: service.status(),
    usage: { today: foldUsage(store.usageSummary({ days: 1 })) },
    stats24h: normalizeStats(store.judgementStats()),
    rows: store.listJudgements({
      chatKey,
      limit: intParam(query?.get('limit'), 50, 1, 200),
      verdict: oneOf(query?.get('verdict'), VERDICTS),
      layer: oneOf(query?.get('layer'), LAYERS),
    }),
  }
}

/** `/api/usage`：按天 × 阶段，附带合计与判定占比 */
export function usage({ service, query }) {
  const store = storeOf(service)
  const days = intParam(query?.get('days'), 7, 1, 90)
  const rows = store.usageSummary({ days })

  const byStage = {}
  const byDay = new Map()
  let total = zeroUsage()
  for (const r of rows) {
    const s = byStage[r.stage] ?? zeroUsage()
    s.calls += r.calls
    s.inTokens += r.inTokens
    s.outTokens += r.outTokens
    s.cost += r.cost
    byStage[r.stage] = s

    const d = byDay.get(r.day) ?? { day: r.day, stages: {}, total: zeroUsage() }
    d.stages[r.stage] = r
    d.total.calls += r.calls
    d.total.inTokens += r.inTokens
    d.total.outTokens += r.outTokens
    d.total.cost += r.cost
    byDay.set(r.day, d)

    total = {
      calls: total.calls + r.calls,
      inTokens: total.inTokens + r.inTokens,
      outTokens: total.outTokens + r.outTokens,
      cost: total.cost + r.cost,
    }
  }

  return {
    ok: true,
    status: service.status(),
    // 用量页自己就有完整窗口，但仍带一份"今日"：顶部状态带只认这个形状
    usage: { today: foldUsage(store.usageSummary({ days: 1 })) },
    days,
    rows,
    byDay: [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))),
    byStage,
    total,
    judgeShare: total.cost > 0 ? (byStage.judge?.cost ?? 0) / total.cost : 0,
  }
}

/** `/api/dead` */
export function dead({ service, query }) {
  const store = storeOf(service)
  return {
    ok: true,
    status: service.status(),
    usage: { today: foldUsage(store.usageSummary({ days: 1 })) },
    total: store.countDeadLetters(),
    rows: store.listDeadLetters({ limit: intParam(query?.get('limit'), 50, 1, 200) }),
  }
}

// ---------------- 可写配置（M3 第二阶段） ----------------

function configStoreOf(service) {
  const cs = service?.configStore
  if (!cs) throw new ApiError('not-ready', '内核尚未就绪（配置层还未初始化）', 503)
  return cs
}

/** 配置层的错误码与 HTTP 状态由 ConfigStore 决定，这里只做形状翻译 */
function translate(err) {
  if (err instanceof ConfigError) throw new ApiError(err.code, err.message, err.status)
  if (err instanceof TabError) throw new ApiError(err.code, err.message, err.status)
  throw err
}

/**
 * `/api/config/describe`：表单的**唯一数据源**。
 *
 * 带上审计尾部（最近 20 条）：配置页要回答"谁把它改坏了"，
 * 为此多开一个接口不值当。
 */
export function configDescribe({ service }) {
  const cs = configStoreOf(service)
  // 带上 status：顶部连接状态带只认这个形状，少一次额外请求
  return { ok: true, status: service.status(), ...cs.describe(), audit: cs.audit(20) }
}

/**
 * `POST /api/config`：保存运行层覆盖，并**立刻**让它生效。
 *
 * 生效走的是既有链路 `service.applyConfig()` —— 那条链已经把 gates / judge /
 * outbox / memory / persona / 批窗口全部串好了，只是此前没有调用者。
 * 这里绝不自己再写一套下发逻辑：两套一定会漂移。
 */
export function configUpdate({ service, server, body }) {
  const cs = configStoreOf(service)
  let result
  try {
    result = cs.update({
      patch: body?.patch,
      revision: body?.revision,
      actor: String(body?.actor ?? ''),
    })
  } catch (err) {
    translate(err)
  }

  if (result.changed.length > 0) {
    service.applyConfig(result.effective)
    // 控制台自己也要跟着变：pollMs / allowedHosts 读的是 server.config 这一份
    server?.syncConfig?.(result.effective)
  }

  return {
    ok: true,
    revision: result.revision,
    changed: result.changed,
    describe: cs.describe(),
    audit: cs.audit(20),
  }
}

/** `/api/tabs`：插件选项卡（内置五项由前端固定，不在这里） */
export function tabs({ server, service }) {
  const reg = server?.tabs ?? null
  return { ok: true, status: service?.status?.() ?? null, tabs: reg?.list?.() ?? [] }
}

/**
 * 宿主 LLM 的 provider / model 清单（给配置页做下拉）。
 *
 * 三个边界（都是 dsh-llm 源码里的事实）：
 *   1. 只反映**当前注册了 adapter 的路由**，pi-ai 会动态 replace → 每次现取，不做缓存
 *   2. `listModels()` 可能返回空数组（取决于 adapter 有没有 discoverModels）
 *   3. 独立进程没有 ctx.llm → 返回 `reason: 'no-llm-service'`，前端退化成手填
 *
 * @param {{ service: object }} ctx
 */
export async function llm({ service }) {
  const log = service?.log ?? (() => {})
  const l = service?.ctx?.llm
  const status = service?.status?.() ?? null

  if (!l || typeof l.listProviders !== 'function') {
    return { ok: true, status, providers: [], models: {}, reason: 'no-llm-service' }
  }

  /** @type {Map<string, { id: string, name: string, live: boolean }>} */
  const providers = new Map()
  try {
    for (const p of l.listProviders() ?? []) {
      if (!p?.id) continue
      providers.set(p.id, { id: p.id, name: String(p.name ?? p.id), live: true })
    }
  } catch (err) {
    log('warn', `qdash-neo: listProviders 失败 name=${err?.name} msg=${err?.message}`)
  }
  try {
    // directory 里有"配了凭证但此刻没挂载"的 provider（live=false），一并列出来
    for (const p of l.listConfigurableProviders() ?? []) {
      const id = String(p?.provider ?? '')
      if (!id || providers.has(id)) continue
      providers.set(id, { id, name: String(p.displayName ?? id), live: false })
    }
  } catch (err) {
    log('warn', `qdash-neo: listConfigurableProviders 失败 name=${err?.name} msg=${err?.message}`)
  }

  /** @type {Record<string, Array<{ id: string, name: string }>>} */
  const models = {}
  for (const id of providers.keys()) {
    try {
      const list = (await l.listModels(id)) ?? []
      models[id] = list
        .filter(m => m?.id)
        .map(m => ({ id: String(m.id), name: String(m.name ?? m.id) }))
    } catch (err) {
      models[id] = []
      log('warn', `qdash-neo: listModels(${id}) 失败 name=${err?.name} msg=${err?.message}`)
    }
  }

  return { ok: true, status, providers: [...providers.values()], models, reason: null }
}

/**
 * `POST /api/tabs/<id>/actions/<actionId>`：执行插件声明的动作。
 *
 * 动作函数只存在于服务端注册表里，前端拿到的永远是 id/label ——
 * 这样"插件写了前端"这件事在本轮仍然不成立。
 */
export async function tabAction({ server, id, actionId, body }) {
  const reg = server?.tabs ?? null
  if (!reg) throw new ApiError('not-ready', '选项卡注册表未初始化', 503)
  try {
    return await reg.run(id, actionId, body ?? null)
  } catch (err) {
    translate(err)
  }
}

/**
 * `POST /api/account/password`：改控制台访问口令。
 *
 * 三个约束：
 *   1. 必须验旧口令 —— 会话被劫持时不能靠一个 cookie 就换掉口令
 *   2. 口令来自部署层配置（`console.password`）时直接拒绝：那种情况写 kv 不会生效，
 *      悄悄收下会变成"改完发现没变"，比报错更糟
 *   3. 只写 kv，不清会话 —— 当前页面还在用，踢掉自己只会让人以为改失败了
 */
export function accountPassword({ server, body }) {
  const current = String(body?.current ?? '')
  const next = String(body?.next ?? '').trim()

  if (next.length < 8) throw new ApiError('weak-password', '新口令至少 8 位', 400)

  const info = server.passwordInfoOrResolve()
  if (info.source === 'config') {
    throw new ApiError(
      'password-from-deploy',
      '口令由部署层配置指定（console.password），请改 patch；在这里改不会生效',
      400,
    )
  }
  if (!tokenMatches(current, info.password)) {
    throw new ApiError('bad-credentials', '当前口令不正确', 401)
  }

  const store = server.service?.store
  if (!store || typeof store.kvSet !== 'function') {
    throw new ApiError('not-ready', '数据库不可用', 503)
  }
  try {
    store.kvSet(PASSWORD_KEY, next)
  } catch (err) {
    server.log('error', `qdash-neo: 写入新口令失败 name=${err?.name} msg=${err?.message}`)
    throw new ApiError('internal-error', '写入失败（看内核日志）', 500)
  }
  // 清掉缓存，下一次 resolve 才会读到新值
  server.passwordInfo = null
  server.log('info', 'qdash-neo: 控制台访问口令已更新')
  return { ok: true, message: '口令已更新，下次登录用新口令' }
}

/**
 * `POST /api/chats`：目前只有 `action=delete`。
 *
 * 删除是全链路动作（内存句柄 + 磁盘记录 + chats 行），所以放服务端做，
 * 不让前端分三步调 —— 中途失败会留下"删了一半"的状态。
 */
export async function chatsUpdate({ service, body }) {
  const action = String(body?.action ?? '').trim()
  if (action !== 'delete') {
    throw new ApiError('bad-request', `未知操作：${action || '(空)'}（目前只有 delete）`, 400)
  }
  const chatKey = String(body?.chatKey ?? '').trim()
  if (!chatKey) throw new ApiError('bad-request', 'chatKey 不能为空', 400)
  if (typeof service?.deleteChat !== 'function') {
    throw new ApiError('not-ready', '内核尚未就绪，无法删除会话', 503)
  }
  try {
    const res = await service.deleteChat(chatKey)
    return { ok: true, ...res, chats: service.store?.chatSummaries?.({ limit: 50 }) ?? [] }
  } catch (err) {
    service?.log?.('warn', `qdash-neo: 删除会话失败 ${chatKey} name=${err?.name} msg=${err?.message}`)
    throw new ApiError('chat-delete-failed', err?.message ?? '删除会话失败', 500)
  }
}

/* ---------------- 工具目录 ---------------- */

/**
 * `GET /api/tools`：给控制台画"可勾选列表"。
 *
 * 三类来源分开返回，因为它们的能力与风险不同：
 *   - `qq`：插件自己注册的（分组开关控制，不是逐个勾选）
 *   - `internal`：DSH 内置里**允许**的那批（只读类，默认已给）
 *   - `external`：DSH 里注册的其它工具（MCP 之类），勾选才给
 *   - `blocked`：命中高危名单的，**只用于展示"为什么不给"**，不可勾选
 *
 * 注意：`schemas()` 里读到的工具名随 profile 变化，所以清单只代表"此刻"。
 * 配了但当前不存在的项由 `applyToolPolicy` 求交集时留痕，这里不回显成"可用"。
 */
export function toolsCatalog({ service }) {
  const cfg = service?.config?.tools ?? {}
  /**
   * `ctx.tools` 是 Cordis 服务：**没在插件 inject 里声明时，读属性会直接抛**
   * （`cannot get property "tools" without inject`）。这里必须 try/catch，
   * 否则界面在"没声明 inject 的部署"上会整个 500。
   */
  let tools = null
  try {
    tools = service?.ctx?.tools ?? null
  } catch {
    tools = null
  }
  let names = []
  try {
    names = (tools?.schemas?.() ?? []).map(s => String(s?.name ?? '')).filter(Boolean)
  } catch (err) {
    service?.log?.('warn', `qdash-neo: 读工具清单失败 name=${err?.name} msg=${err?.message}`)
  }

  /**
   * 根作用域只能看到少数全局工具 —— DSH 的内置工具是按 preset 注册在 **agent 作用域**的。
   * 真实清单要从建过会话的 agent 里取（`applyToolPolicy` 把 `schemas()` 结果回传存下来了）。
   */
  const seen = new Set(names)
  for (const state of service?.toolStates?.values?.() ?? []) {
    for (const name of state?.available ?? []) seen.add(String(name))
  }
  names = [...seen].filter(Boolean).sort()

  const qq = QQ_TOOLS.map(t => ({ name: t.name, title: t.title, group: t.group, sideEffect: Boolean(t.sideEffect) }))
  const internal = []
  const external = []
  const blocked = []
  for (const name of names.sort()) {
    if (QQ_TOOL_NAMES.includes(name)) continue
    if (isDenied(name)) {
      blocked.push(name)
      continue
    }
    if (isSafeInternal(name)) internal.push(name)
    else external.push(name)
  }

  return {
    ok: true,
    // 根作用域有没有 tools 服务：没有的话前端只能手填
    ready: Boolean(tools && typeof tools.schemas === 'function'),
    qq,
    // 记忆工具：只在记忆开着时才真的挂上（关掉时给空数组，前端据此不显示）
    memory: service?.config?.memory?.enabled === true ? MEMORY_TOOLS : [],
    internal,
    external,
    blocked,
    config: {
      enabled: cfg.enabled !== false,
      imageMode: String(cfg.imageMode ?? 'auto'),
      qqRead: cfg.qqRead !== false,
      qqWrite: cfg.qqWrite !== false,
      qqAdmin: cfg.qqAdmin === true,
      internalAllow: cfg.internalAllow ?? [],
      externalAllow: cfg.externalAllow ?? [],
    },
  }
}

/* ---------------- 人格卡库 ---------------- */

/**
 * 取人格对象；store 未就绪时给 503，而不是返回空卡库假装成功。
 * @param {object} service
 */
function personaOf(service) {
  if (!service?.store) throw new ApiError('not-ready', '内核尚未就绪（数据库未打开）', 503)
  const p = service.personaOf?.()
  if (!p) throw new ApiError('not-ready', '人格模块未装配', 503)
  return p
}

/**
 * `GET /api/persona`：卡库 + 当前选中 + **实际生效**的内容。
 *
 * 三个都给，是因为"选中的卡"和"真正进 prompt 的文本"可能不是一回事
 * （选了卡但 `persona.enabled=false`，或选了卡又被部署层人设兜底）。界面照实显示。
 */
export function persona({ service, query }) {
  const p = personaOf(service)
  const cards = p.book.all()
  const active = p.book.activeCard()
  const effective = p.snapshot('')
  // 列表只给长度，编辑器要全文时按 id 单独取 —— 20 张卡全量下发会把每次轮询撑大
  const cardId = String(query?.get?.('cardId') ?? '').trim()
  const editTarget = cardId ? p.book.get(cardId) : null
  return {
    ok: true,
    status: service.status?.() ?? null,
    enabled: p.enabled,
    activeId: p.book.activeId(),
    active: active
      ? {
          id: active.id,
          name: active.name,
          text: active.text,
          hint: active.hint,
          aliases: active.aliases ?? [],
          updatedAt: active.updatedAt,
        }
      : null,
    // 列表只给长度，不回传全文：20 张卡 × 上千字会把每 5 秒的轮询撑大
    cards: cards.map(c => ({
      id: c.id,
      name: c.name,
      chars: c.text.length,
      hintChars: c.hint.length,
      aliasCount: (c.aliases ?? []).length,
      updatedAt: c.updatedAt,
    })),
    effective: {
      enabled: effective.enabled,
      source: effective.source,
      hasCard: effective.hasCard,
      cardChars: effective.cardChars,
      activeName: effective.activeName,
    },
    editing: editTarget
      ? {
          id: editTarget.id,
          name: editTarget.name,
          text: editTarget.text,
          hint: editTarget.hint,
          aliases: editTarget.aliases ?? [],
        }
      : null,
  }
}

/**
 * `POST /api/persona`：save / delete / activate。
 *
 * 卡库不是 ConfigStore 的用户层（那是"覆盖某个配置字段"），所以走独立接口；
 * 但同样只接受 JSON、同样走会话鉴权（在 server 里统一）。
 */
export function personaUpdate({ service, body }) {
  const p = personaOf(service)
  const action = String(body?.action ?? 'save')

  let res
  if (action === 'save') {
    res = p.book.save(body?.card ?? body)
  } else if (action === 'delete') {
    res = p.book.remove(String(body?.id ?? '').trim())
  } else if (action === 'activate') {
    res = p.book.activate(String(body?.id ?? '').trim())
  } else {
    throw new ApiError('bad-request', `未知操作：${action}（只有 save / delete / activate）`, 400)
  }

  if (!res.ok) throw new ApiError('persona-invalid', res.error ?? '人格卡操作失败', 400)

  // 别名跟着卡走：换卡 / 改别名之后必须把"机器人叫什么"重新推给闸门与判定器，
  // 否则要等下次改配置或重启才生效 —— 那正是"改了没反应"的典型来源
  try {
    service.syncBotNames?.()
  } catch (err) {
    service.log?.('warn', `qdash-neo: 切换人格卡后同步别名失败 name=${err?.name} msg=${err?.message}`)
  }

  // 切卡/改卡之后立刻重新算一次"生效内容"：热更新本来就走 kv，不需要重启
  return persona({ service })
}
