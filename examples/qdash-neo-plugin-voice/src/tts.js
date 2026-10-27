import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `format` 到文件扩展名的映射。opus 用 .ogg：QQ 侧的 record 段按容器认，不看后缀名 */
const EXT_BY_FORMAT = { mp3: '.mp3', wav: '.wav', ogg: '.ogg', opus: '.ogg', silk: '.silk' }

/** 单次合成结果的体积上限：超过说明不是正常音频（多半是返回了一大段 JSON 错误） */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

const PROTOCOLS = ['openai', 'gpt-sovits', 'custom']

/**
 * 文本 → 音频文件。
 *
 * 三种协议各自拼请求体，但出口只有一个：**一个磁盘上的音频路径**。
 * 它只负责"造出一个文件"，安全边界不在这里 —— 路径校验、体积体检、发送限流
 * 都由主框架的 `voice.send()` 统一做。插件绕不过去，也不该各写一遍。
 *
 * 缓存按内容哈希落盘：同一句话第二次直接命中，省一次合成成本和 2~8 秒延迟。
 */
export class TtsClient {
  /**
   * @param {object} config 插件配置（读 `config.tts`）
   * @param {{ log?: Function, dir?: string }} [deps]
   *   `dir` 是主框架的语音库目录（缓存放它的 `.tts/` 子目录）。
   *   由调用方从 `ctx.qdashNeo.voice.dir()` 传入，避免两边各推一遍目录规则 ——
   *   换了 `DSH_HOME` 之后一个写对一个写错是最难查的一类问题。
   */
  constructor(config = {}, { log = () => {}, dir = '' } = {}) {
    const t = config?.tts ?? {}
    this.conf = {
      enabled: t.enabled === true,
      protocol: PROTOCOLS.includes(t.protocol) ? t.protocol : 'openai',
      endpoint: String(t.endpoint ?? '').trim(),
      apiKey: String(t.apiKey ?? '').trim(),
      timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : 30000,
      maxChars: Number(t.maxChars) > 0 ? Number(t.maxChars) : 200,
      format: String(t.format ?? 'mp3').trim() || 'mp3',
      cacheMaxFiles: Number(t.cacheMaxFiles) >= 0 ? Number(t.cacheMaxFiles) : 200,

      model: String(t.model ?? 'tts-1').trim(),
      voice: String(t.voice ?? 'alloy').trim(),

      refAudioPath: String(t.refAudioPath ?? '').trim(),
      promptText: String(t.promptText ?? '').trim(),
      promptLang: String(t.promptLang ?? 'zh').trim(),
      textLang: String(t.textLang ?? 'zh').trim(),
      speedFactor: Number(t.speedFactor) > 0 ? Number(t.speedFactor) : 1,

      bodyTemplate: String(t.bodyTemplate ?? '').trim() || '{"text":"{{text}}"}',
    }
    this.dir = String(dir ?? '').trim()
    this.log = log
  }

  /** 开了且配了地址才算可用 —— 只有 `enabled: true` 但没 endpoint 时，调它必然失败 */
  get enabled() {
    return this.conf.enabled && Boolean(this.conf.endpoint)
  }

  get protocol() {
    return this.conf.protocol
  }

  /** 缓存目录（不存在则建） */
  cacheDir() {
    const d = join(this.dir || '.', '.tts')
    try {
      mkdirSync(d, { recursive: true })
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-voice: 创建 TTS 缓存目录失败 ${d} name=${err?.name} msg=${err?.message}`)
    }
    return d
  }

  /**
   * 缓存键。
   *
   * **必须把音色和协议参数也算进去**：换了音色之后同一句话应该是新的音频，
   * 只按文本做键会让它一直播放旧音色，而且极难察觉（内容是对的，声音不对）。
   */
  cacheKey(text) {
    const c = this.conf
    const sig = [
      c.protocol,
      c.endpoint,
      c.format,
      c.model,
      c.voice,
      c.refAudioPath,
      c.promptText,
      c.promptLang,
      c.textLang,
      String(c.speedFactor),
      c.bodyTemplate,
      text,
    ].join('\u0001')
    return createHash('sha1').update(sig).digest('hex').slice(0, 24)
  }

  /**
   * 按协议拼请求。
   *
   * @param {string} text
   * @returns {{ headers: Record<string,string>, body: object }}
   */
  buildRequest(text) {
    const c = this.conf
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`

    if (c.protocol === 'openai') {
      return {
        headers,
        body: {
          model: c.model,
          input: text,
          voice: c.voice,
          response_format: c.format,
        },
      }
    }

    if (c.protocol === 'gpt-sovits') {
      return {
        headers,
        body: {
          text,
          text_lang: c.textLang,
          ref_audio_path: c.refAudioPath,
          prompt_text: c.promptText,
          prompt_lang: c.promptLang,
          speed_factor: c.speedFactor,
        },
      }
    }

    /**
     * custom：把 `{{text}}` 换进去再解析。
     *
     * 替换前先 `JSON.stringify` 再切掉首尾引号 —— 直接拼原文的话，
     * 文本里出现一个引号就会把模板 JSON 结构打断，报的错还跟引号毫无关系。
     */
    const escaped = JSON.stringify(text).slice(1, -1)
    const raw = c.bodyTemplate.split('{{text}}').join(escaped)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Error('TTS 的 bodyTemplate 不是合法 JSON（检查 {{text}} 两边的引号是否成对）')
    }
    return { headers, body }
  }

