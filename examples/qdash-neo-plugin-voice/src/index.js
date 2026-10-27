import Schema from '@deepseek-ai/schemastery'

import { TtsClient } from './tts.js'

/**
 * 语音插件：把一句话合成成语音。
 *
 * **它只做主框架做不了的事**（TTS 需要外部服务）。发送、路径校验、体积体检、
 * 频率限流、`[语音] xxx` 落库全部由主框架的 `ctx.qdashNeo.voice.send()` 负责 ——
 * 插件只产出一个音频文件，其余什么都碰不到。
 *
 * 不装这个插件时主框架的语音功能照常可用（`qq_send_voice` 发语音库里现成的音频）。
 */

export const name = 'qdash-neo-plugin-voice'

/** 只声明需要的能力：拿服务、注册工具 */
export const inject = ['qdashNeo']

export const Config = Schema.object({
  tts: Schema.object({
    enabled: Schema.boolean().default(false).description('允许把文字合成语音（默认关）'),
    protocol: Schema.union(['openai', 'gpt-sovits', 'custom'])
      .default('openai')
      .description('接口形状：openai = /v1/audio/speech 兼容 / gpt-sovits = 原生 /tts / custom = 自己填 body 模板'),
    endpoint: Schema.string()
      .default('')
      .description('合成接口地址，如 http://127.0.0.1:9880/v1/audio/speech'),
    apiKey: Schema.string().role('secret').default('').description('可选，会以 Authorization: Bearer 发送'),
    timeoutMs: Schema.natural()
      .default(30000)
      .description('单次合成超时；超时直接失败（不重试），让模型改用文字说同样的话'),
    maxChars: Schema.natural()
      .default(200)
      .description('单次合成最多多少字；超过直接拒（合成慢、按量计费，长文本没意义）'),
    format: Schema.string().default('mp3').description('要回来的音频格式：mp3 / wav / opus / silk'),
    cacheMaxFiles: Schema.natural()
      .default(200)
      .description('合成缓存最多保留多少个文件，超出按最旧的删；同一句话不会重复合成'),

    model: Schema.string().default('tts-1').description('[openai] 模型名'),
    voice: Schema.string().default('alloy').description('[openai] 音色名'),

    refAudioPath: Schema.string()
      .default('')
      .description('[gpt-sovits] 参考音频在服务器上的绝对路径，必须真实存在'),
    promptText: Schema.string()
      .default('')
      .description('[gpt-sovits] 参考音频对应的文字（要与音频内容一致，否则音色会飘）'),
    promptLang: Schema.string().default('zh').description('[gpt-sovits] 参考音频的语言'),
    textLang: Schema.string().default('zh').description('[gpt-sovits] 要合成的文本语言'),
    speedFactor: Schema.number().default(1).description('[gpt-sovits] 语速倍率，1 = 原速'),

    bodyTemplate: Schema.string()
      .default('{"text":"{{text}}"}')
      .description('[custom] 请求体 JSON 模板，`{{text}}` 会被替换成要说的内容'),
  }).description('TTS：把文字合成语音（默认关）'),
}).description('语音插件配置')

