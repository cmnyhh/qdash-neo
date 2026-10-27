/**
 * qdash-neo 控制台前端（浅色现代后台）。
 *
 * 三条硬约束没变：
 *   1. 不用 innerHTML：消息正文来自群友，任何拼接都是 XSS 入口。数据一律 textContent。
 *   2. 无第三方依赖、无构建：控制台不是产品级前端，为它装一条构建链不划算。
 *   3. 轮询要能中断：切路由 / 页面隐藏时 abort 在途请求。
 *
 * M3 第二阶段起它不再是"只读"：多了「配置」视图（可写，带锁与乐观并发）与
 * 插件选项卡视图。写接口只有两条（`POST /api/config`、`POST /api/tabs/…/actions/…`），
 * 前端这里只是调用方；真正的校验与落库在内核。
 *
 * 设计上的取舍：
 *   - 每屏一个焦点：总览是"今日花费 + 判定分布"，会话页是列表，详情页是消息流。
 *   - 指标不再做成八张同款卡片：hero 数字 + 内联统计条 + 迷你柱。
 *   - 层级同时用尺寸/字重/颜色，颜色只承担状态语义。
 *   - **写操作必须有反馈**：脏字段有圆点、保存后有"已生效"、冲突时拉最新值并高亮。
 */
import { el, empty, icon, renderBlocks, table } from './blocks.js'

/* ---------------- DOM 小工具 ---------------- */

const nf = new Intl.NumberFormat('zh-CN')
const int = v => nf.format(Number(v) || 0)

function cost(v) {
  const n = Number(v) || 0
  if (n === 0) return '¥0'
  if (n < 0.01) return `¥${n.toFixed(4)}`
  if (n < 1) return `¥${n.toFixed(3)}`
  return `¥${n.toFixed(2)}`
}

function clock(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function stamp(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ago(ts) {
  if (!ts) return '—'
  const diff = Date.now() - Number(ts)
  if (!Number.isFinite(diff)) return '—'
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))} 秒前`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}

function duration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)}ms`
  return `${(n / 1000).toFixed(1)}s`
}

function clip(text, n = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function dayKey(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 语义件 ---------------- */

function statePill(state) {
  const s = String(state ?? '')
  if (!s) return el('span', { class: 'pill is-plain', text: '—' })
  if (s === 'sent' || s === 'delivered') return el('span', { class: 'pill is-ok', text: s === 'sent' ? '已发送' : '已投递' })
  if (s === 'context') return el('span', { class: 'pill is-info', text: '听过' })
  if (s === 'queued') return el('span', { class: 'pill is-accent', text: '已入队' })
  if (s === 'dead') return el('span', { class: 'pill is-bad', text: '死信' })
  if (s.startsWith('dropped')) return el('span', { class: 'pill is-warn', text: `丢弃${s.includes(':') ? ` · ${s.split(':')[1]}` : ''}` })
  return el('span', { class: 'pill is-plain', text: s })
}

function verdictPill(verdict) {
  const v = String(verdict ?? '')
  if (v === 'reply') return el('span', { class: 'pill is-ok', text: '回复' })
  if (v === 'silent') return el('span', { class: 'pill is-warn', text: '沉默' })
  if (v === 'defer') return el('span', { class: 'pill is-info', text: '交给对话层' })
  return el('span', { class: 'pill is-plain', text: v || '—' })
}

function layerPill(layer) {
  const l = String(layer ?? '')
  const map = { heuristic: ['启发式', 'is-info'], llm: ['模型', 'is-accent'], gate: ['闸门', 'is-warn'] }
  const [label, cls] = map[l] ?? [l || '—', 'is-plain']
  return el('span', { class: `pill ${cls}`, text: label })
}

function stat({ label, value, hint, tone = '' }) {
  return el('div', { class: `stat ${tone}` }, [
    el('span', { class: 'stat-label', text: label }),
    el('span', { class: 'stat-value', text: value }),
    hint ? el('span', { class: 'stat-hint', text: hint }) : null,
  ])
}

function statStrip(items) {
  return el('div', { class: 'stat-strip' }, items)
}

function panel({ title, sub, body, flush = false, actions = null }) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      title ? el('h2', { class: 'panel-title', text: title }) : null,
      sub ? el('span', { class: 'panel-sub', text: sub }) : null,
      el('span', { class: 'spacer' }),
      actions,
    ]),
    el('div', { class: `panel-body ${flush ? 'is-flush' : ''}` }, body),
  ])
}

function pageHead(title, sub, extra = null) {
  return el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { class: 'page-title', text: title }), sub ? el('div', { class: 'page-sub', text: sub }) : null]),
    el('span', { class: 'spacer' }),
    extra,
  ])
}

function sectionHead(title, sub, extra = null) {
  return el('div', { class: 'section-head' }, [
    el('h2', { class: 'section-title', text: title }),
    sub ? el('span', { class: 'section-sub', text: sub }) : null,
    el('span', { class: 'spacer', style: { flex: '1' } }),
    extra,
  ])
}

/* ---------------- 改口令弹窗 ---------------- */

/**
 * 顶栏「口令」：改的是**控制台登录口令**（落 kv），不是配置里的 console.password。
 *
 * 为什么不复用配置页那个字段：它是 secret，藏在「控制台」组的第 7 项，
 * 找得到的人不需要提示，需要提示的人找不到。改口令是低频但要立刻能找到的动作。
 */
function openPasswordDialog() {
  if (document.querySelector('.modal')) return

  const error = el('p', { class: 'modal-error', hidden: true, attrs: { role: 'alert' } })
  const showError = msg => {
    error.textContent = msg
    error.hidden = !msg
  }

  const input = (id, labelText, autocomplete) => {
    const field = el('input', {
      class: 'input',
      type: 'password',
      attrs: { id, autocomplete, required: 'required' },
    })
    return { field, node: el('label', { class: 'modal-field' }, [el('span', { class: 'modal-label', text: labelText }), field]) }
  }

  const current = input('pw-current', '当前口令', 'current-password')
  const next = input('pw-next', '新口令（至少 8 位）', 'new-password')
  const confirm = input('pw-confirm', '再输一次', 'new-password')

  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, '保存')

  const dialog = el('dialog', { class: 'modal' }, [
    el('form', { class: 'modal-form' }, [
      el('div', { class: 'modal-head' }, [
        el('span', { class: 'modal-title', text: '修改访问口令' }),
        el('button', { class: 'btn btn-ghost modal-close', type: 'button', attrs: { 'aria-label': '关闭' }, on: { click: () => close() } }, '×'),
      ]),
      current.node,
      next.node,
      confirm.node,
      error,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => close() } }, '取消'),
        submit,
      ]),
    ]),
  ])

  function close() {
    dialog.close()
    dialog.remove()
  }

  dialog.querySelector('form').addEventListener('submit', async ev => {
    ev.preventDefault()
    showError('')
    if (next.field.value !== confirm.field.value) {
      showError('两次输入的新口令不一致')
      return
    }
    if (next.field.value.length < 8) {
      showError('新口令至少 8 位')
      return
    }
    submit.disabled = true
    submit.textContent = '保存中…'
    try {
      const res = await apiWrite('/account/password', {
        current: current.field.value,
        next: next.field.value,
      })
      close()
      showBanner(res.message ?? '口令已更新')
    } catch (err) {
      showError(err.message)
    } finally {
      submit.disabled = false
      submit.textContent = '保存'
    }
  })

  // 点遮罩关闭：dialog 本身是块级，点击 target 为 dialog 时说明点在 ::backdrop 上
  dialog.addEventListener('click', ev => {
    if (ev.target === dialog) close()
  })

  document.body.append(dialog)
  dialog.showModal()
  current.field.focus()
}

/* ---------------- 取数 ---------------- */

/**
 * 挂载前缀（`''` 或 `/qdash-neo` 这种）。
 *
 * 从脚本自身 URL 推，而不是 `location.pathname`。
 *
 * **当前路由是 hash 模式**（`#/chats`），所以 `pathname` 一直停在挂载点上，
 * 用 `pathname` 推也能得到正确值 —— 这是它一直没出问题的原因，不是它写对了。
 *
 * 之所以改：一旦路由换成 history 模式（`/chats` 这种），`pathname` 就跟着变，
 * `MOUNT` 会算成 `/chats`，所有接口变成 `/chats/api/...`。服务端没这个路由，
 * 兜底返回 `index.html`（200 + HTML），前端报「响应不是预期的 JSON」。
 *
 * 那种故障只在"改了路由实现"之后才出现，排查的人不会想到是挂载前缀算错了 ——
 * 所以趁现在把依赖去掉。`<mount>/assets/app.js` 的前缀不随路由变。
 */
const MOUNT = new URL(import.meta.url).pathname.replace(/\/assets\/app\.js$/, '')
const state = {
  meta: null,
  route: null,
  routeKey: '',
  ctrl: null,
  timer: null,
  cache: new Map(),
  /** 插件选项卡（`renderNav` 用） */
  tabs: [],
  query: '',
}

/**
 * 取数。
 *
 * `keep: true` 用于**辅助数据**（provider 清单、人格卡库）：它们不该和主轮询抢
 * 同一个 AbortController —— 否则 5 秒一次的刷新会把还没回来的辅助请求打断，
 * 表现为"提示条一直说拿不到清单"，而实际上是它被自己人砍了。
 *
 * @param {string} path
 * @param {{ keep?: boolean }} [opts]
 */
