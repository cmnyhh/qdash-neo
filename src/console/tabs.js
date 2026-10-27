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
      /**
       * **同来源重注册 = 替换，不报冲突。**
       *
       * 场景：插件卸载时注册没清干净（没挂 `ctx.effect`，或被强制移除），
       * 旧选项卡还占着这个 id。重装同一个插件时若抛「已被占用」，
       * 日志里写的是它自己的名字 —— 看得出有冲突，但看不出「是它自己」，
       * 而唯一的解是重启宿主。
       *
       * 不同 owner 抢同一个 id 仍然报错：那是真的撞名，必须让人改；
       * 静默覆盖会让两个插件互相踩着对方的页面，比报错难查得多。
       *
       * `owner` 为空时不做替换：两个都没署名，没法判断是不是同一个来源。
       */
      const prevOwner = String(existing.owner ?? '')
      const nextOwner = String(desc.owner ?? '')
      if (prevOwner && prevOwner === nextOwner) {
        this.log?.(
          'warn',
          `qdash-neo: 选项卡「${id}」被同一来源（${nextOwner}）重新注册，替换旧注册`,
        )
        this.tabs.delete(id)
      } else {
        throw new TabError('tab-conflict', `选项卡 id「${id}」已被占用（${existing.owner || '未知来源'}）`, {
          conflictWith: existing.owner || '',
        })
      }
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
        const out = {
          path: String(f.path),
          label: String(f.label ?? f.path),
          type: String(f.type ?? 'string'),
          value: jsonSafe(f.value ?? null, `${where}.fields[${i}].value`, fail),
          description: String(f.description ?? ''),
        }

        /**
         * `image`：内联图片（二维码这类）。
         *
         * **只接受 `data:image/…;base64,`**，不接受 http(s) URL ——
         * 图片控件会把值直接塞进 `<img src>`，放开外链等于让插件能命令
         * 控制台去请求任意地址（探内网、打追踪像素），而这个是浏览器自动发的，
         * 用户点都不会点。
         *
         * 400KB 上限：base64 之后约 300KB 原图，二维码远远够。
         */
        if (out.type === 'image') {
          const v = String(out.value ?? '')
          /**
           * **空值是合法的**：表示"暂时没有图片"（比如二维码还没生成）。
           *
           * 早先这里没放空值，结果插件注册选项卡时直接抛 TabError ——
           * 而那个错误发生在 `apply` 里，**整个插件都不加载**，
           * 日志里只有一行 TabError，看不出是"还没生成二维码"。
           */
          /**
           * 允许 `svg+xml`：二维码这类**纯几何图形**用 SVG 生成最省事 ——
           * 不需要 PNG 编码（zlib + CRC + 分块），插件里带一个 50KB 的
           * QR 库就能本地画出来，不必求第三方转图服务（境内还经常连不上）。
           */
          if (v && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(v)) {
            fail(`${where}.fields[${i}] 的 image 值必须是 data:image/…;base64, 开头的内联图片（或空字符串）`)
          }
          if (v.length > 400_000) {
            fail(`${where}.fields[${i}] 的内联图片太大（base64 ${v.length} 字符，上限 400000）`)
          }
        }

        /**
         * `options`：下拉选项。
         *
         * **必须在这里透传**。之前只返回 path/label/type/value/description，
         * 插件写了 `options` 也会被吞掉，前端拿到的是普通文本框 ——
         * 和 `submit` 那次是同一个坑：插件侧看不出异常，因为它确实传了。
         */
        if (Array.isArray(f.options) && f.options.length > 0) {
          out.options = f.options.slice(0, 50).map((o, j) => {
            if (!isPlainObject(o) || o.value == null) {
              fail(`${where}.fields[${i}].options[${j}] 必须是 { value, label }`)
            }
            return {
              value: String(o.value),
              label: String(o.label ?? o.value),
            }
          })
        }

        /**
         * `when`：条件显示。`{ path, in: [...] }` 或 `{ path, is: ... }`。
         *
         * 只接受这两种形状：放开任意表达式等于让插件在前端跑代码，
         * 而这个能力只需要"按某个字段的值决定显示与否"。
         */
        if (isPlainObject(f.when)) {
          const wPath = String(f.when.path ?? '')
          if (!wPath) fail(`${where}.fields[${i}].when 缺少 path`)
          if (Array.isArray(f.when.in)) {
            out.when = { path: wPath, in: f.when.in.slice(0, 50).map(String) }
          } else if ('is' in f.when) {
            out.when = { path: wPath, is: String(f.when.is) }
          } else {
            fail(`${where}.fields[${i}].when 需要 in（数组）或 is（单值）`)
          }
        }

        return out
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
