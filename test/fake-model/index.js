/**
 * qdn-fake-model —— 只为跑通链路存在的假 LLM provider（**测试件，不进产品代码**）。
 *
 * 本机没有 LLM key，真模型调不了。它做三件事：
 *   1. 注册一个假 provider，让 agent 能真的跑完一轮（入站 → followup → 出站 → QQ）
 *   2. 看到 `[[JUDGE]]` 标记时**回判定 JSON**，这样 `groupTrigger=judge` 的群场景能被脚本控制
 *   3. 可选把收到的 prompt 摘要写进 `QDN_FAKE_LOG`，让集成测试能断言「上下文真的拼进去了」
 *
 * 环境变量：
 *   QDN_JUDGE_MODE = reply（默认）| silent | garbage | error | timeout
 *   QDN_FAKE_LOG   = JSONL 输出路径（不设则不写）
 *
 * 它不做工具调用，所以验的是**接线与判定编排**，不是模型质量。
 */
import { appendFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'qdn-fake-model'
export const inject = ['llm']

const PROVIDER = 'qdn-fake'
const MODEL = 'fake-1'
const JUDGE_MARK = '[[JUDGE]]'
const ANSWER = '［假模型］收到，QQ → DSH → QQ 这条链路是通的。'

const MODE = process.env.QDN_JUDGE_MODE || 'reply'
const LOG_PATH = process.env.QDN_FAKE_LOG || ''

function findHostPackage(pkg) {
  for (const argvPath of process.argv.slice(1)) {
    let dir = dirname(argvPath)
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'node_modules', pkg)
      const pkgJson = join(candidate, 'package.json')
      if (existsSync(pkgJson)) {
        try {
          return pathToFileURL(createRequire(pkgJson).resolve(pkg)).href
        } catch {
          return pathToFileURL(join(candidate, 'lib', 'index.js')).href
        }
      }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  throw new Error(`qdn-fake-model: 找不到 ${pkg}`)
}

const dshLlm = await import(findHostPackage('@deepseek-ai/dsh-llm'))

/** 判定回复：整段 JSON 必须能被 judge/llm.js 的 parseVerdict 解析 */
function judgePayload(mode) {
  switch (mode) {
    case 'silent':
      return { kind: 'json', text: '{"reply":false,"score":0.1,"reason":"假判定·不回"}' }
    case 'garbage':
      return { kind: 'json', text: '这个我判断不了' }
    case 'error':
      return { kind: 'error' }
    case 'timeout':
      return { kind: 'hang' }
    case 'reply':
    default:
      return { kind: 'json', text: '{"reply":true,"score":0.9,"reason":"假判定·回"}' }
  }
}

function logPayload(kind, options) {
  if (!LOG_PATH) return
  let text = ''
  try {
    text = JSON.stringify(options ?? {})
  } catch (err) {
    text = `<unserializable: ${err?.message}>`
  }
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ kind, ts: Date.now(), payload: text.slice(0, 6000) })}\n`)
  } catch (err) {
    console.error(`qdn-fake-model: 写日志失败 name=${err?.name} msg=${err?.message}`)
  }
}

class FakeAdapter extends dshLlm.LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'QDN Fake' }
  }

  async listModels(provider) {
    return [{ id: MODEL, name: MODEL, provider }]
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      description: 'fake model for wiring test',
      context: { contextWindow: 128000 },
      defaultMaxTokens: 1024,
    }
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: o => this.stream(o) }
  }

  async *stream(options) {
    let payload = ''
    try {
      payload = JSON.stringify(options ?? {})
    } catch (err) {
      payload = ''
      console.error(`qdn-fake-model: options 无法序列化 name=${err?.name} msg=${err?.message}`)
    }

    if (payload.includes(JUDGE_MARK)) {
      logPayload('judge', options)
      const verdict = judgePayload(MODE)
      if (verdict.kind === 'error') throw new Error(`qdn-fake-model: 判定流故意报错（QDN_JUDGE_MODE=${MODE}）`)
      if (verdict.kind === 'hang') {
        await new Promise(() => {})
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: verdict.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: verdict.text } }
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 12, totalTokens: 72 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    logPayload('answer', options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: ANSWER }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: ANSWER } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new FakeAdapter())
  ctx.logger?.('qdn-fake-model')?.info?.(`已注册假 provider ${PROVIDER}/${MODEL}（判定模式 ${MODE}）`)
}
