import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TtsClient } from '../src/tts.js'

/**
 * 插件侧 TTS 的测试重点：
 *   1. 三种协议的请求体形状（接错一个字段 = 永远 400，而错误信息通常指不到根因）
 *   2. 缓存命中（同一句话不该重复花钱）
 *   3. 失败时抛的文案**能不能让模型自救** —— 写成 `fetch failed` 它就只会瞎试
 *   4. 端点回 200 但内容是 JSON（有些服务出错时这样）
 *
 * 发送、路径校验、限流、落库都在主框架，不在这里测。
 */

const TTS_BASE = {
  enabled: true,
  endpoint: 'http://127.0.0.1:9/tts',
  protocol: 'openai',
  format: 'mp3',
  maxChars: 20,
  cacheMaxFiles: 100,
  model: 'tts-1',
  voice: 'alloy',
}

function mkClient(over = {}, dir = '') {
  return new TtsClient({ tts: { ...TTS_BASE, ...over } }, { log: () => {}, dir })
}

function mkDir() {
  return mkdtempSync(join(tmpdir(), 'qdn-tts-'))
}

/** 临时替换全局 fetch（node:test 同文件内串行，不会串场） */
async function withFetch(fake, run) {
  const orig = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await run()
  } finally {
    globalThis.fetch = orig
  }
}

const audioOk = () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), { status: 200 })

test('TTS：三种协议的请求体形状', () => {
  const a = mkClient({ protocol: 'openai', model: 'tts-1', voice: 'alloy' }).buildRequest('你好')
  assert.equal(a.body.input, '你好')
  assert.equal(a.body.model, 'tts-1')
  assert.equal(a.body.voice, 'alloy')
  assert.equal(a.body.response_format, 'mp3')

  const b = mkClient({
    protocol: 'gpt-sovits',
    refAudioPath: '/srv/ref.wav',
    promptText: '参考文本',
    textLang: 'zh',
  }).buildRequest('你好')
  assert.equal(b.body.text, '你好')
  assert.equal(b.body.ref_audio_path, '/srv/ref.wav')
  assert.equal(b.body.prompt_text, '参考文本')
  assert.equal(b.body.text_lang, 'zh')

  const c = mkClient({ protocol: 'custom', bodyTemplate: '{"q":"{{text}}","k":1}' }).buildRequest('他说"你好"')
  // 引号必须被转义，否则模板 JSON 会被打断
  assert.equal(c.body.q, '他说"你好"')
  assert.equal(c.body.k, 1)
})

test('TTS：带 apiKey 时走 Authorization', () => {
  assert.equal(mkClient({ apiKey: 'sk-x' }).buildRequest('hi').headers.authorization, 'Bearer sk-x')
  assert.equal(mkClient({}).buildRequest('hi').headers.authorization, undefined)
})

test('TTS：custom 模板不是合法 JSON 时给出可读错误', () => {
  const c = mkClient({ protocol: 'custom', bodyTemplate: '{"q":"{{text}}"' })
  assert.throws(() => c.buildRequest('x'), /bodyTemplate 不是合法 JSON/)
})

test('TTS：同一句话第二次命中缓存，不发请求', async () => {
  const dir = mkDir()
  const c = mkClient({}, dir)
  try {
    let calls = 0
    await withFetch(
      async () => {
        calls += 1
        return audioOk()
      },
      async () => {
        assert.equal((await c.render('晚安')).cached, false)
        assert.equal((await c.render('晚安')).cached, true)
        assert.equal(calls, 1, '第二次不该再请求')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：换了音色之后同一句话要重新合成（缓存键含参数）', async () => {
  const dir = mkDir()
  try {
    const a = mkClient({ voice: 'alloy' }, dir)
    const b = mkClient({ voice: 'nova' }, dir)
    let calls = 0
    await withFetch(
      async () => {
        calls += 1
        return audioOk()
      },
      async () => {
        await a.render('晚安')
        await b.render('晚安')
        assert.equal(calls, 2, '音色不同 = 不同音频，不能复用缓存')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：服务 5xx 时给出能被模型自救的错误', async () => {
  const dir = mkDir()
  const c = mkClient({}, dir)
  try {
    await withFetch(
      async () => new Response('upstream boom', { status: 502 }),
      async () => {
        await assert.rejects(
          () => c.render('在吗'),
          err => {
            assert.match(err.message, /HTTP 502/)
            assert.match(err.message, /改用 qq_send_message/, '要让模型知道下一步该干什么')
            return true
          },
        )
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：超时也提示改用文字（不重试，重试只会更慢）', async () => {
  const dir = mkDir()
  const c = mkClient({}, dir)
  try {
    await withFetch(
      async () => {
        const err = new Error('timed out')
        err.name = 'TimeoutError'
        throw err
      },
      async () => {
        await assert.rejects(() => c.render('在吗'), /没响应.*改用/)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：端点回 200 但内容是 JSON 时不能当音频写盘', async () => {
  const dir = mkDir()
  const c = mkClient({}, dir)
  try {
    await withFetch(
      async () => new Response('{"error":"bad ref audio"}', { status: 200 }),
      async () => {
        await assert.rejects(() => c.render('在吗'), /不是音频而是 JSON/)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：超过 maxChars 直接拒，不发请求', async () => {
  const dir = mkDir()
  const c = mkClient({ maxChars: 5 }, dir)
  try {
    let called = false
    await withFetch(
      async () => {
        called = true
        return audioOk()
      },
      async () => {
        await assert.rejects(() => c.render('这句话明显超过五个字'), /超过 TTS 单次上限/)
        assert.equal(called, false, '超长就不该发请求（合成慢且按量计费）')
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：未开 / 没配 endpoint 时明确报出缺什么', async () => {
  await assert.rejects(() => mkClient({ enabled: false }).render('hi'), /TTS 未开启/)
  await assert.rejects(() => mkClient({ endpoint: '' }).render('hi'), /没配 endpoint/)
  assert.equal(mkClient({ enabled: false }).enabled, false)
  assert.equal(mkClient({ endpoint: '' }).enabled, false, '没 endpoint 等于没开')
})

test('TTS：缓存超过上限按最旧删', async () => {
  const dir = mkDir()
  const c = mkClient({ cacheMaxFiles: 2 }, dir)
  try {
    await withFetch(
      async () => audioOk(),
      async () => {
        for (const text of ['一', '二', '三']) {
          await c.render(text)
          // mtime 精度可能只到毫秒，隔开一点确保排序有意义
          await new Promise(r => setTimeout(r, 15))
        }
      },
    )
    assert.equal(readdirSync(join(dir, '.tts')).length, 2, '超出的要删掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTS：describe 暴露给控制台的信息齐全', () => {
  const d = mkClient({}).describe()
  assert.equal(d.enabled, true)
  assert.equal(d.protocol, 'openai')
  assert.equal(typeof d.cachedFiles, 'number')
})
