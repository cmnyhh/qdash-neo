/**
 * 前端原语 + 声明式选项卡渲染器（M3 第二阶段）。
 *
 * 为什么把 `el` / `table` / `empty` 也搬到这里：插件选项卡的四种块
 * （form / table / status / actions）与控制台自己的视图必须共用同一套原语，
 * 否则"插件页面看起来像另一个产品"。原语只有这一份实现。
 *
 * 两条不能破的约束：
 *   1. **不用 innerHTML**：插件送来的 label / 表格单元格同样是不可信文本。
 *   2. **动态样式走 CSSOM**：`style-src 'self'` 会拦内联 style 属性，
 *      拼字符串写进 `style="..."` 的表现是"布局全是默认值"，且控制台里看不到报错。
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** 只保留真正用到的图标，避免引入图标库 */
const ICONS = {
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  chevron: ['M9 18l6-6-6-6'],
  // 删除会话用（会话列表每行一个）
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6M14 11v6'],
  inbox: ['M4 13h4l2 3h4l2-3h4', 'M5 5h14l1 8v6H4v-6z'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  plug: ['M9 3v6M15 3v6', 'M6 9h12v3a6 6 0 0 1-12 0z', 'M12 18v3'],
  check: ['M20 6 9 17l-5-5'],
  // 导航图标（与内置五视图一一对应）
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  chat: ['M21 12a8 8 0 0 1-8 8H7l-4 3v-8a8 8 0 0 1 8-8h2a8 8 0 0 1 8 5z', 'M8 11h8M8 15h5'],
  pulse: ['M3 12h4l2.5-6 4 12L16 12h5'],
  bars: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
  sliders: ['M4 7h6M14 7h6', 'M4 12h10M18 12h2', 'M4 17h3M11 17h9', 'M7 5v4', 'M15 10v4', 'M8 15v4'],
}

/** @param {keyof ICONS} name @param {string} [cls] */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  if (cls) svg.setAttribute('class', cls)
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** `text` 永远走 textContent；动态尺寸走 CSSOM（CSP 拦内联 style 属性） */
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag)
  if (opts.class) node.className = opts.class
  if (opts.text != null) node.textContent = String(opts.text)
  if (opts.title) node.title = String(opts.title)
  if (opts.type) node.type = opts.type
  if (opts.value != null) node.value = opts.value
  if (opts.hidden) node.hidden = true
  if (opts.disabled) node.disabled = true
  if (opts.style) Object.assign(node.style, opts.style)
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v != null && v !== false) node.setAttribute(k, String(v))
    }
  }
  if (opts.on) {
    for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn)
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function empty({ title = '暂无数据', hint = '', iconName = 'inbox' } = {}) {
  return el('div', { class: 'empty' }, [
    el('span', { class: 'empty-icon' }, icon(iconName)),
    el('span', { class: 'empty-title', text: title }),
    hint ? el('span', { class: 'empty-hint', text: hint }) : null,
  ])
}

/**
 * 数据表。
 * @param {{ columns: Array<{label:string,num?:boolean,clip?:boolean}>,
 *           rows: Array<Array<Node|string>>, empty?: Node,
 *           onRowClick?: ((index:number)=>void)|null }} p
 */
export function table({ columns, rows, empty: emptyNode = null, onRowClick = null }) {
  if (!rows.length) {
    return emptyNode ?? el('div', { class: 'empty' }, [el('span', { class: 'empty-title', text: '暂无数据' })])
  }
  const head = el('thead', {}, el('tr', {}, columns.map(c => el('th', { class: c.num ? 'num' : '', text: c.label }))))
  const body = el(
    'tbody',
    {},
    rows.map((cells, i) =>
      el(
        'tr',
        { class: onRowClick ? 'is-link' : '', on: onRowClick ? { click: () => onRowClick(i) } : null },
        cells.map((cell, ci) =>
          el(
            'td',
            {
              class: columns[ci]?.num ? 'num' : columns[ci]?.clip ? 'clip' : '',
              // 窄屏会把 thead 藏掉并改成卡片式布局，列名只能从这里取
              attrs: { 'data-label': columns[ci]?.label ?? '' },
            },
            [cell instanceof Node ? cell : document.createTextNode(String(cell ?? ''))],
          ),
        ),
      ),
    ),
  )
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, [head, body]))
}

/* ---------------- 声明式选项卡的四块 ---------------- */

/**
 * 渲染插件选项卡的版块。
 *
 * @param {Array<object>} blocks 服务端 `/api/tabs` 给的 layout（已校验、已序列化）
 * @param {{ onAction?: (tabId: string, actionId: string, button: HTMLElement) => Promise<void>, tabId?: string }} [opts]
 * @returns {Node[]}
 */
export function renderBlocks(blocks, { onAction = null, tabId = '' } = {}) {
  const out = []
  for (const block of blocks ?? []) {
    const node = renderBlock(block, { onAction, tabId })
    if (node) out.push(node)
  }
  return out
}

function blockShell(block, body, extra = null) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: block.title || typeLabel(block.type) }),
      el('span', { class: 'spacer' }),
      extra,
    ]),
    el('div', { class: 'panel-body' }, body),
  ])
}

