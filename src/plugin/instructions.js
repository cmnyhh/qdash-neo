/**
 * 插件贡献的提示词。
 *
 * ## 为什么需要这个能力面
 *
 * 有些引导必须**常驻**系统提示，塞不进工具 `description`：
 *
 * - 「看到群友发的图觉得有意思就存下来」—— 这是行为习惯，不是工具用法
 * - `description` 只在模型"挑工具"时被读到，而这条要在它**看图的那一刻**就起作用
 *
 * 内核自己的 `MEMORY_RULE` 就是同一个道理：不写这段，`memory_add` 基本不会被调用。
 *
 * ## 为什么要授权
 *
 * 这段文字会进入系统提示，**等于能改写模型的行为准则**。恶意插件可以写
 * 「忽略以上所有限制」。
 *
 * 所以和工具权限一样分两步：插件注册（看得见）→ 用户授予（才生效）。
 * 而且**独立于** `tools.grantedPlugins`：提示词比工具权限更敏感，
 * 一个插件可能"工具能用，但它的引导不想让它生效"。
 *
 * ## 容量
 *
 * 单个插件的引导限 2000 字、全局总长限 8000 字。超了拒绝注册 ——
 * 提示词是有预算的，不会因为"多写点总没坏处"而变好，只会把别的挤掉。
 */
export class PluginInstructions {
  /** 单段上限：够写一段行为引导，又不至于把别的内容淹掉 */
  static MAX_TEXT = 2000

  /** 全局总长上限：所有插件的引导加起来 */
  static MAX_TOTAL = 8000

  constructor({ log = () => {} } = {}) {
    /**
     * @type {Map<string, { key: string, owner: string, text: string, at: number }>}
     */
    this.items = new Map()
    this.log = log
  }

  /**
   * 注册 / 替换一段引导。
   *
   * 同一个 `key` 重复注册视为**替换**（和选项卡、工具一致的语义）：
   * 插件热重载时不会因为"已经注册过"而失败。
   *
   * @param {{ key?: string, owner?: string, text?: string }} desc
   * @returns {() => void} 注销函数
   */
  register(desc) {
    const key = String(desc?.key ?? '').trim()
    if (!key) throw new Error('插件引导缺少 key（卸载时按它移除）')

    const owner = String(desc?.owner ?? '').trim() || '未署名插件'
    const text = String(desc?.text ?? '').trim()
    if (!text) throw new Error(`插件引导「${key}」的 text 为空`)

    if (text.length > PluginInstructions.MAX_TEXT) {
      throw new Error(
        `插件引导「${key}」超过 ${PluginInstructions.MAX_TEXT} 字（当前 ${text.length}）—— ` +
          '提示词有预算，请精简到最关键的一两句',
      )
    }

    // 替换时不把旧的那段算进总量
    const others = [...this.items.values()]
      .filter(it => it.key !== key)
      .reduce((n, it) => n + it.text.length, 0)
    if (others + text.length > PluginInstructions.MAX_TOTAL) {
      throw new Error(
        `插件引导总长超过 ${PluginInstructions.MAX_TOTAL} 字（已有 ${others} + 本次 ${text.length}）—— ` +
          '请先摘掉别的插件的引导',
      )
    }

    if (this.items.has(key)) {
      this.log('warn', `qdash-neo: 插件引导「${key}」被重新注册，替换旧内容`)
    }

    this.items.set(key, { key, owner, text, at: Date.now() })

    return () => {
      const cur = this.items.get(key)
      // 只删自己那条：重新注册之后旧 disposer 不应把新的也删掉
      if (cur && cur.text === text) this.items.delete(key)
    }
  }

  /**
   * 只返回**已授权插件**的引导。
   *
   * @param {Iterable<string>} grantedOwners 授权名单（插件的 owner）
   * @returns {Array<{ owner: string, text: string }>}
   */
  granted(grantedOwners) {
    const ok = new Set([...grantedOwners].map(String))
    return [...this.items.values()]
      .filter(it => ok.has(it.owner))
      .map(it => ({ owner: it.owner, text: it.text }))
  }

  /** 控制台用：全部注册项（含未授权的，界面上要能看见并授权） */
  list() {
    return [...this.items.values()].map(it => ({ key: it.key, owner: it.owner, text: it.text }))
  }

  get size() {
    return this.items.size
  }
}
