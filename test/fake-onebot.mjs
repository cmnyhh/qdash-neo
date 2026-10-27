/**
 * 假 OneBot v11 服务端 —— 集成测试用：
 *
 *   1. 起一个 WS 服务端冒充 SnowLuma
 *   2. 客户端（qdash-neo）连上后按脚本推事件
 *   3. 记录所有收到的 action（尤其 send_private_msg / send_group_msg 的文本）
 *   4. 打印结论并给出退出码
 *
 * 两个场景（`FAKE_SCENARIO`）：
 *
 *   private（默认）
 *     正常 → 重复 → 新消息，期望 **2 条回复**（重复的那条要 0 回复）
 *
 *   group
 *     连续 **10 条群消息**（3 个成员轮流发，其中 2 个不在私聊白名单里），
 *     期望 **1 ≤ 回复 ≤ 3**：配额（groupReplyQuota.maxReplies=3）必须生效，
 *     但也不能一条都不回（那就成了"群开关打开却永远沉默"）。
 *     若设了 `QDN_FAKE_LOG`，还会断言判定的 prompt 里带上了更早的群聊记录
 *     ——「听得见」这件事只有这样才能自动化验证。
 *
 * 为什么要有它：真 QQ 需要人手动发消息，而链路里最容易出错的是
 * `ensure()` / `session/event` / outbox / sendText / 上下文拼接 这几段 ——
 * 它们必须能自动化回归。
 *
 * 跑法：
 *   node test/fake-onebot.mjs                              # 私聊场景，127.0.0.1:3999
 *   FAKE_SCENARIO=group node test/fake-onebot.mjs           # 群场景
 *   FAKE_PORT=4000 FAKE_SCENARIO=group node test/fake-onebot.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const PORT = Number(process.env.FAKE_PORT ?? 3999)
const SELF_ID = Number(process.env.FAKE_SELF_ID ?? 100000001)
const USER_ID = Number(process.env.FAKE_USER_ID ?? 10001)
const GROUP_ID = Number(process.env.FAKE_GROUP_ID ?? 777888)
const SCENARIO = process.env.FAKE_SCENARIO === 'group' ? 'group' : 'private'
const FAKE_LOG = process.env.QDN_FAKE_LOG || ''
/**
 * 断言窗口：假模型 24s 够用，真模型一轮 turn 可能十几秒（还要排 10 条判定），
 * 所以真 LLM 集成测试用 `FAKE_REPORT_MS=180000` 把窗口拉长。
 */
const REPORT_MS = Number(process.env.FAKE_REPORT_MS ?? 24_000)
/** 群消息之间的间隔：真模型判定慢时不必挤在一起 */
const PUSH_GAP_MS = Number(process.env.FAKE_PUSH_GAP_MS ?? 1500)
/** 群场景里第几条 @ 机器人；`-1` = 不 @（整批都要走模型判定，验"合并后一起判"） */
const AT_INDEX = Number(process.env.FAKE_AT_INDEX ?? 0)

/** 宿主的 node_modules 里有 `ws`（插件目录里没有）：优先 QDN_HOST_MODULES，否则从启动脚本往上找 */
function resolveWs() {
  const extra = process.env.QDN_HOST_MODULES
  if (extra) {
    for (const root of extra.split(';')) {
      const pkgJson = join(root, 'ws', 'package.json')
      if (existsSync(pkgJson)) return createRequire(pkgJson)('ws')
    }
  }
  for (const argvPath of process.argv.slice(1)) {
    let dir = dirname(argvPath)
    for (let i = 0; i < 8; i++) {
      const pkgJson = join(dir, 'node_modules', 'ws', 'package.json')
      if (existsSync(pkgJson)) return createRequire(pkgJson)('ws')
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  throw new Error('find ws failed: 设 QDN_HOST_MODULES 或从 DSH 的 node_modules 里跑')
}

// 每次跑都从干净的日志开始：否则上一次的 judge 记录会让上下文断言假通过
if (FAKE_LOG) rmSync(FAKE_LOG, { force: true })

const { WebSocketServer } = resolveWs()
const t0 = Date.now()
const log = (...a) => console.log(`[fake +${Date.now() - t0}ms]`, ...a)

const replies = []
const actions = []

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('fake onebot\n')
})