function typeLabel(type) {
  return { form: '设置', table: '数据', status: '状态', actions: '操作' }[type] ?? '版块'
}

function renderBlock(block, ctx) {
  if (!block || typeof block !== 'object') return null

  if (block.type === 'form') {
    /**
     * 可编辑表单：块上带 `submit` 时才渲染输入控件。
     *
     * 不带 `submit` 就维持只读展示 —— 有些 form 块本来就只是展示（比如内核自己的
     * 只读项），全变成输入框会让"哪些能改"变模糊。
     *
     * 提交时按 `path` 把所有字段的当前值收成一个对象交给动作处理函数；
     * 后端（`tabAction`）原样透传，**插件自己调 `settings.set()` 落库**。
     * 内核不解析插件的配置结构 —— 否则每加一个插件就要改一次内核。
     */
    const editable = Boolean(block.submit) && typeof ctx.onAction === 'function'
    /** @type {Map<string, () => unknown>} path → 取值函数 */
    const getters = new Map()

    const rows = (block.fields ?? []).map(f => {
      const key = String(f.path ?? f.label ?? '')
      let control

      if (!editable) {
        control = el('span', { class: 'field-static' }, formatValue(f.value, f.type))
      } else if (f.type === 'boolean') {
        const box = el('input', { type: 'checkbox' })
        box.checked = f.value === true
        getters.set(key, () => box.checked)
        control = el('label', { class: 'field-check' }, [box])
      } else if (f.type === 'number') {
        const input = el('input', { class: 'field-input', type: 'number', value: f.value ?? '' })
        // 空串转成 0 而不是 NaN：后者 JSON 序列化成 null，插件那边会读出 null
        getters.set(key, () => {
          const n = Number(input.value)
          return Number.isFinite(n) ? n : 0
        })
        control = input
      } else {
        const input = el('input', { class: 'field-input', type: 'text', value: f.value ?? '' })
        getters.set(key, () => input.value)
        control = input
      }

      return el('div', { class: 'field-row' }, [
        el('div', { class: 'field-meta' }, [
          el('span', { class: 'field-label', text: f.label || f.path }),
          f.description ? el('span', { class: 'field-desc', text: f.description }) : null,
        ]),
        el('div', { class: 'field-control' }, [control]),
      ])
    })

    const body = rows.length ? rows.slice() : [empty({ title: '没有可展示的字段' })]

    if (editable) {
      const btn = el('button', { class: 'btn', type: 'button' }, [
        icon('check'),
        el('span', { text: block.submit.label || '保存' }),
      ])
      btn.addEventListener('click', () => {
        const values = {}
        for (const [k, get] of getters) values[k] = get()
        ctx.onAction(ctx.tabId, block.submit.id, btn, { values })
      })
      body.push(el('div', { class: 'form-actions' }, [btn]))
    }

    return blockShell(
      block,
      body,
      el('span', { class: `pill${editable ? '' : ' is-plain'}`, text: editable ? '可编辑' : '只读' }),
    )
  }

  if (block.type === 'table') {
    const columns = (block.columns ?? []).map(c => ({ label: c.label, num: Boolean(c.num) }))
    const rows = (block.rows ?? []).map(row => [].concat(row).map(cell => formatCell(cell)))
    return blockShell(
      block,
      table({ columns, rows, empty: empty({ title: block.empty || '暂无数据' }) }),
      rows.length ? el('span', { class: 'panel-sub', text: `${rows.length} 行` }) : null,
    )
  }

  if (block.type === 'status') {
    const items = (block.items ?? []).map(it =>
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'kv-key', text: it.label }),
        el('span', { class: `kv-val ${it.tone ? `is-${it.tone}` : ''}`, text: it.value }),
      ]),
    )
    return blockShell(block, items.length ? el('div', { class: 'kv-list' }, items) : empty({ title: '没有状态项' }))
  }

  if (block.type === 'actions') {
    const buttons = (block.actions ?? []).map(a =>
      el(
        'button',
        {
          class: 'btn btn-ghost',
          type: 'button',
          attrs: { 'data-action': a.id },
          on: ctx.onAction
            ? {
                click: ev => {
                  const btn = ev.currentTarget
                  // 含外部副作用的动作必须二次确认（04 §5.4）：这类按钮会改真实世界
                  if (a.confirm && !window.confirm(a.confirm)) return
                  ctx.onAction(ctx.tabId, a.id, btn)
                },
              }
            : null,
          disabled: !ctx.onAction,
        },
        [
          icon('plug'),
          a.label || a.id,
        ],
      ),
    )
    const hint = ctx.onAction ? null : el('span', { class: 'field-desc', text: '当前环境不支持执行动作' })
    return blockShell(block, [el('div', { class: 'action-row' }, buttons), hint])
  }

  return null
}

function formatValue(value, type) {
  if (value == null) return '—'
  if (type === 'boolean') return value ? '开' : '关'
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 表格单元格：只允许标量/字符串，对象走 JSON（插件不该往格子里塞复杂结构） */
function formatCell(cell) {
  if (cell == null) return '—'
  if (typeof cell === 'object') return JSON.stringify(cell)
  if (typeof cell === 'boolean') return cell ? '是' : '否'
  return String(cell)
}
