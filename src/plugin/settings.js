/**
 * 插件运行层配置。
 *
 * 和「插件自己的 patch config」的分工：
 *   - patch config（`cordis.patch.yml` 的 `config:`）是**部署方**给的，改要重启
 *   - 这里注册的是**运行时**配置，用户能在控制台改、立即生效
 *
 * 两份都要存在的原因很实际：`voice.tts.endpoint` 这类东西属于部署方（改一次就不动），
 * 而「今天要不要开语音」属于用户（随时可能改）。硬塞进同一层，
 * 要么用户改不了，要么部署方每次都被覆盖。
 *
 * 命名空间用 `cfg:<插件名>:<key>`，和内核自己的 `cfg:*` 隔开 —— 插件不能覆盖
 * `cfg:policy.*` 这类内核配置，只能读写自己那一份。
 */

/** 插件名规则，和 storage 保持一致 */
const NS_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** key 规则：字母/数字/下划线/点，最长 64 */
const KEY_RE = /^[a-z0-9_.]{1,64}$/i

export class PluginSettings {
  /**
   * @param {{ getStore?: () => object|null, store?: object|null, log?: Function }} deps
   */
  constructor({ getStore = null, store = null, log = () => {} } = {}) {
    this.getStore = getStore ?? (() => store)
    this.log = log
  }

  get store() {
    try {
      return this.getStore()
    } catch {
      return null
    }
  }

  /**
   * 注册一份插件配置。
   *
   * @param {{
   *   key: string,
   *   plugin?: string,
   *   schema?: (value: object) => object,
   *   defaults?: object,
   * }} opts
   *   `schema` 是 schemastery 对象（可调用）。传了就会在每次读取时校验并补默认值；
   *   不传则原样返回合并结果。
   * @returns {{ key: string, get: () => object, set: (patch?: object) => object, reset: () => void }}
   */
  register({ key, plugin = 'unknown', schema = null, defaults = {} } = {}) {
    const k = String(key ?? '').trim()
    // 不转小写：命名空间是标识符，大小写混用应当报错而不是被悄悄归一
    const p = String(plugin ?? '').trim()

    if (!KEY_RE.test(k)) throw new Error(`settings.register 的 key「${k}」不合法：只允许字母数字下划线点，最长 64`)
    if (!NS_RE.test(p)) throw new Error(`settings.register 的插件名「${plugin}」不合法：只允许小写字母开头、a-z0-9_`)

    const ns = `${p}:${k}`
    const storageKey = `cfg:${ns}`

    const load = () => {
      const s = this.store
      if (!s?.kvGet) return {}
      const raw = s.kvGet(storageKey)
      if (!raw) return {}
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        // 被手工改坏了就当没存过，别让插件因为一个畸形值起不来
        this.log('warn', `qdash-neo: 插件配置 ${ns} 解析失败，按默认值处理`)
        return {}
      }
    }

    /**
     * 读。
     *
     * `schema(merged)` 是 schemastery 的校验入口：它会补齐缺失的默认值、
     * 拒绝类型错误。所以读出来的总是**完整且合法**的对象，
     * 插件不用自己兜 `undefined`。
     */
    const get = () => {
      const merged = { ...defaults, ...load() }
      if (typeof schema !== 'function') return merged
      try {
        return schema(merged)
      } catch (err) {
        this.log('warn', `qdash-neo: 插件配置 ${ns} 校验失败，退回默认值（${err?.message ?? err}）`)
        return typeof schema === 'function' ? schema({}) : merged
      }
    }

    /**
     * 写（增量合并）。
     *
     * 写完立刻回读校验：非法值应该在**写入这一步**就报错，
     * 而不是等到插件下次读的时候才炸 —— 那时用户早已忘了自己改过什么。
     */
    const set = patch => {
      const s = this.store
      if (!s?.kvSet) throw new Error('存储未就绪')
      const merged = { ...get(), ...(patch ?? {}) }
      const next = typeof schema === 'function' ? schema(merged) : merged
      s.kvSet(storageKey, JSON.stringify(next))
      return next
    }

    /** 清掉所有覆盖，回到默认值 */
    const reset = () => {
      this.store?.kvDel?.(storageKey)
      return get()
    }

    return { key: ns, get, set, reset }
  }
}