async function api(path, { keep = false } = {}) {
  if (!keep && state.ctrl) state.ctrl.abort()
  const ctrl = new AbortController()
  if (!keep) state.ctrl = ctrl
  let res
  try {
    res = await fetch(`${MOUNT}/api${path}`, {
      signal: ctrl.signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new Error(`连不上内核：${err?.message ?? err}`)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (res.status === 401) {
    // 会话过期或从未登录：直接去登录页。停在原地显示"401"对用户没有任何帮助
    location.replace(data?.loginUrl || `${MOUNT}/login`)
    throw new Error('未登录，正在跳转登录页…')
  }
  /**
   * HTTP 层成功（2xx）但业务层失败，和「请求本身失败」是两件事。
   *
   * 前者最常见的成因是：路径被别的服务接走了（反向代理指错、前缀不对），
   * 拿回一页 HTML，JSON 解析失败 → `data` 为 null → `!data?.ok` 成立。
   * 这时候写「请求失败（HTTP 200）」自相矛盾 —— 200 明明是成功。
   */
  if (!res.ok || !data?.ok) {
    const detail = res.ok
      ? '响应不是预期的 JSON（HTTP 200，通常是路径或反向代理指到了别的服务）'
      : `请求失败（HTTP ${res.status}）`
    throw new Error(data?.error?.message ?? detail)
  }
  return data
}

/** 登出：服务端销毁会话 + 清 cookie，然后回登录页 */
async function logout() {
  try {
    await fetch(`${MOUNT}/logout`, { method: 'POST', credentials: 'same-origin' })
  } catch {
    // 网络断了也要把用户送回登录页：本地会话已经没意义了
  }
  location.replace(`${MOUNT}/login`)
}

/* ---------------- 外壳 ---------------- */

const dom = {
  view: document.getElementById('view'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  connDot: document.getElementById('conn-dot'),
  connName: document.getElementById('conn-name'),
  crumbSection: document.getElementById('crumb-section'),
  crumbTitle: document.getElementById('crumb-title'),
  refreshed: document.getElementById('refreshed-at'),
  version: document.getElementById('sidebar-version'),
  mount: document.getElementById('sidebar-mount'),
  ready: document.getElementById('footer-ready'),
  clock: document.getElementById('footer-clock'),
}

let bannerTimer = null

function showBanner(message, { bad = false } = {}) {
  dom.bannerText.textContent = message
  dom.banner.classList.toggle('is-bad', bad)
  dom.banner.hidden = false
  if (bannerTimer) clearTimeout(bannerTimer)
  bannerTimer = setTimeout(hideBanner, bad ? 12_000 : 6_000)
}

function hideBanner() {
  if (bannerTimer) clearTimeout(bannerTimer)
  bannerTimer = null
  dom.banner.hidden = true
}

document.getElementById('banner-close').addEventListener('click', hideBanner)

function setCrumbs(section, title) {
  dom.crumbSection.textContent = section
  dom.crumbTitle.textContent = title
}

function paintShell(status) {
  const onebot = status?.onebot ?? null
  const healthy = Boolean(onebot?.healthy)
  dom.connDot.className = `conn-dot ${healthy ? 'is-ok' : 'is-bad'}`
  dom.connName.textContent = healthy ? '在线' : '离线'
  dom.connName.title = onebot?.url ? `${healthy ? '已连接' : '未连接'}：${onebot.url}` : 'OneBot 未配置'
  dom.refreshed.textContent = clock(Date.now())
  dom.clock.textContent = clock(Date.now())
}

function paintMeta(meta) {
  dom.version.textContent = `v${meta?.plugin?.version ?? '—'}`
  dom.mount.textContent = meta?.mount ?? '/qdash-neo'
  dom.mount.title = meta?.mount ?? ''
  dom.ready.textContent = meta?.ready ? `内核已就绪 · ${meta?.bot?.nickname || meta?.bot?.selfId || '机器人'}` : '内核尚未就绪'
}

/* ---------------- 总览 ---------------- */

function sparkSeries(rows, days = 7) {
  const byDay = new Map()
  for (const r of rows ?? []) {
    const d = byDay.get(r.day) ?? { day: r.day, answer: 0, judge: 0, daily: 0, total: 0 }
    if (r.stage === 'answer') d.answer += r.cost
    else if (r.stage === 'judge') d.judge += r.cost
    else d.daily += r.cost
    d.total += r.cost
    byDay.set(r.day, d)
  }
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(Date.now() - i * 86_400_000)
    out.push(byDay.get(key) ?? { day: key, answer: 0, judge: 0, daily: 0, total: 0 })
  }
  return out
}

function renderOverview(data) {
  const st = data.status ?? {}
  const today = data.usage?.today ?? { stages: {}, total: {} }
  const stages = today.stages ?? {}
  const total = today.total ?? {}
  const js = data.judgements?.stats24h ?? {}
  const judgeTotal = Number(js.total) || 0
  const replied = Number(js.replied) || 0
  const silent = Math.max(0, judgeTotal - replied)
  const pending = (st.batching?.pending ?? []).reduce((a, b) => a + (b.count ?? 0), 0)
  const series = sparkSeries(data.usage?.days, 7)
  const maxCost = Math.max(0.000001, ...series.map(d => d.total))

  const hero = el('div', { class: 'hero' }, [
    el('span', { class: 'eyebrow', text: '今日花费' }),
    el('div', { class: 'hero-value', text: cost(total.cost) }),
    el('div', { class: 'hero-meta' }, [
      el('span', { text: `调用 ${int(total.calls)} 次` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { text: `输入 ${int(total.inTokens)}` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { text: `输出 ${int(total.outTokens)}` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { text: `判定 ${int(stages.judge?.calls ?? 0)} 次` }),
    ]),
    el('div', { class: 'spark', attrs: { 'aria-hidden': 'true' } }, series.map(d =>
      el('div', { class: 'spark-col' }, [
        el('div', { class: 'spark-bar is-daily', style: { height: `${(d.daily / maxCost) * 100}%` } }),
        el('div', { class: 'spark-bar is-judge', style: { height: `${(d.judge / maxCost) * 100}%` } }),
        el('div', { class: 'spark-bar is-answer', style: { height: `${(d.answer / maxCost) * 100}%` } }),
      ]),
    )),
    el('div', { class: 'spark-labels', attrs: { 'aria-hidden': 'true' } }, series.map(d =>
      el('span', { text: String(d.day).slice(5) }),
    )),
  ])

  const replyPct = judgeTotal ? (replied / judgeTotal) * 100 : 0
  const dist = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '近 24 小时判定' }),
      el('span', { class: 'panel-sub', text: `${int(judgeTotal)} 次` }),
    ]),
    el('div', { class: 'panel-body' }, [
      el('div', { class: 'dist-bar', attrs: { role: 'img', 'aria-label': `回复 ${replied} 次，沉默 ${silent} 次` } }, [
        el('div', { class: 'dist-seg is-reply', style: { width: `${replyPct}%` } }),
        el('div', { class: 'dist-seg is-silent', style: { width: `${100 - replyPct}%` } }),
      ]),
      el('div', { class: 'legend' }, [
        el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: 'var(--ok)' } }), `回复 ${int(replied)}`]),
        el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: '#f5c97a' } }), `沉默 ${int(silent)}`]),
        el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: 'var(--ink-4)' } }), `模型 ${int(js.llmCalls)} 次`]),
      ]),
      el('div', { class: 'kv-list', style: { marginTop: '12px' } }, [
        el('div', { class: 'kv-row' }, [el('span', { class: 'kv-key', text: '平均耗时' }), el('span', { class: 'kv-val', text: duration(js.avgCostMs) })]),
        el('div', { class: 'kv-row' }, [el('span', { class: 'kv-key', text: '合并判定' }), el('span', { class: 'kv-val', text: `${int(js.batched)} 批` })]),
        el('div', { class: 'kv-row' }, [el('span', { class: 'kv-key', text: '覆盖消息' }), el('span', { class: 'kv-val', text: int(js.coveredMsgs) })]),
      ]),
    ]),
  ])

  const stats = statStrip([
    stat({ label: 'OneBot', value: st.onebot?.healthy ? '在线' : '离线', hint: st.onebot?.url ? clip(st.onebot.url, 28) : '未配置', tone: st.onebot?.healthy ? '' : 'is-bad' }),
    stat({ label: '会话', value: int(st.chats), hint: '已建 agent 会话' }),
    stat({ label: '出站队列', value: int(st.queue), hint: '待发送' }),
    stat({ label: '上下文', value: int(st.context?.lines), hint: `${int(st.context?.chats)} 个群在缓冲` }),
    stat({ label: '死信', value: int(data.dead?.total), hint: '发送失败', tone: (data.dead?.total ?? 0) > 0 ? 'is-bad' : '' }),
    stat({ label: '批窗口', value: int(pending), hint: st.batching ? `静默 ${Math.round((st.batching.windowMs ?? 0) / 1000)}s` : '已关闭' }),
  ])

  const recent = data.judgements?.recent ?? []
  const judgeList = recent.length
    ? el('div', { class: 'judge-list' }, recent.map(j =>
      el('div', { class: 'judge-row' }, [
        el('span', { class: 'judge-time', text: clock(j.ts) }),
        el('div', { style: { minWidth: '0' } }, [
          el('div', { class: 'judge-reason', text: clip(j.reason || j.code || '—', 80) }),
          el('div', { class: 'faint text-xs mono', text: j.chatKey }),
        ]),
        layerPill(j.layer),
        verdictPill(j.verdict),
      ]),
    ))
    : empty({ title: '还没有判定', hint: '群里来消息后，这里会记录每一层为什么放行或沉默', iconName: 'inbox' })

  const modules = el('div', { class: 'kv-list' }, [
    kvRow('判定器', st.judge?.enabled !== false, st.judge?.enabled === false ? '已关闭（一律不回）' : `阈值 ${st.judge?.threshold ?? '—'}`),
    kvRow('长期记忆', Boolean(st.memory?.enabled), st.memory?.enabled ? `注入 ${st.memory?.maxChars ?? '—'} 字` : '关闭（不写也不注入）'),
    kvRow('日总结', Boolean(st.daily?.enabled), st.daily?.last ? `上次 ${clock(st.daily.last.at)} · ${st.daily.last.done} 条${st.daily.last.error ? ' · 失败' : ''}` : '还没跑过'),
    kvRow('人设', Boolean(st.persona?.hasCard), st.persona?.hasCard ? `${st.persona.hintChars ?? 0} 字摘要` : '未配置'),
    kvRow('控制台', Boolean(st.console?.registered), st.console?.registered ? st.console.mount : (st.console?.error || '未挂载')),
  ])

  const deadSection = (data.dead?.total ?? 0) > 0
    ? el('div', { class: 'section' }, [
      sectionHead('死信', `${data.dead.total} 条永远发不出去`),
      panel({
        body: table({
          columns: [{ label: '时间' }, { label: '会话' }, { label: '内容', clip: true }],
          rows: (data.dead?.recent ?? []).map(d => [
            el('span', { class: 'mono faint', text: stamp(d.ts) }),
            el('span', { class: 'mono text-xs', text: d.chatKey }),
            clip(d.text, 70),
          ]),
        }),
        flush: true,
      }),
    ])
    : null

  return el('div', {}, [
    pageHead('总览', '出问题时先看这一屏：连接、队列、花费、判定'),
    el('div', { class: 'overview-grid' }, [hero, dist]),
    stats,
    el('div', { class: 'section' }, [sectionHead('最近判定', '每一层为什么放行或沉默'), panel({ body: judgeList, flush: true })]),
    el('div', { class: 'section' }, [sectionHead('模块状态', '插件内各能力是否在工作'), panel({ body: modules })]),
    deadSection,
  ])
}

function kvRow(key, ok, detail) {
  return el('div', { class: 'kv-row' }, [
    el('span', { class: 'kv-key' }, [el('span', { class: `pill ${ok ? 'is-ok' : 'is-warn'}`, text: ok ? '正常' : '注意' }), key]),
    el('span', { class: 'faint text-xs', text: detail }),
  ])
}

/* ---------------- 会话列表 ---------------- */

/**
 * 删除一个会话。
 *
 * 服务端一次做三件事（内存句柄 / 磁盘记录 / chats 行），前端不自己拼步骤 ——
 * 分步调用的中途失败会留下"删了一半"的状态，比不删更糟。
 */
async function deleteChat(chatKey, label, mode = 'delete') {
  const rebuild = mode === 'rebuild'
  const ok = window.confirm(
    rebuild
      ? `重建会话「${label}」？\n\n会丢掉当前对话上下文（历史消息仍保留在控制台），下一条消息按**最新配置**重新建立。\n用于让「系统提示」这类只在建会话时读取一次的内容生效。`
      : `删除会话「${label}」？\n\n会删掉 DSH 的会话记录（下次从这个会话开始重新积累上下文）。\n控制台里的历史消息保留，仍可回看。`,
  )
  if (!ok) return
  try {
    // 重建与删除在服务端是同一个动作（释放句柄 + 删磁盘记录），差别只在文案与后果说明
    await apiWrite('/chats', { action: 'delete', chatKey })
    showBanner(rebuild ? `已重建会话 ${label}（下条消息生效）` : `已删除会话 ${label}`)
    await loadRoute({ quiet: false, force: true })
  } catch (err) {
    showBanner(err?.message ?? (rebuild ? '重建失败' : '删除失败'), { bad: true })
  }
}

