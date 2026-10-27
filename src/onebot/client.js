/**
 * OneBot v11 正向 WebSocket 客户端。
 *
 * 关于 transport 的取舍：docs/qdash-neo/02 §0 定的是直连 `@snowluma/sdk`（不走 MCP）。
 * 本文件先用**原生 WebSocket** 实现同一套语义 —— 因为 OneBot v11 的 WS 协议就是
 * 「发 {action, params, echo} / 收 {status, retcode, data, echo}」，而 `@snowluma/sdk`
 * 目前不在依赖里。接口按 sdk 的形状留（`call(action, params)` + `on('message')`），
 * 以后接 sdk 只替换本文件，上层不动。
 *
 * 原项目踩过的两个坑，这里直接内建：
 *   1. HTTP token 与 WS token 不是同一个值 → 首次失败时换 query 形态重试一次（token 自愈）
 *   2. `get_login_info` 不返回 `good` 字段 → 健康判断不用它，用心跳时间戳
 */

const noop = () => {}

/**
 * 把 OneBot 的「拍一拍」通知转成一条 message 事件。
 *
 * 形状要跟真实 message 一致，否则 `normalizeEvent` 那一层拿不到 expected 字段。
 * 关键点：
 *   - 带一个 `at` 段指向自己 → `atMe` 为真。拍一下就是明确在叫你，
 *     后面概率闸门会因为 `atMe` 而免疫（没人希望"拍了拍它，它装没看见"）。
 *   - 通知没有 `message_id`，用 `poke-<time>-<user>` 合成一个稳定键：
 *     落库的 `(chat_key, qq_msg_id)` 唯一约束靠它去重，重连补发不会重复回。
 *   - 只认 `target_id === 自己`；别人互拍（群里很常见）不该唤醒机器人。
 *
 * @param {object} p notice 事件
 * @param {string} selfId 自己 QQ
 * @returns {object|null} message 形状的 raw，或 null（不是拍自己）
 */
function pokeToMessage(p, selfId) {
  if (p?.notice_type !== 'notify' || p?.sub_type !== 'poke') return null
  const me = String(selfId ?? p.self_id ?? '').trim()
  if (!me) return null
  if (String(p.target_id ?? '') !== me) return null

  const groupId = p.group_id == null ? null : String(p.group_id)
  const text = '（拍了拍你）'
  return {
    post_type: 'message',
    message_type: groupId ? 'group' : 'private',
    sub_type: 'normal',
    self_id: p.self_id,
    user_id: p.user_id,
    ...(groupId ? { group_id: p.group_id } : {}),
    message_id: `poke-${p.time ?? Date.now()}-${p.user_id ?? ''}`,
    message: [
      { type: 'at', data: { qq: me } },
      { type: 'text', data: { text } },
    ],
    raw_message: text,
    time: p.time ?? Math.floor(Date.now() / 1000),
    sender: { user_id: p.user_id, nickname: String(p.sender?.nickname ?? '') },
  }
}

export class OneBotClient {
  /**
   * @param {{ wsUrl: string, token?: string, log?: Function }} opts
   */
  constructor({ wsUrl, token = '', log = noop }) {
    if (typeof WebSocket !== 'undefined') {
      this.wsImpl = WebSocket
    } else {
      throw new Error('qdash-neo: 当前 Node 没有全局 WebSocket（需要 Node >= 22）')
    }
    this.wsUrl = wsUrl
    this.token = token
    this.log = log
    this.ws = null
    this.stopped = true
    this.echo = 0
    this.pending = new Map()
    this.handlers = { message: new Set(), close: new Set(), ready: new Set(), login: new Set() }
    this.backoff = 1000
    this.tokenMode = 'header' // header | query —— 自愈用
    this.timer = null
    this.lastHeartbeat = 0
    this.selfId = ''
    this.nickname = ''
  }

  /** @param {'message'|'close'|'ready'|'login'} type */
  on(type, fn) {
    this.handlers[type].add(fn)
    return () => this.handlers[type].delete(fn)
  }

