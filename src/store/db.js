/**
 * sqlite 存储层。
 *
 * 与 03 §4 的唯一差异：用 **`node:sqlite`（Node 内置）** 而不是 better-sqlite3。
 * 理由是本机没有 C++ 编译器（AGENTS.md §5，`koffi` 就是这么装不上的），
 * 而 node:sqlite 的同步 API 与 better-sqlite3 几乎同形（exec/prepare/run/get），
 * 换回去只改这一个文件。
 *
 * 写操作一律同步短事务；**禁止在事件回调里做长查询**（03 §4）。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 出站分片的消息 id：`out:<ts>:<n>` 是 replyId，末尾再挂 `:<i>` 是第 i 片（M2）。
 * 用它把"库里按片存"折回"模型眼里一次回复一条"，不需要额外的列。
 */
const OUT_SHARD = /^(out:\d+:\d+):(\d+)$/

/** 分片 id → 所属回复 id；不是分片返回 null */
function shardBase(id) {
  return OUT_SHARD.exec(id ?? '')?.[1] ?? null
}

/**
 * 把**同一回复**的连续分片合并成一行（入参必须是按时间正序的原始行）。
 *
 * 为什么要在这一层合并：`messages` 里按片存是为了控制台能看出"第 3 片死了"，
 * 但喂给模型的"我说过什么"必须是一次回复一条 —— 否则一次 800 字回复拆 5 片，
 * 重启恢复后模型看到 5 条碎句，20 条的窗口被自己吃掉 5 格。
 * 合并后 `text` 是各片按序拼接（未送达的片本来就不在 `state='sent'` 里），
 * `messageId` 用 replyId，与内存里 `rememberOutbound` 写入的那条对齐。
 */
function mergeOutboundShards(rowsAsc) {
  const out = []
  // 单独记住"上一条属于哪个 replyId"：push 进去的行已经把 id 改写成 replyId 了，
  // 若再从它身上解析分片号，第二次就匹配不上（这个坑单测会直接抓到）
  let lastBase = null
  for (const r of rowsAsc) {
    const base = r.direction === 'out' ? shardBase(r.qq_msg_id) : null
    if (base && lastBase === base) {
      const prev = out[out.length - 1]
      prev.text = `${prev.text ?? ''}\n${r.text ?? ''}`
      prev.ts = r.ts // 用最后一片的时间：这条回复"说完了"的时刻
      continue
    }
    out.push(base ? { ...r, qq_msg_id: base } : { ...r })
    lastBase = base
  }
  return out
}

const SCHEMA = `
create table if not exists chats (
  chat_key text primary key,
  kind text not null, chat_id text not null, title text,
  mode text not null default 'chat', preset text not null default 'qq-chat', persona_id text,
  session_id text, status text not null default 'active',
  last_msg_id text, created_at integer, updated_at integer
);
create table if not exists messages (
  id integer primary key, chat_key text not null, qq_msg_id text not null,
  direction text not null, sender_id text, sender_name text, text text,
  ts integer not null, state text,
  -- 是否 @ 了机器人：重启恢复上下文时要用，否则历史里"谁 @ 过我"全丢
  at_me integer not null default 0,
  -- 这条消息带的图片 id（image_mark 靠它找回"哪条消息该更新"）
  image_file text,
  unique(chat_key, qq_msg_id)
);
create index if not exists idx_msg_chat_ts on messages(chat_key, ts desc);
create table if not exists usage (
  id integer primary key, chat_key text, ts integer not null,
  model text, stage text default 'answer',
  provider text, in_tokens integer, cache_hit integer, out_tokens integer,
  cost real, hour_bucket integer
);
create index if not exists idx_usage_ts on usage(ts);
create table if not exists outbox (
  id integer primary key, chat_key text not null, kind text not null default 'text',
  payload text not null, reply_to text, attempts integer not null default 0,
  next_at integer not null default 0, state text not null default 'pending',
  created_at integer not null
);
create table if not exists judgements (
  id integer primary key, chat_key text not null, qq_msg_id text,
  layer text not null, verdict text not null, score real,
  -- code 是机器可读的原因码（REASON.*），reason 是给人看的中文说明：前者能建索引查"为什么没回"
  code text, reason text, cost_ms integer, ts integer not null,
  -- 批窗口之后，一次判定可能覆盖多条消息：batch_size + 这几条的 id
  batch_size integer not null default 1, qq_msg_ids text
);
create index if not exists idx_judgements_ts on judgements(ts);

-- 长期记忆：三类结构化笔记。刻意不做向量检索 —— 每次直接注入，可解释、可预算。
-- unique 用来去重：同一句话再记一次只更新时间戳和权重，不新增行。
create table if not exists memories (
  id integer primary key,
  chat_key text not null,
  kind text not null,                 -- topic | thought | impression
  target text not null default '',    -- impression 的对象（群友名 / QQ 号）
  text text not null,
  evidence text,                      -- 凭什么记的（哪条消息 / 谁说的）
  weight integer not null default 1,  -- 被提到/确认的次数
  created_at integer not null,
  last_seen_at integer not null,
  expires_at integer,
  unique(chat_key, kind, target, text)
);
create index if not exists idx_memories_chat on memories(chat_key, kind, last_seen_at desc);

create table if not exists kv (k text primary key, v text not null);

-- 配置变更审计（M3 可写控制台）：谁在什么时候把哪个字段从什么改成了什么。
-- 没有它，"为什么行为变了"只能靠翻宿主日志，而日志会被轮转掉。
create table if not exists config_audit (
  id integer primary key,
  at integer not null,
  path text not null,
  from_value text,
  to_value text,
  actor text not null default ''
);
create index if not exists idx_config_audit_at on config_audit(at desc);
`