function renderChats(data) {
  const rows = data.chats ?? []
  const search = el('input', { class: 'input', attrs: { placeholder: '搜索会话 / 标题 / QQ 号', type: 'search' } })
  const count = el('span', { class: 'toolbar-count' })
  const listWrap = el('div')

  let kind = 'all'
  const segs = ['all', 'group', 'private'].map(v => {
    const label = v === 'all' ? '全部' : v === 'group' ? '群聊' : '私聊'
    const b = el('button', { class: `seg ${v === 'all' ? 'is-active' : ''}`, type: 'button', text: label })
    b.addEventListener('click', () => {
      kind = v
      for (const other of segs) other.classList.toggle('is-active', other === b)
      paint()
    })
    return b
  })

  function paint() {
    const q = search.value.trim().toLowerCase()
    const filtered = rows.filter(r => {
      if (kind !== 'all' && r.kind !== kind) return false
      if (!q) return true
      return [r.chatKey, r.title, r.chatId].some(v => String(v ?? '').toLowerCase().includes(q))
    })
    count.textContent = `${filtered.length} / ${rows.length} 个会话`
    listWrap.replaceChildren(
      table({
        columns: [
          { label: '会话' },
          { label: '类型' },
          { label: '消息', num: true },
          { label: '死信', num: true },
          { label: '最后一条', clip: true },
          { label: '更新', num: true },
          { label: '' },
        ],
        rows: filtered.map(r => [
          el('div', { class: 'cell-title' }, [
            el('strong', { text: r.title || (r.kind === 'group' ? `群 ${r.chatId}` : '私聊') }),
            el('span', { text: r.chatKey }),
          ]),
          r.kind === 'group' ? el('span', { class: 'pill is-info', text: '群' }) : el('span', { class: 'pill is-plain', text: '私聊' }),
          int(r.msgCount),
          r.deadCount > 0 ? el('span', { class: 'pill is-bad', text: int(r.deadCount) }) : el('span', { class: 'faint', text: '0' }),
          r.last
            ? el('span', { class: 'cell-inline' }, [statePill(r.last.state), el('span', { class: 'truncate', text: clip(r.last.text, 46) })])
            : el('span', { class: 'faint', text: '—' }),
          el('span', { class: 'faint text-xs', text: ago(r.updatedAt) }),
          // 重建：丢掉对话上下文、按最新配置重开（系统提示只在新会话读得到）
          el(
            'button',
            {
              class: 'icon-btn is-text',
              type: 'button',
              title: '重建会话（按最新配置重开，历史消息保留）',
              attrs: { 'aria-label': `重建会话 ${r.title || r.chatKey}` },
              on: {
                click: ev => {
                  ev.stopPropagation()
                  void deleteChat(r.chatKey, r.title || r.chatKey, 'rebuild')
                },
              },
            },
            el('span', { text: '重建' }),
          ),
          // 删除：stopPropagation 是必须的，否则会同时触发整行的跳转
          el(
            'button',
            {
              class: 'icon-btn is-danger',
              type: 'button',
              title: '删除会话（连同 DSH 会话记录）',
              attrs: { 'aria-label': `删除会话 ${r.title || r.chatKey}` },
              on: {
                click: ev => {
                  ev.stopPropagation()
                  void deleteChat(r.chatKey, r.title || r.chatKey)
                },
              },
            },
            icon('trash'),
          ),
          icon('chevron', 'chev'),
        ]),
        onRowClick: i => { location.hash = `#/chat/${encodeURIComponent(filtered[i].chatKey)}` },
        empty: empty({ title: '还没有会话', hint: '收到第一条消息后，这里会按活跃时间排序' }),
      }),
    )
  }

  search.addEventListener('input', paint)
  paint()

  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', { class: 'field' }, [icon('search'), search]),
    el('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': '会话类型' } }, segs),
    el('span', { class: 'spacer' }),
    count,
  ])

  return el('div', {}, [
    pageHead('会话', '点一行看消息流与判定'),
    toolbar,
    panel({ body: listWrap, flush: true }),
  ])
}

/* ---------------- 会话详情 ---------------- */

function renderChat(data) {
  const chat = data.chat ?? {}
  const states = data.states ?? {}
  const messages = data.messages ?? []
  const judgements = data.judgements ?? []
  const title = chat.title || chat.chatKey
  setCrumbs('会话', title)

  const byMsg = new Map()
  for (const j of judgements) {
    for (const id of j.msgIds ?? []) if (!byMsg.has(id)) byMsg.set(id, j)
  }

  const stream = messages.length
    ? el('div', { class: 'msg-list' }, messages.map(m => {
      const j = byMsg.get(m.messageId)
      const cls = [
        'msg',
        m.direction === 'out' ? 'is-out' : '',
        m.state === 'dead' ? 'is-dead' : '',
        String(m.state ?? '').startsWith('dropped') ? 'is-dropped' : '',
      ].filter(Boolean).join(' ')
      return el('div', { class: cls }, [
        el('div', { style: { minWidth: '0' } }, [
          el('div', { class: 'msg-head' }, [
            el('span', { class: 'msg-who', text: m.direction === 'out' ? `你${m.senderName ? `（${m.senderName}）` : ''}` : (m.senderName || m.userId || '?') }),
            el('span', { class: 'msg-time', text: stamp(m.ts) }),
            m.atMe ? el('span', { class: 'pill is-accent', text: '@我' }) : null,
            statePill(m.state),
          ]),
          el('div', { class: 'msg-text', text: m.text || '（空消息）' }),
        ]),
        el('div', { class: 'msg-side' }, [
          el('span', { class: 'msg-id', text: m.messageId || '—' }),
          j ? verdictPill(j.verdict) : null,
          j ? el('span', { class: 'faint text-xs', text: clip(j.reason || j.code, 16) }) : null,
        ]),
      ])
    }))
    : empty({ title: '还没有消息', hint: '收到第一条之后这里会有完整记录（含被丢弃与被挡住的）' })

  const stateRows = Object.entries(states).map(([key, count]) =>
    el('div', { class: 'kv-row' }, [el('span', { class: 'kv-key' }, statePill(key)), el('span', { class: 'kv-val', text: int(count) })]),
  )

  const recentJudge = judgements.slice(0, 5)
  const judgeList = recentJudge.length
    ? el('div', { class: 'mini-list' }, recentJudge.map(j =>
      el('div', { class: 'mini-row' }, [
        verdictPill(j.verdict),
        el('span', { class: 'truncate', text: clip(j.reason || j.code || '—', 40) }),
        el('span', { class: 'when', text: clock(j.ts) }),
      ]),
    ))
    : el('div', { class: 'faint text-xs', text: '还没有判定记录' })

  const memCounts = data.memory?.counts ?? []
  const memRows = memCounts.map(c =>
    el('div', { class: 'kv-row' }, [
      el('span', { class: 'kv-key mono', text: c.kind }),
      el('span', { class: 'kv-val', text: `${int(c.c)} 条` }),
    ]),
  )

  const daily = data.memory?.daily ?? []
  const dailyList = daily.length
    ? el('div', { class: 'mini-list' }, daily.map(d =>
      el('div', { class: 'mini-row' }, [
        el('span', { class: 'mono text-xs faint', text: d.day }),
        el('span', { class: 'truncate', text: clip(d.text, 60) }),
      ]),
    ))
    : el('div', { class: 'faint text-xs', text: '没有日总结' })

  const rail = el('div', { class: 'rail' }, [
    panel({ title: '消息状态', body: el('div', { class: 'kv-list' }, stateRows.length ? stateRows : [el('div', { class: 'faint text-xs', text: '暂无' })]) }),
    panel({ title: '最近判定', body: judgeList }),
    panel({
      title: '记忆',
      body: el('div', {}, [
        el('div', { class: 'kv-list' }, memRows.length ? memRows : [el('div', { class: 'faint text-xs', text: '记忆未开启或还没有内容' })]),
        el('div', { style: { marginTop: '12px' } }, [el('div', { class: 'eyebrow', text: '日总结' }), el('div', { style: { marginTop: '6px' } }, dailyList)]),
      ]),
    }),
  ])

  const judgeTable = panel({
    title: '判定流水',
    sub: `${judgements.length} 条`,
    flush: true,
    body: table({
      columns: [
        { label: '时间' }, { label: '层' }, { label: '结论' }, { label: '分数', num: true },
        { label: '原因', clip: true }, { label: '原因码' }, { label: '覆盖', num: true }, { label: '耗时', num: true },
      ],
      rows: judgements.map(j => [
        el('span', { class: 'mono faint text-xs', text: clock(j.ts) }),
        layerPill(j.layer),
        verdictPill(j.verdict),
        scoreCell(j.score),
        clip(j.reason || '—', 48),
        el('span', { class: 'mono text-xs faint', text: j.code || '—' }),
        int(j.batchSize),
        duration(j.costMs),
      ]),
      empty: empty({ title: '还没有判定', hint: '这个会话的判定记录会出现在这里' }),
    }),
  })

  return el('div', {}, [
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('a', { class: 'link-back', href: '#/chats' }, [icon('chevron'), '会话']),
        el('h1', { class: 'page-title', text: title, style: { marginTop: '4px' } }),
        el('div', { class: 'page-sub mono', text: chat.chatKey }),
      ]),
      el('span', { class: 'spacer' }),
      chat.kind === 'group' ? el('span', { class: 'pill is-info', text: '群聊' }) : el('span', { class: 'pill is-plain', text: '私聊' }),
      chat.status ? el('span', { class: 'pill is-plain', text: chat.status }) : null,
    ]),
    el('div', { class: 'detail-grid' }, [
      panel({ title: '消息流', sub: `最近 ${messages.length} 条`, body: stream, flush: messages.length > 0 }),
      rail,
    ]),
    el('div', { class: 'section' }, [judgeTable]),
  ])
}

function scoreCell(score) {
  if (score == null) return el('span', { class: 'faint', text: '—' })
  const pct = Math.max(0, Math.min(100, Number(score) * 100))
  return el('span', { class: 'score' }, [
    el('span', { class: 'score-track' }, el('span', { class: 'score-fill', style: { width: `${pct}%` } })),
    el('span', { class: 'num text-xs', text: Number(score).toFixed(2) }),
  ])
}

/* ---------------- 判定 ---------------- */

function renderJudgements(data) {
  const rows = data.rows ?? []
  const stats = data.stats24h ?? {}

  const chatInput = el('input', { class: 'input', attrs: { placeholder: '按会话筛选（g:123 / u:456）', type: 'search' } })
  const verdictSel = el('select', { class: 'select' }, [
    el('option', { text: '全部结论', value: '' }),
    el('option', { text: '回复', value: 'reply' }),
    el('option', { text: '沉默', value: 'silent' }),
    el('option', { text: '交给对话层', value: 'defer' }),
  ])
  const layerSel = el('select', { class: 'select' }, [
    el('option', { text: '全部来源', value: '' }),
    el('option', { text: '启发式', value: 'heuristic' }),
    el('option', { text: '模型', value: 'llm' }),
    el('option', { text: '闸门', value: 'gate' }),
  ])
  const count = el('span', { class: 'toolbar-count', text: `${rows.length} 条` })

  function go() {
    const q = new URLSearchParams()
    if (chatInput.value.trim()) q.set('chatKey', chatInput.value.trim())
    if (verdictSel.value) q.set('verdict', verdictSel.value)
    if (layerSel.value) q.set('layer', layerSel.value)
    loadRoute({ quiet: true, query: q.toString() })
  }

  for (const n of [chatInput, verdictSel, layerSel]) {
    n.addEventListener('change', go)
    n.addEventListener('keydown', e => { if (e.key === 'Enter') go() })
  }

  const stats_ = statStrip([
    stat({ label: '24h 判定', value: int(stats.total) }),
    stat({ label: '回复', value: int(stats.replied), hint: `沉默 ${int((Number(stats.total) || 0) - (Number(stats.replied) || 0))}` }),
    stat({ label: '平均耗时', value: duration(stats.avgCostMs) }),
    stat({ label: '合并批次', value: int(stats.batched), hint: `覆盖 ${int(stats.coveredMsgs)} 条` }),
  ])

  return el('div', {}, [
    pageHead('判定', '为什么没回：先看这一屏'),
    stats_,
    el('div', { class: 'section' }, [
      el('div', { class: 'toolbar' }, [
        el('div', { class: 'field' }, [icon('search'), chatInput]),
        verdictSel,
        layerSel,
        el('span', { class: 'spacer' }),
        count,
      ]),
      panel({
        body: table({
          columns: [
            { label: '时间' }, { label: '会话' }, { label: '层' }, { label: '结论' },
            { label: '分数', num: true }, { label: '原因', clip: true }, { label: '原因码' },
            { label: '覆盖', num: true }, { label: '耗时', num: true },
          ],
          rows: rows.map(j => [
            el('span', { class: 'mono faint text-xs', text: stamp(j.ts) }),
            el('a', { class: 'mono text-xs', href: `#/chat/${encodeURIComponent(j.chatKey)}`, text: j.chatKey }),
            layerPill(j.layer),
            verdictPill(j.verdict),
            scoreCell(j.score),
            el('span', { class: j.verdict === 'silent' ? 'muted' : '', text: clip(j.reason || '—', 54) }),
            el('span', { class: 'mono text-xs faint', text: j.code || '—' }),
            int(j.batchSize),
            duration(j.costMs),
          ]),
          empty: empty({ title: '没有符合条件的判定', hint: '换个会话或结论再试' }),
        }),
        flush: true,
      }),
    ]),
  ])
}

