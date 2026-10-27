/**
 * 内核串联测试：`node --test test/service.test.js`
 *
 * 这一层验的不是单个函数，而是**入站四段（ingest → context → trigger → judge → deliver）串起来之后的实际行为**：
 *   - 非白名单成员的群消息必须进上下文（"听得见"），但不一定能引起回复
 *   - 连续 10 条群消息最多回 3 条（配额），且不能一条都不回
 *   - 判定沉默 / 超时 / 关闭时一律不回，原因必须落进 judgements
 *   - 重启后上下文能从库里恢复
 *
 * 不连 DSH、不连 OneBot：`start()` 会把 WS 和真实会话拉起来，这里只手工装配依赖。
 * 真机全链路另见 `test/fake-onebot.mjs`（假 OneBot 服务端 + 真 DSH 宿主）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseSleepMarker } from '../src/consts.js'
import { JudgeChain } from '../src/judge/chain.js'
import { Memory } from '../src/memory/index.js'
import { Gates } from '../src/pipeline/gates.js'
import { GroupContext } from '../src/pipeline/context.js'
import { QdashNeoService } from '../src/service.js'
import { planReply } from '../src/outbox/split.js'
import { Store } from '../src/store/db.js'

const SELF_ID = 999
const GROUP_ID = 777

const BASE_CONFIG = {
  onebot: { selfId: String(SELF_ID), wsUrl: 'ws://127.0.0.1:0' },
  // 机器人的称呼：登录昵称在真机上由 get_login_info 给，单测直接用别名代替
  identity: { aliases: ['小助手'] },
  agent: { provider: 'fake', model: 'fake-1', preset: '' },
  policy: {
    whitelist: ['10001'],
    groupEnabled: true,
    groupTrigger: 'judge',
    groupReplyQuota: { windowMinutes: 10, maxReplies: 3 },
    ratePerMinute: 100,
  },
  judge: {
    enabled: true,
    // 基线显式 llm：生产默认已是 agent（把"要不要开口"交给对话层），
    // 但这一组用例测的是判定链路本身，不写死就会被默认值牵着走
    onUnsure: 'llm',
    provider: 'fake',
    model: 'fake-1',
    timeoutMs: 1000,
    threshold: 0.6,
    maxPerMinute: 50,
    errorCooldownMs: 60_000,
    contextLines: 20,
    contextMaxChars: 3000,
    contextTtlMinutes: 60,
    // 单测默认关批窗口（= 逐条判）：批窗口自己的行为在下面的专测里用毫秒级窗口验
    batchWindowMs: 0,
    batchMaxWaitMs: 2000,
    batchMaxMessages: 20,
    atLookaheadMs: 0,
  },
  // 长期记忆默认关；开启行为在"记忆"那组测里单独验
  memory: { enabled: false },
  // 人设默认关；开启行为在"人设"那组测里单独验
  persona: { enabled: false, text: '', judgeHint: '' },
  // 出站形态（M2）：默认值本身在 config.js，这里给测试一份可控的等价物
  outbound: {
    split: true,
    maxChars: 500,
    maxSegments: 5,
    intervalMs: 0,
    plainText: true,
  },
}

/** 假判定流：mode 决定模型说什么，覆盖回/不回/超时/报错 */
const streamFor = mode =>
  async function* () {
    if (mode === 'hang') {
      await new Promise(() => {})
      return
    }
    if (mode === 'error') throw new Error('假判定流故意报错')
    const text =
      mode === 'silent'
        ? '{"reply":false,"score":0.1,"reason":"闲聊"}'
        : '{"reply":true,"score":0.9,"reason":"在问大家"}'
    yield { type: 'text-delta', text }
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

/**
 * 手工装配一个 service（不调 start()）。
 * @param {{ judgeMode?: string, policy?: object, judge?: object }} [over]
 */
function makeService(over = {}) {
  const config = {
    ...BASE_CONFIG,
    identity: { ...BASE_CONFIG.identity, ...(over.identity ?? {}) },
    policy: { ...BASE_CONFIG.policy, ...(over.policy ?? {}) },
    judge: { ...BASE_CONFIG.judge, ...(over.judge ?? {}) },
    memory: { ...BASE_CONFIG.memory, ...(over.memory ?? {}) },
    persona: { ...BASE_CONFIG.persona, ...(over.persona ?? {}) },
    outbound: { ...BASE_CONFIG.outbound, ...(over.outbound ?? {}) },
    // tools 之前没合并：传 `tools: {...}` 会被静默丢掉，导致"配了不生效"的假象
    tools: { ...(BASE_CONFIG.tools ?? {}), ...(over.tools ?? {}) },
  }
  const dir = mkdtempSync(join(tmpdir(), 'qdn-svc-'))
  const dbPath = join(dir, 't.db')
  const store = new Store(dbPath)
  const deliveries = []
  const logs = []

  const ctx = { llm: { stream: () => streamFor(over.judgeMode ?? 'reply')() } }
  const service = new QdashNeoService(ctx, config, {
    log: (level, msg) => logs.push({ level, msg }),
    createUserMessage: text => ({ text }),
  })
  service.store = store
  service.gates = new Gates(config)
  service.context = new GroupContext({
    limit: 20,
    maxChars: 3000,
    store,
    // 与 start() 保持一致：恢复时用当前白名单重算 trusted
    isTrusted: userId => service.gates.allowAll || service.gates.whitelist.has(String(userId)),
  })
  service.judge = new JudgeChain(ctx, { config, log: service.log, store })
  // 走产品代码那条路：judge 与 gates 必须拿到同一份称呼，跳过的只是登录事件
  service.syncBotNames()
  // 只替换最后一跳（真机上这里是 ctx.agents + followup），前面全部走产品代码
  service.router = {
    deliver: async (chatKey, prompt) => {
      deliveries.push({ chatKey, prompt })
    },
  }

  return {
    config,
    dir,
    dbPath,
    store,
    service,
    deliveries,
    logs,
    dispose() {
      // 批窗口的 setTimeout 不通过 clearTimeout 取消，node --test 会一直等它到期
      // （最长 batchMaxWaitMs=20s）才退出进程 —— 表现就是"测试跑完卡住"
      service.clearTimers()
      // 出站泵是 100ms 的 setTimeout 自循环，同理：不停掉进程退不出去
      service.outbox?.stop()
      service.ledger?.clear()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 构造 OneBot 原始群消息事件 */
function groupRaw({ id, userId, name, text, at = false }) {
  const message = at
    ? [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text } }]
    : [{ type: 'text', data: { text } }]
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: SELF_ID,
    group_id: GROUP_ID,
    user_id: userId,
    message_id: id,
    message,
    raw_message: text,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: name, card: name },
  }
}

/** 推一条并等它跑完（service 内部按 chat 串行） */
async function feed(service, raw) {
  service.handleInbound(raw)
  await service.chatTails.get(`g:${GROUP_ID}`)
}

const MEMBERS = [
  { userId: 20001, name: '路人甲' },
  { userId: 20002, name: '路人乙' },
  { userId: 10001, name: '测试者' }, // 只有这个在私聊白名单里
]

test('群：10 条消息最多回 3 条，但非白名单成员的话也进了上下文', async () => {
  const s = makeService()
  try {
    for (let i = 0; i < 10; i++) {
      const m = MEMBERS[i % MEMBERS.length]
      await feed(s.service, groupRaw({ id: 1000 + i, ...m, text: `群消息第${i + 1}条：今天中午吃啥` }))
    }

    assert.equal(s.deliveries.length, 3, '配额 3 必须生效')
    // 第三条投递时，上下文里应当已经有前两条（其中一条来自非白名单成员）
    const third = s.deliveries.at(-1).prompt
    assert.match(third, /路人甲/)
    assert.match(third, /群消息第1条/)
    assert.match(third, /非指令/)

    // 配额用尽后的消息仍然"听得见"：state=context 落库，没被丢掉
    const states = s.store.db
      .prepare(`select state, count(*) as c from messages where chat_key = ? group by state`)
      .all(`g:${GROUP_ID}`)
    const byState = Object.fromEntries(states.map(r => [r.state, r.c]))
    assert.equal(byState.delivered, 3)
    assert.equal(byState.context, 7)

    // 判定花费单独记 stage=judge，且只在前 3 条上花钱；
    // 后 7 条被配额挡住，也要各留一条 gate 记录（"为什么没回"必须查得到）
    const stats = s.store.judgementStats()
    assert.equal(stats.llm_calls, 3)
    assert.equal(stats.replied, 3)
    assert.equal(stats.total, 10)
    const gateRows = s.store.db
      .prepare(`select count(*) as c from judgements where layer = 'gate' and chat_key = ? and code is not null`)
      .get(`g:${GROUP_ID}`)
    assert.equal(gateRows.c, 7)
    const judgeUsage = s.store.db
      .prepare(`select count(*) as c from usage where stage = 'judge' and chat_key = ?`)
      .get(`g:${GROUP_ID}`)
    assert.equal(judgeUsage.c, 3)
  } finally {
    s.dispose()
  }
})

