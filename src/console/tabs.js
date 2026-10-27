/**
 * 插件选项卡注册表（M3 第二阶段）。
 *
 * 设计前提（04 §0）：**插件作者零前端**。插件只交一份声明式描述，控制台负责渲染。
 * 所以这里做的全是"校验 + 保存 + 序列化"，没有任何渲染逻辑 —— 渲染在 `public/assets/blocks.js`。
 *
 * 三条硬约束：
 *   1. **id 全局唯一**。两个插件抢同名 id 时，第二个被拒，且拒绝原因要能直接贴给用户
 *      （"被 X 占用"比"注册失败"有用得多）。
 *   2. **越界即报错**。字段名/块类型写错不能静默降级成空白页 ——
 *      "装了没反应"是这个项目一路在对抗的故障形态。
 *   3. **有界**。选项卡数量上限 50；单个选项卡版块上限 20、批量数据上限 500 行。
 *      这不是洁癖：这些数据每 5 秒被前端轮询一次，无限长会拖死浏览器标签页。
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const BLOCK_TYPES = new Set(['form', 'table', 'status', 'actions'])
const MAX_TABS = 50
const MAX_BLOCKS = 20
const MAX_ROWS = 500

export class TabError extends Error {
  /**
   * @param {string} code `tab-invalid` | `tab-conflict` | `tab-not-found`
   * @param {string} message
   * @param {{ status?: number, conflictWith?: string }} [opts]
   */
  constructor(code, message, { status = 400, conflictWith = '' } = {}) {
    super(message)
    this.name = 'TabError'
    this.code = code
    this.status = status
    this.conflictWith = conflictWith
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 只保留可 JSON 化的部分：函数、循环引用在 HTTP 上没法传，必须在注册期就拦住 */
function jsonSafe(value, path, fail) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    fail(`${path} 不是可序列化的 JSON（${err?.name ?? 'Error'}）`)
    return null
  }
}

export class TabRegistry {
  /**
   * @param {{ limit?: number, log?: Function }} [deps]
   */
  constructor({ limit = MAX_TABS, log = () => {} } = {}) {
    this.limit = limit
    this.log = log
    /** @type {Map<string, { id, title, order, owner, layout, actions: Map<string, Function> }>} */
    this.tabs = new Map()
    /** @type {Set<Function>} */
    this.listeners = new Set()
  }

  /**
   * @param {{ id: string, title: string, order?: number, owner?: string, layout: object[] }} desc
   * @returns {() => void} disposer（插件 fiber 卸载时调用）
   */
  register(desc) {
    const fail = msg => {
      throw new TabError('tab-invalid', msg)
    }
    if (!isPlainObject(desc)) fail('选项卡描述必须是对象')

    const id = String(desc.id ?? '')
    if (!ID_RE.test(id)) {
      fail(`选项卡 id 非法：${JSON.stringify(desc.id ?? '')}（只允许小写字母、数字、连字符，最长 40）`)
    }

    const existing = this.tabs.get(id)
    if (existing) {
      throw new TabError('tab-conflict', `选项卡 id「${id}」已被占用（${existing.owner || '未知来源'}）`, {
        conflictWith: existing.owner || '',
      })
    }
    if (this.tabs.size >= this.limit) {
      throw new TabError('tab-invalid', `选项卡数量已达上限 ${this.limit}，拒绝注册「${id}」`)
    }

    const title = String(desc.title ?? '').trim()
    if (!title) fail(`选项卡「${id}」缺少 title`)
    if (title.length > 40) fail(`选项卡「${id}」的 title 超过 40 字`)

    const order = Number.isFinite(Number(desc.order)) ? Number(desc.order) : 100
    const layout = Array.isArray(desc.layout) ? desc.layout : []
    if (layout.length === 0) fail(`选项卡「${id}」的 layout 不能为空`)
    if (layout.length > MAX_BLOCKS) fail(`选项卡「${id}」的版块超过上限 ${MAX_BLOCKS}`)

    const actions = new Map()
    const blocks = layout.map((block, i) => this.#block(id, block, i, actions, fail))

    this.tabs.set(id, { id, title, order, owner: String(desc.owner ?? ''), layout: blocks, actions })
    this.log('info', `qdash-neo: 注册选项卡 ${id}（${blocks.length} 块）owner=${desc.owner || '未知'}`)
    this.#emit()

    return () => this.unregister(id)
  }

  /** @param {string} id */
  unregister(id) {
    if (!this.tabs.delete(id)) return false
    this.log('info', `qdash-neo: 注销选项卡 ${id}`)
    this.#emit()
    return true
  }

  /** 序列化给 `/api/tabs`：**不含** action 的处理函数 */
  list() {
    return [...this.tabs.values()]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(t => ({ id: t.id, title: t.title, order: t.order, owner: t.owner, layout: t.layout }))
  }

  get size() {
    return this.tabs.size
  }

  has(id) {
    return this.tabs.has(String(id))
  }

  /**
   * 执行选项卡里的一个 action。
   * action 的实现在注册方（插件）里，**只在服务端执行**——前端拿到的永远只是一串 id/label。
   * @param {string} tabId
   * @param {string} actionId
   * @param {unknown} payload
   */
  async run(tabId, actionId, payload) {
    const tab = this.tabs.get(String(tabId))
    if (!tab) throw new TabError('tab-not-found', `没有这个选项卡：${tabId}`, { status: 404 })
    const fn = tab.actions.get(String(actionId))
    if (!fn) throw new TabError('tab-not-found', `选项卡「${tabId}」没有动作：${actionId}`, { status: 404 })
    const result = await fn(payload)
    // 结果要回给浏览器：不可序列化时明确报错，而不是让前端收到 null 后一脸茫然
    if (result === undefined) return { ok: true }
    try {
      return { ok: true, result: JSON.parse(JSON.stringify(result)) }
    } catch (err) {
      throw new TabError('tab-invalid', `动作 ${tabId}/${actionId} 的返回值不可序列化（${err?.name ?? 'Error'}）`, {
        status: 500,
      })
    }
  }

  /** @param {Function} cb @returns {() => void} */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {}
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  clear() {
    if (this.tabs.size === 0) return
    this.tabs.clear()
    this.#emit()
  }

  #emit() {
    for (const cb of this.listeners) {
      try {
        cb(this.list())
      } catch (err) {
        // 一个监听器炸了不该影响其它监听器，但必须留痕
        this.log('error', `qdash-neo: 选项卡变更通知失败 name=${err?.name} msg=${err?.message}`, err)
      }
    }
  }