/* ---------------- 用量 ---------------- */

function renderUsage(data) {
  const byStage = data.byStage ?? {}
  const total = data.total ?? {}
  const judgeShare = Math.round((Number(data.judgeShare) || 0) * 100)
  const days = Number(data.days) || 7
  const filled = new Map((data.byDay ?? []).map(d => [d.day, d]))
  const series = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(Date.now() - i * 86_400_000)
    series.push(filled.get(day) ?? { day, stages: {}, total: { cost: 0 } })
  }
  const maxCost = Math.max(0.000001, ...series.map(d => Number(d.total?.cost) || 0))

  const hero = el('div', { class: 'hero' }, [
    el('span', { class: 'eyebrow', text: `最近 ${days} 天总花费` }),
    el('div', { class: 'hero-value', text: cost(total.cost) }),
    el('div', { class: 'hero-meta' }, [
      el('span', { text: `调用 ${int(total.calls)} 次` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { text: `输入 ${int(total.inTokens)}` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { text: `输出 ${int(total.outTokens)}` }),
      el('span', { class: 'faint', text: '·' }),
      el('span', { class: judgeShare > 30 ? '' : 'muted', text: `判定占比 ${judgeShare}%` }),
    ]),
    el('div', { class: 'usage-bars' }, series.map(d => {
      const ans = Number(d.stages?.answer?.cost) || 0
      const jud = Number(d.stages?.judge?.cost) || 0
      const dai = Number(d.stages?.daily?.cost) || 0
      return el('div', { class: 'usage-col' }, [
        el('div', { class: 'usage-stack', title: `${d.day}：${cost(d.total?.cost)}` }, [
          el('div', { class: 'usage-seg is-daily', style: { height: `${(dai / maxCost) * 100}%` } }),
          el('div', { class: 'usage-seg is-judge', style: { height: `${(jud / maxCost) * 100}%` } }),
          el('div', { class: 'usage-seg is-answer', style: { height: `${(ans / maxCost) * 100}%` } }),
        ]),
        el('span', { class: 'usage-label', text: String(d.day).slice(5) }),
      ])
    })),
  ])

  const stats = statStrip([
    stat({ label: '回答', value: cost(byStage.answer?.cost), hint: `${int(byStage.answer?.calls)} 次` }),
    stat({ label: '判定', value: cost(byStage.judge?.cost), hint: `${int(byStage.judge?.calls)} 次` }),
    stat({ label: '日总结', value: cost(byStage.daily?.cost), hint: `${int(byStage.daily?.calls)} 次` }),
    stat({ label: '判定占比', value: `${judgeShare}%`, hint: '超过 30% 值得看一眼', tone: judgeShare > 30 ? 'is-warn' : '' }),
  ])

  return el('div', {}, [
    pageHead('用量', `最近 ${days} 天 · 按网关计价`),
    hero,
    stats,
    el('div', { class: 'section' }, [
      sectionHead('按天 × 阶段', '回答 / 判定 / 日总结'),
      panel({
        body: el('div', {}, [
          el('div', { class: 'legend', style: { marginTop: '0', marginBottom: '8px' } }, [
            el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: '#99d5f8' } }), '回答']),
            el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: '#f5c97a' } }), '判定']),
            el('span', { class: 'legend-item' }, [el('i', { class: 'swatch', style: { background: 'var(--accent-line)' } }), '日总结']),
          ]),
          table({
            columns: [{ label: '日期' }, { label: '阶段' }, { label: '次数', num: true }, { label: '输入', num: true }, { label: '输出', num: true }, { label: '花费', num: true }],
            rows: (data.rows ?? []).map(r => [
              el('span', { class: 'mono text-xs', text: r.day }),
              el('span', { class: 'pill is-plain', text: r.stage }),
              int(r.calls),
              int(r.inTokens),
              int(r.outTokens),
              cost(r.cost),
            ]),
            empty: empty({ title: '还没有用量记录', hint: '跑过一轮对话或判定之后这里会有数据' }),
          }),
        ]),
      }),
    ]),
  ])
}

/* ---------------- 配置（可写） ---------------- */

const BUILTIN_VIEWS = [
  { id: 'overview', label: '总览', icon: 'grid', href: '#/overview' },
  { id: 'chats', label: '会话', icon: 'chat', href: '#/chats' },
  { id: 'judgements', label: '判定', icon: 'pulse', href: '#/judgements' },
  { id: 'usage', label: '用量', icon: 'bars', href: '#/usage' },
  { id: 'settings', label: '配置', icon: 'sliders', href: '#/settings' },
]

/**
 * 配置页的临时状态。放在模块级而不是函数里，是因为**轮询会重渲染整页**：
 * 用户正在改的草稿不能被 5 秒一次的刷新抹掉。
 */
const cfg = {
  describe: null,
  /** @type {Map<string, unknown>} path → 待保存的值 */
  draft: new Map(),
  saving: false,
  /** 宿主 LLM 的 provider/model 清单（懒加载，独立进程里会是 no-llm-service） */
  llm: null,
  llmLoading: false,
}

/** 拉一次 provider/model 清单；失败也记成对象，让控件退化成手填而不是永远 loading */
function ensureLlmOptions(onLoaded) {
  if (cfg.llm || cfg.llmLoading) return
  cfg.llmLoading = true
  api('/llm', { keep: true })
    .then(data => {
      cfg.llm = data
    })
    .catch(err => {
      // 被下一次轮询 abort 掉不是失败：不写 cfg.llm，下次进页面自然会重试。
      // 写成"拿不到清单"会让提示条一直挂着，比没提示更误导。
      if (err?.name === 'AbortError') return
      cfg.llm = { providers: [], models: {}, reason: err?.message ?? 'request-failed' }
    })
    .finally(() => {
      cfg.llmLoading = false
      if (cfg.llm) onLoaded?.()
    })
}

function renderNav(tabs) {
  const nav = document.getElementById('nav')
  if (!nav) return
  const items = [...BUILTIN_VIEWS]
  for (const t of tabs ?? []) {
    items.push({ id: `tab:${t.id}`, label: t.title, icon: 'plug', href: `#/tab/${encodeURIComponent(t.id)}` })
  }
  nav.replaceChildren(
    ...items.map(v =>
      el('a', { class: 'nav-link', attrs: { href: v.href, 'data-view': v.id }, title: v.label }, [
        icon(v.icon),
        el('span', { class: 'nav-text', text: v.label }),
      ]),
    ),
  )
  const route = state.route
  setActiveNav(route?.name === 'tab' ? `tab:${route.key}` : route?.name ?? 'overview')
}

