import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * 认的音频扩展名。
 *
 * `silk` 是 QQ 原生格式（体积最小、兼容最好），`amr` 是老机型遗留，
 * 其余是常见格式 —— 网关大多会自动转码，但转不动的时候会静默退化成"文件"消息，
 * 所以这里把可接受的写在错误文案里，让模型自己换一个。
 */
const AUDIO_EXT = new Set(['.silk', '.amr', '.mp3', '.wav', '.ogg', '.flac', '.m4a'])

/**
 * 语音库：路径解析、体检、限流。
 *
 * 为什么单独成模块而不是直接塞进 `qq_send_voice` 工具：
 * **路径穿越防护和限流一旦散在调用点，很容易漏掉一处**，而漏掉的那处
 * 就是「模型能读任意本地文件」或者「一次刷十条语音」。这两件事必须只有一个入口。
 *
 * 不做 TTS：合成质量、音色一致性、外部服务依赖都是另一条产品线。这里只负责
 * 「把已有的音频文件安全地发出去」。
 */
export class VoiceLibrary {
  /**
   * @param {object} config 完整配置（读 `config.voice`）
   * @param {{ log?: Function, deliver?: Function|null }} [deps]
   *   `deliver(chatKey, segments, meta)` 由 service 注入，指向出站队列。
   *   插件不该知道队列长什么样，所以发送动作从这里进来，而不是让调用方各自传。
   */
  constructor(config = {}, { log = () => {}, deliver = null } = {}) {
    const v = config?.voice ?? {}
    this.enabled = v.enabled === true
    this.dirCfg = String(v.dir ?? '').trim()
    this.maxBytes = Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 8 * 1024 * 1024
    /**
     * 时长上限目前**只写进提示词**，不在这里校验。
     *
     * 校验需要 ffprobe（或解码器），为一条语音引入外部依赖不划算；
     * 而超长语音的实际后果只是"对方要听很久"，不是安全问题。
     * 所以保留配置项、在 tool 描述里提示模型自律。
     */
    this.maxSeconds = Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 60
    this.maxPerMinute = Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2
    this.maxPerHour = Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10
    this.allowAbsolutePath = v.allowAbsolutePath === true
    this.log = log
    /** @type {((chatKey: string, segments: object[], meta?: object) => any)|null} 出站出口 */
    this.deliver = deliver
    /** @type {Function|null} 出站钩子（见 `onSendVoice`），只允许一个 */
    this.sendHook = null
    /** chatKey → 发送时间戳[]（只保留一小时内） */
    this.sent = new Map()
  }

  /**
   * 语音库目录。
   *
   * 留空时跟随 `DSH_HOME` —— 和数据库同一个原则：换了 DSH_HOME 数据就该跟着走。
   */
  dir() {
    if (this.dirCfg) return this.dirCfg
    const home = String(process.env.DSH_HOME ?? '').trim()
    const base = home || join(homedir(), '.dsh')
    return join(base, 'qdash-voice')
  }

  /** 确保目录存在。第一次真正用语音时才建，避免装完插件就多一个空目录 */
  ensureDir() {
    const d = this.dir()
    try {
      mkdirSync(d, { recursive: true })
    } catch (err) {
      this.log('warn', `qdash-neo: 创建语音库失败 ${d} name=${err?.name} msg=${err?.message}`)
    }
    return d
  }

  /**
   * 把模型给的引用解析成绝对路径。
   *
   * 默认**只接受库内文件名**：`resolve` 之后必须仍在库目录下。
   * 这是防 prompt injection 的关键一环 —— 群友一句"发一下 /etc/passwd"，
   * 模型照做的话就变成任意文件读取（虽然发出去的是音频段，但网关会读文件）。
   *
   * @param {string} ref
   * @returns {string} 绝对路径
   */
  resolve(ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) throw new Error('音频文件名不能为空')

    if (isAbsolute(raw)) {
      if (!this.allowAbsolutePath) {
        throw new Error(
          '不接受绝对路径。请只传语音库里的文件名' +
            '（确实需要发任意路径时，在控制台打开 voice.allowAbsolutePath，但这会让模型能读本地任意文件）',
        )
      }
      if (!existsSync(raw)) throw new Error(`文件不存在：${basename(raw)}`)
      return raw
    }

