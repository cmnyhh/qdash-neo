/**
 * 判定链单测：`node --test test/judge.test.js`
 *
 * 全部用假 `ctx.llm`，不联网、不烧钱。覆盖的是**兜底行为**：
 * 判不出来、超时、报错、频控命中时到底回不回 —— 答案永远是「不回」，
 * 而且原因必须写进 judgements（否则"为什么没回"永远查不到）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JudgeChain } from '../src/judge/chain.js'
import { heuristic, matchKeyword } from '../src/judge/heuristics.js'
import { JudgeParseError, buildSystem, parseVerdict } from '../src/judge/llm.js'

const cfg = (judge = {}) => ({
  agent: { provider: 'p', model: 'm' },
  policy: {},
  judge: {
    enabled: true,
    // 基线显式写死 llm：生产默认已改成 agent（不烧判定），
    // 但这一组用例测的就是"模型层怎么判"，不该被默认值牵着走
    onUnsure: 'llm',
    threshold: 0.6,
    timeoutMs: 1000,
    maxPerMinute: 10,
    errorCooldownMs: 60_000,
    ...judge,
  },
})

const inbound = (over = {}) => ({
  kind: 'group',
  chatKey: 'g:555',
  userId: '10001',
  groupId: '555',
  messageId: 'g1',
  text: '今天天气不错',
  atMe: false,
  hasImage: false,
  segments: [],
  raw: {},
  ...over,
})

const fakeStore = () => ({
  judgements: [],
  usages: [],
  recordJudgement(row) {
    this.judgements.push(row)
  },
  recordUsage(row) {
    this.usages.push(row)
  },
})

const okStream = (json, usage = { inputTokens: 80, outputTokens: 12, totalTokens: 92 }) =>
  async function* () {
    yield { type: 'text-delta', text: json }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

const throwStream = message =>
  async function* () {
    throw new Error(message)
  }

const hangStream = () =>
  async function* () {
    await new Promise(() => {})
  }

const mkCtx = streamFn => ({ llm: { stream: () => streamFn() } })

/* ---------------------------------------------------------------- 启发式 */

test('启发式：@ 与叫名字是确定性信号', () => {
  assert.equal(heuristic({ inbound: inbound({ atMe: true }), config: {} }).verdict, 'reply')
  const named = heuristic({ inbound: inbound({ text: '小助手你觉得呢' }), config: {}, botNames: ['小助手'] })
  assert.equal(named.verdict, 'reply')
  assert.match(named.reason, /小助手/)
})

test('启发式：空/过短直接沉默，问句与关键词只是"不确定"', () => {
  assert.equal(heuristic({ inbound: inbound({ text: '' }), config: {} }).verdict, 'silent')
  assert.equal(heuristic({ inbound: inbound({ text: '啊' }), config: {} }).verdict, 'silent')
  assert.equal(heuristic({ inbound: inbound({ text: '这个怎么配？' }), config: {} }).verdict, 'unsure')
  const kw = heuristic({ inbound: inbound({ text: '部署一下' }), config: { policy: { groupTriggerKeywords: ['部署'] } } })
  assert.equal(kw.verdict, 'unsure')
  assert.match(kw.reason, /部署/)
})

test('启发式：短英文关键词走词边界，不误命中子串', () => {
  assert.equal(matchKeyword('ADS 是什么', 'DS'), false)
  assert.equal(matchKeyword('DS 是什么', 'DS'), true)
  assert.equal(matchKeyword('随便聊聊', '聊天'), false)
})

/* ------------------------------------------------------------ 输出解析 */

test('buildSystem：有人格摘要就切换判据，没有就保持通用', () => {
  const generic = buildSystem('')
  assert.match(generic, /纯属群友之间的闲聊（此时不该插话）/, '无人格时是管家型判据')

  const withPersona = buildSystem('白绫：狐狸大小姐，狡黠爱逗人、好奇心重')
  assert.match(withPersona, /性格外向/, '有人格时按参与意愿判断')
  assert.doesNotMatch(withPersona, /纯属群友之间的闲聊（此时不该插话）/, '两种判据不能同时出现')
})

test('parseVerdict：容忍代码块与废话，解析不出就抛错（不猜）', () => {
  assert.deepEqual(parseVerdict('```json\n{"reply":true,"score":0.9,"reason":"提问"}\n```'), {
    verdict: 'reply',
    score: 0.9,
    reason: '提问',
    // 模型没给 memory：当空串，不能因此判失败
    memory: '',
  })
  // memory 是可选加分项：类型不对也不该影响判定
  assert.equal(parseVerdict('{"reply":true,"memory":123}').memory, '')
  assert.equal(parseVerdict('{"reply":true,"memory":"在聊球赛"}').memory, '在聊球赛')
  assert.equal(parseVerdict('{"reply":false}').verdict, 'silent')
  assert.throws(() => parseVerdict('我觉得应该回'), JudgeParseError)
  assert.throws(() => parseVerdict('{"score":0.5}'), JudgeParseError)
})