  emit(type, payload) {
    for (const fn of this.handlers[type]) {
      try {
        fn(payload)
      } catch (err) {
        // 观察者异常不许掀掉连接，但必须可见
        this.log('error', `qdash-neo: ${type} 处理器抛错`, err)
      }
    }
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      this.ws?.close()
    } catch {
      /* 连接可能已经断了 */
    }
    this.ws = null
    for (const [, p] of this.pending) p.reject(new Error('qdash-neo: 连接关闭'))
    this.pending.clear()
  }

  /**
   * 换地址 / 换口令后重连（控制台保存 onebot.wsUrl|token 时调用）。
   *
   * 为什么不能只 stop()+start()：`stop()` 只清 `ws` 与 `timer`，下面这些状态会留到下一次连接 ——
   *   1. 旧 socket 晚到的 close 会触发 scheduleReconnect，覆盖新连接的定时器（双连接竞态）
   *   2. `tokenMode` 可能已经降级成 'query'，换新口令后永远不再试 header
   *   3. `backoff` 停在 30s，换地址后首连失败要等半分钟
   *   4. `lastHeartbeat` 还新鲜 → healthy() 在没连上的时候报"在线"
   *   5. `selfId` / `nickname` 是旧身份 → "别回自己"按旧号判断
   *
   * @param {{ wsUrl?: string, token?: string }} [next]
   */
  restart({ wsUrl = this.wsUrl, token = this.token } = {}) {
    const old = this.ws
    this.ws = null
    if (old) {
      // 先摘监听再关：否则 close 回调会在 this.ws 已经是 null 之后跑一遍旧逻辑
      old.removeAllListeners?.()
      try {
        old.close(1000, 'restart')
      } catch (err) {
        this.log('warn', `qdash-neo: 关闭旧连接失败（忽略）msg=${err?.message}`)
      }
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null

    this.wsUrl = wsUrl
    this.token = token
    this.tokenMode = 'header'
    this.backoff = 1000
    this.lastHeartbeat = 0
    this.selfId = ''
    this.nickname = ''
    this.stopped = false
    for (const [, p] of this.pending) p.reject(new Error('qdash-neo: 连接已重启'))
    this.pending.clear()
    this.log('info', `qdash-neo: 按新地址重连 OneBot（${wsUrl}，token ${token ? '已设置' : '未设置'}）`)
    this.connect()
  }

  connect() {
    if (this.stopped) return
    const url = this.tokenMode === 'query' && this.token
      ? `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`
      : this.wsUrl

    const attempts = []
    try {
      this.ws = this.tokenMode === 'header' && this.token
        ? new this.wsImpl(url, { headers: { authorization: `Bearer ${this.token}` } })
        : new this.wsImpl(url)
    } catch (err) {
      // 某些 undici 版本不支持 headers 选项 → 直接退到 query 形态
      attempts.push(`headers 形态失败：${err.message}`)
      this.tokenMode = 'query'
      this.scheduleReconnect(attempts.join('; '))
      return
    }

    /**
     * 捕获本次连接对象。
     * `restart()` 会把 this.ws 换成新的，旧 socket 的回调还会再来一轮；
     * 没有这个引用，旧连接的 close 会走 scheduleReconnect 覆盖新连接的定时器（双连接竞态）。
     */
    const socket = this.ws

    socket.addEventListener('open', () => {
      this.backoff = 1000
      this.log('info', `qdash-neo: OneBot WS 已连接（token 形态=${this.tokenMode}）`)
      // 立刻取一次登录信息：`selfId` 靠它，而 selfId 是"别回自己"的唯一依据。
      // 只等信息事件里的 self_id 会漏掉第一条（第一条正是最危险的）
      this.call('get_login_info', {}, 5000)
        .then(info => {
          if (info?.user_id != null) {
            this.selfId = String(info.user_id)
            this.nickname = String(info.nickname ?? '')
            this.log('info', `qdash-neo: 登录身份 ${this.selfId} (${this.nickname})`)
            // 判定启发式要认「叫名字」，昵称只有这里拿得到
            this.emit('login', { userId: this.selfId, nickname: this.nickname })
          }
        })
        .catch(err => this.log('warn', `qdash-neo: get_login_info 失败 msg=${err?.message}`))
      this.emit('ready', {})
    })

    socket.addEventListener('message', event => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch (err) {
        this.log('warn', `qdash-neo: 收到非 JSON 帧，已忽略：${err.message}`)
        return
      }
      this.route(payload)
    })

    socket.addEventListener('error', event => {
      const msg = event?.message || event?.error?.message || 'ws error'
      attempts.push(msg)
      this.log('warn', `qdash-neo: WS 错误 ${msg}`)
    })

    socket.addEventListener('close', event => {
      // 旧连接的收尾：不广播、不排重连。restart 之后这条一定会晚到
      if (this.ws !== socket) return
      this.emit('close', event)
      if (this.stopped) return
      // 1008/policy violation 与 401 通常意味着鉴权形态不对：换 token 形态重试一次
      const code = event?.code
      if ((code === 1008 || code === 4001 || code === 401) && this.tokenMode === 'header' && this.token) {
        this.tokenMode = 'query'
        this.log('warn', 'qdash-neo: 鉴权失败，改用 access_token query 形态重连（02 §2 的坑）')
      }
      this.scheduleReconnect(attempts.join('; ') || `close code=${code}`)
    })
  }

  scheduleReconnect(why) {
    if (this.stopped) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30_000)
    this.log('warn', `qdash-neo: ${delay}ms 后重连 OneBot（${why}）`)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  route(payload) {
    if (payload && payload.post_type) {
      if (payload.post_type === 'meta_event') {
        this.lastHeartbeat = Date.now()
        return
      }
      if (payload.post_type === 'message') {
        if (!this.selfId && payload.self_id) this.selfId = String(payload.self_id)
        this.emit('message', payload)
        return
      }
      /**
       * 拍一拍（notice/notify/poke）**要能触发对话**。
       *
       * 原来这里直接 `return`，于是 notice 全被丢掉 —— 用户拍一下机器人毫无反应。
       * 在客户端层把它转成一条 message 投给上层，比在上层加一条并行的
       * notice 通道好：闸门、去重、批窗口、落库全都复用现有链路，不需要第二套。
       *
       * 只在**拍的是自己**时转（别人互相拍不该唤醒机器人）。
       */
      if (payload.post_type === 'notice') {
        if (!this.selfId && payload.self_id) this.selfId = String(payload.self_id)
        const poked = pokeToMessage(payload, this.selfId)
        if (poked) {
          this.log(
            'info',
            `qdash-neo: 收到拍一拍（${poked.message_type === 'group' ? `群 ${poked.group_id}` : '私聊'}）来自 ${poked.user_id}`,
          )
          this.emit('message', poked)
        }
      }
      return
    }
    // action 回包
    const echo = payload?.echo
    const waiter = echo != null ? this.pending.get(String(echo)) : undefined
    if (!waiter) {
      this.log('warn', 'qdash-neo: 收到无主回包（echo 不匹配），已忽略')
      return
    }
    this.pending.delete(String(echo))
    clearTimeout(waiter.timer)
    if (payload.status === 'ok' || payload.retcode === 0) waiter.resolve(payload.data)
    else waiter.reject(new Error(`OneBot ${payload.retcode ?? '?'}: ${payload.wording ?? payload.message ?? 'failed'}`))
  }

  /**
   * 调一个 OneBot action。
   * @param {string} action
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  call(action, params = {}, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error(`qdash-neo: OneBot 未连接，${action} 未发送`))
        return
      }
      const echo = String(++this.echo)
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`qdash-neo: ${action} 超过 ${timeoutMs}ms 无回包`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  /**
   * @param {string} chatKey 内核的 chatKey（`u:<qq>` / `g:<群号>`）
   * @param {string} text
   */
  async sendText(chatKey, text) {
    const id = chatKey.slice(2)
    const isGroup = chatKey.startsWith('g:')
    return this.call(isGroup ? 'send_group_msg' : 'send_private_msg', {
      ...(isGroup ? { group_id: id } : { user_id: id }),
      message: [{ type: 'text', data: { text } }],
    })
  }

  /** 用「最近一次心跳时间」判活，不用 get_login_info.good（那个字段不存在） */
  healthy(maxSilenceMs = 45_000) {
    return this.ws?.readyState === 1 && Date.now() - this.lastHeartbeat < maxSilenceMs
  }
}