const wss = new WebSocketServer({ server })

/** 群场景的发言者：前两个故意不在私聊白名单（10001）里 —— 他们说的话也必须"听得见" */
const MEMBERS = [
  { id: 20001, name: '路人甲' },
  { id: 20002, name: '路人乙' },
  { id: USER_ID, name: '测试者' },
]

const GROUP_TEXTS = [
  '今天中午吃啥',
  '刚看到楼下新开了家面馆',
  '周日有人打球吗',
  '这周的需求终于上线了',
  '天气突然就冷了',
]

wss.on('connection', (ws, req) => {
  log(`客户端已连接 token=${req.headers.authorization ? 'header' : 'none'} scenario=${SCENARIO}`)

  const send = payload => {
    ws.send(JSON.stringify(payload))
    return payload
  }

  const pushPrivate = (messageId, text) => {
    log(`-> 推入私聊 id=${messageId} text=${text}`)
    send({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: SELF_ID,
      user_id: USER_ID,
      message_id: messageId,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: USER_ID, nickname: '测试者' },
    })
  }

  const pushGroup = (messageId, text, member, { at = false } = {}) => {
    log(`-> 推入群消息 id=${messageId} from=${member.name}(${member.id}) at=${at} text=${text}`)
    send({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: SELF_ID,
      group_id: GROUP_ID,
      user_id: member.id,
      message_id: messageId,
      message: at
        ? [{ type: 'at', data: { qq: String(SELF_ID) } }, { type: 'text', data: { text } }]
        : [{ type: 'text', data: { text } }],
      raw_message: text,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: member.id, nickname: member.name, card: member.name },
    })
  }

  ws.on('message', raw => {
    let req2
    try {
      req2 = JSON.parse(raw.toString())
    } catch {
      log('收到非 JSON，忽略')
      return
    }
    actions.push(req2)
    const { action, echo, params } = req2

    if (action === 'get_login_info') {
      return send({ status: 'ok', retcode: 0, echo, data: { user_id: SELF_ID, nickname: 'fake-bot' } })
    }
    if (action === 'get_status') {
      return send({ status: 'ok', retcode: 0, echo, data: { online: true, good: true } })
    }
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      const text = Array.isArray(params?.message)
        ? params.message.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('')
        : String(params?.message ?? '')
      replies.push({ action, to: params?.user_id ?? params?.group_id, text })
      log(`<- 出站回复 [${action}] to=${params?.user_id ?? params?.group_id} text=${text}`)
      return send({ status: 'ok', retcode: 0, echo, data: { message_id: 9000 + replies.length } })
    }
    send({ status: 'ok', retcode: 0, echo, data: {} })
  })

  // 心跳：让客户端 healthy() 为真
  const hb = setInterval(() => {
    if (ws.readyState === 1) send({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: SELF_ID, time: Math.floor(Date.now() / 1000) })
  }, 3000)

  ws.on('close', () => {
    clearInterval(hb)
    log('客户端断开')
  })

  // message_id 每次运行都不同：否则跨重启会被 (chat_key, qq_msg_id) 唯一约束当重复丢掉，
  // 那验的是去重、不是 resume。要固定 id 就设 FAKE_MSG_BASE。
  const base = Number(process.env.FAKE_MSG_BASE ?? (Date.now() % 900000) * 10)

  if (SCENARIO === 'group') {
    // 10 条群消息，间隔 1.5s：足够慢到不撞限流、又足够快让 10 条都落在同一个配额窗口里。
    // 第 1 条让**非私聊白名单成员** @ 机器人（`FAKE_AT_INDEX=-1` 可关掉）：
    //   1. 真模型对纯闲聊一律判沉默（2026-10-26 实测 0/10），没有一条确定性触发的话，
    //      "投递链路"和"配额"就都验不到 —— 断言会退化成"0 条也 PASS"
    //   2. 它来自 20001（不在白名单），顺带证明"群消息不受私聊白名单约束"
    //   3. 关掉 @ 时整批都要进模型判定，用来验"合并后的多条一起判"这条路径
    for (let i = 0; i < 10; i++) {
      const member = MEMBERS[i % MEMBERS.length]
      const text = `群消息第${i + 1}条：${GROUP_TEXTS[i % GROUP_TEXTS.length]}`
      setTimeout(() => pushGroup(base + i + 1, text, member, { at: i === AT_INDEX }), 2000 + i * PUSH_GAP_MS)
    }
    setTimeout(reportGroup, REPORT_MS)
  } else {
    setTimeout(() => pushPrivate(base + 1, '你好'), 2000)
    setTimeout(() => pushPrivate(base + 1, '你好'), 6000) // 同一个 message_id：必须只回一次
    setTimeout(() => pushPrivate(base + 2, '第二条'), 9000)
    setTimeout(reportPrivate, REPORT_MS)
  }

  function reportPrivate() {
    log('================ 结论（私聊）================')
    log(`收到 action 共 ${actions.length} 条：${[...new Set(actions.map(a => a.action))].join(',')}`)
    log(`出站回复 ${replies.length} 条：`)
    for (const r of replies) log(`   ${r.action} to=${r.to} :: ${r.text}`)
    const expect = 2
    log(replies.length === expect ? `PASS：回复数 ${replies.length} == ${expect}（重复消息被去重）` : `FAIL：回复数 ${replies.length}，期望 ${expect}`)
    log('==========================================')
    finish(replies.length === expect)
  }

  function reportGroup() {
    log('================ 结论（群）================')
    log(`收到 action 共 ${actions.length} 条：${[...new Set(actions.map(a => a.action))].join(',')}`)
    const groupReplies = replies.filter(r => r.action === 'send_group_msg')
    log(`群回复 ${groupReplies.length} 条（期望 1..3，配额上限 3）：`)
    for (const r of groupReplies) log(`   ${r.action} to=${r.to} :: ${r.text}`)

    const quotaOk = groupReplies.length >= 1 && groupReplies.length <= 3
    log(quotaOk ? `PASS：配额生效，10 条群消息回了 ${groupReplies.length} 条` : `FAIL：群回复 ${groupReplies.length} 条，期望 1..3`)

    const ctx = checkContext()
    log(
      ctx === null
        ? 'SKIP：未设置 QDN_FAKE_LOG，"上下文是否带上了更早的群聊"未验证'
        : ctx
          ? 'PASS：判定 prompt 里带上了更早的群聊记录（听得见）'
          : 'FAIL：判定 prompt 里没有更早的群聊记录（上下文没拼进去）',
    )
    log('==========================================')
    finish(quotaOk && ctx !== false)
  }

  /** @returns {boolean|null} null = 没日志可查（跳过），不是失败 */
  function checkContext() {
    if (!FAKE_LOG || !existsSync(FAKE_LOG)) return null
    const lines = readFileSync(FAKE_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch (err) {
          log(`日志行解析失败 name=${err?.name} msg=${err?.message}`)
          return null
        }
      })
      .filter(Boolean)
    const judges = lines.filter(l => l.kind === 'judge')
    log(`假模型记录：判定 ${judges.length} 次，回答 ${lines.filter(l => l.kind === 'answer').length} 次`)
    return judges.some(l => l.payload.includes('群消息第1条'))
  }

  function finish(pass) {
    setTimeout(() => {
      server.close()
      process.exit(pass ? 0 : 1)
    }, 300)
  }
})

server.listen(PORT, '127.0.0.1', () => log(`假 OneBot 监听 ws://127.0.0.1:${PORT}`))