async function apiWrite(path, body) {
  const res = await fetch(`${MOUNT}/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok || !data?.ok) {
    const err = new Error(
      data?.error?.message ??
        (res.ok
          ? '响应不是预期的 JSON（HTTP 200，通常是路径或反向代理指到了别的服务）'
          : `请求失败（HTTP ${res.status}）`),
    )
    err.status = res.status
    err.code = data?.error?.code ?? ''
    throw err
  }
  return data
}

/** 草稿是否与当前值不同（深比较走 JSON：配置项都是 JSON 标量/数组） */
function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function fieldId(path) {
  return `cfg-${path.replace(/\./g, '-')}`
}

/**
 * 多值字段的切分。
 *
 * 用户不会去读代码，所以**能想到的分隔符都认**：换行、空格、中英文逗号、
 * 中英文分号、顿号、"、"。QQ 号/群号是纯数字，多认几种不会误伤。
 */
function splitList(raw) {
  return String(raw ?? '')
    .split(/[\s,，;；、]+/u)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 把 `/api/llm` 的结果摊平成 datalist 选项 */
function llmOptionsFor(f) {
  const llm = cfg.llm
  if (!llm) return []
  if (f.optionsFrom === 'llm.providers') {
    return (llm.providers ?? []).map(p => ({
      value: p.id,
      label: p.live ? p.name : `${p.name}（已配置但未挂载）`,
    }))
  }
  const seen = new Set()
  const out = []
  for (const list of Object.values(llm.models ?? {})) {
    for (const m of list ?? []) {
      if (!m?.id || seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ value: m.id, label: m.name && m.name !== m.id ? m.name : m.id })
    }
  }
  return out
}

/** 按字段类型造控件。返回值变化时写进 cfg.draft，由保存栏统一提交 */
function buildControl(f, onDirty) {
  const dirty = cfg.draft.has(f.path)
  const current = dirty ? cfg.draft.get(f.path) : f.value
  const id = fieldId(f.path)
  /**
   * 只有"部署层锁定"才禁用。
   *
   * 之前这里还判了 `applies === 'restart'` 和 `type === 'secret'`，结果是：
   * wsUrl / 存储路径 / 控制台端口全灰，而且**改密码的入口根本不存在**
   * （console.password 是 secret，被这条一并禁用）。
   * 正确做法是能改就允许改，用徽标写清"什么时候生效"。
   */
  const disabled = Boolean(f.locked)

  const commit = value => {
    if (sameValue(value, f.value)) cfg.draft.delete(f.path)
    else cfg.draft.set(f.path, value)
    onDirty()
  }

  /**
   * provider / model：候选值是运行时从宿主 LLM 服务问来的。
   * 用 input + datalist 而不是 select —— 既能选也能手填，
   * 而且 listModels() 返回空的时候不会把字段锁死（那是上游能力边界，不是错误）。
   */
  if (f.optionsFrom || f.suggest?.length) {
    const opts = f.optionsFrom
      ? llmOptionsFor(f)
      : (f.suggest ?? []).map(v => ({ value: String(v), label: String(v) }))
    const cur = current == null ? '' : String(current)

    /**
     * 候选拿不到时只能手填（独立进程没有 `ctx.llm`）——
     * 这时给个空下拉等于锁死字段，所以退回 input。
     */
    if (!opts.length) {
      return el('input', {
        class: 'input',
        attrs: { id, autocomplete: 'off', placeholder: 'DSH 未提供清单，请手填' },
        value: cur,
        disabled,
        on: { change: ev => commit(ev.currentTarget.value) },
      })
    }

    /**
     * 有候选就是**普通 `<select>`**。
     *
     * 之前是 input + datalist：datalist 在输入过程中不参与过滤，看起来"打什么都没反应"，
     * 而且不可点击展开的态度在不同浏览器上还不一致。这里只需要"从已知值里挑一个"。
     *
     * 当前值不在候选里（部署层写了自定义 id）→ 补一条并标出来，
     * 否则 select 会静默显示成第一项，看着像"值被改掉了"。
     */
    const known = cur && opts.some(o => o.value === cur)
    const head = []
    if (!cur) head.push(el('option', { value: '', text: '（未设置）' }))
    else if (!known) head.push(el('option', { value: cur, text: `${cur}（当前值，不在清单中）` }))

    const sel = el(
      'select',
      {
        class: 'input is-select',
        attrs: { id },
        disabled,
        on: { change: ev => commit(ev.currentTarget.value) },
      },
      [...head, ...opts.map(o => el('option', { value: o.value, text: o.label }))],
    )
    sel.value = cur
    return sel
  }

  if (f.type === 'boolean') {
    const input = el('input', {
      class: 'switch',
      type: 'checkbox',
      attrs: { id },
      disabled,
      on: { change: ev => commit(Boolean(ev.currentTarget.checked)) },
    })
    input.checked = Boolean(current)
    return input
  }

  if (f.type === 'enum') {
    const select = el('select', {
      class: 'input',
      attrs: { id },
      disabled,
      on: { change: ev => commit(ev.currentTarget.value) },
    }, (f.options ?? []).map(o => el('option', { value: String(o), text: String(o) })))
    select.value = String(current ?? '')
    return select
  }

  if (f.type === 'number') {
    return el('input', {
      class: 'input',
      type: 'number',
      attrs: { id, step: 'any' },
      value: current == null ? '' : String(current),
      disabled,
      on: {
        change: ev => {
          const raw = ev.currentTarget.value
          if (raw === '') {
            cfg.draft.delete(f.path)
            onDirty()
            return
          }
          commit(Number(raw))
        },
      },
    })
  }

  if (f.type === 'string[]' || f.type === 'number[]' || f.type === 'json') {
    const text = f.type === 'json'
      ? JSON.stringify(current ?? null, null, 2)
      : [].concat(current ?? []).join('\n')
    return el('textarea', {
      class: 'input is-textarea',
      attrs: {
        id,
        rows: f.type === 'json' ? '6' : '3',
        // 分隔方式是这一档最常见的疑问（逗号？换行？），直接写在占位里
        placeholder:
          f.type === 'json'
            ? ''
            : f.type === 'number[]'
              ? '多个用逗号或换行分隔，如：1, 2, 3'
              : '多个用逗号或换行分隔，如：10001, 10002',
      },
      value: text,
      disabled,
      on: {
        change: ev => {
          const raw = ev.currentTarget.value
          if (f.type === 'json') {
            try {
              commit(JSON.parse(raw || 'null'))
            } catch {
              showBanner(`${f.key} 不是合法 JSON，未记入草稿`, { bad: true })
            }
            return
          }
          const parts = splitList(raw)
          if (f.type === 'number[]') {
            const nums = parts.map(Number).filter(n => Number.isFinite(n))
            if (nums.length !== parts.length) {
              // 静默丢弃会让"我明明填了 5 个"变成 3 个，说不清为什么
              showBanner(`${f.key} 里有 ${parts.length - nums.length} 项不是数字，已忽略`, { bad: true })
            }
            commit(nums)
            return
          }
          commit(parts)
        },
      },
    })
  }

  /**
   * 多行字符串（系统提示这类多段落内容）。
   * 行数与人格角色卡一致：都是"要反复写的东西"，一眼能看全比省空间重要。
   */
  if (f.type === 'string' && f.multiline) {
    return el('textarea', {
      class: 'input is-textarea persona-text',
      attrs: { id, rows: '10' },
      value: current == null ? '' : String(current),
      disabled,
      on: { change: ev => commit(ev.currentTarget.value) },
    })
  }

  // string / secret
  const isSecret = f.type === 'secret'
  /**
   * secret 的已填值要**留在框里**（`type=password` 会显示成点）。
   *
   * 之前这里写死 `value: ''`，靠 placeholder 表达"已设置"，看起来省事，
   * 但用户输完一失焦就触发重渲染，框又空了 —— 主观上就是"我输了但没进去"，
   * 于是反复输入、或者以为没生效。**草稿里有值就回显它**，保存成功清空草稿后
   * 自然回落到 placeholder。
   */
  const secretValue = isSecret && dirty ? String(cfg.draft.get(f.path) ?? '') : ''

  return el('input', {
    class: 'input',
    type: isSecret ? 'password' : 'text',
    attrs: {
      id,
      placeholder: isSecret ? (f.hasValue ? '已设置（留空表示不改）' : '未设置') : '',
      autocomplete: isSecret ? 'new-password' : 'off',
    },
    value: isSecret ? secretValue : String(current ?? ''),
    disabled,
    on: {
      change: ev => {
        const raw = ev.currentTarget.value
        if (isSecret) {
          // 清空 = 放弃这次修改（回到"已设置/未设置"），不是把口令抹掉
          if (raw === '') {
            cfg.draft.delete(f.path)
            onDirty()
            return
          }
          commit(raw)
          return
        }
        commit(raw)
      },
    },
  })
}

function fieldRow(f, onDirty) {
  const id = fieldId(f.path)
  const control = buildControl(f, onDirty)
  const dirty = cfg.draft.has(f.path)

  const badges = []
  if (f.locked) {
    badges.push(
      el('span', { class: 'badge is-lock', title: '这个字段由部署层（patch）指定，控制台改不了' }, [
        icon('lock'),
        el('span', { text: '部署层指定' }),
      ]),
    )
  }
  if (f.applies === 'restart') badges.push(el('span', { class: 'badge is-warn', text: '下次启动生效' }))
  if (f.applies === 'reconnect') badges.push(el('span', { class: 'badge is-info', text: '保存后重连' }))
  if (dirty) badges.push(el('span', { class: 'badge is-dirty', text: '未保存' }))

  return el('div', { class: `field-row ${dirty ? 'is-dirty' : ''} ${f.locked ? 'is-locked' : ''}` }, [
    el('div', { class: 'field-meta' }, [
      el('label', { class: 'field-label', attrs: { for: id } }, [
        // 有中文名就显示中文名（`groupTrigger` 这种 key 扫一眼认不出来），路径仍留作定位
        el('span', { text: f.label || f.key }),
        el('span', { class: 'field-path mono', text: f.path }),
      ]),
      f.description ? el('span', { class: 'field-desc', text: f.description }) : null,
      badges.length ? el('span', { class: 'field-badges' }, badges) : null,
    ]),
    el('div', { class: 'field-control' }, control),
  ])
}

function saveBar(onSave, onReset) {
  const count = cfg.draft.size
  if (count === 0) return null
  return el('div', { class: 'save-bar', attrs: { role: 'region', 'aria-label': '未保存的配置' } }, [
    el('span', { class: 'save-count', text: `${count} 项未保存` }),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      disabled: cfg.saving,
      on: { click: onReset },
    }, '放弃更改'),
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      disabled: cfg.saving || !cfg.describe?.writable,
      on: { click: onSave },
      attrs: { 'aria-live': 'polite' },
    }, cfg.saving ? '保存中…' : '保存并生效'),
  ])
}

function renderSettings(data) {
  cfg.describe = data
  const writable = Boolean(data.writable)
  const groups = data.groups ?? []
  const rerender = () => loadRoute({ quiet: true, force: true })
  // provider/model 的候选值不在 schema 里，进页面时异步拉一次（失败就退成手填）
  ensureLlmOptions(rerender)

  const onSave = async () => {
    if (cfg.saving) return
    cfg.saving = true
    rerender()
    const patch = {}
    for (const [p, v] of cfg.draft) patch[p] = v
    try {
      const res = await apiWrite('/config', { patch, revision: data.revision })
      const touchedOnebot = Object.keys(patch).some(p => p.startsWith('onebot.'))
      cfg.draft.clear()
      showBanner(
        touchedOnebot
          ? `已保存 ${res.changed.length} 项；OneBot 正在按新参数重连（约 1~3 秒）`
          : `已生效：${res.changed.length} 项配置已更新`,
      )
      await loadRoute({ quiet: false })
    } catch (err) {
      if (err.status === 409) {
        // 别人先改了：把最新值拉回来，并明确告诉用户草稿还在
        showBanner('配置已被其他页面修改，已拉取最新值；你的改动仍在草稿里，请重新保存', { bad: true })
        await loadRoute({ quiet: true, force: true })
      } else {
        showBanner(err.message, { bad: true })
      }
    } finally {
      cfg.saving = false
      rerender()
    }
  }

  const onReset = () => {
    cfg.draft.clear()
    rerender()
  }

  const statusBar = el('div', { class: 'cfg-status' }, [
    el('span', { class: 'cfg-chip' }, [
      el('span', { class: 'cfg-chip-key', text: '最后保存' }),
      el('span', { class: 'cfg-chip-val', text: data.updatedAt ? stamp(data.updatedAt) : '从未在控制台改过' }),
    ]),
    el('span', { class: 'cfg-chip' }, [
      el('span', { class: 'cfg-chip-key', text: '待保存' }),
      el('span', { class: 'cfg-chip-val', text: String(cfg.draft.size) }),
    ]),
    writable ? null : el('span', { class: 'cfg-hint is-bad', text: '内核未就绪，暂不可改' }),
  ])

  // 分组导航：一屏只对付一组（3~22 个字段），加字段也不会把页面拉长
  const activeKey = cfgGroupKey(groups)
  const active = groups.find(g => g.key === activeKey) ?? groups[0] ?? null

  const navItems = groups.map(g => {
    const dirty = g.fields.filter(f => cfg.draft.has(f.path)).length
    const isActive = g.key === activeKey
    return el(
      'button',
      {
        class: `cfg-nav-item ${isActive ? 'is-active' : ''}`,
        type: 'button',
        attrs: { role: 'tab', 'aria-selected': isActive ? 'true' : 'false', 'data-group': g.key },
        on: {
          click: () => {
            if (location.hash !== `#/settings/${g.key}`) location.hash = `#/settings/${g.key}`
          },
        },
      },
      [
        el('span', { class: 'cfg-nav-label', text: g.label }),
        dirty
          ? el('span', { class: 'cfg-nav-badge is-dirty', text: String(dirty) })
          : el('span', { class: 'cfg-nav-badge', text: String(g.fields.length) }),
      ],
    )
  })

  const pane = active
    ? active.key === 'persona'
      ? renderPersonaPane(active, rerender)
      : active.key === 'tools'
        ? renderToolsPane(active, rerender)
        : panel({
          title: active.label,
          sub: `${active.fields.length} 项`,
          body: active.fields.map(f => fieldRow(f, rerender)),
        })
    : panel({ title: '没有可配置项', body: empty({ title: '配置 schema 为空' }) })

  const audit = (data.audit ?? []).length
    ? panel({
        title: '最近变更',
        sub: '谁在什么时候改了什么',
        flush: true,
        body: table({
          columns: [{ label: '时间' }, { label: '字段' }, { label: '原值' }, { label: '新值' }, { label: '来源' }],
          rows: (data.audit ?? []).map(r => [
            stamp(r.at),
            el('span', { class: 'mono', text: r.path }),
            el('span', { class: 'mono muted clip', text: clip(r.from ?? '—', 40) }),
            el('span', { class: 'mono clip', text: clip(r.to ?? '—', 40) }),
            el('span', { class: 'muted', text: r.actor || '—' }),
          ]),
          empty: empty({ title: '还没有通过控制台改过配置' }),
        }),
      })
    : null

  const llmNote =
    cfg.llm && cfg.llm.reason
      ? el('div', { class: 'cfg-note' }, [
          icon('alert'),
          el('span', {
            text:
              cfg.llm.reason === 'no-llm-service'
                ? '当前进程没有 LLM 服务（独立模式）：provider / model 只能手填。接到宿主里会自动变成下拉。'
                : `拿不到 provider 清单（${cfg.llm.reason}）：provider / model 可手填。`,
          }),
        ])
      : null

  return el('div', { class: 'page' }, [
    pageHead('配置', '运行层配置', null),
    statusBar,
    llmNote,
    el('div', { class: 'cfg-layout' }, [
      el('nav', { class: 'cfg-nav', attrs: { 'aria-label': '配置分组', role: 'tablist' } }, navItems),
      el('div', { class: 'cfg-pane', attrs: { role: 'tabpanel' } }, [pane]),
    ]),
    audit,
    saveBar(onSave, onReset),
  ])
}