/**
 * 默认数据库路径。
 *
 * **必须跟随 `DSH_HOME`**：宿主把 `DSH_HOME` 指到别处时（服务器上用
 * `/opt/dsh-home-official`），数据就该跟着走。之前硬编码 `~/.dsh`，
 * 结果是同一个账号跑两个 profile、或者自定义 `DSH_HOME` 时，
 * 两份实例会写到同一个库上互相踩 —— 而这件事只有在"改过 DSH_HOME 的部署"里
 * 才会暴露，本地开发永远看不到。
 *
 * 顺序：`DSH_HOME/storages/qdash-neo.db` → `~/.dsh/storages/qdash-neo.db`。
 * 用户仍然可以用 `store.path` 显式覆盖。
 */
export function defaultDbPath() {
  const home = String(process.env.DSH_HOME ?? '').trim()
  const base = home || join(homedir(), '.dsh')
  return join(base, 'storages', 'qdash-neo.db')
}

/**
 * 控制台传来的 `limit` 不可信：夹在 1..max。
 * 一条 URL 就能把同步 sqlite 拖住的话，卡的是整个宿主进程，不是那个浏览器标签页。
 */
function clampLimit(value, fallback = 50, max = 200) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export class Store {
  /**
   * @param {string} [path] 省略则落到 ~/.dsh/storages/qdash-neo.db
   */
  constructor(path = '') {
    // QDN_DB 给集成测试/多实例用：不改代码就能换库，避免测试写脏线上库
    this.path = path || process.env.QDN_DB || defaultDbPath()
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec('pragma journal_mode = wal')
    this.db.exec('pragma busy_timeout = 3000')
    this.db.exec(SCHEMA)
    // 老库补列：create table if not exists 不会给已有表加字段。
    // **加列**不重写行（有 default 就安全），比"改已有字段类型/回填数据"风险低得多；
    // 但仍然只补自己有把握的列，不做数据回填。
    this.ensureColumn('judgements', 'batch_size', 'integer not null default 1')
    this.ensureColumn('judgements', 'qq_msg_ids', 'text')
    this.ensureColumn('judgements', 'code', 'text')
    this.ensureColumn('messages', 'at_me', 'integer not null default 0')
    /**
     * 图片 id（`image_mark` 靠它找回"哪条消息该更新"）。
     *
     * **幂等**：`ensureColumn` 会先查 `pragma table_info`，已有就跳过 ——
     * 这里不做回填，老消息的 `image_file` 保持 null。
     * 那些老消息的 `text` 里还是 `[图片:xxx]` 形式，靠下面
     * `migrateLegacyImageTags()` 一次性抽出来。
     */
    this.ensureColumn('messages', 'image_file', 'text')
    this.migrateLegacyImageTags()
  }

  /**
   * **把老消息里的 `[图片:X.jpg]` 抽成 `image_file` 列，text 换成描述或 `[图片]`。**
   *
   * 为什么要动历史数据：新代码不再做"渲染时替换"，老消息如果还留着
   * `[图片:9C62A6A12E33725B...]`，模型看到的就是一串哈希 —— 比没有更糟。
   *
   * **幂等**：处理完写一个 kv 标记，之后启动直接跳过。
   * 只扫 `image_file is null` 且 text 里含 `[图片:` 的行，量很小。
   */
  migrateLegacyImageTags() {
    const FLAG = 'schema:migrated:image_file'
    try {
      if (this.kvGet(FLAG)) return
      const RE = /\[图片:([^\]]+)\]/

      // ① messages
      const rows = this.db
        .prepare(`select id, text from messages where image_file is null and text like '%[图片:%'`)
        .all()
      const upd = this.db.prepare('update messages set image_file = ?, text = ? where id = ?')
      for (const r of rows) {
        const m = RE.exec(String(r.text ?? ''))
        if (!m) continue
        const desc = String(this.kvGet(`image:desc:${m[1]}`) ?? '').trim()
        upd.run(m[1], desc ? `[图片 ${desc}]` : '[图片]', r.id)
      }

      // ② memories：记忆里引用的同一张图，同样只保留描述
      const mems = this.db.prepare(`select id, text from memories where text like '%[图片:%'`).all()
      const updMem = this.db.prepare('update memories set text = ? where id = ?')
      for (const r of mems) {
        const next = String(r.text ?? '').replace(/\[图片:([^\]]+)\]/g, (_m, f) => {
          const d = String(this.kvGet(`image:desc:${f}`) ?? '').trim()
          return d ? `[图片 ${d}]` : '[图片]'
        })
        if (next !== r.text) updMem.run(next, r.id)
      }

      this.kvSet(FLAG, String(Date.now()))
      if (rows.length || mems.length) {
        console.log(`qdash-neo: 迁移图片占位 消息 ${rows.length} 条 / 记忆 ${mems.length} 条`)
      }
    } catch (err) {
      // 迁移失败不该挡住启动：下轮还会再试
      console.log(`qdash-neo: 迁移图片占位失败 msg=${err?.message}`)
    }
  }

  /** @param {string} table @param {string} column @param {string} ddl 列定义（不含列名） */
  ensureColumn(table, column, ddl) {
    const cols = this.db.prepare(`pragma table_info(${table})`).all().map(c => String(c.name))
    if (!cols.includes(column)) this.db.exec(`alter table ${table} add column ${column} ${ddl}`)
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已经关了：重复 close 不是错误 */
    }
  }

  /**
   * 落一条消息；靠 unique(chat_key, qq_msg_id) 做**跨重启**去重。
   * @returns {boolean} 是否真的插入（false = 已存在）
   */
  insertMessage({
    chatKey, qqMsgId, direction, senderId = '', senderName = '', text = '',
    state = '', ts = Date.now(), atMe = 0, imageFile = '',
  }) {
    const stmt = this.db.prepare(
      `insert into messages (chat_key, qq_msg_id, direction, sender_id, sender_name, text, ts, state, at_me, image_file)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(chat_key, qq_msg_id) do nothing`,
    )
    const res = stmt.run(
      chatKey,
      qqMsgId,
      direction,
      senderId,
      senderName,
      text,
      ts,
      state,
      atMe ? 1 : 0,
      String(imageFile ?? '') || null,
    )
    return Number(res.changes) > 0
  }

  /** 出站状态流转：queued → sent / dead。状态停在 queued 会让控制台骗人 */
  markMessageState(chatKey, qqMsgId, state) {
    this.db
      .prepare('update messages set state = ? where chat_key = ? and qq_msg_id = ?')
      .run(state, chatKey, qqMsgId)
  }

  /**
   * **按 QQ 消息 id 反查原文** —— 用于"这条在回复哪一句"。
   *
   * 入站的 `qq_msg_id` 就是 QQ 的 message_id，`reply` 段里的 id 能直接对上。
   * 出站的消息**发出去后会回填真实 id**（见 `replaceQqMsgId`），所以
   * "用户回复你发的图"也能查到。
   *
   * @param {string} chatKey
   * @param {string} qqMsgId
   * @returns {{ direction: string, sender_name: string, text: string, ts: number }|null}
   */
  messageByQqId(chatKey, qqMsgId) {
    if (!chatKey || !qqMsgId) return null
    try {
      const r = this.db
        .prepare(
          'select direction, sender_name, text, ts from messages where chat_key = ? and qq_msg_id = ? limit 1',
        )
        .get(String(chatKey), String(qqMsgId))
      return r ?? null
    } catch {
      return null
    }
  }

  /**
   * **把自造的 id 换成 QQ 返回的真实 id。**
   *
   * 出站消息落库用的是 `tool:<ts>:<n>` / `out:<ts>:<n>:<i>` —— 那是我们自己的
   * 顺序号，**QQ 不认识**。于是用户长按一条回复时，`reply` 带的是真实 id，
   * 而我们库里只有自造 id，**永远查不到"他回复的是哪一句"**。
   *
   * 现在发送成功后有真实 id 了，就地替换。
   * `unique(chat_key, qq_msg_id)` 可能冲突（极少见），失败就保持原样。
   */
  /**
   * **把"这张图是什么"一次写进三处，单事务。**
   *
   * 这是整个改动的核心：早先 `image_mark` 只写 kv（`image:desc:<file>`），
   * 而 `messages.text` 和 `memories.text` 里还是 `[图片:X.jpg]` —— 于是
   * **渲染层不得不做字符串替换**，而替换点散落在 6 个地方，每加一个
   * 渲染入口就漏一次（已漏过 6 次）。
   *
   * 现在三处一起写，渲染层什么都不用做：
   *
   *   ① kv          image:desc:<file> = 描述（"有没有描述"的唯一真相）
   *   ② messages    按 image_file 找到那条消息，text 换成 `[图片 描述]`
   *   ③ memories    记忆里引用了这张图的地方，同样替换
   *
   * **用一个事务**：三处必须一起成功。只写 kv 不写消息，就是回到老问题；
   * 只写消息不写 kv，下一轮 `context.append` 又查不到描述。
   *
   * @returns {number} 被更新的消息行数（0 表示这条消息不在本会话 / 已更新过）
   */
  setImageDesc(chatKey, file, desc) {
    const f = String(file ?? '').trim()
    const d = String(desc ?? '').trim()
    if (!f || !d) return 0

    const marker = `[图片 ${d}]`
    let changed = 0
    try {
      this.db.exec('begin')
      try {
        // ① kv：写入后 `context.append` 就能查到
        this.kvSet(`image:desc:${f}`, d)

        // ② 落库：按 image_file 精确定位，不靠字符串猜
        const a = this.db
          .prepare('update messages set text = ? where chat_key = ? and image_file = ?')
          .run(marker, String(chatKey), f)
        changed = Number(a.changes)

        // ③ 记忆：老记录里可能引用了这张图的占位
        this.db
          .prepare(`update memories set text = replace(text, ?, ?) where chat_key = ? and text like ?`)
          .run(`[图片:${f}]`, marker, String(chatKey), `%[图片:${f}]%`)

        this.db.exec('commit')
      } catch (err) {
        this.db.exec('rollback')
        throw err
      }
    } catch {
      return 0
    }
    return changed
  }

  replaceQqMsgId(chatKey, oldId, newId) {
    if (!chatKey || !oldId || !newId || String(oldId) === String(newId)) return false
    try {
      const res = this.db
        .prepare('update messages set qq_msg_id = ? where chat_key = ? and qq_msg_id = ?')
        .run(String(newId), String(chatKey), String(oldId))
      return Number(res.changes) > 0
    } catch {
      return false
    }
  }

  upsertChat({ chatKey, kind, chatId, title = '', mode = 'chat', preset = 'qq-chat', sessionId = '', status = 'active' }) {
    const now = Date.now()
    this.db
      .prepare(
        `insert into chats (chat_key, kind, chat_id, title, mode, preset, session_id, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(chat_key) do update set
           title = excluded.title, session_id = excluded.session_id,
           status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(chatKey, kind, chatId, title, mode, preset, sessionId, status, now, now)
  }

  getChat(chatKey) {
    return this.db.prepare('select * from chats where chat_key = ?').get(chatKey)
  }

  listChats(limit = 50) {
    return this.db.prepare('select * from chats order by updated_at desc limit ?').all(limit)
  }

  recordUsage({ chatKey = null, model = '', provider = '', inTokens = 0, outTokens = 0, cost = 0, stage = 'answer', ts = Date.now() }) {
    this.db
      .prepare(
        `insert into usage (chat_key, ts, model, stage, provider, in_tokens, out_tokens, cost, hour_bucket)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatKey, ts, model, stage, provider, inTokens, outTokens, cost, Math.floor(ts / 3_600_000))
  }

  /**
   * 取某个群最近的对话（入站 + 出站），用于重启后恢复上下文。
   *
   * 两个方向的可见状态不同，不能用一个条件糊住：
   *   - 入站 `context` / `delivered` 都算"听过"，`dropped:*` 是被闸门挡掉的
   *   - 出站只有 `sent` 才算"说过"。`queued` 还没发、`dead` 永远发不出去 ——
   *     让它们进上下文，模型会以为自己说过一句实际没送达的话
   *
   * @param {string} chatKey
   * @param {number} limit
   * @returns {Array<{userId:string,senderName:string,text:string,ts:number,messageId:string,
   *                   atMe:boolean,direction:'in'|'out',trusted:boolean}>}
   */
  recentContextMessages(chatKey, limit) {
    const rows = this.db
      .prepare(
        `select qq_msg_id, sender_id, sender_name, text, ts, at_me, direction
           from messages
          where chat_key = ?
            and (
              (direction = 'in' and state in ('context', 'delivered'))
              or (direction = 'out' and state = 'sent')
            )
          order by ts desc, id desc limit ?`,
      )
      .all(chatKey, limit)
    // 出站分片在这里折回一条：恢复进内存的必须是"一次回复一条"，不是 5 条碎句
    return mergeOutboundShards(rows.reverse()).map(r => ({
      userId: r.direction === 'out' ? 'self' : (r.sender_id ?? ''),
      senderName: r.sender_name ?? '',
      text: r.text ?? '',
      ts: r.ts,
      messageId: r.qq_msg_id ?? '',
      atMe: Number(r.at_me) === 1,
      direction: r.direction === 'out' ? 'out' : 'in',
      // 存储层不持有白名单：这里给保守值，GroupContext 会用当前配置重算
      trusted: false,
    }))
  }

  /**
   * 取"某个时间点之前（或排除指定 id 后）"的最近对话，给记忆的「最近对话」段用。
   *
   * 与 `recentContextMessages` 的分工：
   *   - 那个是**重启恢复内存缓冲**，按条数取，参与上下文预算
   *   - 这个是**补一段窗口外的历史**，按 ts 切，专门喂长期记忆
   * 按 `messageId` 排除而不是只按 ts：入站 ts 来自 QQ（秒级），出站是本地毫秒，
   * 同一秒内"他说一句、我回一句"用时间比较会漏或重。
   *
   * @param {string} chatKey
   * @param {{ beforeTs?: number|null, excludeIds?: string[], limit?: number }} [opts]
   * @returns {Array<{userId:string,senderName:string,text:string,ts:number,messageId:string,
   *                   atMe:boolean,direction:'in'|'out',trusted:boolean}>}
   */
  messagesBefore(chatKey, { beforeTs = null, excludeIds = [], limit = 20 } = {}) {
    const excluded = new Set((excludeIds ?? []).filter(Boolean))
    const rows = this.db
      .prepare(
        `select qq_msg_id, sender_id, sender_name, text, ts, at_me, direction
           from messages
          where chat_key = ?
            and (
              (direction = 'in' and state in ('context', 'delivered'))
              or (direction = 'out' and state = 'sent')
            )
            and (? is null or ts < ?)
          order by ts desc, id desc limit ?`,
      )
      // 多取 excluded.size 条：排除窗口内那几句之后仍要凑够 limit
      .all(chatKey, beforeTs, beforeTs, limit + excluded.size)
    // 排除要同时认「分片 id」和「所属回复 id」：内存里记的是后者（rememberOutbound 用 replyId）
    const kept = rows.filter(r => {
      const base = shardBase(r.qq_msg_id)
      return !excluded.has(r.qq_msg_id) && !(base && excluded.has(base))
    })
    return mergeOutboundShards(kept.reverse())
      .slice(-limit)
      .map(r => ({
        userId: r.direction === 'out' ? 'self' : (r.sender_id ?? ''),
        senderName: r.sender_name ?? '',
        text: r.text ?? '',
        ts: r.ts,
        messageId: r.qq_msg_id ?? '',
        atMe: Number(r.at_me) === 1,
        direction: r.direction === 'out' ? 'out' : 'in',
        trusted: false,
      }))
  }

  /**
   * 取某一天（本地时区的 [startTs, endTs)）的全部对话，给日总结用。
   *
   * **首尾各取一半**：只取最新会丢掉当天早上定的事，只取最早会丢掉晚上的收尾。
   * 返回 `total` 让调用方能判断"是否只总结了一部分"。
   *
   * @param {string} chatKey
   * @param {{ startTs: number, endTs: number, limit?: number }} opts
   * @returns {{ rows: object[], total: number }}
   */
  messagesOfDay(chatKey, { startTs, endTs, limit = 300 } = {}) {
    const where = `chat_key = ? and ts >= ? and ts < ?
      and ((direction = 'in' and state in ('context', 'delivered'))
        or (direction = 'out' and state = 'sent'))`
    const cols = 'id, qq_msg_id, sender_id, sender_name, text, ts, at_me, direction'
    const head = Math.ceil(limit / 2)
    const tail = Math.max(0, limit - head)

    const first = this.db
      .prepare(`select ${cols} from messages where ${where} order by ts asc, id asc limit ?`)
      .all(chatKey, startTs, endTs, head)
    const last = tail
      ? this.db
        .prepare(`select ${cols} from messages where ${where} order by ts desc, id desc limit ?`)
        .all(chatKey, startTs, endTs, tail)
      : []

    const seen = new Set()
    const rows = []
    for (const r of [...first, ...last]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      rows.push(r)
    }
    rows.sort((a, b) => a.ts - b.ts || a.id - b.id)

    const total = Number(
      this.db.prepare(`select count(*) as c from messages where ${where}`).get(chatKey, startTs, endTs)?.c ?? rows.length,
    )
    return {
      total,
      rows: rows.map(r => ({
        userId: r.direction === 'out' ? 'self' : (r.sender_id ?? ''),
        senderName: r.sender_name ?? '',
        text: r.text ?? '',
        ts: r.ts,
        messageId: r.qq_msg_id ?? '',
        atMe: Number(r.at_me) === 1,
        direction: r.direction === 'out' ? 'out' : 'in',
        trusted: false,
      })),
    }
  }

  /** 判定记录：判定自身的花费和结论必须可查，否则"为什么没回"永远查不到 */
  /**
   * @param {object} j
   * @param {number} [j.batchSize] 这次判定覆盖了几条消息（批窗口 > 1）
   * @param {string[]} [j.msgIds] 被这次判定覆盖的消息 id（方便"这句为什么没回"回溯）
   * @param {string} [j.code] 机器可读原因码（`REASON.*`），`reason` 是给人看的中文说明
   */
  recordJudgement({
    chatKey,
    qqMsgId = null,
    layer,
    verdict,
    score = null,
    reason = '',
    code = null,
    costMs = null,
    batchSize = 1,
    msgIds = null,
    ts = Date.now(),
  }) {
    this.db
      .prepare(
        `insert into judgements (chat_key, qq_msg_id, layer, verdict, score, reason, code, cost_ms, batch_size, qq_msg_ids, ts)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatKey, qqMsgId, layer, verdict, score, reason, code, costMs, batchSize, msgIds ? msgIds.join(',') : null, ts)
  }

  /** 判定统计（控制台以后要用）：总数/放行数/花费/批次数 */
  judgementStats(windowMs = 24 * 3600 * 1000) {
    const since = Date.now() - windowMs
    return this.db
      .prepare(
        `select count(*) total,
                sum(case when verdict = 'reply' then 1 else 0 end) replied,
                sum(case when layer = 'llm' then 1 else 0 end) llm_calls,
                sum(case when batch_size > 1 then 1 else 0 end) batched,
                sum(batch_size) covered_msgs,
                avg(cost_ms) avg_cost_ms
           from judgements where ts >= ?`,
      )
      .get(since)
  }

  // ---------------- 控制台只读查询 ----------------
  // 全部只读、全部 limit 夹紧、全部参数化。控制台不写库、不建表：
  // 它只是把已经落库的事实换个形状展示，多一个真相源就多一处会不一致的地方。

  /**
   * 会话列表：一条 SQL 取完"消息数 + 死信数 + 未发数 + 最后一条"。
   * 不做 N+1 —— 会话一多就是几十次查询，而这是 5 秒一次的轮询接口。
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Array<object>}
   */
  chatSummaries({ limit = 50 } = {}) {
    const rows = this.db
      .prepare(
        `with last as (
           select chat_key, ts, state, text, direction,
                  row_number() over (partition by chat_key order by ts desc, id desc) rn
             from messages
         ),
         agg as (
           select chat_key, count(*) total,
                  sum(case when state = 'dead' then 1 else 0 end) dead,
                  sum(case when state = 'queued' then 1 else 0 end) queued
             from messages group by chat_key
         )
         select c.chat_key, c.kind, c.chat_id, c.title, c.status, c.session_id, c.preset,
                c.created_at, c.updated_at,
                coalesce(agg.total, 0) msg_count,
                coalesce(agg.dead, 0) dead_count,
                coalesce(agg.queued, 0) queued_count,
                last.ts last_ts, last.state last_state,
                last.text last_text, last.direction last_direction
           from chats c
           left join agg on agg.chat_key = c.chat_key
           left join last on last.chat_key = c.chat_key and last.rn = 1
          order by coalesce(last.ts, c.updated_at) desc
          limit ?`,
      )
      .all(clampLimit(limit))
    return rows.map(r => ({
      chatKey: r.chat_key,
      kind: r.kind,
      chatId: r.chat_id,
      title: r.title ?? '',
      status: r.status ?? '',
      sessionId: r.session_id ?? '',
      preset: r.preset ?? '',
      msgCount: Number(r.msg_count ?? 0),
      deadCount: Number(r.dead_count ?? 0),
      queuedCount: Number(r.queued_count ?? 0),
      updatedAt: r.updated_at ?? null,
      last: r.last_ts == null
        ? null
        : {
            ts: r.last_ts,
            state: r.last_state ?? '',
            text: r.last_text ?? '',
            direction: r.last_direction ?? '',
          },
    }))
  }

  /**
   * 任意状态的消息（控制台看"为什么没回"必须看到 queued / dead / dropped，
   * 不能只取进过上下文的那部分 —— 那恰好是"正常的那些"）。
   *
   * @param {string} chatKey
   * @param {{ limit?: number, state?: string|null, direction?: 'in'|'out'|null }} [opts]
   * @returns {Array<object>} 按时间正序（老的在前，直接渲染成消息流）
   */
  listMessages(chatKey, { limit = 50, state = null, direction = null } = {}) {
    const rows = this.db
      .prepare(
        `select id, qq_msg_id, direction, sender_id, sender_name, text, ts, state, at_me
           from messages
          where chat_key = ?
            and (? is null or state = ?)
            and (? is null or direction = ?)
          order by ts desc, id desc limit ?`,
      )
      .all(chatKey, state, state, direction, direction, clampLimit(limit))
    return rows
      .map(r => ({
        id: r.id,
        messageId: r.qq_msg_id ?? '',
        direction: r.direction === 'out' ? 'out' : 'in',
        userId: r.sender_id ?? '',
        senderName: r.sender_name ?? '',
        text: r.text ?? '',
        ts: r.ts,
        state: r.state ?? '',
        atMe: Number(r.at_me) === 1,
      }))
      .reverse()
  }

  /**
   * 每个状态各多少条。`dropped:*` 会按具体原因分开（duplicate / policy / empty…），
   * 这正是"被哪一层挡的"的直接证据。
   * @param {string} chatKey
   * @returns {Record<string, number>}
   */
  messageStateCounts(chatKey) {
    const rows = this.db
      .prepare('select state, count(*) c from messages where chat_key = ? group by state')
      .all(chatKey)
    /** @type {Record<string, number>} */
    const out = {}
    for (const r of rows) out[String(r.state ?? '')] = Number(r.c ?? 0)
    return out
  }

  /**
   * 判定流水。`qq_msg_ids` 在库里是逗号分隔字符串，这里展开成数组，
   * 前端才能按 messageId 把"这句为什么没回"关联到消息上。
   *
   * @param {{ chatKey?: string|null, limit?: number, verdict?: string|null,
   *           layer?: string|null, since?: number|null }} [opts]
   * @returns {Array<object>}
   */
  listJudgements({ chatKey = null, limit = 50, verdict = null, layer = null, since = null } = {}) {
    const rows = this.db
      .prepare(
        `select id, chat_key, qq_msg_id, layer, verdict, score, code, reason,
                cost_ms, batch_size, qq_msg_ids, ts
           from judgements
          where (? is null or chat_key = ?)
            and (? is null or verdict = ?)
            and (? is null or layer = ?)
            and (? is null or ts >= ?)
          order by ts desc, id desc limit ?`,
      )
      .all(chatKey, chatKey, verdict, verdict, layer, layer, since, since, clampLimit(limit))
    return rows.map(r => {
      const joined = String(r.qq_msg_ids ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      return {
        id: r.id,
        chatKey: r.chat_key,
        messageId: r.qq_msg_id ?? '',
        layer: r.layer,
        verdict: r.verdict,
        score: r.score,
        code: r.code ?? '',
        reason: r.reason ?? '',
        costMs: r.cost_ms,
        batchSize: Number(r.batch_size ?? 1),
        // 老行没有 qq_msg_ids：用代表消息兜底，别让前端拿到空数组
        msgIds: joined.length ? joined : (r.qq_msg_id ? [String(r.qq_msg_id)] : []),
        ts: r.ts,
      }
    })
  }

  /**
   * 用量按「本地日期 × 阶段」聚合。日期用 sqlite 的 localtime，和日总结的
   * `localDay()` 是同一套时区口径 —— 两边算出不同的"今天"会让人怀疑数据。
   *
   * @param {{ days?: number, now?: number }} [opts]
   * @returns {Array<{day:string,stage:string,calls:number,inTokens:number,outTokens:number,cost:number}>}
   */
  usageSummary({ days = 7, now = Date.now() } = {}) {
    const n = clampLimit(days, 7, 90)
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    // 含今天在内共 n 天：今天往前推 n-1 天
    const since = start.getTime() - (n - 1) * 86_400_000
    const rows = this.db
      .prepare(
        `select date(ts / 1000, 'unixepoch', 'localtime') day, stage,
                count(*) calls,
                coalesce(sum(in_tokens), 0) in_tokens,
                coalesce(sum(out_tokens), 0) out_tokens,
                coalesce(sum(cost), 0) cost
           from usage
          where ts >= ?
          group by day, stage
          order by day asc`,
      )
      .all(since)
    return rows.map(r => ({
      day: String(r.day ?? ''),
      stage: String(r.stage ?? 'answer'),
      calls: Number(r.calls ?? 0),
      inTokens: Number(r.in_tokens ?? 0),
      outTokens: Number(r.out_tokens ?? 0),
      cost: Number(r.cost ?? 0),
    }))
  }

  /**
   * 死信列表。**唯一真相源是 `messages.state='dead'`**：
   * `outbox` 表目前没有写入路径（队列在内存里），拿它当死信会永远显示 0 条。
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Array<object>}
   */
  listDeadLetters({ limit = 50 } = {}) {
    return this.db
      .prepare(
        `select m.id, m.chat_key, m.qq_msg_id, m.text, m.ts, m.state,
                c.kind, c.title
           from messages m
           left join chats c on c.chat_key = m.chat_key
          where m.direction = 'out' and m.state = 'dead'
          order by m.ts desc, m.id desc
          limit ?`,
      )
      .all(clampLimit(limit))
      .map(r => ({
        id: r.id,
        chatKey: r.chat_key,
        messageId: r.qq_msg_id ?? '',
        text: r.text ?? '',
        ts: r.ts,
        state: r.state ?? '',
        chatKind: r.kind ?? '',
        chatTitle: r.title ?? '',
      }))
  }

  /** 死信总数：总览要的是"现在有多少",不是"最近 50 条里有多少" */
  countDeadLetters() {
    const row = this.db
      .prepare(`select count(*) c from messages where direction = 'out' and state = 'dead'`)
      .get()
    return Number(row?.c ?? 0)
  }

  // ---------------- 长期记忆 ----------------
  // 只存纯数据（字符串/数字）。原项目踩过「往函数对象上写字段，JSON.stringify 静默丢掉」的坑。

  /**
   * 记一条；同 (chat, kind, target, text) 已存在则只更新时间戳、权重、证据。
   * @param {{ chatKey: string, kind: 'topic'|'thought'|'impression', target?: string,
   *           text: string, evidence?: string, expiresAt?: number|null, ts?: number,
   *           maxTextChars?: number }} m
   *   `maxTextChars` 由配置传进来：200 字会把一条长回复拦腰截断，而 self 存的是原文
   */
  upsertMemory({ chatKey, kind, target = '', text, evidence = '', expiresAt = null, ts = Date.now(), maxTextChars = 600 }) {
    const clean = String(text ?? '').trim().slice(0, maxTextChars)
    if (!chatKey || !kind || !clean) return null
    const targetKey = String(target ?? '')
    this.db
      .prepare(
        `insert into memories (chat_key, kind, target, text, evidence, weight, created_at, last_seen_at, expires_at)
         values (?, ?, ?, ?, ?, 1, ?, ?, ?)
         on conflict(chat_key, kind, target, text) do update set
           last_seen_at = excluded.last_seen_at,
           weight = memories.weight + 1,
           evidence = coalesce(nullif(excluded.evidence, ''), memories.evidence),
           expires_at = coalesce(excluded.expires_at, memories.expires_at)`,
      )
      .run(chatKey, kind, targetKey, clean, String(evidence ?? ''), ts, ts, expiresAt)
    return this.db
      .prepare('select * from memories where chat_key = ? and kind = ? and target = ? and text = ?')
      .get(chatKey, kind, targetKey, clean)
  }

  /**
   * 取一个会话里"还没过期"的记忆，按最后提及时间倒序，每类各取 limit 条。
   * @param {string} chatKey
   * @param {{ now?: number, perKind?: number }} [opts]
   */
  listMemories(chatKey, { now = Date.now(), perKind = 10 } = {}) {
    const rows = this.db
      .prepare(
        `select * from memories
          where chat_key = ? and (expires_at is null or expires_at > ?)
          order by last_seen_at desc, id desc`,
      )
      .all(chatKey, now)
    const out = []
    // 只有老项目那三类社交状态 + 日总结；长期事实与 self 都不再做（外部记忆负责）
    for (const kind of ['topic', 'thought', 'impression', 'daily']) {
      out.push(...rows.filter(r => r.kind === kind).slice(0, perKind))
    }
    return out
  }

  /**
   * 删一条。**必须带 chatKey**：只按 id 删等于给了跨群删别人记忆的入口。
   * @param {string} chatKey @param {number} id
   */
  deleteMemory(chatKey, id) {
    return Number(this.db.prepare('delete from memories where chat_key = ? and id = ?').run(chatKey, id).changes) > 0
  }

  /**
   * 群消息提到某个旧话题时刷新它的活性（只动 last_seen_at，不新增行）。
   * 不刷新的话话题的 last_seen_at 永远停在创建时刻，prune 会把它当成最旧的删掉 ——
   * 哪怕群里正在聊它。
   * @param {string} chatKey @param {number[]} ids @returns {number} 更新了几条
   */
  touchMemories(chatKey, ids, ts = Date.now()) {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    const stmt = this.db.prepare('update memories set last_seen_at = ? where chat_key = ? and id = ?')
    let n = 0
    for (const id of ids) n += Number(stmt.run(ts, chatKey, id).changes)
    return n
  }

  /**
   * @param {string} chatKey
   * @param {''|'topic'|'thought'|'impression'} [kind] 留空 = 全清
   */
  clearMemories(chatKey, kind = '') {
    const stmt = kind
      ? this.db.prepare('delete from memories where chat_key = ? and kind = ?')
      : this.db.prepare('delete from memories where chat_key = ?')
    return Number((kind ? stmt.run(chatKey, kind) : stmt.run(chatKey)).changes)
  }

  /**
   * 容量治理：删过期 + 每类只留最新 N 条。不治理的话状态会无限膨胀（原项目踩过）。
   * @param {string} chatKey
   * @param {{ maxTopics?: number, maxThoughts?: number,
   *           maxImpressions?: number, now?: number }} [opts]
   * @returns {number} 删掉几条
   */
  pruneMemories(
    chatKey,
    { maxTopics = 60, maxThoughts = 60, maxImpressions = 150, now = Date.now() } = {},
  ) {
    let removed = Number(this.db.prepare('delete from memories where chat_key = ? and expires_at is not null and expires_at <= ?').run(chatKey, now).changes)
    const caps = { topic: maxTopics, thought: maxThoughts, impression: maxImpressions }
    for (const [kind, cap] of Object.entries(caps)) {
      // 先按权重再按新鲜度：被反复提到的记忆不该因为"这周没人提"就被淘汰
      const ids = this.db
        // id desc 是稳定 tie-breaker：同一毫秒写入多条时，没有它"哪条被淘汰"不可复现
        .prepare('select id from memories where chat_key = ? and kind = ? order by weight desc, last_seen_at desc, id desc')
        .all(chatKey, kind)
        .map(r => Number(r.id))
      const extra = ids.slice(Math.max(0, cap))
      if (!extra.length) continue
      const del = this.db.prepare('delete from memories where id = ?')
      for (const id of extra) removed += Number(del.run(id).changes)
    }
    return removed
  }

  /**
   * 写入/覆盖某天的总结。
   *
   * 必须 `delete + insert`：唯一约束是 `(chat_key, kind, target, text)`，
   * 直接 upsert 时 text 一变就会多一条 —— 同一天补跑两次就是两份总结，
   * 注入时模型会把它们当成"两天的事"。
   */
  upsertDailySummary({ chatKey, day, text, evidence = '', ts = Date.now(), keepDays = 30 }) {
    const clean = String(text ?? '').trim()
    if (!chatKey || !day || !clean) return null
    this.db
      .prepare(`delete from memories where chat_key = ? and kind = 'daily' and target = ?`)
      .run(chatKey, day)
    this.db
      .prepare(
        `insert into memories (chat_key, kind, target, text, evidence, weight, created_at, last_seen_at, expires_at)
         values (?, 'daily', ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(chatKey, day, clean, String(evidence ?? ''), ts, ts, ts + keepDays * 86_400_000)
    return this.getDailySummary(chatKey, day)
  }

  /** @param {string} chatKey @param {string} day @returns {object|null} */
  getDailySummary(chatKey, day) {
    return this.db
      .prepare(`select * from memories where chat_key = ? and kind = 'daily' and target = ?`)
      .get(chatKey, day) ?? null
  }

  /** 控制台用：每类多少条、最近一次写入 */
  memoryStats(chatKey) {
    return this.db
      .prepare(
        `select kind, count(*) c, max(last_seen_at) last_at
           from memories where chat_key = ? group by kind`,
      )
      .all(chatKey)
  }

  /** 出站入队（M1 只用来兜住发送失败的补偿，M2 才做完整泵） */
  enqueueOutbox({ chatKey, payload, kind = 'text', replyTo = null }) {
    const now = Date.now()
    this.db
      .prepare(
        `insert into outbox (chat_key, kind, payload, reply_to, attempts, next_at, state, created_at)
         values (?, ?, ?, ?, 0, ?, 'pending', ?)`,
      )
      .run(chatKey, kind, payload, replyTo, now, now)
  }

  kvGet(k, fallback = null) {
    const row = this.db.prepare('select v from kv where k = ?').get(k)
    return row ? row.v : fallback
  }

  kvSet(k, v) {
    this.db.prepare('insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, String(v))
  }

  /** 删除一个键。用户层"改回默认值"必须真的删掉覆盖，否则库里留一份和默认值一样的值 */
  kvDel(k) {
    this.db.prepare('delete from kv where k = ?').run(k)
  }

  /**
   * 按前缀列键（`cfg:` / `feature_x:` 这类命名空间用）。
   * 注意 LIKE 的 `%`/`_` 在键名里出现会误匹配，所以 prefix 里不做转义 ——
   * 我们所有前缀都是字面量常量，调用方必须自己保证（写在注释里而不是假装通用）。
   */
  kvList(prefix = '') {
    const rows = this.db.prepare('select k, v from kv where k like ? order by k').all(`${prefix}%`)
    return rows.map(r => ({ key: String(r.k), value: String(r.v) }))
  }

  /**
   * 记一条配置变更审计。
   * 单进程串行写，直接按 rowid 裁剪到最近 max 行：审计表无限长迟早拖慢查询。
   */
  appendConfigAudit({ at = Date.now(), path, fromValue = null, toValue = null, actor = '' } = {}, max = 500) {
    this.db
      .prepare('insert into config_audit (at, path, from_value, to_value, actor) values (?, ?, ?, ?, ?)')
      .run(at, String(path ?? ''), fromValue == null ? null : String(fromValue), toValue == null ? null : String(toValue), String(actor ?? ''))
    this.db
      .prepare('delete from config_audit where id <= (select max(id) - ? from config_audit)')
      .run(max)
  }

  /** 删掉一条会话记录（用户主动"删除会话"时用；messages 保留，历史仍可查） */
  deleteChat(chatKey) {
    this.db.prepare('delete from chats where chat_key = ?').run(String(chatKey ?? ''))
  }

  /** 最近若干条审计，新的在前 */
  listConfigAudit(limit = 20) {
    const rows = this.db
      .prepare('select id, at, path, from_value, to_value, actor from config_audit order by at desc, id desc limit ?')
      .all(clampLimit(limit, 20, 200))
    return rows.map(r => ({
      id: r.id,
      at: r.at,
      path: String(r.path ?? ''),
      from: r.from_value == null ? null : String(r.from_value),
      to: r.to_value == null ? null : String(r.to_value),
      actor: String(r.actor ?? ''),
    }))
  }
}