  /**
   * 合成一段语音。
   *
   * 失败时抛的文案是**给模型看的行动指引**，不是给开发者看的堆栈摘要 ——
   * 它读到"改用 qq_send_message 把这句话写出来"才有办法自救；
   * 读到 `fetch failed` 只会换一种方式再试一次。
   *
   * @param {string} text
   * @returns {Promise<{ file: string, cached: boolean }>}
   */
  async render(text) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('要合成的文本是空的')
    if (!this.conf.enabled) throw new Error('TTS 未开启（在插件的 config 里设 tts.enabled: true）')
    if (!this.conf.endpoint) throw new Error('TTS 没配 endpoint（插件的 config 里的 tts.endpoint）')
    if (body.length > this.conf.maxChars) {
      throw new Error(
        `这段有 ${body.length} 字，超过 TTS 单次上限 ${this.conf.maxChars} 字；` +
          '这么长请直接用 qq_send_message 发文字',
      )
    }

    const ext = EXT_BY_FORMAT[this.conf.format] ?? '.mp3'
    const file = join(this.cacheDir(), `${this.cacheKey(body)}${ext}`)
    if (existsSync(file)) {
      try {
        if (statSync(file).size > 0) return { file, cached: true }
      } catch {
        /* 读不到就当没命中，重新合成 */
      }
    }

    const req = this.buildRequest(body)
    let res
    try {
      res = await fetch(this.conf.endpoint, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(this.conf.timeoutMs),
      })
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      throw new Error(
        `TTS ${timedOut ? `${Math.round(this.conf.timeoutMs / 1000)} 秒没响应` : '连不上服务'}，` +
          '这句改用 qq_send_message 发文字吧',
      )
    }

    if (!res.ok) {
      // 错误体常含关键信息（比如"参考音频不存在"），截一段带上，别让模型盲猜
      const detail = await res.text().catch(() => '')
      const brief = detail.replace(/\s+/g, ' ').trim().slice(0, 120)
      throw new Error(
        `TTS 返回 HTTP ${res.status}${brief ? `（${brief}）` : ''}，这句改用 qq_send_message 发文字吧`,
      )
    }

    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) throw new Error('TTS 返回了空内容，这句改用 qq_send_message 发文字吧')
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new Error(`TTS 返回的内容过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB），改用文字`)
    }
    /**
     * 有些端点在出错时也回 200，body 是一段 JSON。
     * 直接写盘会得到一个"音频文件"，发出去在 QQ 里表现是加载失败 ——
     * 那种失败最难查（工具没报错、日志没异常），所以这里先认一下头。
     */
    const head = bytes.subarray(0, 1).toString('utf8')
    if (head === '{' || head === '[') {
      const brief = bytes.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
      throw new Error(`TTS 返回的不是音频而是 JSON（${brief}），检查 endpoint 与协议是否匹配`)
    }

    try {
      writeFileSync(file, bytes)
    } catch (err) {
      throw new Error(`TTS 音频写盘失败（${err?.message ?? err}），这句改用文字发吧`)
    }
    this.pruneCache()
    this.log('info', `qdash-neo-plugin-voice: TTS 合成完成 ${bytes.length} 字节（${this.conf.protocol}/${this.conf.format}）`)
    return { file, cached: false }
  }

  /** 缓存淘汰：超出上限按 mtime 删最旧的。失败不影响使用 */
  pruneCache() {
    const max = this.conf.cacheMaxFiles
    if (!(max > 0)) return
    const dir = join(this.dir || '.', '.tts')
    let entries
    try {
      entries = readdirSync(dir)
        .map(name => {
          const p = join(dir, name)
          try {
            return { p, mtime: statSync(p).mtimeMs }
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return
    }
    for (const f of entries.slice(max)) {
      try {
        rmSync(f.p, { force: true })
      } catch {
        /* 删不掉就下次再删 */
      }
    }
  }

  /** 控制台/状态用 */
  describe() {
    let cachedFiles = 0
    try {
      cachedFiles = readdirSync(join(this.dir || '.', '.tts')).length
    } catch {
      cachedFiles = 0
    }
    return {
      enabled: this.enabled,
      protocol: this.conf.protocol,
      endpoint: this.conf.endpoint,
      format: this.conf.format,
      maxChars: this.conf.maxChars,
      cachedFiles,
    }
  }
}