test('群：判定沉默 → 不投递、不占配额，但留在上下文并记录原因', async () => {
  const s = makeService({ judgeMode: 'silent' })
  try {
    await feed(s.service, groupRaw({ id: 2001, ...MEMBERS[0], text: '今天中午吃啥' }))
    await feed(s.service, groupRaw({ id: 2002, ...MEMBERS[1], text: '楼下新开了家面馆' }))

    assert.equal(s.deliveries.length, 0)
    assert.equal(s.store.judgementStats().total, 2)
    const rows = s.store.db.prepare('select verdict, layer, reason from judgements order by id').all()
    assert.deepEqual(rows.map(r => r.verdict), ['silent', 'silent'])
    assert.ok(rows.every(r => r.layer === 'llm'))
    // 配额没有被沉默的消息消耗：允许开口的次数不变
    assert.equal(s.service.gates.allowReply(`g:${GROUP_ID}`), true)
  } finally {
    s.dispose()
  }
})

test('群：@ 直接回，判定的钱一分不花', async () => {
  const s = makeService({ judgeMode: 'hang' })
  try {
    await feed(s.service, groupRaw({ id: 3001, ...MEMBERS[0], text: '这怎么配', at: true }))
    assert.equal(s.deliveries.length, 1)
    assert.match(s.deliveries[0].prompt, /（@你）/)
    assert.equal(s.store.judgementStats().llm_calls, 0)
    const row = s.store.db.prepare('select layer, verdict from judgements order by id').get()
    assert.equal(row.layer, 'heuristic')
    assert.equal(row.verdict, 'reply')
  } finally {
    s.dispose()
  }
})

test('群：默认 mention 档——不 @ 一条不回，但消息全部进上下文', async () => {
  const s = makeService({ policy: { groupTrigger: 'mention' } })
  try {
    for (let i = 0; i < 5; i++) {
      await feed(s.service, groupRaw({ id: 4000 + i, ...MEMBERS[i % 2], text: `闲聊第${i + 1}条` }))
    }
    assert.equal(s.deliveries.length, 0)
    const ctxRows = s.store.db
      .prepare(`select count(*) as c from messages where chat_key = ? and state = 'context'`)
      .get(`g:${GROUP_ID}`)
    assert.equal(ctxRows.c, 5)
    // mention 档压根不进判定器（不烧钱）
    assert.equal(s.store.judgementStats().total, 0)
  } finally {
    s.dispose()
  }
})

test('群：判定超时 → 静默，且原因可查（宁可沉默不可乱回）', async () => {
  const s = makeService({ judgeMode: 'hang', judge: { timeoutMs: 40 } })
  try {
    await feed(s.service, groupRaw({ id: 5001, ...MEMBERS[0], text: '这个怎么配' }))
    assert.equal(s.deliveries.length, 0)
    const row = s.store.db.prepare('select verdict, reason from judgements order by id').get()
    assert.equal(row.verdict, 'silent')
    assert.match(row.reason, /超时/)
  } finally {
    s.dispose()
  }
})

test('群：重启后从库里恢复上下文，不因重启失忆', async () => {
  const first = makeService()
  let dbPath
  try {
    dbPath = first.dbPath
    await feed(first.service, groupRaw({ id: 6001, ...MEMBERS[0], text: '重启前的第一句' }))
    first.store.close()

    // 同一个库、新进程：手工重建 service
    const config = first.config
    const store = new Store(dbPath)
    const deliveries = []
    const ctx = { llm: { stream: () => streamFor('reply')() } }
    const service = new QdashNeoService(ctx, config, { log: () => {}, createUserMessage: t => ({ text: t }) })
    service.store = store
    service.gates = new Gates(config)
    service.context = new GroupContext({
      limit: 20,
      maxChars: 3000,
      store,
      // 与 start() 保持一致：恢复时用当前白名单重算 trusted
      isTrusted: userId => service.gates.allowAll || service.gates.whitelist.has(String(userId)),
    })
    service.judge = new JudgeChain(ctx, { config, log: service.log, store })
    service.syncBotNames()
    service.router = {
      deliver: async (chatKey, prompt) => {
        deliveries.push({ chatKey, prompt })
      },
    }

    try {
      await feed(service, groupRaw({ id: 6002, ...MEMBERS[1], text: '重启后的第二句', at: true }))
      assert.equal(deliveries.length, 1)
      assert.match(deliveries[0].prompt, /重启前的第一句/)
    } finally {
      store.close()
    }
  } finally {
    first.dispose()
  }
})

// ---------------- 批窗口（防抖 + 最长等待） ----------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (cond, timeoutMs = 1500, stepMs = 10) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(stepMs)
  }
  return cond()
}
const judgementsOf = s => s.store.db.prepare('select layer, verdict, batch_size, qq_msg_ids, reason from judgements order by id').all()

test('批窗口：3 条连续发言只判一次、只回一条，batch_size 落库', async () => {
  const s = makeService({ judge: { batchWindowMs: 40, batchMaxWaitMs: 500 } })
  try {
    await feed(s.service, groupRaw({ id: 7001, ...MEMBERS[0], text: '在吗' }))
    await feed(s.service, groupRaw({ id: 7002, ...MEMBERS[0], text: '想问你个事' }))
    await feed(s.service, groupRaw({ id: 7003, ...MEMBERS[1], text: '这周的需求上线了吗' }))

    assert.equal(s.deliveries.length, 0, '窗口内不该立刻投递')
    assert.ok(await waitFor(() => s.deliveries.length > 0), '窗口到点必须投递')
    assert.equal(s.deliveries.length, 1, '一批只回一条')

    const prompt = s.deliveries[0].prompt
    // 没人 @ 时标题不再命令它回应（"请回应这条"曾让它每条都接），
  // 但"三条要合并成一次回复"这件事必须还在 —— 那才是批窗口的目的
  assert.match(prompt, /共 3 条连着发的/)
  assert.match(prompt, /合成一条自然回复/)
    assert.match(prompt, /在吗/)
    assert.match(prompt, /这周的需求上线了吗/)
    // 批里的消息不能再以"历史"身份出现一次，否则模型会把同一句读两遍
    assert.equal((prompt.match(/在吗/g) ?? []).length, 1)

    const rows = judgementsOf(s)
    assert.equal(rows.length, 1, '一批只有一条判定记录')
    assert.equal(rows[0].batch_size, 3)
    assert.match(rows[0].qq_msg_ids, /7001/)
    assert.equal(s.store.judgementStats().llm_calls, 1, '只花一次判定的钱')
  } finally {
    s.dispose()
  }
})

test('批窗口：每来一条就重新计时，最后一条静默后才定稿', async () => {
  const s = makeService({ judge: { batchWindowMs: 60, batchMaxWaitMs: 5000 } })
  try {
    await feed(s.service, groupRaw({ id: 7101, ...MEMBERS[0], text: '第一句' }))
    await sleep(35)
    await feed(s.service, groupRaw({ id: 7102, ...MEMBERS[0], text: '第二句' }))
    await sleep(35)
    await feed(s.service, groupRaw({ id: 7103, ...MEMBERS[0], text: '第三句' }))

    // 距第一条已经 70ms > window，但最后一条之后才过了 0ms → 仍然要等
    assert.equal(s.deliveries.length, 0, '有人接着说时必须继续等')
    assert.ok(await waitFor(() => s.deliveries.length > 0))
    assert.equal(s.deliveries.length, 1)
    assert.equal(judgementsOf(s)[0].batch_size, 3)
  } finally {
    s.dispose()
  }
})

test('批窗口：一直有人说话也最多等 maxWait，不会永远攒着', async () => {
  // 静默窗口 5s 远大于最长等待 120ms：不设上限的话这批永远等不到静默。
  // 配额显式钉成 1：这个用例要验的是"maxWait 只强制定稿一次"，不是配额。
  // 不钉的话 8 条消息会跨两次 maxWait，第二次回复也合法（默认配额 3），断言就变成跑在时间竞态上。
  const s = makeService({
    judge: { batchWindowMs: 5000, batchMaxWaitMs: 120 },
    policy: { groupReplyQuota: { windowMinutes: 10, maxReplies: 1 } },
  })
  try {
    for (let i = 0; i < 8; i++) {
      await feed(s.service, groupRaw({ id: 7200 + i, ...MEMBERS[i % 2], text: `连续刷屏第${i + 1}句` }))
      await sleep(25)
    }
    assert.ok(await waitFor(() => s.deliveries.length > 0, 1000), 'maxWait 到点必须强制判定')
    const first = judgementsOf(s)[0]
    assert.ok(first.batch_size >= 2, `maxWait 触发的批次应含多条，实际 ${first.batch_size}`)
    assert.equal(s.deliveries.length, 1, '配额只允许回一条')
  } finally {
    s.dispose()
  }
})

test('批窗口：批里有 @ 就走启发式，一分钱判定费不花', async () => {
  const s = makeService({ judge: { batchWindowMs: 40, batchMaxWaitMs: 500 } })
  try {
    await feed(s.service, groupRaw({ id: 7301, ...MEMBERS[0], text: '在吗' }))
    await feed(s.service, groupRaw({ id: 7302, ...MEMBERS[1], text: '帮我看看这个配置', at: true }))
    await feed(s.service, groupRaw({ id: 7303, ...MEMBERS[0], text: '我也想知道' }))

    assert.ok(await waitFor(() => s.deliveries.length > 0))
    assert.equal(s.deliveries.length, 1)
    const row = judgementsOf(s)[0]
    assert.equal(row.layer, 'heuristic')
    assert.equal(row.verdict, 'reply')
    assert.equal(row.batch_size, 3)
    assert.match(row.reason, /批次 3 条，第 2 条/)
    assert.equal(s.store.judgementStats().llm_calls, 0)
  } finally {
    s.dispose()
  }
})