export function apply(ctx, config) {
  const neo = ctx.qdashNeo
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}

  /**
   * 主框架版本不匹配时**直接退出并说明原因**。
   * 「插件装了没反应」是最难查的一类问题：没有报错、页面也没变化。
   */
  if (!neo?.tools?.register) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 tools.register（qdash-neo 版本太旧？），已跳过')
    return
  }
  if (!neo?.voice?.send) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 voice.send，已跳过')
    return
  }
  if (!neo?.console?.registerTab) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 console.registerTab，控制台选项卡将不可用')
  }

  // 缓存目录跟主框架的语音库走：两边各推一遍规则，换 DSH_HOME 后必然一个写对一个写错
  const tts = new TtsClient(config ?? {}, { log, dir: neo.voice.dir?.() ?? '' })

  /* ---------------- 工具 ---------------- */

  /**
   * TTS 没开启就**不注册工具**。
   *
   * 挂一个必然报错的工具比没有更糟：模型会调一次、读错误、换个说法再调一次，
   * 一整轮就这么没了 —— 而它本来可以直接打字。
   */
  if (tts.enabled) {
    neo.tools.register({
      name: 'qq_speak',
      owner: name,
      description:
        '把一句话合成成语音发到当前会话。**语音是"语气比字面更重要"时才用的东西**：' +
        '一两句就说完、情绪明显、或者懒得打字。说正事、内容偏长、群里人多的时候，' +
        '用 qq_send_message 打字更合适。文本不宜过长（合成慢且按量计费）。',
      params: { text: '要合成成语音的文字，尽量短' },
      async execute(args, exec) {
        const text = String(args?.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const chatKey = String(exec?.chatKey ?? '').trim()
        if (!chatKey) throw new Error('拿不到会话标识（主框架未注入 chatKey）')

        // 只负责"造出文件"，发送与全部检查都交给主框架
        const { file } = await tts.render(text)
        await neo.voice.send({ chatKey, file, label: text, trusted: true })
        return { ok: true, spoke: text }
      },
    })
    log('info', 'qdash-neo-plugin-voice: 已注册工具 qq_speak（对新建会话生效）')
  } else {
    log('info', 'qdash-neo-plugin-voice: TTS 未开启，qq_speak 不注册')
  }

  /* ---------------- 控制台选项卡 ---------------- */

  if (!neo.console?.registerTab) return

  let dispose = null
  const mb = n => (Number(n) / 1024 / 1024).toFixed(1)

  const snapshot = () => {
    try {
      return { voice: neo.voice.describe?.() ?? null, tts: tts.describe() }
    } catch (err) {
      log('warn', `qdash-neo-plugin-voice: 读状态失败 name=${err?.name} msg=${err?.message}`)
      return { voice: null, tts: tts.describe() }
    }
  }

  const build = () => {
    const s = snapshot()
    const v = s.voice
    const files = v?.files ?? []

    return {
      id: 'voice',
      title: '语音库',
      order: 50,
      owner: name,
      layout: [
        {
          type: 'status',
          title: '状态',
          items: [
            { label: '语音功能', value: v?.enabled ? '已开启' : '未开启', tone: v?.enabled ? 'ok' : 'warn' },
            { label: '目录', value: v?.dir ?? '(未就绪)' },
            { label: '音频文件', value: `${files.length} 个`, tone: files.length ? 'ok' : 'warn' },
            {
              label: 'TTS',
              value: s.tts.enabled ? `${s.tts.protocol}` : '未开启',
              tone: s.tts.enabled ? 'ok' : 'warn',
            },
            { label: '合成缓存', value: `${s.tts.cachedFiles} 个` },
          ],
        },
        {
          type: 'table',
          title: '库里有什么',
          columns: [{ label: '文件' }, { label: '大小', num: true }, { label: '修改时间' }],
          rows: files
            .slice(0, 50)
            .map(f => [f.name, `${mb(f.size)}MB`, new Date(f.mtime).toLocaleString('zh-CN', { hour12: false })]),
          empty: '语音库是空的 —— 把 .mp3 / .silk 放进上面的目录，再点「刷新列表」',
        },
        {
          type: 'form',
          title: 'TTS 配置（只读，改在插件的 cordis.patch.yml 里）',
          fields: [
            { path: 'tts.enabled', label: 'TTS 开关', type: 'string', value: s.tts.enabled ? '开' : '关' },
            { path: 'tts.protocol', label: '协议', type: 'string', value: s.tts.protocol },
            { path: 'tts.endpoint', label: '接口地址', type: 'string', value: s.tts.endpoint || '(未配置)' },
            { path: 'tts.format', label: '音频格式', type: 'string', value: s.tts.format },
            { path: 'tts.maxChars', label: '单次字数上限', type: 'string', value: String(s.tts.maxChars) },
          ],
        },
        {
          type: 'actions',
          actions: [
            {
              id: 'refresh',
              label: '刷新列表',
              run: async () => {
                registry()
                return { ok: true, message: `已重新读取，共 ${(snapshot().voice?.files ?? []).length} 个文件` }
              },
            },
          ],
        },
      ],
    }
  }

  const registry = () => {
    try {
      dispose?.()
    } catch {
      /* 旧 disposer 抛错不该挡住重新注册 */
    }
    dispose = neo.console.registerTab(build())
  }

  registry()
}
