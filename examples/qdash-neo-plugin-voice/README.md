# qdash-neo-plugin-voice

qdash-neo 的**语音插件**：把一句话合成成语音。

它**只做主框架做不到的事**——TTS 需要外部服务。发送、路径校验、体积体检、
频率限流、`[语音] xxx` 落库全部由主框架负责，插件碰不到那些东西。

不装这个插件时，主框架的语音功能照常可用（`qq_send_voice` 发语音库里现成的音频），
只是不能"开口说"。

## 装

```bash
npm i qdash-neo-plugin-voice
```

然后在 profile 的 `cordis.patch.yml` 里加上它的 patch：

```yaml
- insert:
    - id: qq-voice
      name: 'qdash-neo-plugin-voice'
      config:
        tts:
          enabled: true
          protocol: 'openai'
          endpoint: 'http://127.0.0.1:9880/v1/audio/speech'
          model: 'tts-1'
          voice: 'alloy'
```

重启宿主。**已经建立的会话不会自动多出工具**——工具是在建会话时挂上去的，
所以要新建一个会话（或重建现有会话）才看得到 `qq_speak`。

## 三种协议

| `protocol` | 请求体 | 适合 |
|---|---|---|
| `openai` | `{model, input, voice, response_format}` | `/v1/audio/speech` 兼容的服务 |
| `gpt-sovits` | `{text, text_lang, ref_audio_path, prompt_text, prompt_lang, speed_factor}` | 本地 GPT-SoVITS 原生 `/tts` |
| `custom` | 你写的 `bodyTemplate`，`{{text}}` 被替换 | 形状奇怪的端点 |

GPT-SoVITS 的 `refAudioPath` 必须是**服务器上的绝对路径**，且文件真实存在；
`promptText` 要和那段参考音频的内容一致，否则音色会飘。

`custom` 的模板替换会先 `JSON.stringify` 再塞进去，所以文本里有引号也不会打断 JSON。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `tts.enabled` | `false` | 总开关。关着时 `qq_speak` **不注册**（挂个必然报错的工具比没有更糟） |
| `tts.endpoint` | 空 | 合成接口地址 |
| `tts.apiKey` | 空 | 可选，走 `Authorization: Bearer` |
| `tts.timeoutMs` | `30000` | 超时直接失败，不重试（重试只会更慢） |
| `tts.maxChars` | `200` | 单次字数上限，超过直接拒（合成慢且按量计费） |
| `tts.format` | `mp3` | 要回来的音频格式 |
| `tts.cacheMaxFiles` | `200` | 缓存上限，超出按最旧删 |

缓存落在主框架语音库目录的 `.tts/` 子目录，键含**音色与协议参数**——
换了音色不会复用旧音频（只按文本做键会出现"内容对、声音不对"，几乎没人会往缓存上想）。

## 它注册了什么

一个工具：`qq_speak({ text })`。

合成出文件后交给 `ctx.qdashNeo.voice.send({ chatKey, file, label, trusted: true })`，
后者走完整检查链：体积、扩展名、频率上限、`[语音] xxx` 落库。

`trusted: true` 只让它跳过"文件是否在库内"的归属校验（这是插件自己刚生成的绝对路径），
**其余检查一律不跳**。

## 测试

```bash
npm test          # 只测协议构造、缓存、超时与降级文案
```

发送与安全边界在主框架里测，不在这里重复。