test('群：群白名单已配时 all 档对全群生效（不必再逐个加个人白名单）', async () => {
  const s = makeService({ policy: { groupWhitelist: [String(GROUP_ID)], groupTrigger: 'all' } })
  try {
    // MEMBERS[0] = 20001，**不在**私聊白名单里
    await feed(s.service, groupRaw({ id: 8301, ...MEMBERS[0], text: '路人甲说话' }))
    assert.equal(s.deliveries.length, 1, '群已显式加白，就不该再要求个人加白')
  } finally {
    s.dispose()
  }
})

test('群：all 档但没配群白名单 → 仍只回私聊白名单成员（否则全群刷屏）', async () => {
  const s = makeService({ policy: { groupWhitelist: [], groupTrigger: 'all' } })
  try {
    await feed(s.service, groupRaw({ id: 8302, ...MEMBERS[0], text: '路人甲说话' }))
    assert.equal(s.deliveries.length, 0, '群白名单为空 = 机器人所在的所有群，这时必须收窄到个人白名单')
  } finally {
    s.dispose()
  }
})

test('批窗口：配额用尽时静默并留痕（gate 层），不再进判定器', async () => {
  const s = makeService({
    policy: { groupReplyQuota: { windowMinutes: 10, maxReplies: 1 } },
    judge: { batchWindowMs: 30, batchMaxWaitMs: 300 },
  })
  try {
    await feed(s.service, groupRaw({ id: 7401, ...MEMBERS[0], text: '第一波（@你）', at: true }))
    assert.ok(await waitFor(() => s.deliveries.length === 1))
    await sleep(40)

    await feed(s.service, groupRaw({ id: 7402, ...MEMBERS[1], text: '第二波问题' }))
    await feed(s.service, groupRaw({ id: 7403, ...MEMBERS[1], text: '还在吗' }))
    assert.ok(await waitFor(() => judgementsOf(s).length >= 2))

    const rows = judgementsOf(s)
    const gateRow = rows.find(r => r.layer === 'gate')
    assert.ok(gateRow, '被配额挡掉要有记录')
    assert.match(gateRow.reason, /quota|配额/i)
    assert.equal(gateRow.batch_size, 2)
    assert.equal(s.deliveries.length, 1, '配额用尽后不再投递')
  } finally {
    s.dispose()
  }
})

test('批窗口：0 表示关闭，回到逐条判定', async () => {
  const s = makeService()
  try {
    await feed(s.service, groupRaw({ id: 7501, ...MEMBERS[0], text: '一句' }))
    await feed(s.service, groupRaw({ id: 7502, ...MEMBERS[0], text: '两句' }))
    assert.equal(s.deliveries.length, 2)
    assert.equal(judgementsOf(s).filter(r => r.batch_size > 1).length, 0)
  } finally {
    s.dispose()
  }
})

test('批窗口：@ 提前封口，带上攒在前面的和紧跟着的一句', async () => {
  const s = makeService({ judge: { batchWindowMs: 5000, batchMaxWaitMs: 20000, atLookaheadMs: 120 } })
  try {
    await feed(s.service, groupRaw({ id: 7601, ...MEMBERS[0], text: '前一句没 @' }))
    const started = Date.now()
    await feed(s.service, groupRaw({ id: 7602, ...MEMBERS[1], text: '帮我看下', at: true }))
    await sleep(40) // 宽限期内补一句：真实场景里"@ 完再补一句"很常见
    await feed(s.service, groupRaw({ id: 7603, ...MEMBERS[0], text: '补充：是构建报错' }))

    assert.equal(s.deliveries.length, 0, '宽限期内不该投递')
    assert.ok(await waitFor(() => s.deliveries.length > 0, 1000), '@ 宽限到点必须立刻判')
    const cost = Date.now() - started
    assert.ok(cost < 1500, `@ 不该等满 5s 静默窗口，实际 ${cost}ms`)

    const prompt = s.deliveries[0].prompt
    assert.match(prompt, /前一句没 @/)
    assert.match(prompt, /补充：是构建报错/)
    assert.equal(judgementsOf(s)[0].batch_size, 3)
  } finally {
    s.dispose()
  }
})

test('批窗口：all 档也合并（每句都回 ≠ 每句单独回），且不进判定器', async () => {
  const s = makeService({ policy: { groupTrigger: 'all' }, judge: { batchWindowMs: 40, batchMaxWaitMs: 500 } })
  try {
    for (const id of [7701, 7702, 7703]) {
      await feed(s.service, groupRaw({ id, ...MEMBERS[2], text: `白名单成员第 ${id} 句` }))
    }
    assert.ok(await waitFor(() => s.deliveries.length > 0))
    assert.equal(s.deliveries.length, 1, 'all 档也要合并成一条')
    // 同上：all 档也没人 @，标题是中性的；合并要求仍然生效
  assert.match(s.deliveries[0].prompt, /共 3 条连着发的/)
  assert.match(s.deliveries[0].prompt, /合成一条自然回复/)
    assert.equal(judgementsOf(s).length, 0, 'all 档不该产生判定记录')
  } finally {
    s.dispose()
  }
})

// ---------------- 别名（叫名字）：比 @ 弱一档的确定性信号 ----------------

test('mention 档：叫别名等同被点名，直接回', async () => {
  const s = makeService({ policy: { groupTrigger: 'mention' } })
  try {
    await feed(s.service, groupRaw({ id: 8001, ...MEMBERS[0], text: '小助手在吗' }))
    assert.equal(s.deliveries.length, 1, '叫到名字就要回，不能因为没 @ 就当没看见')
    assert.equal(s.service.judge.stats.llmCalls, 0, '别名是确定性信号，不该花钱判定')
    // mention 档本来就不跑判定链（@ 也一样）：判定器不是被别名跳过的，是压根没进
    assert.equal(s.store.judgementStats().total, 0)
  } finally {
    s.dispose()
  }
})

test('judge 档：叫别名命中启发式，跳过判定器（零模型调用且留痕）', async () => {
  const s = makeService() // BASE_CONFIG 是 judge 档 + 逐条处理
  try {
    await feed(s.service, groupRaw({ id: 8021, ...MEMBERS[0], text: '小助手你觉得呢' }))
    assert.equal(s.deliveries.length, 1)
    assert.equal(s.service.judge.stats.llmCalls, 0, '确定性信号不该进模型')
    const row = s.store.db.prepare('select layer, verdict, reason from judgements order by id').get()
    assert.equal(row.layer, 'heuristic', '走启发式层，不花判定的钱')
    assert.equal(row.verdict, 'reply')
    assert.match(row.reason, /提到名字「小助手」/, '"为什么回"必须留在库里的 reason 上')
  } finally {
    s.dispose()
  }
})

test('mention 档：没 @ 也没叫名字 —— 继续沉默，且不留噪音记录', async () => {
  const s = makeService({ policy: { groupTrigger: 'mention' } })
  try {
    await feed(s.service, groupRaw({ id: 8011, ...MEMBERS[0], text: '今天中午吃啥' }))
    assert.equal(s.deliveries.length, 0)
    assert.equal(s.store.judgementStats().total, 0, 'mention 档的"没叫我"属于预期静默，不记库')
  } finally {
    s.dispose()
  }
})

test('批窗口：别名命中不提前封口（比 @ 弱），仍等满静默窗口', async () => {
  const s = makeService({ judge: { batchWindowMs: 300, atLookaheadMs: 40, batchMaxWaitMs: 2000 } })
  try {
    await feed(s.service, groupRaw({ id: 8101, ...MEMBERS[0], text: '小助手你觉得呢' }))
    await sleep(120)
    assert.equal(s.deliveries.length, 0, '叫一声未必是专门找它，别像 @ 那样打断"有人还在补充"')
    assert.ok(await waitFor(() => s.deliveries.length > 0, 1200), '静默窗口到点后仍然要回')
  } finally {
    s.dispose()
  }
})

test('批窗口：@ 才是提前封口的那一个（atLookaheadMs）', async () => {
  const s = makeService({ judge: { batchWindowMs: 300, atLookaheadMs: 40, batchMaxWaitMs: 2000 } })
  try {
    await feed(s.service, groupRaw({ id: 8111, ...MEMBERS[0], text: '这个怎么配', at: true }))
    assert.equal(await waitFor(() => s.deliveries.length > 0, 150), true, '@ 必须在静默窗口之前就回')
  } finally {
    s.dispose()
  }
})