/** 当前选中的分组：URL 里有且合法就用它，否则落到第一组 */
function cfgGroupKey(groups) {
  const key = state.route?.name === 'settings' ? state.route.key : ''
  if (key && groups.some(g => g.key === key)) return key
  return groups[0]?.key ?? ''
}

/* ---------------- 工具 ---------------- */

/**
 * 工具面板的数据。
 *
 * 和配置字段不同：`GET /api/tools` 返回的是**宿主此刻真实注册了什么**，
 * 会随 profile / MCP 连接变化 —— 所以不能塞进 `/api/config`（那是 5 秒轮询的）。
 */
const toolsUI = { data: null, loading: false, error: '', at: 0 }

/**
 * 拉工具清单。
 *
 * **基本不缓存**：工具清单是"此刻注册了什么"，插件可以随时注册/注销，
 * 缓存住它等于让页面撒谎。所以每次进工具页都重新拉。
 *
 * 只保留一个 2 秒窗口，用来合并**同一轮渲染里的多次调用**
 * （面板重建时几个块会先后要数据），不是给页面做缓存用的。
 *
 * 早先的写法是 `if (toolsUI.data) return` —— 结果是"点了禁用没反应，
 * 刷新页面才看到"，以及"插件新注册的工具要重进页面才出现"。
 *
 * @param {Function} [onLoaded]
 * @param {{ force?: boolean }} [opts]
 */
function ensureTools(onLoaded, { force = false } = {}) {
  if (toolsUI.loading) return
  const fresh = toolsUI.data && Date.now() - toolsUI.at < 2000
  if (fresh && !force) return
  toolsUI.loading = true
  api('/tools', { keep: true })
    .then(d => {
      toolsUI.data = d
      toolsUI.error = ''
      toolsUI.at = Date.now()
    })
    .catch(err => {
      if (err?.name === 'AbortError') return
      toolsUI.error = err?.message ?? '工具清单读取失败'
    })
    .finally(() => {
      toolsUI.loading = false
      if (toolsUI.data || toolsUI.error) onLoaded?.()
    })
}

/**
 * 勾选即生效（写进 `cfg.draft`，随底部保存栏一起提交）。
 *
 * 为什么不直接 POST：这些是配置字段（`tools.internalAllow` / `tools.externalAllow`），
 * 走同一条保存链路才能享受 revision 冲突检测与审计。
 */
function toggleToolList(path, name, rerender) {
  const f = cfg.describe?.groups?.flatMap(g => g.fields).find(x => x.path === path)
  const cur = cfg.draft.has(path) ? cfg.draft.get(path) : (f?.value ?? [])
  const next = cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name]
  if (sameValue(next, f?.value ?? [])) cfg.draft.delete(path)
  else cfg.draft.set(path, next)
  rerender()
}

/** 一个可勾选的条目 */
function toolChip({ label, hint, on, disabled, onClick }) {
  return el(
    'button',
    {
      class: `tool-chip ${on ? 'is-on' : ''} ${disabled ? 'is-off' : ''}`,
      type: 'button',
      disabled: Boolean(disabled),
      title: hint ?? label,
      attrs: { 'aria-pressed': on ? 'true' : 'false' },
      on: { click: onClick },
    },
    [on ? icon('check') : null, el('span', { class: 'tool-chip-label', text: label })],
  )
}

function renderToolsPane(group, rerender) {
  ensureTools(rerender)
  const byPath = new Map(group.fields.map(f => [f.path, f]))
  const data = toolsUI.data

  const listOf = path => {
    const f = byPath.get(path)
    return cfg.draft.has(path) ? cfg.draft.get(path) : (f?.value ?? [])
  }

  // 这组是"普通字段行"：开关 + 需要手填的多值列表。
  // `adminOwners` 必须在这里，否则它只存在于 /api/config 里、界面上永远看不到。
  const switches = [
    'tools.enabled',
    'tools.imageMode',
    'tools.qqRead',
    'tools.qqWrite',
    'tools.qqAdmin',
    'tools.adminOwners',
  ]
    .map(p => byPath.get(p))
    .filter(Boolean)

  const groupsSwitch = ['tools.qqRead', 'tools.qqWrite', 'tools.qqAdmin']
    .map(p => byPath.get(p))
    .filter(Boolean)

  const body = []

  // 1. 总开关与 QQ 能力分档
  if (switches.length) {
    body.push(panel({ title: '能力开关', body: switches.map(f => fieldRow(f, rerender)) }))
  }

  // 2. QQ 能力（只读展示：分组开关决定，不逐个勾）
  const qqOn = {
    read: Boolean(byPath.get('tools.qqRead') ? listOf('tools.qqRead') !== false : true),
    write: Boolean(byPath.get('tools.qqWrite') ? listOf('tools.qqWrite') !== false : true),
    admin: Boolean(byPath.get('tools.qqAdmin') ? listOf('tools.qqAdmin') === true : false),
  }
  if (data) {
    const groups = [
      { key: 'read', label: '只读' },
      { key: 'write', label: '发送 / 互动' },
      { key: 'admin', label: '管理（默认关）' },
    ]
    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: 'QQ 能力' }),
          el('span', { class: 'persona-count', text: `${data.qq.length} 个` }),
        ]),
        ...groups.map(g => {
          const items = data.qq.filter(t => t.group === g.key)
          if (!items.length) return null
          const on = g.key === 'read' ? qqOn.read : g.key === 'write' ? qqOn.write : qqOn.admin
          return el('div', { class: 'tool-group' }, [
            el('div', { class: 'tool-group-head' }, [
              el('span', { class: 'tool-group-label', text: g.label }),
              on ? null : el('span', { class: 'badge', text: '未启用' }),
            ]),
            el(
              'div',
              { class: 'tool-chips' },
              items.map(t =>
                toolChip({
                  label: t.title,
                  hint: `${t.name}${t.sideEffect ? '（有副作用，走出站队列）' : ''}`,
                  on,
                  disabled: true,
                  onClick: () => {},
                }),
              ),
            ),
          ])
        }),
      ]),
    )
  }

  /**
   * 2.4 插件注册的工具。
   *
   * 数据来自注册表（实时），不是建会话时的 `toolStates` 快照 ——
   * 后者要等下一次建会话才更新，表现为"插件说注册了，目录里永远没有"。
   */
  if (data?.plugins?.length) {
    /** 已授予的插件。**默认空 = 一个都不授予** */
    const granted = new Set((data.config?.grantedPlugins ?? []).map(String))
    /** @type {Map<string, object[]>} owner → 该插件的工具 */
    const byOwner = new Map()
    for (const t of data.plugins) {
      const owner = String(t.owner ?? '未署名插件')
      if (!byOwner.has(owner)) byOwner.set(owner, [])
      byOwner.get(owner).push(t)
    }

    /**
     * 授予 / 收回某个插件的工具。
     *
     * 粒度是**整个插件**，不是单个工具 —— 内核不知道"摘掉这一个，
     * 那个插件还能不能正常工作"，那个判断只有插件自己知道。
     */
    const setGranted = async (owner, nextGranted) => {
      try {
        /**
         * 走专用接口，**不碰 revision**。
         *
         * 用 `/api/config` 的话要带上打开页面时的 revision，而用户在别处改过配置
         * 之后它就已经过期了 —— 直接 409，表现为"点了没反应"，
         * 而提示藏在 banner 里，很容易被当成按钮坏了。
         */
        await apiWrite('/tools/plugin', { owner, granted: nextGranted })
        showBanner(
          nextGranted ? `已授予「${owner}」，模型现在能用了` : `已收回「${owner}」，模型不再能调用`,
        )
        /**
         * 先丢缓存再拉，**不能只调 `rerender()`**：`ensureTools` 有缓存短路，
         * 那样只是拿旧数据重建 DOM，看起来像"点了没反应、刷新才生效"。
         */
        toolsUI.data = null
        ensureTools(() => rerender(), { force: true })
      } catch (err) {
        showBanner(`切换失败：${err?.message ?? err}`, { bad: true })
      }
    }

    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: '插件工具' }),
          el('span', { class: 'persona-count', text: `${data.plugins.length} 个` }),
        ]),
        ...[...byOwner.entries()].map(([owner, items]) => {
          const on = granted.has(owner)
          const btn = el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: on ? '收回' : '授予',
          })
          btn.addEventListener('click', () => setGranted(owner, !on))
          return el('div', { class: 'tool-group' }, [
            el('div', { class: 'tool-group-head' }, [
              el('span', { class: 'tool-group-label', text: owner }),
              on ? null : el('span', { class: 'badge', text: '已禁用' }),
              btn,
            ]),
            el(
              'div',
              { class: 'tool-chips' },
              items.map(t =>
                toolChip({
                  label: t.name,
                  hint: t.description || '',
                  on,
                  disabled: true,
                  onClick: () => {},
                }),
              ),
            ),
          ])
        }),
      ]),
    )
  }

  // 2.5 记忆工具：只在 memory.enabled 时才会有内容
  if (data?.memory?.length) {
    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: '记忆工具' }),
          el('span', { class: 'persona-count', text: `${data.memory.length} 个` }),
        ]),
        el(
          'div',
          { class: 'tool-chips' },
          data.memory.map(name => toolChip({ label: name, on: true, disabled: true, onClick: () => {} })),
        ),
      ]),
    )
  }

  // 3. DSH 内置安全项（默认已给，可取消）
  if (data) {
    const internalAllow = listOf('tools.internalAllow')
    const safeOn = name => internalAllow.includes(name)
    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: 'DSH 内置（只读类）' }),
          el('span', { class: 'persona-count', text: `${data.internal.length} 个可用` }),
        ]),
        data.internal.length
          ? el(
              'div',
              { class: 'tool-chips' },
              data.internal.map(name =>
                toolChip({
                  label: name,
                  on: safeOn(name),
                  onClick: () => toggleToolList('tools.internalAllow', name, rerender),
                }),
              ),
            )
          : el('p', { class: 'persona-hint', text: data.ready ? '当前没有可用的内置只读工具' : '当前进程没有工具服务' }),
      ]),
    )
  }

  // 4. 外部 / MCP 工具（勾选才给）
  if (data) {
    const externalAllow = listOf('tools.externalAllow')
    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: '外部工具（MCP 等）' }),
          el('span', { class: 'persona-count', text: `${data.external.length} 个可用` }),
        ]),
        data.external.length
          ? el(
              'div',
              { class: 'tool-chips' },
              data.external.map(name =>
                toolChip({
                  label: name,
                  on: externalAllow.includes(name),
                  onClick: () => toggleToolList('tools.externalAllow', name, rerender),
                }),
              ),
            )
          : el('p', { class: 'persona-hint', text: '没有检测到外部工具。接入 MCP 后这里会出现可选清单。' }),
      ]),
    )
  }

  // 5. 高危：只展示原因，不可勾选
  if (data?.blocked?.length) {
    body.push(
      el('div', { class: 'persona-section' }, [
        el('div', { class: 'persona-head' }, [
          el('span', { class: 'persona-title', text: '已屏蔽（高危）' }),
          el('span', { class: 'persona-count', text: `${data.blocked.length} 个` }),
        ]),
        el('p', { class: 'persona-hint', text: '这些在任何会话都不提供：群消息是不可信输入，能执行命令或写文件的工具等于把机器交出去。' }),
        el(
          'div',
          { class: 'tool-chips' },
          data.blocked.map(name => toolChip({ label: name, on: false, disabled: true, onClick: () => {} })),
        ),
      ]),
    )
  }

  if (toolsUI.error) {
    body.push(el('p', { class: 'persona-hint', text: `工具清单读取失败：${toolsUI.error}` }))
  }

  return panel({
    title: group.label,
    sub: data?.ready === false ? '当前进程没有工具服务' : undefined,
    body,
  })
}