/* ---------------------------------------------------------------- 判定链 */

test('判定链：@ 直接回，不调用模型', async () => {
  let calls = 0
  const chain = new JudgeChain(mkCtx(() => {
    calls += 1
    return okStream('{"reply":false}')()
  }), { config: cfg(), log: () => {}, store: fakeStore() })

  const j = await chain.decide({ inbound: inbound({ atMe: true }) })
  assert.equal(j.verdict, 'reply')
  assert.equal(j.layer, 'heuristic')
  assert.equal(calls, 0)
})

test('判定链：onUnsure=agent 时不调模型，直接交给对话层', async () => {
  let calls = 0
  const ctx = {
    llm: {
      stream: () => {
        calls += 1
        return okStream('{"reply":true,"score":0.9}')()
      },
    },
  }
  const store = fakeStore()
  const d = new JudgeChain(ctx, { config: cfg({ onUnsure: 'agent' }), log: () => {}, store })
  const j = await d.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'defer', '启发式不确定时应把决定权交出去')
  assert.equal(calls, 0, 'defer 模式不该产生任何模型调用')
  assert.equal(d.stats.llmCalls, 0)
  assert.equal(j.code, 'defer-to-agent')
  assert.equal(store.judgements[0].code, 'defer-to-agent', '原因码必须落库，否则控制台只能靠 reason 文本猜')
})

test('判定链：onUnsure=silent 时一律不回，也不调模型', async () => {
  let calls = 0
  const ctx = {
    llm: {
      stream: () => {
        calls += 1
        return okStream('{"reply":true,"score":0.9}')()
      },
    },
  }
  const d = new JudgeChain(ctx, { config: cfg({ onUnsure: 'silent' }), log: () => {} })
  const j = await d.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'silent')
  assert.equal(calls, 0)
  assert.equal(j.code, 'on-unsure-silent')
})

test('判定链：onUnsure 非法值退回 llm 并留痕', async () => {
  const logs = []
  const ctx = { llm: { stream: () => okStream('{"reply":true,"score":0.9}')() } }
  const d = new JudgeChain(ctx, {
    config: cfg({ onUnsure: 'yolo' }),
    log: (level, msg) => logs.push({ level, msg }),
  })
  assert.equal(d.onUnsure, 'agent', '配置写错退回默认值（agent）')
  assert.ok(logs.some(l => /onUnsure 取值非法/.test(l.msg)), '非法配置必须留痕')

  const j = await d.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'defer', '退回 agent 后交给对话层，不再烧判定')
})

test('判定链：模型高分 → 回，且判定花费单独记 stage=judge', async () => {
  const store = fakeStore()
  const chain = new JudgeChain(mkCtx(okStream('{"reply":true,"score":0.82,"reason":"在问我"}')), {
    config: cfg(),
    log: () => {},
    store,
  })

  const j = await chain.decide({ inbound: inbound(), contextText: '甲：在吗' })
  assert.equal(j.verdict, 'reply')
  assert.equal(j.layer, 'llm')
  assert.equal(store.judgements.length, 1)
  assert.equal(store.judgements[0].verdict, 'reply')
  assert.equal(store.usages.length, 1)
  assert.equal(store.usages[0].stage, 'judge')
  assert.equal(store.usages[0].inTokens, 80)
})

test('判定链：阈值分档 —— 模型说回但分数不够，仍然沉默', async () => {
  const chain = new JudgeChain(mkCtx(okStream('{"reply":true,"score":0.5,"reason":"也许"}')), {
    config: cfg({ threshold: 0.6 }),
    log: () => {},
    store: fakeStore(),
  })
  const j = await chain.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'silent')
  assert.match(j.reason, /阈值/)
})

test('判定链：模型报错 → 沉默 + 冷却期内不再烧钱', async () => {
  let calls = 0
  const store = fakeStore()
  const chain = new JudgeChain(
    mkCtx(() => {
      calls += 1
      return calls === 1 ? throwStream('boom')() : okStream('{"reply":true,"score":0.99}')()
    }),
    { config: cfg({ errorCooldownMs: 60_000 }), log: () => {}, store },
  )

  const first = await chain.decide({ inbound: inbound() })
  assert.equal(first.verdict, 'silent')
  assert.match(first.reason, /判定失败/)

  // 冷却期内：即使模型会回也不该再调
  const second = await chain.decide({ inbound: inbound({ messageId: 'g2' }) })
  assert.equal(second.verdict, 'silent')
  assert.match(second.reason, /冷却/)
  assert.equal(calls, 1)
  assert.equal(store.judgements.length, 2)
})