test('批窗口：判定期间新到的消息不进这次 prompt（历史不能比当前新）', async () => {
  const s = makeService({ judge: { batchWindowMs: 30, maxPerMinute: 50 } })
  try {
    let release
    const barrier = new Promise(resolve => {
      release = resolve
    })
    s.service.judge = {
      botNames: [],
      setBotNames() {},
      decideBatch: async () => {
        await barrier
        return { verdict: 'reply', score: 0.9, layer: 'llm', reason: 'stub' }
      },
    }

    await feed(s.service, groupRaw({ id: 8001, ...MEMBERS[0], text: '第一句话' }))
    assert.ok(await waitFor(() => !s.service.batches.has(`g:${GROUP_ID}`)), '窗口到点应开始判定')

    // 判定还没返回时又来一条：它属于下一批，不能混进"第一句话这次"的历史。
    //
    // **不能 await feed**：feed 会等整个 per-chat 串行链，而上一条 flush 正卡在
    // barrier 上等 release() —— await 会直接死锁（release 永远走不到）。
    // handleInbound 在第一个 await 之前就把消息落库并塞进缓冲/批次了，同步调用即够。
    void s.service.handleInbound(groupRaw({ id: 8002, ...MEMBERS[0], text: '判定期新消息' }))
    release()

    assert.ok(await waitFor(() => s.deliveries.some(d => d.prompt.includes('第一句话'))))
    const first = s.deliveries.find(d => d.prompt.includes('第一句话')).prompt
    assert.doesNotMatch(first, /判定期新消息/)
  } finally {
    s.dispose()
  }
})

// ---------------- 长期记忆 ----------------

test('记忆默认关闭：不写库、不注入 prompt', async () => {
  const s = makeService()
  try {
    const key = `g:${GROUP_ID}`
    assert.equal(s.service.remember(key, { kind: 'topic', text: '周末打球' }), null)
    assert.deepEqual(s.store.listMemories(key), [])

    await feed(s.service, groupRaw({ id: 9001, ...MEMBERS[0], text: '在吗', at: true }))
    assert.doesNotMatch(s.deliveries[0].prompt, /你记得的事/)
    assert.equal(s.service.status().memory.enabled, false)
  } finally {
    s.dispose()
  }
})

test('记忆开启：注入 prompt；关掉 inject 立刻不注入', async () => {
  const s = makeService({ memory: { enabled: true } })
  try {
    const key = `g:${GROUP_ID}`
    s.service.remember(key, { kind: 'topic', text: '周末约球' })
    s.service.remember(key, { kind: 'impression', target: '路人甲', text: '喜欢 Python' })
    assert.equal(s.service.status().memory.enabled, true)

    await feed(s.service, groupRaw({ id: 9101, ...MEMBERS[0], text: '在吗', at: true }))
    const prompt = s.deliveries[0].prompt
    assert.match(prompt, /你记得的事/)
    assert.match(prompt, /周末约球/)
    assert.match(prompt, /路人甲：喜欢 Python/)
    // 记忆只出现在"当前消息"之前：越靠后越"当下"
    assert.ok(prompt.indexOf('你记得的事') < prompt.indexOf('【当前消息'), '记忆应早于当前消息')

    s.service.applyConfig({ ...s.config, memory: { ...s.config.memory, inject: false } })
    await feed(s.service, groupRaw({ id: 9102, ...MEMBERS[0], text: '再来一句', at: true }))
    assert.doesNotMatch(s.deliveries[1].prompt, /你记得的事/)
  } finally {
    s.dispose()
  }
})

test('记忆：容量上限与过期会生效（不治理一定膨胀）', async () => {
  const s = makeService({ memory: { enabled: true, maxTopics: 2 } })
  try {
    const key = `g:${GROUP_ID}`
    for (const text of ['话题A', '话题B', '话题C']) {
      s.service.remember(key, { kind: 'topic', text })
      await sleep(5)
    }
    const topics = s.store.listMemories(key).filter(m => m.kind === 'topic')
    assert.equal(topics.length, 2, '超出 maxTopics 应淘汰最旧的')
    assert.ok(!topics.some(t => t.text === '话题A'))

    s.service.remember(key, { kind: 'thought', text: '待说的一句话', expiresAtMs: 5 })
    await sleep(20)
    assert.equal(s.store.listMemories(key).filter(m => m.kind === 'thought').length, 0, '过期想法应被过滤')

    // 同一句话再记一次只涨权重，不新增行
    s.service.remember(key, { kind: 'topic', text: '话题C' })
    const again = s.store.listMemories(key).filter(m => m.kind === 'topic')
    assert.equal(again.length, 2)
    assert.equal(Number(again.find(t => t.text === '话题C').weight), 2)
  } finally {
    s.dispose()
  }
})

test('记忆：关掉开关后仍能查看和清空（不留看不见也删不掉的黑盒）', () => {
  const s = makeService({ memory: { enabled: true } })
  try {
    const key = `g:${GROUP_ID}`
    s.service.remember(key, { kind: 'topic', text: '要清理的话题' })
    assert.equal(s.service.listMemories(key).length, 1)

    s.service.applyConfig({ ...s.config, memory: { ...s.config.memory, enabled: false } })
    assert.equal(s.service.status().memory.enabled, false)

    // 关掉只影响"新增"和"注入"：残留必须看得见、删得掉
    assert.equal(s.service.remember(key, { kind: 'topic', text: '关掉后不该写进去' }), null)
    assert.equal(s.service.listMemories(key).length, 1)
    assert.equal(s.service.clearMemories(key), 1)
    assert.equal(s.service.listMemories(key).length, 0)
  } finally {
    s.dispose()
  }
})

test('记忆：群里再次提到旧话题会刷新活性，不会被当成最旧淘汰', async () => {
  const s = makeService({ memory: { enabled: true, maxTopics: 2 } })
  try {
    const key = `g:${GROUP_ID}`
    s.service.remember(key, { kind: 'topic', text: '话题A' })
    await sleep(5)
    s.service.remember(key, { kind: 'topic', text: '话题B' })

    // 新消息又提到 A：活性刷新后，A 不该是最旧的那个
    assert.equal(s.service.memoryOf().touch(key, '刚刚又聊到话题A了'), 1)

    s.service.remember(key, { kind: 'topic', text: '话题C' })
    const topics = s.store.listMemories(key).filter(m => m.kind === 'topic').map(t => t.text)
    assert.deepEqual(topics.sort(), ['话题A', '话题C'], '最久没提的 B 该被淘汰')
  } finally {
    s.dispose()
  }
})

test('记忆：判定沉默时把模型的 memory 记成 thought（带过期时间）', async () => {
  const s = makeService({ memory: { enabled: true } })
  try {
    s.service.judge = {
      botNames: [],
      setBotNames() {},
      decide: async () => ({
        verdict: 'silent',
        score: 0.2,
        layer: 'llm',
        reason: '纯闲聊',
        memory: '他们在约周末打球',
      }),
    }

    await feed(s.service, groupRaw({ id: 9501, ...MEMBERS[0], text: '周末打球吗' }))
    assert.equal(s.deliveries.length, 0, '判定沉默就不该投递')

    const rows = s.store.listMemories(`g:${GROUP_ID}`).filter(m => m.kind === 'thought')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, '他们在约周末打球')
    assert.equal(rows[0].evidence, '9501', '要能追回是哪条消息引出的')
    assert.ok(rows[0].expires_at > Date.now(), 'thought 必须带过期时间，靠 TTL 自愈')
  } finally {
    s.dispose()
  }
})

test('人设：完整角色卡进回复 prompt，性格摘要进判定', async () => {
  const s = makeService({
    persona: {
      enabled: true,
      text: '你是白绫，狐狸一族的独女，外人称「白绫小姐」。',
      judgeHint: '白绫：狡黠爱逗人的狐狸大小姐，会主动接感兴趣的话题',
    },
  })
  try {
    const seen = []
    s.service.judge = {
      botNames: [],
      setBotNames() {},
      decide: async input => {
        seen.push(input)
        return { verdict: 'reply', score: 0.9, layer: 'llm', reason: '在问话' }
      },
    }

    await feed(s.service, groupRaw({ id: 9701, ...MEMBERS[0], text: '在吗' }))
    await sleep(20)

    assert.equal(seen.length, 1)
    assert.equal(seen[0].personaHint, '白绫：狡黠爱逗人的狐狸大小姐，会主动接感兴趣的话题',
      '判定必须拿到性格摘要，否则判据还是「管家型」')

    assert.equal(s.deliveries.length, 1)
    assert.match(s.deliveries[0].prompt, /你是白绫/, '回复 prompt 要有完整人设')
    assert.match(s.deliveries[0].prompt, /狐狸一族的独女/)
    // 摘要不该混进回复 prompt：那是给判定器的耳朵，不是给模型的台词
    assert.doesNotMatch(s.deliveries[0].prompt, /会主动接感兴趣的话题/)
  } finally {
    s.dispose()
  }
})

test('人设：关掉开关时既不进 prompt 也不进判定', async () => {
  const s = makeService({ persona: { enabled: false, text: '你是白绫。', judgeHint: '白绫' } })
  try {
    const seen = []
    s.service.judge = {
      botNames: [],
      setBotNames() {},
      decide: async input => {
        seen.push(input)
        return { verdict: 'reply', score: 0.9, layer: 'llm', reason: 'ok' }
      },
    }

    await feed(s.service, groupRaw({ id: 9702, ...MEMBERS[0], text: '在吗' }))
    await sleep(20)

    assert.equal(seen[0].personaHint, '')
    assert.doesNotMatch(s.deliveries[0].prompt, /你是白绫/)
  } finally {
    s.dispose()
  }
})

test('applyConfig：批窗口热更新对后续消息立刻生效', async () => {
  const s = makeService()
  try {
    await feed(s.service, groupRaw({ id: 9201, ...MEMBERS[0], text: '第一条（逐条判）' }))
    assert.equal(s.deliveries.length, 1)

    s.service.applyConfig({ ...s.config, judge: { ...s.config.judge, batchWindowMs: 30 } })
    assert.equal(s.service.batchWindowMs, 30)

    await feed(s.service, groupRaw({ id: 9202, ...MEMBERS[0], text: '第二条' }))
    await feed(s.service, groupRaw({ id: 9203, ...MEMBERS[0], text: '第三条' }))
    assert.ok(await waitFor(() => s.deliveries.length === 2))
    assert.equal(s.deliveries.length, 2)
  } finally {
    s.dispose()
  }
})

