import { isDenied } from '../tools/catalog.js'
import { JSON_OUTPUT } from '../tools/index.js'

/**
 * 插件工具注册表。
 *
 * 插件通过 `ctx.qdashNeo.tools.register()` 把自己的工具登记进来，
 * 内核在**每次建立会话**时把它们注册到 agent 的工具作用域里。
 *
 * 为什么不直接让插件拿 `tools.register`：那是会话级的对象，插件根本碰不到 ——
 * 会话由内核创建，插件只知道自己是"进程里的一个东西"。
 * 所以走"全局登记 → 会话时挂载"这条路。
 *
 * 三条边界：
 *   1. **高危名单拒绝**：`isDenied()` 命中的名字一律不收（`bash` / `exec` 那类）
 *   2. **插件之间重名拒绝**：后来的那个报错，不静默覆盖
 *   3. **内核工具优先**：同名时内核赢，判定在 `applyToolPolicy` 里做（注册表不知道内核有哪些工具）
 */
export class PluginToolRegistry {
  /** @param {{ log?: Function }} [deps] */
  constructor({ log = () => {} } = {}) {
    this.log = log
    /** @type {Map<string, { def: object, owner: string }>} */
    this.items = new Map()
  }

  /**
   * 注册一个插件工具。
   *
   * @param {{
   *   name: string,
   *   description: string,
   *   params?: Record<string, string>,
   *   output?: object,
   *   owner?: string,
   *   execute: (args: object, ctx: object) => any,
   * }} desc
   * @returns {() => void} disposer，插件卸载时调用（重复调用无害）
   */
  register(desc) {
    const name = String(desc?.name ?? '').trim()
    if (!name) throw new Error('插件工具必须有 name')
    if (typeof desc?.execute !== 'function') {
      throw new Error(`插件工具「${name}」缺少 execute 函数`)
    }
    const owner = String(desc?.owner ?? '未署名插件').trim() || '未署名插件'

    /**
     * 高危名单在**注册期**就拦，而不是等 dispatch 期。
     *
     * 放到后面再拦的话，插件会以为自己注册成功了（`list()` 里也有），
     * 直到模型调用才报错 —— 而那时排查的人看的是工具调用日志，不会想到注册这一步。
     */
    if (isDenied(name)) {
      throw new Error(`插件工具名「${name}」命中内核高危名单，拒绝注册`)
    }

    /**
     * 同来源重注册 = 替换，不报冲突。
     *
     * 和 `TabRegistry#register` 同一个理由：插件卸载时注册没清干净的话，
     * 重装同名工具会撞上自己留下的那份，报「已被 xxx 注册」——
     * 而 xxx 就是它自己，唯一的解是重启宿主。
     *
     * 不同 owner 同名仍然报错：那是真撞名。
     */
    const exist = this.items.get(name)
    if (exist) {
      if (String(exist.owner) === owner) {
        this.log?.('warn', `qdash-neo: 插件工具「${name}」被同一来源（${owner}）重新注册，替换旧注册`)
        this.items.delete(name)
      } else {
        throw new Error(`插件工具「${name}」已被 ${exist.owner} 注册`)
      }
    }

    const properties = {}
    for (const [key, text] of Object.entries(desc.params ?? {})) {
      properties[key] = { type: 'string', description: String(text) }
    }

    const log = this.log

    // 与内核 `tool()` 产出完全同形，模型侧看不出差别
    const def = {
      name,
      description: String(desc.description ?? ''),
      parameters: { type: 'object', properties, additionalProperties: false },
      output: desc.output ?? JSON_OUTPUT,
      async execute(args, exec) {
        const started = Date.now()
        try {
          return await desc.execute(args ?? {}, exec ?? {})
        } finally {
          log('info', `qdash-neo: 插件工具 ${name} ${Date.now() - started}ms`)
        }
      },
    }

    this.items.set(name, { def, owner })

    /**
     * 这句提示是必要的：工具是在**建立会话**时挂上去的，
     * 已经存在的会话不会因为插件加载而多出工具。不说的话，用户会以为插件没生效。
     */
    this.log('info', `qdash-neo: 插件工具「${name}」已登记（来源：${owner}），对**新建会话**生效`)

    return () => {
      // 只删自己那一份：后注册的同名工具（理论上不会存在）不该被前一个的 disposer 删掉
      const cur = this.items.get(name)
      if (cur && cur.owner === owner) this.items.delete(name)
    }
  }

  /**
   * 归一化后的工具定义（给 `applyToolPolicy` 挂载用）。
   *
   * 带上 `owner`：挂载时要按插件名过滤（白名单）（`tools.grantedPlugins`），
   * 只给一份 `defs()` 而不带来源的话，那个过滤就没法做。
   * DSH 的 `tools.register` 会忽略不认识的字段，多这一个没影响。
   */
  defs() {
    return [...this.items.values()].map(v => ({ ...v.def, owner: v.owner }))
  }

  /** @param {string} name */
  has(name) {
    return this.items.has(String(name ?? ''))
  }

  /** 状态/文档用 */
  list() {
    return [...this.items.values()].map(v => ({
      name: v.def.name,
      owner: v.owner,
      description: v.def.description,
    }))
  }

  get size() {
    return this.items.size
  }
}