/* ---------------- 身份与人格（卡库） ---------------- */

/**
 * 人格卡库的界面状态。
 *
 * 为什么不复用 `cfg.draft`：那是 ConfigStore 的 patch 草稿（键是配置路径），
 * 而卡库是独立存储（kv JSON），保存走 `POST /api/persona`。
 * 混在一起会让"保存并生效"按钮同时承担两种语义，出错时无从判断是谁失败。
 */
const personaUI = {
  /** 最近一次 GET /api/persona 的结果 */
  data: null,
  /** @type {{ id: string, name: string, text: string, hint: string }|null} 正在编辑的卡（id='' 表示新建） */
  editing: null,
  loading: false,
  saving: false,
  error: '',
}

function ensurePersona(onLoaded) {
  if (personaUI.data || personaUI.loading) return
  personaUI.loading = true
  api('/persona', { keep: true })
    .then(d => {
      personaUI.data = d
      personaUI.error = ''
    })
    .catch(err => {
      // 同上：轮询 abort 不算失败，保持"未加载"状态好让下次重试
      if (err?.name === 'AbortError') return
      personaUI.error = err?.message ?? '卡库读取失败'
    })
    .finally(() => {
      personaUI.loading = false
      if (personaUI.data || personaUI.error) onLoaded?.()
    })
}

/**
 * 切到另一张卡：列表里只有长度，全文要按 id 另取。
 * @param {string} id 空串 = 新建
 */
async function editPersonaCard(id, rerender) {
  if (!id) {
    personaUI.editing = { id: '', name: '', text: '', hint: '', aliases: [] }
    rerender()
    return
  }
  try {
    const d = await api(`/persona?cardId=${encodeURIComponent(id)}`, { keep: true })
    personaUI.data = { ...personaUI.data, ...d }
    personaUI.editing = d.editing ?? { id: '', name: '', text: '', hint: '', aliases: [] }
    personaUI.error = ''
  } catch (err) {
    personaUI.error = err?.message ?? '读取这张卡失败'
  }
  rerender()
}

/** @param {object} body */
async function personaAction(body, rerender, okText) {
  if (personaUI.saving) return
  personaUI.saving = true
  rerender()
  try {
    const d = await apiWrite('/persona', body)
    personaUI.data = d
    personaUI.error = ''
    if (okText) showBanner(okText)
  } catch (err) {
    personaUI.error = err?.message ?? '操作失败'
    showBanner(personaUI.error, { bad: true })
  } finally {
    personaUI.saving = false
    rerender()
  }
}

/** 一段标题 + 说明，和通用表单的排版对齐 */
function personaSection(title, hint, children) {
  return el('div', { class: 'persona-section' }, [
    el('div', { class: 'persona-head' }, [el('span', { class: 'persona-title', text: title })]),
    hint ? el('p', { class: 'persona-hint', text: hint }) : null,
    ...[].concat(children),
  ])
}

/**
 * 「身份与人格」面板。
 *
 * 三块：
 *   1. 身份（selfId / nickname）—— 仍是配置字段，走 cfg.draft 与底部保存栏
 *   2. 人格卡库 —— 独立 API，卡内编辑即时保存
 *   3. 注入预览 —— 展示"正在编辑的这张卡"会变成什么
 *
 * 生效顺序（内核里的优先级）：按群覆盖 → 当前卡 → 部署层静态人设。
 */
function renderPersonaPane(group, rerender) {
  const byPath = new Map(group.fields.map(f => [f.path, f]))
  const fEnabled = byPath.get('persona.enabled')
  // 这一组现在混了三类：身份（selfId）、人格卡（persona.*）、系统提示（agent.systemPrompt）。
  // 按路径显式取，不再用"非 persona.* 就是身份"这种反推 —— 一加字段就会归类错。
  const identityFields = group.fields.filter(f => f.path === 'onebot.selfId')
  const promptField = group.fields.find(f => f.path === 'agent.systemPrompt')

  ensurePersona(rerender)
  if (!personaUI.editing) personaUI.editing = { id: '', name: '', text: '', hint: '', aliases: [] }

  const val = f => (cfg.draft.has(f.path) ? cfg.draft.get(f.path) : f.value)
  const editing = personaUI.editing
  const data = personaUI.data
  const isNew = !editing.id
  const activeId = data?.activeId ?? ''

  const countText = text => {
    const s = String(text ?? '')
    const chars = Array.from(s.trim()).length
    const lines = s ? s.split('\n').length : 0
    return `${chars} 字 · ${lines} 行`
  }

  /* --- 卡列表 --- */
  const chips = (data?.cards ?? []).map(c =>
    el(
      'button',
      {
        class: `chip-card ${c.id === editing.id ? 'is-editing' : ''} ${c.id === activeId ? 'is-active' : ''}`,
        type: 'button',
        title: `${c.name} · ${c.chars} 字`,
        on: { click: () => void editPersonaCard(c.id, rerender) },
      },
      [
        el('span', { class: 'chip-card-name', text: c.name }),
        c.id === activeId ? el('span', { class: 'chip-card-flag', text: '生效中' }) : null,
      ],
    ),
  )
  chips.push(
    el(
      'button',
      {
        class: `chip-card is-add ${isNew ? 'is-editing' : ''}`,
        type: 'button',
        on: { click: () => void editPersonaCard('', rerender) },
      },
      [el('span', { text: '+ 新建' })],
    ),
  )

  /* --- 编辑器 --- */
  const nameInput = el('input', {
    class: 'input',
    attrs: { id: 'persona-card-name', placeholder: '这张卡叫什么（如：鲸鱼助手 / 冷面客服）', maxlength: '40' },
    value: editing.name,
    on: {
      input: ev => {
        editing.name = ev.currentTarget.value
      },
    },
  })

  // 别名跟着卡走：换卡即换一组称呼，不需要再去配置里改一次
  const aliasInput = el('input', {
    class: 'input',
    attrs: { id: 'persona-card-aliases', placeholder: '逗号分隔，如：小白, 鲸鱼, 小助手' },
    value: (editing.aliases ?? []).join(', '),
    on: {
      input: ev => {
        editing.aliases = ev.currentTarget.value
          .split(/[,，\n]/)
          .map(s => s.trim())
          .filter(Boolean)
      },
    },
  })

  const textArea = el('textarea', {
    class: 'input is-textarea persona-text',
    attrs: { rows: '10', placeholder: '你是谁、怎么说话、有什么习惯' },
    value: editing.text,
  })
  const textCount = el('span', { class: 'persona-count', text: countText(editing.text) })
  textArea.addEventListener('input', () => {
    editing.text = textArea.value
    textCount.textContent = countText(textArea.value)
  })

  const hintArea = el('textarea', {
    class: 'input is-textarea persona-text',
    attrs: { rows: '4', placeholder: '性格与参与意愿；留空用角色卡全文' },
    value: editing.hint,
  })
  const hintCount = el('span', { class: 'persona-count', text: countText(editing.hint) })
  hintArea.addEventListener('input', () => {
    editing.hint = hintArea.value
    hintCount.textContent = countText(hintArea.value)
  })

  const canSave = Boolean(String(editing.name ?? '').trim()) && !personaUI.saving
  const saveBtn = el(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      disabled: !canSave,
      on: {
        click: () =>
          void personaAction(
            {
              action: 'save',
              card: {
                id: editing.id,
                name: editing.name,
                text: editing.text,
                hint: editing.hint,
                aliases: editing.aliases ?? [],
              },
            },
            rerender,
            isNew ? '人格卡已创建' : '人格卡已保存',
          ),
      },
    },
    personaUI.saving ? '保存中…' : isNew ? '创建这张卡' : '保存这张卡',
  )

  const activateBtn = el(
    'button',
    {
      class: 'btn btn-ghost',
      type: 'button',
      disabled: isNew || editing.id === activeId || personaUI.saving,
      on: {
        click: () => void personaAction({ action: 'activate', id: editing.id }, rerender, `已切换到「${editing.name}」`),
      },
    },
    editing.id === activeId ? '当前生效' : '设为当前',
  )

  const deleteBtn = el(
    'button',
    {
      class: 'btn btn-ghost is-danger',
      type: 'button',
      disabled: isNew || personaUI.saving,
      on: {
        click: () => {
          if (!window.confirm(`删除人格卡「${editing.name}」？这一步不能撤销。`)) return
          void personaAction({ action: 'delete', id: editing.id }, () => {
            personaUI.editing = { id: '', name: '', text: '', hint: '', aliases: [] }
            rerender()
          }, '人格卡已删除')
        },
      },
    },
    '删除',
  )

  /* --- 生效说明 --- */
  const eff = data?.effective
  const effectLine = !data
    ? personaUI.error
      ? `读取失败：${personaUI.error}`
      : '读取中…'
    : !eff?.enabled
      ? '未启用人格'
      : eff.source === 'card'
        ? `生效：卡「${eff.activeName}」`
        : eff.source === 'config'
          ? '生效：部署层人设'
          : '未设置人设'

  /* --- 预览 --- */
  const previewBox = el('div', { class: 'persona-preview', hidden: true })
  const renderPreview = () => {
    const text = String(editing.text ?? '').trim()
    const hintText = String(editing.hint ?? '').trim()
    const judgeBody = hintText
      ? hintText
      : text
        ? `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}\n\n（摘要留空 → 判定侧用上段全文的前 120 字）`
        : ''
    previewBox.replaceChildren(
      el('div', { class: 'persona-preview-block' }, [
        el('div', { class: 'persona-preview-title', text: '回复 prompt：这段会拼在群聊记录之后' }),
        el('pre', {
          class: 'persona-preview-body mono',
          text: text ? `【角色人格】\n${text}` : '（空：不注入人设，模型按默认助手语气回）',
        }),
      ]),
      el('div', { class: 'persona-preview-block' }, [
        el('div', { class: 'persona-preview-title', text: '判定 prompt：这段只影响"要不要开口"' }),
        el('pre', {
          class: 'persona-preview-body mono',
          text: judgeBody ? `【角色人格】\n${judgeBody}` : '（空：判定走通用判据）',
        }),
      ]),
    )
    previewBox.hidden = !previewBox.hidden
  }

  const body = []

  // 1. 身份：仍是配置字段，改完跟着底部「保存并生效」走
  if (identityFields.length) {
    body.push(personaSection('身份', '', identityFields.map(f => fieldRow(f, rerender))))
  }

  // 2. 总开关
  if (fEnabled) {
    body.push(
      el('div', { class: 'persona-toggle' }, [
        el('div', { class: 'field-meta' }, [
          el('span', { class: 'field-label', text: '启用人格' }),
          el('span', { class: 'field-desc', text: '停用后角色卡不参与回复与判定' }),
        ]),
        el('div', { class: 'field-control' }, buildControl(fEnabled, rerender)),
      ]),
    )
  }

  // 3. 卡库
  body.push(
    el('div', { class: 'persona-section' }, [
      el('div', { class: 'persona-head' }, [
        el('span', { class: 'persona-title', text: '人格卡' }),
        el('span', { class: 'persona-count', text: `${data?.cards?.length ?? 0} 张` }),
      ]),

      el('div', { class: 'chip-row' }, chips),
      el('p', { class: 'persona-effect', text: effectLine }),
      el('div', { class: 'persona-editor' }, [
        el('div', { class: 'persona-field' }, [
          el('span', { class: 'persona-field-label', text: '名字' }),
          nameInput,
        ]),
        el('div', { class: 'persona-field' }, [
          el('span', { class: 'persona-field-label', text: '别名' }),
          aliasInput,
        ]),
        el('div', { class: 'persona-field' }, [
          el('div', { class: 'persona-head' }, [
            el('span', { class: 'persona-field-label', text: '角色卡' }),
            textCount,
          ]),
          textArea,
        ]),
        el('div', { class: 'persona-field' }, [
          el('div', { class: 'persona-head' }, [
            el('span', { class: 'persona-field-label', text: '性格摘要（给判定器）' }),
            hintCount,
          ]),
          hintArea,
        ]),
        el('div', { class: 'persona-actions' }, [saveBtn, activateBtn, deleteBtn]),
      ]),
    ]),
  )

  // 4. 系统提示：写进工作区 AGENTS.md，新建会话生效
  if (promptField) {
    body.push(personaSection('系统提示', '', [fieldRow(promptField, rerender)]))
  }

  // 5. 预览
  body.push(
    el('div', { class: 'persona-actions' }, [
      el('button', { class: 'btn btn-ghost', type: 'button', on: { click: renderPreview } }, [icon('search'), '预览注入效果']),
    ]),
    previewBox,
  )

  return panel({
    title: group.label,
    body,
  })
}