// ---------------- 出站进上下文 / 提示词 ----------------

test('出站：回复成功后回写上下文，私聊不回写（不再记 self）', () => {
  const s = makeService({ memory: { enabled: true } })
  try {
    const chatKey = `g:${GROUP_ID}`
    s.service.rememberContext({
      chatKey, userId: '20001', senderName: '路人甲', text: '这个怎么配', messageId: '9801', ts: Date.now(),
    })
    s.service.rememberOutbound({ chatKey, text: '改 agent.provider', meta: { qqMsgId: 'out:1:1' } })

    const { lines } = s.service.context.recent(chatKey)
    assert.deepEqual(lines.map(l => l.direction), ['in', 'out'])
    assert.equal(lines[1].text, '改 agent.provider')

    // self 已不再实现：出站原文靠内存上下文 + messages 表的 out 行（outbox 侧落库），
    // 记忆里再存一份只是同一句话放两遍
    const selfs = s.store.listMemories(chatKey, { perKind: 10 }).filter(r => r.kind === 'self')
    assert.equal(selfs.length, 0, '不再写 self 记忆')

    // 私聊不走上下文缓冲（读取处只在群里拼 prompt）
    s.service.rememberOutbound({ chatKey: 'u:10001', text: '私聊的话', meta: {} })
    assert.equal(s.service.context.recent('u:10001').lines.length, 0)
  } finally {
    s.dispose()
  }
})

test('提示词：允许补答更早的提问，不再「只回应当前消息」', async () => {
  const s = makeService()
  try {
    await feed(s.service, groupRaw({ id: 9811, ...MEMBERS[0], text: '这个怎么配', at: true }))
    assert.equal(s.deliveries.length, 1)
    const prompt = s.deliveries[0].prompt
    assert.doesNotMatch(prompt, /只回应「当前消息」/)
    assert.match(prompt, /别只盯着最后一句/)
    assert.match(prompt, /可以一并接上/)
    assert.match(prompt, /不要重复/)
  } finally {
    s.dispose()
  }
})

test('提示词：群聊记录里出现「你」，模型看得见自己说过的话', async () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    s.service.rememberContext({
      chatKey, userId: '20001', senderName: '路人甲', text: '之前问过的', messageId: '9821', ts: Date.now(),
    })
    s.service.rememberOutbound({ chatKey, text: '之前答过的', meta: { qqMsgId: 'out:9' } })

    await feed(s.service, groupRaw({ id: 9822, ...MEMBERS[0], text: '那现在呢', at: true }))
    const prompt = s.deliveries[0].prompt
    assert.match(prompt, /你：之前答过的/)
    assert.doesNotMatch(prompt, /你：之前答过的[\s\S]*你：之前答过的/, '同一句不能重复注入')
  } finally {
    s.dispose()
  }
})

test('日总结：runDailySummaries 幂等，同一天只调一次模型', async () => {
  const s = makeService({ memory: { enabled: true, daily: { enabled: true, backfillDays: 1 } } })
  try {
    const chatKey = `g:${GROUP_ID}`
    s.store.upsertChat({ chatKey, kind: 'group', chatId: String(GROUP_ID) })
    s.store.insertMessage({
      chatKey, qqMsgId: 'd1', direction: 'in', senderId: '1', senderName: '甲',
      text: '昨天的对话', state: 'context', ts: Date.now() - 86_400_000,
    })
    s.service.memory = new Memory({ store: s.store, config: s.config, log: s.service.log })

    let calls = 0
    s.service.ctx.llm.stream = () => {
      calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: '昨天的摘要' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }

    assert.equal(await s.service.runDailySummaries(), 1)
    // 状态里必须看得到"跑过、成了几条" —— 否则失败只能靠翻日志
    const daily = s.service.status().daily
    assert.equal(daily.enabled, true)
    assert.equal(daily.backfillDays, 1)
    assert.equal(daily.last.done, 1)
    assert.equal(daily.last.error, null)

    assert.equal(await s.service.runDailySummaries(), 0, '已经有总结就不该再调模型')
    assert.equal(calls, 1)
  } finally {
    s.dispose()
  }
})

test('日总结：定时器归 clearTimers 管，不停掉就退不出进程', () => {
  const s = makeService({ memory: { enabled: true, daily: { enabled: true } } })
  try {
    s.service.memory = new Memory({ store: s.store, config: s.config, log: s.service.log })
    s.service.startDailyLoop()
    assert.equal(s.service.status().daily.running, true)

    s.service.clearTimers()
    assert.equal(s.service.status().daily.running, false)
    assert.equal(s.service.dailyTimer, null)
    assert.equal(s.service.dailyBootTimer, null)
  } finally {
    s.dispose()
  }
})

test('日总结：关闭时不起定时器（空转的 interval 会让宿主无法退出）', () => {
  const s = makeService({ memory: { enabled: true, daily: { enabled: false } } })
  try {
    s.service.memory = new Memory({ store: s.store, config: s.config, log: s.service.log })
    s.service.startDailyLoop()
    assert.equal(s.service.dailyTimer, null)
    assert.equal(s.service.status().daily.enabled, false)
  } finally {
    s.dispose()
  }
})

// ---------------- 出站分条（M2） ----------------

/**
 * 装上出站队列：走产品同一套 `createOutbox`（onSent/onDead 都是真的），只把最后一跳换成假发送。
 * `intervalMs` 默认压到 0 —— 否则每个用例都要等 1.2s。
 * @returns {Array<{chatKey: string, text: string}>} 真正"发出去"的文本
 */
/**
 * 模拟"模型调用了 qq_send_message"：清洗 → 按配置拆条 → 落库入队。
 *
 * 正文不再自动转发之后，发送只有工具这一条路；这些用例测的是分条与清洗，
 * 必须从真实入口进。这里复刻工具那一侧的两步（`planReply` + `enqueueOut`），
 * 而不是直接往 outbox 里塞，免得测试和产品代码各走一套。
 */
function sendText(service, chatKey, text) {
  const oc = service.config.outbound ?? {}
  const plan = planReply(text, {
    split: oc.split,
    plainText: oc.plainText !== false,
    maxChars: oc.maxChars,
    maxSegments: oc.maxSegments,
    // 警告要进 service.logs：有断言靠它确认"截断没有静默吞掉"
    onWarn: msg => service.log('warn', `qdash-neo: ${msg}`),
  })
  if (plan.parts.length === 0) {
    service.log('warn', `qdash-neo: 回复清洗后为空，不发送 ${chatKey}`)
    return plan
  }
  if (plan.truncated) {
    service.log('warn', `qdash-neo: 回复超长，已省略 ${plan.droppedChars} 字，分片=${plan.parts.length}`)
  }
  // 同一批分片共享前缀：控制台靠它把一次回复拆出的几条归成一组
  const replyId = `out:${Date.now()}:${++service.outSeq}`
  plan.parts.forEach((part, i) => {
    const qqMsgId = plan.parts.length === 1 ? replyId : `${replyId}:${i + 1}`
    service.enqueueOut(chatKey, part, { qqMsgId, replyId, total: plan.parts.length, fullText: plan.text })
  })
  return plan
}

function attachOutbox(s, { outbound = {}, failWhen = () => false, maxAttempts = 3 } = {}) {
  s.service.config = {
    ...s.service.config,
    outbound: { ...s.service.config.outbound, intervalMs: 0, ...outbound },
  }
  const sent = []
  s.service.outbox = s.service.createOutbox({
    send: async (chatKey, text) => {
      if (failWhen(text)) throw new Error(`假发送失败：${text.slice(0, 6)}`)
      sent.push({ chatKey, text })
    },
  })
  s.service.outbox.maxAttempts = maxAttempts
  s.service.outbox.start()
  return sent
}

