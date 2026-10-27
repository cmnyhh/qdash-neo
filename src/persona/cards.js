/**
 * 人格卡库：一个人可以存多张角色卡，选一张当"当前生效"。
 *
 * 为什么不做成 `config.persona.text` 的多值字段：schema 是**部署层**的东西
 * （patch 里写死的、会被锁），而"我今晚想演这个角色"是运行期的偏好，
 * 两者混在一起就没法在控制台里自由增删了。
 *
 * 存储：两张 kv 表
 *   `persona:cards`  → JSON 数组 `[{ id, name, text, hint, updatedAt }]`
 *   `persona:active` → 当前卡 id
 *
 * 与静态配置的关系（单一真相源的边界）：
 *   `config.persona.text` 是"部署层兜底人设"，卡库里没有任何卡时用它；
 *   选中某张卡后，卡内容优先。两个来源各自可编辑，但**同一时刻只有一处生效**，
 *   `effective()` 会把当前生效值和来源一起报出来，界面照实显示。
 */

/** kv 键 */
const KV_CARDS = 'persona:cards'
const KV_ACTIVE = 'persona:active'

/** 上限：卡库不是笔记软件，20 张足够；没有上限的话 kv 会被慢慢撑大 */
const MAX_CARDS = 20
const MAX_NAME = 40
const MAX_TEXT = 20_000
const MAX_HINT = 2_000

/** 生成 id：不进 URL 主键，但要求可读、可排序、不撞 */
function newId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 别名上限：判定器的"被点名"是逐条 includes，太多会拖慢且没有意义 */
const MAX_ALIASES = 20
const MAX_ALIAS_LEN = 20

/**
 * 别名归一化：去空白、去重、限长。
 * 太短的（1 个字）一律丢——单字别名会把"我"、"你"这种词命中成点名。
 */
export function normalizeAliases(raw, log) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    const name = String(item ?? '').trim()
    if (!name) continue
    if (name.length < 2 || name.length > MAX_ALIAS_LEN) {
      log?.('warn', `qdash-neo: 别名长度不合法（2~${MAX_ALIAS_LEN} 字），已忽略：${name}`)
      continue
    }
    if (out.includes(name)) continue
    out.push(name)
    if (out.length >= MAX_ALIASES) break
  }
  return out
}

/** @param {unknown} raw */
function sanitizeCard(raw, log) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  if (!id) return null
  const name = String(raw.name ?? '').trim().slice(0, MAX_NAME)
  const text = String(raw.text ?? '').trim().slice(0, MAX_TEXT)
  const hint = String(raw.hint ?? '').trim().slice(0, MAX_HINT)
  const aliases = normalizeAliases(raw.aliases, log)
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
  // 没有名字的卡在列表里就是一行空白，宁可当脏数据丢掉并留痕
  if (!name) {
    log?.('warn', `qdash-neo: 人格卡缺少名字，已忽略 id=${id}`)
    return null
  }
  return { id, name, text, hint, aliases, updatedAt }
}

export class PersonaCards {
  /**
   * @param {{ store?: object|null, log?: Function }} [opts]
   */
  constructor({ store = null, log = () => {} } = {}) {
    this.store = store
    this.log = log
  }