  /**
   * 校验单块。返回**可序列化**的块（action 函数被抽到 actions Map 里）。
   * @param {string} tabId
   * @param {object} block
   * @param {number} index
   * @param {Map<string, Function>} actions
   * @param {(msg: string) => never} fail
   */
  #block(tabId, block, index, actions, fail) {
    const where = `选项卡「${tabId}」第 ${index + 1} 块`
    if (!isPlainObject(block)) fail(`${where}不是对象`)
    const type = String(block.type ?? '')
    if (!BLOCK_TYPES.has(type)) {
      fail(`${where}的 type 非法：${JSON.stringify(block.type ?? '')}（允许 ${[...BLOCK_TYPES].join('/')}）`)
    }

    const title = block.title == null ? '' : String(block.title)
    if (type === 'form') {
      const fields = Array.isArray(block.fields) ? block.fields : []
      if (fields.length > MAX_ROWS) fail(`${where}的 fields 超过上限 ${MAX_ROWS}`)
      const clean = fields.map((f, i) => {
        if (!isPlainObject(f) || typeof f.path !== 'string') fail(`${where} 的第 ${i + 1} 个字段缺少 path`)
        return {
          path: String(f.path),
          label: String(f.label ?? f.path),
          type: String(f.type ?? 'string'),
          value: jsonSafe(f.value ?? null, `${where}.fields[${i}].value`, fail),
          description: String(f.description ?? ''),
        }
      })

      /**
       * 带 `submit` 的才是**可编辑**表单，不带就维持只读展示。
       *
       * **必须在这里透传**：`blocks.js` 靠 `block.submit` 决定渲染输入框还是静态文本。
       * 这一层早先只返回 `fields`，于是插件写了 `submit` 也白写 ——
       * 面板上永远显示「只读」，而插件侧完全看不出异常：
       * 它确实把 submit 传过来了，是被内核的规范化吞掉的。
       */
      const out = { type, title, fields: clean }
      if (isPlainObject(block.submit) && typeof block.submit.id === 'string' && block.submit.id.trim()) {
        out.submit = {
          id: block.submit.id.trim(),
          label: String(block.submit.label ?? '保存').trim() || '保存',
        }
      }
      return out
    }

    if (type === 'table') {
      const columns = Array.isArray(block.columns) ? block.columns : []
      if (columns.length === 0) fail(`${where}的 columns 不能为空`)
      const rows = Array.isArray(block.rows) ? block.rows.slice(0, MAX_ROWS) : []
      return {
        type,
        title,
        columns: columns.map(c => (isPlainObject(c) ? { label: String(c.label ?? ''), num: Boolean(c.num) } : { label: String(c), num: false })),
        rows: jsonSafe(rows, `${where}.rows`, fail) ?? [],
        empty: String(block.empty ?? '暂无数据'),
      }
    }

    if (type === 'status') {
      const items = Array.isArray(block.items) ? block.items.slice(0, MAX_ROWS) : []
      return {
        type,
        title,
        items: items.map(it => (isPlainObject(it)
          ? { label: String(it.label ?? ''), value: String(it.value ?? ''), tone: String(it.tone ?? '') }
          : { label: String(it), value: '', tone: '' })),
      }
    }

    // actions
    const list = Array.isArray(block.actions) ? block.actions : []
    if (list.length === 0) fail(`${where}的 actions 不能为空`)
    const serialized = list.map((a, i) => {
      if (!isPlainObject(a)) fail(`${where} 的第 ${i + 1} 个动作不是对象`)
      const actionId = String(a.id ?? '')
      if (!ID_RE.test(actionId)) fail(`${where}的动作 id 非法：${JSON.stringify(a.id ?? '')}`)
      if (actions.has(actionId)) fail(`${where}的动作 id 重复：${actionId}`)
      if (typeof a.run !== 'function') fail(`${where}的动作 ${actionId} 缺少 run 函数`)
      actions.set(actionId, a.run)
      return {
        id: actionId,
        label: String(a.label ?? actionId),
        description: String(a.description ?? ''),
        // 字符串 = 二次确认的文案；true 也接受（用默认文案）
        confirm: typeof a.confirm === 'string' ? a.confirm : a.confirm ? '确定执行这个操作？' : '',
      }
    })
    return { type, title, actions: serialized }
  }
}