test('出站分条：一条长回复拆成多条，messages 表逐片留痕、状态各自流转', async () => {
  const s = makeService({ outbound: { maxChars: 30, maxSegments: 5 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    sendText(s.service, chatKey, '甲'.repeat(80))

    assert.ok(await waitFor(() => sent.length === 3), `应拆 3 条，实际 ${sent.length}`)
    assert.deepEqual(sent.map(x => x.text.length), [30, 30, 20], '前两片吃满上限，末片收尾')
    assert.ok(await waitFor(() => s.service.ledger.size === 0))

    const rows = s.store.listMessages(chatKey, { direction: 'out' })
    assert.equal(rows.length, 3, '每片一行 —— 控制台才看得出"第 3 片死了"')
    assert.deepEqual(rows.map(r => r.state), ['sent', 'sent', 'sent'])
    // 分片 id 带序号，且都指向同一条回复（同一 replyId 前缀）
    const ids = rows.map(r => r.messageId).sort()
    assert.deepEqual(
      ids.map(id => id.split(':').at(-1)),
      ['1', '2', '3'],
    )
    const bases = new Set(ids.map(id => id.split(':').slice(0, -1).join(':')))
    assert.equal(bases.size, 1, `三片应属于同一条回复：${[...bases].join(' / ')}`)
  } finally {
    s.dispose()
  }
})

test('出站分条：全部送达后上下文只写一条（不把窗口塞满）', async () => {
  const s = makeService({ memory: { enabled: true }, outbound: { maxChars: 30, maxSegments: 5 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    // 先触发一次恢复（真实链路里入站消息总在出站之前），否则内存空 → 恢复时会把
    // 刚落库的分片再灌一遍，测的就不是"回写几次"而是"恢复去不去重"
    assert.deepEqual(s.service.context.recent(chatKey).lines, [])
    const sent = attachOutbox(s)
    sendText(s.service, chatKey, '乙'.repeat(80))

    assert.ok(await waitFor(() => sent.length === 3))
    assert.ok(await waitFor(() => s.service.ledger.size === 0))

    const outs = s.service.context.recent(chatKey).lines.filter(l => l.direction === 'out')
    assert.equal(outs.length, 1, '一次回复只占一格上下文，否则 20 条窗口被自己的长回复吃光')
    assert.equal(outs[0].text, '乙'.repeat(80), '回写的是完整原文，不是分片碎片')

    // self 已不再实现：分片发送也只回写一次内存上下文（上面那条 out 断言就是它）
    const selfs = s.store.listMemories(chatKey, { perKind: 10 }).filter(r => r.kind === 'self')
    assert.equal(selfs.length, 0, '分片发送也不写 self')
  } finally {
    s.dispose()
  }
})

test('出站分条：末片死信但前面成功 → 仍然回写一次（它确实说过一部分）', async () => {
  const s = makeService({ outbound: { maxChars: 40, maxSegments: 5 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    assert.deepEqual(s.service.context.recent(chatKey).lines, [])
    const sent = attachOutbox(s, { failWhen: t => t.startsWith('丙'), maxAttempts: 1 })
    sendText(s.service, chatKey, `${'甲'.repeat(30)}\n\n${'乙'.repeat(30)}\n\n${'丙'.repeat(30)}`)

    assert.ok(await waitFor(() => sent.length === 2), `前两片应发出，实际 ${sent.length}`)
    assert.ok(await waitFor(() => s.service.ledger.size === 0))

    const outs = s.service.context.recent(chatKey).lines.filter(l => l.direction === 'out')
    assert.equal(outs.length, 1)
    // 送达状态按片落库：有一片是 dead，控制台据此定位
    const states = s.store.listMessages(chatKey, { direction: 'out' }).map(r => r.state).sort()
    assert.deepEqual(states, ['dead', 'sent', 'sent'])
  } finally {
    s.dispose()
  }
})

test('出站分条：全部死信 → 一个字都没说出去，不写上下文也不记 self', async () => {
  const s = makeService({ memory: { enabled: true }, outbound: { maxChars: 30, maxSegments: 5 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s, { failWhen: () => true, maxAttempts: 1 })
    sendText(s.service, chatKey, '丁'.repeat(80))

    assert.ok(await waitFor(() => s.service.ledger.size === 0))
    assert.equal(sent.length, 0)
    assert.equal(
      s.service.context.recent(chatKey).lines.filter(l => l.direction === 'out').length,
      0,
      '写进上下文会让模型以为自己答过',
    )
    assert.equal(s.store.listMemories(chatKey, { perKind: 10 }).filter(r => r.kind === 'self').length, 0)
    assert.ok(s.logs.some(l => l.level === 'error' && l.msg.includes('全部死信')), '失败必须可见')
  } finally {
    s.dispose()
  }
})

test('出站分条：split=false 时一条发全文（配置可退回旧行为）', async () => {
  const s = makeService({ outbound: { split: false, maxChars: 30 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    const text = `${'甲'.repeat(80)}\n\n${'乙'.repeat(10)}`
    const sent = attachOutbox(s)
    sendText(s.service, chatKey, text)

    assert.ok(await waitFor(() => s.service.ledger.size === 0))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, text)
  } finally {
    s.dispose()
  }
})

test('出站分条：配额按「开口次数」记，不按分片条数（否则分条规则一改配额就漂移）', async () => {
  const s = makeService({ outbound: { maxChars: 30, maxSegments: 5 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    await feed(s.service, groupRaw({ id: 9901, ...MEMBERS[0], text: '这个怎么配', at: true }))
    assert.equal(s.deliveries.length, 1)

    sendText(s.service, chatKey, '戊'.repeat(75))
    assert.ok(await waitFor(() => sent.length === 3))
    assert.ok(await waitFor(() => s.service.ledger.size === 0))

    assert.equal(s.service.gates.replies.get(chatKey).length, 1, '拆 3 条也只算开口 1 次')
  } finally {
    s.dispose()
  }
})

test('出站清洗：Markdown 符号不发给用户（QQ 不渲染，符号只会变成噪声）', async () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    sendText(s.service, chatKey, '## 结论\n**重点**是这个 [文档](https://x.y)')

    assert.ok(await waitFor(() => s.service.ledger.size === 0))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, '结论\n重点是这个 文档 (https://x.y)')
  } finally {
    s.dispose()
  }
})

test('出站分条：超长时末条带省略标注，日志同时留痕', async () => {
  const s = makeService({ outbound: { maxChars: 30, maxSegments: 2 } })
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    sendText(s.service, chatKey, '己'.repeat(120))

    assert.ok(await waitFor(() => s.service.ledger.size === 0))
    assert.equal(sent.length, 2)
    assert.match(sent[1].text, /…（已省略 \d+ 字）$/)
    assert.ok(s.logs.some(l => l.level === 'warn' && l.msg.includes('已省略')), '静默截断最难发现')
  } finally {
    s.dispose()
  }
})

test('出站配置：applyConfig 立刻更新发送间隔（不用重启宿主）', () => {
  const s = makeService()
  try {
    attachOutbox(s, { outbound: { intervalMs: 40 } })
    assert.equal(s.service.outbox.perChatIntervalMs, 40)

    s.service.applyConfig({ ...s.config, outbound: { ...s.config.outbound, intervalMs: 900 } })
    assert.equal(s.service.outbox.perChatIntervalMs, 900)
    assert.equal(s.service.status().pendingReplies, 0)
  } finally {
    s.dispose()
  }
})

test('出站分条：重启恢复时把分片折回一条（否则模型看到 5 条碎句）', () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    const base = 'out:1700000000000:9'
    s.store.insertMessage({ chatKey, qqMsgId: `${base}:1`, direction: 'out', text: '甲'.repeat(30), state: 'sent' })
    s.store.insertMessage({ chatKey, qqMsgId: `${base}:2`, direction: 'out', text: '乙'.repeat(30), state: 'sent' })
    // 死信的那片不该被当成"我说过"
    s.store.insertMessage({ chatKey, qqMsgId: `${base}:3`, direction: 'out', text: '丙'.repeat(30), state: 'dead' })

    const rows = s.store.recentContextMessages(chatKey, 20)
    assert.equal(rows.length, 1, '一次回复在上下文里只占一条')
    assert.equal(rows[0].messageId, base, '合并后 id 用 replyId，与内存里回写的那条对齐')
    assert.equal(rows[0].text, `${'甲'.repeat(30)}\n${'乙'.repeat(30)}`)
  } finally {
    s.dispose()
  }
})

test('配置热更新：白名单改完，下一条私聊立即放行（这是控制台「保存即生效」的底）', async () => {
  const s = makeService({ policy: { whitelist: [] } })
  try {
    const raw = id => ({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: SELF_ID,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '你好' } }],
      raw_message: '你好',
      time: Math.floor(Date.now() / 1000),
      message_id: id,
      sender: { user_id: 10001, nickname: '测试者' },
    })

    s.service.handleInbound(raw(9101))
    await s.service.chatTails.get('u:10001')
    assert.equal(s.deliveries.length, 0, '空白名单时私聊必须被丢在闸门')

    // 控制台保存后走的就是这一条：applyConfig → gates 重算，无需重启、无需重连
    s.service.applyConfig({ ...s.config, policy: { ...s.config.policy, whitelist: ['10001'] } })
    assert.equal(s.service.gates.whitelist.has('10001'), true)

    s.service.handleInbound(raw(9102))
    await s.service.chatTails.get('u:10001')
    assert.equal(s.deliveries.length, 1, '下一条消息就该按新白名单放行')
  } finally {
    s.dispose()
  }
})

test('出站分条：清洗后为空的回复不入队（不产生空气泡）', async () => {
  const s = makeService()
  try {
    const sent = attachOutbox(s)
    sendText(s.service, `g:${GROUP_ID}`, '   \n\n  ')
    await sleep(150)
    assert.equal(sent.length, 0)
    assert.equal(s.service.ledger.size, 0)
    assert.ok(s.logs.some(l => l.level === 'warn' && l.msg.includes('清洗后为空')))
  } finally {
    s.dispose()
  }
})

test('记忆：私聊也会调用 render 并注入（此前 isGroup 短路，私聊永远不注入）', async () => {
  const s = makeService({ memory: { enabled: true, inject: true } })
  try {
    // 用桩替换记忆对象：这里要验的是"私聊走不走注入这条路"，不是 Memory 的存储细节
    const calls = []
    s.service.memory = {
      enabled: true,
      inject: true,
      applyConfig() {},
      touch() {},
      remember() {},
      snapshot: () => ({ enabled: true }),
      render: (chatKey, opts) => {
        calls.push({ chatKey, opts })
        return '【长期记忆】我上周说过喜欢鲸鱼'
      },
    }

    const raw = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: SELF_ID,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '还记得我喜欢什么吗' } }],
      raw_message: '还记得我喜欢什么吗',
      time: Math.floor(Date.now() / 1000),
      message_id: 9301,
      sender: { user_id: 10001, nickname: '测试者' },
    }
    s.service.handleInbound(raw)
    await s.service.chatTails.get('u:10001')

    assert.equal(calls.length, 1, '私聊必须调用 render')
    assert.equal(calls[0].chatKey, 'u:10001')
    assert.equal(s.deliveries.length, 1)
    assert.match(s.deliveries[0].prompt, /鲸鱼/, '记忆必须进私聊 prompt')
    assert.equal(
      calls[0].opts.excludeIds.map(String).includes('9301'),
      true,
      '当前这条消息要排除，否则它在 prompt 里会出现两次',
    )
  } finally {
    s.dispose()
  }
})