/* ---------------- 插件选项卡 ---------------- */

function renderTab(data, tabId) {
  const tab = (data.tabs ?? []).find(t => t.id === tabId)
  if (!tab) {
    return el('div', { class: 'page' }, [
      pageHead('选项卡', tabId, null),
      panel({
        title: '选项卡不存在',
        body: empty({ title: `没有找到 id 为「${tabId}」的选项卡`, hint: '插件可能已卸载，或注册时被拒绝', iconName: 'alert' }),
      }),
    ])
  }

  /**
   * 触发选项卡里的动作。
   *
   * `body` 是可选的：`actions` 块只要确认，`form` 块提交时要把字段值一起带上
   * （键是 `path`，值是控件里的当前值）。动作处理函数拿到的就是这份 body。
   */
  const onAction = async (id, actionId, button, body) => {
    const original = button.textContent
    button.disabled = true
    button.textContent = '执行中…'
    try {
      const res = await apiWrite(
        `/tabs/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
        body ?? {},
      )
      showBanner(res.result === undefined ? '已执行' : `已执行：${clip(JSON.stringify(res.result), 120)}`)
      // 表单据此决定要不要清草稿：成功清、失败留着让用户改
      return true
      } catch (err) {
      showBanner(err.message, { bad: true })
      return false
      } finally {
      button.disabled = false
      button.textContent = original
    }
  }

  return el('div', { class: 'page' }, [
    pageHead(tab.title, tab.owner ? `来自 ${tab.owner}` : '插件选项卡', null),
    el('div', { class: 'cfg-grid' }, renderBlocks(tab.layout, { onAction, tabId })),
  ])
}

/* ---------------- 路由与轮询 ---------------- */

const ROUTE_META = {
  overview: ['总览', '运行状态'],
  chats: ['会话', '全部会话'],
  chat: ['会话', '详情'],
  judgements: ['判定', '判定流水'],
  usage: ['用量', '调用与花费'],
  settings: ['配置', '运行层配置'],
  tab: ['插件', '选项卡'],
}

function parseHash() {
  const raw = String(location.hash || '#/overview').replace(/^#/, '')
  const [pathPart, query = ''] = raw.split('?')
  const parts = pathPart.split('/').filter(Boolean)
  if (parts[0] === 'chat' && parts[1]) return { name: 'chat', key: decodeURIComponent(parts[1]), query }
  if (parts[0] === 'chats') return { name: 'chats', query }
  if (parts[0] === 'judgements') return { name: 'judgements', query }
  if (parts[0] === 'usage') return { name: 'usage', query }
  // #/settings/<group>：分组导航选中项进 URL，刷新/分享都能回到同一组
  if (parts[0] === 'settings') return { name: 'settings', key: parts[1] ? decodeURIComponent(parts[1]) : '', query }
  if (parts[0] === 'tab' && parts[1]) return { name: 'tab', key: decodeURIComponent(parts[1]), query }
  return { name: 'overview', query }
}

function setActiveNav(name) {
  const target = name === 'chat' ? 'chats' : name
  for (const a of document.querySelectorAll('.nav-link')) {
    const on = a.dataset.view === target
    a.classList.toggle('is-active', on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
}

function skeleton() {
  return el('div', {}, [
    el('div', { class: 'skeleton', style: { width: '168px', height: '24px', marginBottom: '8px' } }),
    el('div', { class: 'skeleton', style: { width: '260px', height: '12px', marginBottom: '24px' } }),
    el('div', { class: 'overview-grid' }, [
      el('div', { class: 'skeleton', style: { height: '196px', borderRadius: '12px' } }),
      el('div', { class: 'skeleton', style: { height: '196px', borderRadius: '12px' } }),
    ]),
    el('div', { class: 'skeleton', style: { height: '76px', marginTop: '16px', borderRadius: '12px' } }),
    el('div', { class: 'panel', style: { marginTop: '28px' } }, [
      el('div', { class: 'skeleton-row' }, [1, 2, 3, 4].map(() => el('div', { class: 'skeleton' }))),
      el('div', { class: 'skeleton-row' }, [1, 2, 3, 4].map(() => el('div', { class: 'skeleton' }))),
      el('div', { class: 'skeleton-row' }, [1, 2, 3, 4].map(() => el('div', { class: 'skeleton' }))),
    ]),
  ])
}

function pathFor(route, query) {
  const q = query || ''
  if (route.name === 'chat') return `/chats/${encodeURIComponent(route.key)}?days=5&limit=50${q ? `&${q}` : ''}`
  if (route.name === 'chats') return `/chats${q ? `?${q}` : ''}`
  if (route.name === 'judgements') return `/judgements${q ? `?${q}` : ''}`
  if (route.name === 'usage') return `/usage${q ? `?${q}` : ''}`
  if (route.name === 'settings') return '/config'
  if (route.name === 'tab') return '/tabs'
  return '/overview'
}

/** @param {{ name: string, key?: string }|string} route */
function rendererFor(route) {
  const name = typeof route === 'string' ? route : route.name
  if (name === 'chats') return renderChats
  if (name === 'chat') return renderChat
  if (name === 'judgements') return renderJudgements
  if (name === 'usage') return renderUsage
  if (name === 'settings') return renderSettings
  if (name === 'tab') {
    const key = typeof route === 'string' ? '' : route.key
    return data => renderTab(data, key)
  }
  return renderOverview
}

async function loadRoute({ quiet = false, query = null, force = false } = {}) {
  const route = parseHash()
  // 配置页切成两组之间不算换页：否则每点一次分组都会闪一次骨架屏
  const keyOf = r => (r.name === 'settings' ? 'settings' : `${r.name}:${r.key ?? ''}`)
  const firstPaint = state.routeKey !== keyOf(route)
  state.route = route
  state.routeKey = keyOf(route)
  if (query != null) state.query = query
  if (!quiet || firstPaint) state.query = query ?? ''

  // 配置页有未保存草稿时**不自动刷新**：5 秒一次的轮询会把正在输入的控件整段重建
  if (quiet && !force && route.name === 'settings' && cfg.draft.size > 0 && !firstPaint) return

  const meta = ROUTE_META[route.name] ?? ROUTE_META.overview
  setCrumbs(meta[0], route.name === 'tab' && route.key ? route.key : meta[1])
  setActiveNav(route.name === 'tab' ? `tab:${route.key}` : route.name)

  if (!quiet) {
    dom.view.replaceChildren(skeleton())
    hideBanner()
    // 带着未保存的改动离开配置页：提醒一次，但不拦路（拦截式弹窗更烦人）
    if (route.name !== 'settings' && cfg.draft.size > 0) {
      showBanner(`有 ${cfg.draft.size} 项配置改动未保存，回到「配置」页可以继续`, { bad: true })
    }
  }

  try {
    // 刷新前后保留滚动位置：整页替换会把页面弹回顶部，长列表上很打断阅读
    const scrollY = window.scrollY
    const data = await api(pathFor(route, state.query))
    state.cache.set(state.routeKey, data)
    if (data.status) paintShell(data.status)
    dom.view.replaceChildren(rendererFor(route)(data))
    if (quiet && scrollY > 0) window.scrollTo(0, scrollY)
    dom.refreshed.textContent = clock(Date.now())
    dom.clock.textContent = clock(Date.now())
    // 首屏不抢焦点：没人要求"跳到内容"，抢来只会让 #view 的 :focus-visible
    // 在整页外面画一圈描边。skip-link 的原生锚点跳转本来就会聚焦 #view。
  } catch (err) {
    if (err?.name === 'AbortError') return
    const cached = state.cache.get(state.routeKey)
    if (cached) {
      dom.view.replaceChildren(rendererFor(route)(cached))
      showBanner(`${err.message}（显示的是上次成功的数据）`, { bad: true })
    } else {
      if (!quiet) {
        dom.view.replaceChildren(el('div', { class: 'panel' }, el('div', { class: 'panel-body' }, empty({
          title: '取数失败',
          hint: err.message,
          iconName: 'alert',
        }))))
      }
      showBanner(err.message, { bad: true })
    }
  }
}

/**
 * 焦点是否在可编辑控件里。
 *
 * 定时刷新会**整页重渲染**，DOM 一换焦点就没了 —— 正在输入的配置项、
 * 光标位置、选区全部丢失。5 秒一轮的频率下，写长文本几乎不可能。
 * 所以编辑期间跳过重渲染，等失焦再补。
 */
function isEditing() {
  const el = document.activeElement
  if (!el || el === document.body) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function schedule() {
  if (state.timer) clearInterval(state.timer)
  const ms = Math.max(1000, Number(state.meta?.pollMs) || 5000)
  state.timer = setInterval(() => {
    if (document.hidden) return
    if (isEditing()) return
    loadRoute({ quiet: true })
  }, ms)
}

// 编辑结束补一次：编辑期间被跳过的刷新不该让页面一直停在旧数据
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!isEditing() && !document.hidden && state.route) loadRoute({ quiet: true })
  }, 300)
})

window.addEventListener('hashchange', () => loadRoute({ quiet: false }))
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.route) loadRoute({ quiet: true })
})
document.getElementById('refresh').addEventListener('click', () => loadRoute({ quiet: false }))
document.getElementById('logout')?.addEventListener('click', logout)
document.getElementById('account')?.addEventListener('click', openPasswordDialog)

async function boot() {
  try {
    const meta = await api('/meta')
    state.meta = meta
    paintMeta(meta)
  } catch (err) {
    showBanner(err.message, { bad: true })
  }
  // 导航由注册表驱动：插件选项卡必须出现在侧栏里，否则"注册成功但看不见"
  try {
    const tabs = await api('/tabs')
    state.tabs = tabs.tabs ?? []
  } catch {
    // 选项卡列表拿不到不该挡住主页面：内置五项仍然可用，导航先渲染内置部分
    state.tabs = []
  }
  renderNav(state.tabs)
  await loadRoute({ quiet: false })
  schedule()
}

boot()