    const dir = this.dir()
    const full = resolve(dir, raw)
    // 关键防线：`../..` 之类解析后必须仍在库内（`+ sep` 防 `/audio-evil` 被当成子目录）
    if (full !== dir && !full.startsWith(dir + sep)) {
      throw new Error('只能是语音库里的文件（不允许 ../ 跳出目录）')
    }
    if (!existsSync(full)) {
      const names = this.list().map(x => x.name)
      throw new Error(
        `语音库里没有「${raw}」` +
          (names.length ? `。可用：${names.slice(0, 10).join('、')}` : '（库是空的，先把音频放进语音库目录）'),
      )
    }
    return full
  }

  /**
   * 体检：扩展名 + 大小。
   *
   * @param {string} filePath
   * @returns {{ size: number, ext: string }}
   */
  inspect(filePath) {
    const ext = extname(filePath).toLowerCase()
    if (!AUDIO_EXT.has(ext)) {
      throw new Error(`不支持的音频格式「${ext || '(无扩展名)'}」，可用：${[...AUDIO_EXT].join(' ')}`)
    }
    let st
    try {
      st = statSync(filePath)
    } catch {
      throw new Error(`读不到文件：${basename(filePath)}`)
    }
    if (!st.isFile()) throw new Error('不是文件')
    if (st.size === 0) throw new Error('文件是空的')
    if (st.size > this.maxBytes) {
      const mb = (n) => (n / 1024 / 1024).toFixed(1)
      throw new Error(`文件太大：${mb(st.size)}MB，上限 ${mb(this.maxBytes)}MB`)
    }
    return { size: st.size, ext }
  }

  /**
   * 限流检查。**先查后发，发成功才 commit** ——
   * 顺序反了的话，发送失败也会占掉额度（模型改个名字重试就被自己挡死）。
   *
   * @param {string} chatKey
   */
  budget(chatKey) {
    const now = Date.now()
    const list = (this.sent.get(chatKey) ?? []).filter(t => now - t < 3600_000)
    this.sent.set(chatKey, list)
    const inMinute = list.filter(t => now - t < 60_000).length
    if (this.maxPerMinute > 0 && inMinute >= this.maxPerMinute) {
      throw new Error(`语音太频繁：每分钟最多 ${this.maxPerMinute} 条`)
    }
    if (this.maxPerHour > 0 && list.length >= this.maxPerHour) {
      throw new Error(`语音太频繁：每小时最多 ${this.maxPerHour} 条`)
    }
  }

  /** @param {string} chatKey */
  commit(chatKey) {
    const list = this.sent.get(chatKey) ?? []
    list.push(Date.now())
    this.sent.set(chatKey, list)
  }

  /**
   * 库里有什么（给控制台和"可用文件"提示用）。
   * @returns {{ name: string, size: number, mtime: number }[]}
   */
  list() {
    const dir = this.dir()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return [] // 目录不存在 = 空库，不是错误
    }
    return entries
      .filter(e => e.isFile() && AUDIO_EXT.has(extname(e.name).toLowerCase()))
      .map(e => {
        const st = statSync(join(dir, e.name))
        return { name: e.name, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200)
  }

  /**
   * 注册出站钩子：在语音真正发出**之前**改写它。
   *
   * 只允许挂一个。多个钩子串起来会变成"谁后注册谁说了算"，
   * 而晚注册的那个往往只是碰巧加载得慢 —— 排查起来是噩梦。
   *
   * 钩子签名 `({ chatKey, file, label }) => ({ file?, label? } | null)`：
   *   - 返回对象 → 用返回值里的字段覆盖
   *   - 返回 null / undefined → 原样发送
   *   - 抛错 → 记 warn 后**原样发送**（钩子坏了不该连话都发不出去）
   *
   * @param {(req: { chatKey: string, file: string, label: string }) => any} fn
   * @returns {() => void} 取消注册
   */
  onSendVoice(fn) {
    if (typeof fn !== 'function') throw new Error('onSendVoice 需要一个函数')
    if (this.sendHook) throw new Error('onSendVoice 只能挂一个（已有插件占用）')
    this.sendHook = fn
    return () => {
      if (this.sendHook === fn) this.sendHook = null
    }
  }

  /**
   * 发一条语音。**这是语音唯一的出口** —— 内核工具和插件都走这里。
   *
   * 顺序是固定的，不能换：
   *   - `budget()` 在**发送前**查（发不出去就不该占额度）
   *   - `commit()` 在**发送成功后**（失败占额度会让调用方改个名字重试都被自己挡死）
   *
   * @param {{ chatKey: string, file: string, label?: string, trusted?: boolean }} req
   *   `file` 是库内文件名（默认）或绝对路径（`trusted: true` 时）
   *   `trusted` **只跳过路径归属校验**（插件给的是自己刚合成的绝对路径），
   *   体检、限流、落库一律照旧。它不暴露给模型侧工具 —— 否则就是个任意文件读取的口子。
   * @returns {Promise<{ file: string, label: string, result: any }>}
   */
  async send({ chatKey, file, label, trusted = false }) {
    if (!this.enabled) throw new Error('语音功能未开启（控制台 → 语音库 → 打开开关）')
    if (typeof this.deliver !== 'function') throw new Error('出站队列未就绪')

    const ref = String(file ?? '').trim()
    if (!ref) throw new Error('音频文件不能为空')

    this.budget(chatKey)

    let target
    if (trusted) {
      // 只验"文件存在"，不验"是不是库里的"——调用方是可信代码（插件）
      if (!existsSync(ref)) throw new Error(`音频文件不存在：${basename(ref)}`)
      target = ref
    } else {
      target = this.resolve(ref)
    }
    // 无论哪条来源，体积与格式检查都不能跳
    this.inspect(target)

    /**
     * 落库标签：`[语音] <说了什么>`。
     *
     * 不能留空（控制台一片空白），不能放段数组（`String([{}])` 会变成
     * `[object Object]` 进上下文），也不能放裸路径（把本机目录写进模型可见的历史）。
     */
    const shown = String(label ?? '').trim() || basename(target)

    /**
     * 出站钩子：插件可以在真正发出前改写（比如换成合成音频）。
     * 钩子抛错一律按"没挂钩子"处理 —— 它可能是第三方代码，不该连累发送。
     */
    let outFile = target
    let outLabel = shown
    if (typeof this.sendHook === 'function') {
      try {
        const r = await this.sendHook({ chatKey, file: target, label: shown })
        if (r && typeof r === 'object') {
          if (typeof r.file === 'string' && r.file.trim()) outFile = r.file.trim()
          if (typeof r.label === 'string' && r.label.trim()) outLabel = r.label.trim()
        }
      } catch (err) {
        this.log(
          'warn',
          `qdash-neo: 出站钩子抛错，按原样发送 name=${err?.name} msg=${err?.message}`,
        )
      }
    }
    // 改写后的文件同样要过体检：钩子不能成为绕过体积/格式检查的口子
    if (outFile !== target) {
      if (!existsSync(outFile)) throw new Error(`钩子返回的音频文件不存在：${basename(outFile)}`)
      this.inspect(outFile)
    }

    const tag = `[语音] ${outLabel}`
    const result = await this.deliver(chatKey, [{ type: 'record', data: { file: outFile } }], { text: tag })
    this.commit(chatKey)
    return { file: outFile, label: outLabel, result }
  }

  /** 分条格式（控制台用） */
  describe() {
    const dir = this.dir()
    const files = this.list()
    return {
      enabled: this.enabled,
      dir,
      files,
      limits: {
        maxBytes: this.maxBytes,
        maxSeconds: this.maxSeconds,
        maxPerMinute: this.maxPerMinute,
        maxPerHour: this.maxPerHour,
        allowAbsolutePath: this.allowAbsolutePath,
      },
    }
  }
}