test('群：groupTrigger=agent 不跑判定链，且 prompt 要求模型自己表达沉默', async () => {
  const s = makeService({ policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)] } })
  try {
    await feed(s.service, groupRaw({ id: 8401, ...MEMBERS[0], text: '在吗' }))
    assert.equal(s.deliveries.length, 1, 'agent 档：群白名单内直接交给对话层')
    assert.match(
    s.deliveries[0].prompt,
    /qq_send_message/,
    '必须告诉模型"文字不会自动发出，要调工具"——否则它会以为写出来就发到了',
  )
    const judged = s.store.db.prepare('select count(*) n from judgements').get().n
    assert.equal(judged, 0, '这一档不判定，不该产生判定记录')
  } finally {
    s.dispose()
  }
})

test('批窗口：agent 档也会合并（这一档每条都要唤起模型，最需要批）', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)] },
    judge: { batchWindowMs: 40, batchMaxWaitMs: 500 },
  })
  try {
    await feed(s.service, groupRaw({ id: 8501, ...MEMBERS[0], text: '在吗' }))
    await feed(s.service, groupRaw({ id: 8502, ...MEMBERS[0], text: '想问你个事' }))
    await feed(s.service, groupRaw({ id: 8503, ...MEMBERS[1], text: '这周的需求上线了吗' }))

    assert.equal(s.deliveries.length, 0, '窗口内不该立刻投递')
    assert.ok(await waitFor(() => s.deliveries.length === 1), '静默窗口到点后要合并成一次')
    assert.equal(s.deliveries.length, 1, '3 条连发只能产生 1 次模型调用')
    assert.match(s.deliveries[0].prompt, /本次消息/, '三条要作为一批交给模型')
    // agent 档不判定
    assert.equal(s.store.db.prepare('select count(*) n from judgements').get().n, 0)
  } finally {
    s.dispose()
  }
})

/* ---------------- 随机沉睡 / 回复概率 ---------------- */

test('沉睡标记：只认整行，正文里出现不算（宁可多发一条也不误吞）', () => {
  assert.equal(parseSleepMarker('[[SLEEP:30]]'), 30)
  assert.equal(parseSleepMarker('  [[SLEEP:5]]  '), 5)
  assert.equal(parseSleepMarker('我觉得 [[SLEEP:30]] 吧'), 0)
  assert.equal(parseSleepMarker('[[SLEEP:0]]'), 0)
  assert.equal(parseSleepMarker('[[SLEEP]]'), 0)
  assert.equal(parseSleepMarker(''), 0)
})

test('沉睡：期间不回复但消息照常进上下文，叫醒后恢复', async () => {
  const s = makeService({
    policy: {
      groupTrigger: 'agent',
      groupWhitelist: [String(GROUP_ID)],
      sleep: { enabled: true, minMinutes: 10, maxMinutes: 60 },
    },
  })
  try {
    const chatKey = `g:${GROUP_ID}`
    s.service.setSleep(chatKey, 30)
    const until = s.service.isSleeping(chatKey)
    assert.ok(until > Date.now(), '应该在沉睡中')
    // 超出范围要被夹住（配置 10~60，模型给 999）
    assert.ok(until - Date.now() <= 60 * 60_000 + 1000, '超上限要夹到 maxMinutes')

    await feed(s.service, groupRaw({ id: 8601, ...MEMBERS[0], text: '在吗' }))
    assert.equal(s.deliveries.length, 0, '沉睡期间不投递')
    assert.ok(s.service.context.recent(chatKey).lines.length >= 1, '但消息必须进上下文')
    const gate = s.store.db.prepare('select reason from judgements order by id desc limit 1').get()
    assert.match(gate.reason, /^sleeping/)

    s.service.wake(chatKey)
    assert.equal(s.service.isSleeping(chatKey), 0)
    await feed(s.service, groupRaw({ id: 8602, ...MEMBERS[0], text: '醒了吗' }))
    assert.equal(s.deliveries.length, 1, '醒来后恢复回复')
  } finally {
    s.dispose()
  }
})

test('概率：replyChance=0 时过闸也不唤起模型，并留下原因', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)], replyChance: 0 },
  })
  try {
    await feed(s.service, groupRaw({ id: 8611, ...MEMBERS[0], text: '在吗' }))
    assert.equal(s.deliveries.length, 0)
    const gate = s.store.db.prepare('select reason from judgements order by id desc limit 1').get()
    assert.match(gate.reason, /^skipped-by-chance/)

    // replyChance=1 时不该消耗随机数、也不该留痕
    const s2 = makeService({ policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)] } })
    try {
      await feed(s2.service, groupRaw({ id: 8612, ...MEMBERS[0], text: '在吗' }))
      assert.equal(s2.deliveries.length, 1)
    } finally {
      s2.dispose()
    }
  } finally {
    s.dispose()
  }
})
/* ---------------- 工具挂载的容错（2026-10-26 回归） ---------------- */

test('工具：ctx.attachments 读取抛错时 setup 不抛（cordis 未 inject 的真实行为）', () => {
  const s = makeService()
  try {
    // 模拟 cordis：没在 inject 里声明的服务，读属性直接抛（不是返回 undefined）
    Object.defineProperty(s.service.ctx, 'attachments', {
      configurable: true,
      get() {
        throw new Error('cannot get property "attachments" without inject')
      },
    })
    const registered = new Set()
    const tools = {
      register(d) {
        registered.add(d.name)
        return () => {}
      },
      schemas: () => [...registered].map(name => ({ name })),
      restrict: () => () => {},
      guard: () => () => {},
    }

    let threw = null
    try {
      s.service.applyGroupToolGuard({ tools }, 'g:1')
    } catch (err) {
      threw = err
    }
    assert.equal(threw, null, 'attachments 读不到不能让 setup 抛错（否则整个会话建不起来）')
    assert.equal(registered.has('qq_get_image'), true, '工具仍然要挂上')
  } finally {
    s.dispose()
  }
})

test('工具：applyToolPolicy 自己抛错时降级为不挂工具，不冒到会话创建', () => {
  const s = makeService()
  try {
    // register 用 getter 抛错：`typeof tools.register` 就会抛，绕过内部各处 try/catch
    const tools = {
      get register() {
        throw new Error('cannot get property "register"')
      },
    }
    let threw = null
    try {
      s.service.applyGroupToolGuard({ tools }, 'g:1')
    } catch (err) {
      threw = err
    }
    assert.equal(threw, null, '工具层任何异常都必须被吃掉')
    assert.equal(s.service.toolStates.has('g:1'), false, '挂不上就不记状态')
  } finally {
    s.dispose()
  }
})

test('批窗口：agent 调用没结束时，后续消息仍能进同一个批（入批不排在回复后面）', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)] },
    judge: { batchWindowMs: 60, batchMaxWaitMs: 2000 },
  })
  let release = () => {}
  try {
    const chatKey = `g:${GROUP_ID}`
    // 手动往 per-chat 串行链塞一个长任务，模拟"agent 调用耗时几十秒"占住链
    const stuck = new Promise(r => {
      release = r
    })
    s.service.push(chatKey, () => stuck)

    s.service.handleInbound(groupRaw({ id: 8801, ...MEMBERS[0], text: '第一句' }))
    // 批窗口到点 → flushBatch 排在被占住的链后面
    await new Promise(r => setTimeout(r, 150))

    /**
     * 链被占住时再来一条。
     *
     * 以前 `handleInbound` 把整个 handleGroup 塞进链里，这条消息的**入批**要排在
     * 长任务后面 —— 等它执行时批窗口早过了，于是永远单条成批（一句一回复）。
     */
    s.service.handleInbound(groupRaw({ id: 8802, ...MEMBERS[0], text: '第二句' }))
    const b = s.service.batches.get(chatKey)
    assert.ok(b, '第二条必须已经入批（不能被上一条的 agent 调用堵住）')
    /**
     * 两条都在同一个批里 —— 这才是修复的证明。
     *
     * 旧实现里第一条的 flushBatch 会占住链，第二条的入批排在它后面；
     * 等轮到第二条时旧批已被取走，于是新建一个只含自己的批（一句一回复）。
     */
    assert.equal(b.evs.length, 2, '两条应该待在同一个批里')
    assert.equal(String(b.evs[1].messageId), '8802')
  } finally {
    release()
    await new Promise(r => setTimeout(r, 60))
    s.dispose()
  }
})