  /** 读整张表。读不出来/坏 JSON 都给空数组，但必须留痕（静默降级查不出来） */
  all() {
    if (!this.store || typeof this.store.kvGet !== 'function') return []
    let raw = ''
    try {
      raw = String(this.store.kvGet(KV_CARDS, '') ?? '')
    } catch (err) {
      this.log('error', `qdash-neo: 读取人格卡库失败 name=${err?.name} msg=${err?.message}`, err)
      return []
    }
    if (!raw) return []
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.log('error', `qdash-neo: 人格卡库不是合法 JSON，按空库处理 msg=${err?.message}`, err)
      return []
    }
    if (!Array.isArray(parsed)) {
      this.log('warn', 'qdash-neo: 人格卡库不是数组，按空库处理')
      return []
    }
    return parsed.map(c => sanitizeCard(c, this.log)).filter(Boolean)
  }

  /** @param {string} id */
  get(id) {
    return this.all().find(c => c.id === id) ?? null
  }

  /** 当前生效的卡；没选或选中的卡已被删则返回 null（回落静态配置） */
  activeCard() {
    const id = this.activeId()
    if (!id) return null
    const hit = this.get(id)
    if (!hit) {
      // 选中的卡被删了：不能静默把 active 指回第一张，那会让"当前卡"跳变
      this.log('warn', `qdash-neo: 当前人格卡已不存在 id=${id}，暂用部署层人设`)
      return null
    }
    return hit
  }

  activeId() {
    if (!this.store || typeof this.store.kvGet !== 'function') return ''
    try {
      return String(this.store.kvGet(KV_ACTIVE, '') ?? '').trim()
    } catch (err) {
      this.log('error', `qdash-neo: 读取当前人格卡失败 name=${err?.name} msg=${err?.message}`, err)
      return ''
    }
  }

  /** @param {Array<object>} cards */
  #write(cards) {
    if (!this.store || typeof this.store.kvSet !== 'function') return false
    try {
      this.store.kvSet(KV_CARDS, JSON.stringify(cards))
      return true
    } catch (err) {
      this.log('error', `qdash-neo: 写人格卡库失败 name=${err?.name} msg=${err?.message}`, err)
      return false
    }
  }

  /**
   * 新建或更新一张卡。
   * @param {{ id?: string, name: string, text?: string, hint?: string }} input
   * @returns {{ ok: boolean, card?: object, error?: string }}
   */
  save(input) {
    const name = String(input?.name ?? '').trim().slice(0, MAX_NAME)
    if (!name) return { ok: false, error: '人格卡需要一个名字' }

    const cards = this.all()
    const id = String(input?.id ?? '').trim()
    const existing = id ? cards.find(c => c.id === id) : null
    if (id && !existing) return { ok: false, error: '这张卡不存在（可能已被删除）' }
    if (!existing && cards.length >= MAX_CARDS) {
      return { ok: false, error: `最多存 ${MAX_CARDS} 张卡，先删几张` }
    }

    const card = sanitizeCard(
      {
        id: existing?.id ?? newId(),
        name,
        text: input?.text ?? existing?.text ?? '',
        hint: input?.hint ?? existing?.hint ?? '',
        aliases: input?.aliases ?? existing?.aliases ?? [],
        updatedAt: Date.now(),
      },
      this.log,
    )
    if (!card) return { ok: false, error: '人格卡内容不合法' }

    const next = existing ? cards.map(c => (c.id === card.id ? card : c)) : [...cards, card]
    if (!this.#write(next)) return { ok: false, error: '写入失败（数据库不可用，看内核日志）' }

    // 第一张卡自动设为当前：否则用户存完发现"没生效"，还得再点一次
    if (!existing && !this.activeId()) this.activate(card.id)
    return { ok: true, card }
  }

  /**
   * @param {string} id
   * @returns {{ ok: boolean, error?: string }}
   */
  remove(id) {
    const cards = this.all()
    const next = cards.filter(c => c.id !== id)
    if (next.length === cards.length) return { ok: false, error: '这张卡不存在' }
    if (!this.#write(next)) return { ok: false, error: '写入失败（数据库不可用，看内核日志）' }
    // 删掉的正是当前卡：把 active 清空，回落部署层人设，而不是自动跳到别的卡
    if (this.activeId() === id) {
      try {
        this.store.kvSet(KV_ACTIVE, '')
      } catch (err) {
        this.log('error', `qdash-neo: 清空当前人格卡失败 name=${err?.name} msg=${err?.message}`, err)
      }
    }
    return { ok: true }
  }

  /**
   * 设为当前卡；传空串表示"不用卡，回落部署层人设"。
   * @param {string} id
   * @returns {{ ok: boolean, error?: string }}
   */
  activate(id) {
    const target = String(id ?? '').trim()
    if (target && !this.get(target)) return { ok: false, error: '这张卡不存在' }
    if (!this.store || typeof this.store.kvSet !== 'function') {
      return { ok: false, error: '数据库不可用' }
    }
    try {
      this.store.kvSet(KV_ACTIVE, target)
      return { ok: true }
    } catch (err) {
      this.log('error', `qdash-neo: 切换当前人格卡失败 name=${err?.name} msg=${err?.message}`, err)
      return { ok: false, error: '写入失败（看内核日志）' }
    }
  }
}