test('判定链：解析失败不触发冷却（一次空输出不该让整群静默一分钟）', async () => {
  let calls = 0
  const chain = new JudgeChain(
    mkCtx(() => {
      calls += 1
      return calls === 1
        ? okStream('这个我判断不了')()
        : okStream('{"reply":true,"score":0.9}')()
    }),
    { config: cfg({ errorCooldownMs: 60_000 }), log: () => {}, store: fakeStore() },
  )

  const first = await chain.decide({ inbound: inbound() })
  assert.equal(first.verdict, 'silent')
  assert.match(first.reason, /无法解析/)

  const second = await chain.decide({ inbound: inbound({ messageId: 'g2' }) })
  assert.equal(second.verdict, 'reply')
  assert.equal(calls, 2)
})

test('判定链：空正文要能看出 finish 原因，不是只写"无法解析"', async () => {
  const chain = new JudgeChain(
    mkCtx(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }),
    { config: cfg(), log: () => {}, store: fakeStore() },
  )
  const j = await chain.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'silent')
  assert.match(j.reason, /finish=stop/)
})

test('判定链：超时 → 沉默（宁可沉默不可乱回）', async () => {
  const chain = new JudgeChain(mkCtx(hangStream()), {
    config: cfg({ timeoutMs: 40 }),
    log: () => {},
    store: fakeStore(),
  })
  const j = await chain.decide({ inbound: inbound() })
  assert.equal(j.verdict, 'silent')
  assert.match(j.reason, /超时/)
})

test('判定链：输出被 max-tokens 截断 → 沉默并说清"截断"，不是"无法解析"', async () => {
  // DSH 的 FinishReason 是 'max-tokens'（不是 OpenAI 的 'length'），两个都必须识别
  for (const kind of ['max-tokens', 'length']) {
    const chain = new JudgeChain(
      mkCtx(async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 90 } }
        yield { type: 'finish', reason: { kind } }
      }),
      { config: cfg({ maxTokens: 90 }), log: () => {}, store: fakeStore() },
    )
    const j = await chain.decide({ inbound: inbound() })
    assert.equal(j.verdict, 'silent', `finish=${kind}`)
    assert.match(j.reason, /截断/, `finish=${kind}`)
    assert.match(j.reason, /max_tokens=90/, `finish=${kind}`)
  }
})

test('判定调用把 judge.maxTokens 传给 ctx.llm.stream（默认 1280，够推理模型花 + 带 memory）', async () => {
  const seen = []
  const ctx = {
    llm: {
      stream: opts => {
        seen.push(opts)
        return (async function* () {
          yield { type: 'text-delta', text: '{"reply":true,"score":0.9}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const dflt = new JudgeChain(ctx, { config: cfg(), log: () => {}, store: fakeStore() })
  await dflt.decide({ inbound: inbound() })
  // 1280：判定结果里要带一句 memory，1024 容易被推理模型的思考 token 顶掉
  assert.equal(seen[0].maxTokens, 1280)
  assert.equal(seen[0].temperature, 0)
})

test('判定链：每分钟判定次数上限', async () => {
  let calls = 0
  const chain = new JudgeChain(
    mkCtx(() => {
      calls += 1
      return okStream('{"reply":true,"score":0.9}')()
    }),
    { config: cfg({ maxPerMinute: 1 }), log: () => {}, store: fakeStore() },
  )

  assert.equal((await chain.decide({ inbound: inbound() })).verdict, 'reply')
  const second = await chain.decide({ inbound: inbound({ messageId: 'g2' }) })
  assert.equal(second.verdict, 'silent')
  assert.match(second.reason, /每分钟最多判定/)
  assert.equal(calls, 1)
})

test('判定链：判定器关闭 / 缺 provider 时一律沉默并说清原因', async () => {
  const off = new JudgeChain(mkCtx(okStream('{"reply":true,"score":0.9}')), {
    config: cfg({ enabled: false }),
    log: () => {},
    store: fakeStore(),
  })
  const j1 = await off.decide({ inbound: inbound() })
  assert.equal(j1.verdict, 'silent')
  assert.match(j1.reason, /已关闭/)

  // 缺 provider 且明确要求走模型层 → 说不出话，只能沉默并说明原因
  const noModel = new JudgeChain(mkCtx(okStream('{"reply":true,"score":0.9}')), {
    config: { agent: {}, policy: {}, judge: { enabled: true, onUnsure: 'llm' } },
    log: () => {},
    store: fakeStore(),
  })
  const j2 = await noModel.decide({ inbound: inbound() })
  assert.equal(j2.verdict, 'silent')
  assert.match(j2.reason, /不可用/)
  assert.equal(noModel.snapshot().available, false)

  // 默认改成 agent 之后：没有判定模型也能跑，启发式犹豫就交给对话层
  const deferNoModel = new JudgeChain(mkCtx(okStream('{"reply":true,"score":0.9}')), {
    config: { agent: {}, policy: {}, judge: { enabled: true } },
    log: () => {},
    store: fakeStore(),
  })
  const j3 = await deferNoModel.decide({ inbound: inbound() })
  assert.equal(j3.verdict, 'defer', '缺 provider 不该把整个群判死')
  assert.equal(j3.code, 'defer-to-agent')
})