test('批窗口：代表消息恒取最后一条（回复不该挂在更早的 @ 上）', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)] },
    judge: { batchWindowMs: 40, batchMaxWaitMs: 2000 },
  })
  try {
    const chatKey = `g:${GROUP_ID}`
    const delivered = []
    s.service.deliver = async (ev, judgement, extra) => {
      delivered.push({ messageId: ev.messageId, size: extra?.batch?.length ?? 0 })
    }
    // 第一条 @，第二条普通：代表消息必须是第二条
    await feed(s.service, groupRaw({ id: 8811, ...MEMBERS[0], text: '@你 帮我看下', atMe: true }))
    await feed(s.service, groupRaw({ id: 8812, ...MEMBERS[1], text: '后面这句才是最新的' }))

    assert.ok(await waitFor(() => delivered.length === 1), '应该合并成一次投递')
    assert.equal(String(delivered[0].messageId), '8812', '回复要挂在最新那条，不是更早的 @')
    assert.equal(delivered[0].size, 2)
  } finally {
    s.dispose()
  }
})

test('概率：被 @ 时不掷骰子（replyChance=0 也一定回）', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)], replyChance: 0 },
  })
  try {
    await feed(s.service, groupRaw({ id: 8621, ...MEMBERS[0], text: '在吗', at: true }))
    assert.equal(s.deliveries.length, 1, '点名的场合不该被概率挡掉')
    const judged = s.store.db.prepare('select count(*) n from judgements').get().n
    assert.equal(judged, 0, '免疫时不该留 skipped-by-chance 记录')

    // 不 @ 的照旧被挡（证明概率本身还生效）
    await feed(s.service, groupRaw({ id: 8622, ...MEMBERS[0], text: '随便说一句' }))
    assert.equal(s.deliveries.length, 1, '不点名时仍按概率挡')
    const gate = s.store.db.prepare('select reason from judgements order by id desc limit 1').get()
    assert.match(gate.reason, /^skipped-by-chance/)
  } finally {
    s.dispose()
  }
})

test('概率：批里任意一条 @ 就整批都回（代表消息是最后一条，@ 常在前面）', async () => {
  const s = makeService({
    policy: { groupTrigger: 'agent', groupWhitelist: [String(GROUP_ID)], replyChance: 0 },
    judge: { batchWindowMs: 40, batchMaxWaitMs: 600 },
  })
  try {
    await feed(s.service, groupRaw({ id: 8631, ...MEMBERS[0], text: '先垫一句' }))
    await feed(s.service, groupRaw({ id: 8632, ...MEMBERS[1], text: '叫你一下', at: true }))
    await feed(s.service, groupRaw({ id: 8633, ...MEMBERS[0], text: '后面还有一句' }))

    assert.ok(await waitFor(() => s.deliveries.length === 1), '批里只要有 @ 就该回')
    assert.equal(s.deliveries.length, 1, '整批只回一次')
  } finally {
    s.dispose()
  }
})

/* ---------------- 私聊：不掷骰子，但攒批 ---------------- */

test('私聊：不掷骰子（replyChance=0 也回），且连发会合并成一次', async () => {
  const s = makeService({
    policy: { whitelist: ['10001'], replyChance: 0 },
    judge: { batchWindowMs: 40, batchMaxWaitMs: 600 },
  })
  try {
    const raw = id => ({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: SELF_ID,
      user_id: 10001,
      message_id: id,
      message: [{ type: 'text', data: { text: `第${id}句` } }],
      raw_message: `第${id}句`,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 10001, nickname: '测试者' },
    })

    s.service.handleInbound(raw(9401))
    s.service.handleInbound(raw(9402))
    s.service.handleInbound(raw(9403))
    assert.equal(s.deliveries.length, 0, '批窗口内不该立刻投递')

    assert.ok(await waitFor(() => s.deliveries.length === 1), '静默窗口到点后要合并成一次')
    assert.equal(s.deliveries.length, 1, '三条连发只能产生 1 次模型调用')
    assert.match(s.deliveries[0].prompt, /连着发了这 3 条/, '三条要作为一批交给模型')

    // 私聊不掷骰子：不该出现 skipped-by-chance 记录
    const skipped = s.store.db.prepare("select count(*) n from judgements where reason like 'skipped-by-chance%'").get().n
    assert.equal(skipped, 0, '私聊不该被概率挡')
  } finally {
    s.dispose()
  }
})

test('管理员名单：只认 tools.adminOwners，留空就是没人能踢（fail-closed）', () => {
  // 留空绝不回落到私聊白名单：那等于给所有"能私聊"的人自动发管理权限
  const a = makeService({ policy: { whitelist: ['111'] } })
  try {
    assert.equal(a.service.adminOwners().size, 0, '留空 = 没有管理员，不能回落')
  } finally {
    a.dispose()
  }

  const b = makeService({ policy: { whitelist: ['111'] }, tools: { adminOwners: ['222', '333'] } })
  try {
    assert.deepEqual([...b.service.adminOwners()].sort(), ['222', '333'], '单独配了就只认这份')
  } finally {
    b.dispose()
  }
})

/* ---------------- 正文不自动转发 ---------------- */

test('正文不自动转发：没调发送工具就不发，落库 unforwarded 并计数', () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    s.service.onAssistant(chatKey, '这句话不该发到群里')
    assert.equal(sent.length, 0, 'tool 模式不能自动转发')
    assert.equal(s.service.stats.withheld, 1, '要能看出它说了但没发')
    const rows = s.store.listMessages(chatKey, { direction: 'out' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'unforwarded', '控制台要能看到"想了但没说"')
  } finally {
    s.dispose()
  }
})

test('本回合调过发送工具 → 正文不再重复发一遍', () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    const sent = attachOutbox(s)
    let taken = 0
    s.service.toolStates.set(chatKey, {
      consumeSent: () => {
        taken += 1
        return taken === 1 ? 1 : 0
      },
    })
    s.service.onAssistant(chatKey, '这段正文不该再发一遍')
    assert.equal(sent.length, 0, '工具已发过，正文不能再发一次')
    assert.equal(s.service.stats.withheld, 0, '发过就不算 withheld')
  } finally {
    s.dispose()
  }
})

/* ---------------- 沉睡：被点名要强制唤醒 ---------------- */

test('沉睡：@ 强制唤醒并清状态（不是只放行这一条）', () => {
  const s = makeService()
  try {
    const chatKey = `g:${GROUP_ID}`
    s.service.setSleep(chatKey, 60)
    assert.ok(s.service.isSleeping(chatKey) > 0, '先确认真的睡着了')

    assert.ok(s.service.sleepGate(chatKey, { kind: 'group', atMe: false, messageId: '1' }), '普通消息仍被挡')

    assert.equal(s.service.sleepGate(chatKey, { kind: 'group', atMe: true, messageId: '2' }), null, '@ 要放行')
    assert.equal(s.service.isSleeping(chatKey), 0, '@ 之后要真的醒')
    assert.equal(
      s.service.sleepGate(chatKey, { kind: 'group', atMe: false, messageId: '3' }),
      null,
      '醒后普通消息也不再挡（否则观感是"叫一下动一下"）',
    )
  } finally {
    s.dispose()
  }
})

test('沉睡：私聊与拍一拍也强制唤醒', () => {
  const s = makeService()
  try {
    const pk = 'u:10001'
    s.service.setSleep(pk, 60)
    assert.equal(s.service.sleepGate(pk, { kind: 'private', messageId: '1' }), null, '私聊不该被沉睡挡住')
    assert.equal(s.service.isSleeping(pk), 0)

    const gk = `g:${GROUP_ID}`
    s.service.setSleep(gk, 60)
    assert.equal(
      s.service.sleepGate(gk, { kind: 'group', atMe: false, messageId: 'poke-1700000000-10001' }),
      null,
      '拍一拍等于点名',
    )
    assert.equal(s.service.isSleeping(gk), 0)
  } finally {
    s.dispose()
  }
})

/* ---------------- 主动发言：安静时段 ---------------- */

test('安静时段：跨零点能判断（23:00–07:00）', () => {
  const s = makeService({ proactive: { enabled: true, quietHours: ['23:00', '07:00'] } })
  try {
    const at = h => new Date(2026, 9, 27, h, 30, 0)
    assert.equal(s.service.inQuietHours(['23:00', '07:00'], at(23)), true, '23:30 在安静时段内')
    assert.equal(s.service.inQuietHours(['23:00', '07:00'], at(2)), true, '凌晨 2:30 也在')
    assert.equal(s.service.inQuietHours(['23:00', '07:00'], at(12)), false, '中午不在')
    assert.equal(s.service.inQuietHours(['23:00', '07:00'], at(7)), false, '7:00 已过界')
    // 同起止视为不启用，而不是"全天安静"
    assert.equal(s.service.inQuietHours(['08:00', '08:00'], at(12)), false)
  } finally {
    s.dispose()
  }
})

test('主动发言：未开启时到点也不唤起（默认关）', async () => {
  const s = makeService()
  try {
    let delivered = 0
    s.service.router.deliver = async () => {
      delivered += 1
    }
    await s.service.openProactive(`g:${GROUP_ID}`, { hint: '测试' })
    assert.equal(delivered, 0, '默认关闭时不该唤起模型')
  } finally {
    s.dispose()
  }
})
