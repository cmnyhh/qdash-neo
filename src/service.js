/**
 * QdashNeoService —— 内核装配。
 *
 * 数据流（群消息现在是两段闸，见 docs/qdash-neo/03）：
 *
 *   OneBot WS → normalize
 *     ├─ ingest  （听得见吗）去重 / 群开关 / 群白名单 / 空消息
 *     ├─ 群上下文缓冲（含非白名单成员）+ 落库 state='context'
 *     ├─ trigger （可能开口吗）白名单(仅私聊) / @ 要求 / 限流 / 回复配额
 *     ├─ judge   （要不要说）启发式 → ctx.llm.stream → 阈值分档
 *     └─ router.deliver(followup) → session/event → outbox → OneBot WS
 *
 * 这里只做装配与串联，具体规则在各自模块里。**每个 catch 都要带上下文**：
 * 原项目把 MCP 错误对象用 `catch {}` 丢掉，排查了两天（AGENTS.md §4.6）。
 */
import { JudgeChain } from './judge/chain.js'
import { localDay, summarizeDay } from './memory/daily.js'
import { Memory } from './memory/index.js'
import { OneBotClient } from './onebot/client.js'
import { describeImage } from './image/describe.js'
import { imageTag, normalizeEvent, renderPrompt } from './onebot/normalize.js'
import { ReplyLedger } from './outbox/ledger.js'
import { Outbox } from './outbox/queue.js'
import { planReply } from './outbox/split.js'
import { Persona } from './persona/index.js'
import { GroupContext, renderContextBlock } from './pipeline/context.js'
import { Gates, REASON } from './pipeline/gates.js'
import { attachSessionEvents } from './session/events.js'
import { syncInstructions } from './session/instructions.js'
import { applyToolPolicy, parseChatKey } from './tools/index.js'
import { SessionRouter } from './session/router.js'
import { Store } from './store/db.js'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { PluginEvents } from './plugin/events.js'
import { PluginInstructions } from './plugin/instructions.js'
import { PluginOutbox } from './plugin/outbox.js'
import { PluginSettings } from './plugin/settings.js'
import { PluginStorage } from './plugin/storage.js'
import { PluginToolRegistry } from './plugin/tools.js'
import { VoiceLibrary } from './voice/library.js'

/**
 * **插件能访问的 `ctx.qdashNeo` 属性白名单。**
 *
 * 这里没有的东西，插件拿到的就是 `undefined` —— 包括 `deliver` / `client` /
 * `sleepUntil` / `outbox` 这些内部结构。早先整个 service 直接 provide 出去，
 * `capabilities` 那张表只是"说明书"，想绕过出站队列用 `neo.client` 就行。
 *
 * **加新能力要同时改三处**：这里、`this.capabilities`、插件文档 §0.1。
 * 三处不一致就是"文档说有、实际用不了"或反过来。
 */
const PLUGIN_API_KEYS = new Set([
  // 能力清单与只读快照
  'capabilities',
  'config',
  // 门面
  'tools',
  'outboxApi',
  'card',
  'instructions',
  'console',
  'settings',
  'storage',
  'voice',
  'judge',
  // 方法
  'log',
  'on',
  'onConfigChange',
  'openProactive',
])

/**
 * 工具策略的取舍（`tools/index.js` 里实现，这里只留结论）：
 *
 * 早期只挂了 `tools.guard()` 做**负面清单**，因为它不会因未知工具名抛错。
 * 现在改成"正面白名单 + guard 兜底"两道：
 *   - `restrict({allow})` 决定**模型能看见什么**，名字全部来自 `tools.schemas()` 的
 *     真实清单，所以不会抛错（这是此前不敢用 restrict 的原因，已解决）
 *   - `guard()` 单调拒绝高危项，兜住"白名单被配成全开"的情况
 * 细节见 docs/qdash-neo/03-内核实现要点.md。
 */

export class QdashNeoService {
  /**
   * @param {object} ctx
   * @param {object} config 插件 Config
   * @param {{ log: Function, createUserMessage: Function }} deps
   */
  constructor(ctx, config, { log, createUserMessage }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.createUserMessage = createUserMessage

    this.started = false
    this.store = null
    this.gates = null
    this.context = null
    this.judge = null
    this.router = null
    this.client = null
    this.outbox = null
    /**
     * 一次回复拆成多片后的结算表：只有最后一片结算完才回写一次上下文/记忆（M2）。
     * 装配时机与 outbox 无关，测试里手工装 outbox 也能用。
     */
    this.ledger = new ReplyLedger({ log: log ?? (() => {}) })
    this.detachEvents = null
    /** 日总结定时器：缺哪天补哪天，每 10 分钟检查一次 */
    this.dailyTimer = null
    /** 启动补跑：延迟一点点，别和 OneBot 连接抢资源 */
    this.dailyBootTimer = null
    /** 上一次日总结的结果：控制台/排查用，`status()` 如实报，不做"看起来有"的假象 */
    this.dailyLast = null
    /** @type {object|null} 控制台（由 index.js 装配；测试里没有） */
    this.console = null
    /**
     * 运行层配置（M3 第二阶段）：控制台改完立刻生效的那一层。
     * 由 index.js 装配并在这里暴露，因为控制台 API 通过 `service.configStore` 取它。
     * @type {object|null}
     */
    this.configStore = null
    this.sweeper = null
    this.chatTails = new Map()
    /**
     * 群判定批窗口（防抖）：chatKey → 待判定的一串消息。
     * 语义（用户定）：最后一条消息之后静默 `batchWindowMs` 才送判定；
     * 期间有人接着说就重新计时；但从第一条算起最多等 `batchMaxWaitMs`，
     * 否则一群人刷屏会让机器人永远开不了口。
     * @type {Map<string, { evs: object[], firstAt: number, flushAt: number, timer: any }>}
     */
    this.batches = new Map()
    /**
     * 沉睡截止时间：chatKey → 时间戳。
     *
     * 内存为主、kv 兜底（`sleep:<chatKey>`）：重启不该让它"睡醒"，
     * 但也不能每条消息都查一次库 —— 命中内存就不查。
     */
    this.sleepUntil = new Map()
    /**
     * 每个会话最近一张图的 file 标识：chatKey → file。
     *
     * 给 `qq_get_image(file:"latest")` 用。模型经常不知道具体是哪张图
     * （尤其"看看我刚才发的"），没有这个兜底它只能编一个 id 然后失败。
     */
    this.lastImage = new Map()
    /**
     * 每个会话最近一条入站消息的发送者：chatKey → QQ 号。
     *
     * 给 `qq_kick` 做身份校验（"这条要求是谁提的"）。批处理下 `rep` 是批里
     * 最后一条，所以"owner 说完、别人又插一句"会校验失败 → 拒绝执行。
     * 这是刻意的保守失败：宁可它说不敢，也不要误踢。
     */
    this.lastSender = new Map()
    /** 出站消息的自增序号：给工具发出的消息生成稳定 id（落库去重用） */
    this.outSeq = 0
    /** 已经进过结算表的一次回复（分片共享 replyId，避免重复 track） */
    this.trackedReplies = new Set()
    /**
     * 主动发言的排期定时器：chatKey → timeout。
     *
     * 同一会话只保留最近一次排期 —— 排了新的就作废旧的，
     * 否则模型连着排三次，到点会连着被唤起三次。
     */
    this.laterTimers = new Map()
    /**
     * 最近一次主动唤起的时间：chatKey → 时间戳。
     *
     * **不用 `Set` 而用时间戳**，因为 `onSleep` 和 `deliver` 的时序不可靠：
     * `attachSessionEvents` 的回调可能在 `deliver` 返回**之后**才触发，
     * 那时"进行中的集合"已经被 `finally` 清空了 —— 判断必然失效（实测过）。
     *
     * 所以改成**时间窗口**：主动唤起后一段时间内，任何 `[[SLEEP]]` 都丢弃。
     * 这样不依赖任何时序假设。
     */
    this.proactiveRecent = new Map()
    /** 主动评估计数：chatKey → { day, n }，用于每日上限（内存级即可） */
    this.proactiveUsed = new Map()
    /**
     * 每个会话累积了多少**字符**：chatKey → 累计长度。
     *
     * **为什么不按轮数：agent 历史是累积的。**
     *
     * 每轮 prompt 约 4700 字，但第 N 轮的输入不是 4700，而是
     * `N × 4700` —— 历史整段重发。所以：
     *
     *     第  1 轮：输入   4700 字   → 快
     *     第 40 轮：输入 18.8 万字   → 开始慢
     *     第 80 轮：输入 37.6 万字   → 又慢又贵
     *
     * 按轮数判断等于"消息短就撑着、消息长就撞墙"，
     * 而**按累计字符**能保证每一轮的输入都在可控范围。
     */
    this.historyChars = new Map()
    /**
     * 待重建的会话：chatKey → 原因。
     *
     * **只记标记，不在当轮末尾清。** `deliver` 返回时回复可能还在生成，
     * 那时删会话会把这一条打断；真正的清理放到下一轮投递之前。
     */
    this.pendingRebuild = new Map()
    /**
     * 累计多少字符就重建会话。
     *
     * 13 万字 ≈ 8 万 token。这个量级下每轮输入还能接受（几秒），
     * 而 104 万 token 的上限离得远。
     *
     * 按每轮 4700 字算，约 **27 轮**一重建 —— 比固定 80 轮更早，
     * 但**不会出现"第 80 轮输入 37 万字"那种卡顿**。
     */
    this.maxHistoryChars = 130_000
    /**
     * 轮数兜底：极端情况下（每轮极短）字符数涨得慢，但轮数太多也会
     * 让 DSH 自己的会话元数据膨胀，所以仍留一个硬上限。
     */
    this.turnCount = new Map()
    this.maxTurnsPerSession = 200
    /** 沉睡时长范围（**秒**），由配置决定，用于夹住模型给的数值 */
    /**
     * 沉睡范围（秒）。**和 `config.js` 里 `sleep.minSeconds/maxSeconds` 的默认值一致**。
     *
     * 这里只是 `applyConfig` 跑之前的兜底值；不一致的话，
     * 启动瞬间模型看到的范围和配置页显示的会对不上。
     */
    this.sleepMin = 30
    this.sleepMax = 600
    /** 短期安静档（秒）：见 config.js 里的说明 */
    this.sleepShort = 60
    /** 连续安静几次后不再给该选项 */
    this.maxConsecutiveSleep = 2
    /**
     * 每个会话连续安静了几次：chatKey → 次数。
     *
     * 用来实现"别连着静默"——到次数后不再提供 `[[SLEEP]]`，
     * 否则它会每轮都选最省事的那条，最后等于永久隐身。
     * **它一开口就清零**（见 `onAssistant`）。
     */
    this.consecutiveSleep = new Map()
    this.sleepEnabled = false
    /** 过闸门后真正回复的概率（0~1） */
    this.replyChance = 1
    /** 各会话的工具挂载结果（chatKey → applyToolPolicy 的返回值），出站侧查"本回合发过没" */
    this.toolStates = new Map()

    /**
     * 本轮批里的消息 ID（`chatKey` → `Set<id>`）。
     *
     * `qq_send_message` 的 `reply_to` 要校验它是不是"真的在这一批里"：
     * 模型抄错一位，OneBot 会返回"找不到消息"，然后进死信重试三次再丢 ——
     * 用户看到的是"它没说话"，而根因是一条引用到不存在消息上的发送。
     *
     * 每轮开始时由 `deliver` 设置，`turn/end` 清掉。
     *
     * @type {Map<string, Set<string>>}
     */
    this.turnBatches = new Map()
    // 立刻按配置初始化：applyConfig 只在控制台保存后触发，不能等它
    this.applyRandomPolicy(config)
    const jc = config?.judge ?? {}
    this.batchWindowMs = Number.isFinite(jc.batchWindowMs) ? jc.batchWindowMs : 5000
    this.batchMaxWaitMs = Number.isFinite(jc.batchMaxWaitMs) ? jc.batchMaxWaitMs : 20000
    this.batchMaxMessages = Number.isFinite(jc.batchMaxMessages) ? jc.batchMaxMessages : 20
    /** 被 @ 后提前封口的宽限（0=立刻）。2s 用来收进「@ 完再补一句」 */
    this.atLookaheadMs = Number.isFinite(jc.atLookaheadMs) ? jc.atLookaheadMs : 2000
    /** @type {Memory|null} 懒创建：start() 里 store 就绪后才有 */
    this.memory = null
    /** @type {VoiceLibrary|null} 语音库：路径防护与发送额度都收在它手里 */
    this.voice = null
    /**
     * 插件工具登记表。
     *
     * 插件通过 `ctx.qdashNeo.tools.register()` 往这里写，内核在**每次建立会话**时挂载。
     * 不在会话建立期直接注册，是因为插件根本拿不到会话级的 `tools` 对象 ——
     * 会话由内核创建，插件只是"进程里的一个东西"。
     */
    this.pluginTools = new PluginToolRegistry({ log: this.log })
    /** 插件贡献的提示词引导（注册 ≠ 生效，要授权） */
    this.pluginInstructions = new PluginInstructions({ log: this.log })
    /** 给插件用的门面（`ctx.qdashNeo.tools`） */
    this.tools = {
      /**
       * @param {object} desc 见 `PluginToolRegistry#register`
       *
       * 注册完**立刻补挂到已存在的会话**：否则只有"下一个新建的会话"能拿到它，
       * 用户看到的是"开了 TTS，当前对话里模型还是不能用"，而唯一的解是删会话重建。
       */
      register: desc => {
        const dispose = this.pluginTools.register(desc)
        try {
          this.syncPluginToolsToSessions()
        } catch (err) {
          this.log('warn', `qdash-neo: 补挂插件工具失败 msg=${err?.message}`)
        }
        return dispose
      },
      list: () => this.pluginTools.list(),
      has: name => this.pluginTools.has(name),
    }

    /**
     * 插件贡献的提示词引导。
     *
     * 注册完**立刻刷新一次 `AGENTS.md`**：否则引导要等下次 `applyConfig`
     * 或重启才生效，而插件作者会以为"我注册了但模型没收到"。
     *
     * 注意它只是**注册**，真正进系统提示还要这个插件在
     * `instructions.grantedInstructions` 里 —— 见 `applyInstructions`。
     */
    this.instructions = {
      register: desc => {
        const dispose = this.pluginInstructions.register(desc)
        try {
          this.applyInstructions()
        } catch (err) {
          this.log('warn', `qdash-neo: 刷新插件引导失败 msg=${err?.message}`)
        }
        return dispose
      },
      list: () => this.pluginInstructions.list(),
    }

    /**
     * 插件存储与运行时配置。
     *
     * 传 `getStore` 而不是直接给 store 对象：store 在 `start()` 里才创建，
     * 而插件可能在构造之后、start 之前就调 `forFeature()` ——
     * 直接传会拿到 null，然后在第一次用时炸掉，报错还指不到根因。
     */
    this.pluginStorage = new PluginStorage({ getStore: () => this.store, log: this.log })
    this.pluginSettings = new PluginSettings({ getStore: () => this.store, log: this.log })
    /**
     * 插件判定器：`judge` 实例在 `start()` 里才建，所以先存着，建好再灌进去。
     *
     * 直接暴露 `this.judge` 不行 —— 它在 start 之前是 null，
     * 插件在那个时机注册会拿到 `Cannot read property of null`，
     * 而这个错误看起来像"插件写错了"，实际是加载顺序。
     */
    /** @type {Array<{ name: string, provider: Function, owner?: string }>} */
    this.pluginJudges = []
    this.judgeApi = {
      /**
       * @param {{ name: string, provider: Function, owner?: string }} desc
       *   见 `JudgeChain#registerProvider`
       */
      registerProvider: desc => {
        this.pluginJudges.push(desc)
        // judge 已经建好就直接注册，不用等重启
        if (this.judge) {
          try {
            return this.judge.registerProvider(desc)
          } catch (err) {
            this.log('warn', `qdash-neo: 判定器注册失败 msg=${err?.message}`)
          }
        }
        return () => {
          const i = this.pluginJudges.indexOf(desc)
          if (i >= 0) this.pluginJudges.splice(i, 1)
        }
      },
    }

    this.storage = {
      /** @param {string} name 插件自己的名字（做格式校验，命名空间 `feature:<name>:`） */
      forFeature: name => this.pluginStorage.forFeature(name),
      /**
       * 插件自己的目录。**不是授予权限**（插件本来就能用 `node:fs`），
       * 而是给一个跟着 DSH_HOME 走、卸载时知道该清哪儿的约定路径。
       * @param {string} name @param {string} [sub]
       */
      dir: (name, sub) => this.pluginStorage.dir(name, sub),
    }
    this.settings = {
      /** @param {object} opts 见 `PluginSettings#register` */
      register: opts => this.pluginSettings.register(opts),
    }

    /**
     * 出站门面：插件发文本 / 图片的唯一入口。
     *
     * 走的是和模型完全相同的队列（`enqueueOut` / `enqueueSegmentsOut`），
     * 所以分条、限流、死信、落库、控制台可见性全都自动生效 —— 插件绕不过去。
     *
     * 来源标记由 `forPlugin(name)` 在闭包里定死，插件不能覆盖：
     * 审计里要能分清「这条是模型发的还是插件发的」。
     */
    this.pluginOutbox = new PluginOutbox({
      deliver: {
        text: (key, text, meta) => this.enqueueOut(key, text, meta),
        segments: (key, segments, meta) => this.enqueueSegmentsOut(key, segments, meta),
      },
    })
    this.outboxApi = {
      /** @param {string} plugin 插件自己的名字 @returns {{ sendText: Function, sendSegments: Function }} */
      forPlugin: plugin => this.pluginOutbox.forPlugin(plugin),
    }

    /**
     * 分享卡片。
     *
     * **插件只表达意图**（"这是一条 B 站视频"），组卡、签名、降级全在内核 ——
     * 因为卡片签名只有 OneBot 实现算得出来，插件不该碰协议，也不该为了
     * 一个卡片去拿 `client`。
     *
     * 两种实现，对插件是同一个接口：
     *
     *   - 实现支持 `get_mini_app_ark`（SnowLuma）→ 生成带签名的卡片段
     *   - 不支持（NapCat / Lagrange / 自建）→ **降级成纯文本**，标题 + 链接
     *
     * 两条路都走 `enqueueOut` / `enqueueSegmentsOut`，所以限流、落库、
     * 死信重试全都照常 —— 这是它和"给插件一个 client 后门"的根本区别。
     */
    this.card = {
      /**
       * **必须是箭头函数。**
       *
       * 写成 `async share(...)` 的话，`this` 绑定到 `card` 这个对象字面量上，
       * 里面的 `this.log` / `this.enqueueSegmentsOut` 全部炸：
       *
       *     Error: this.log is not a function
       *
       * 而调用方 `card.share(...)` 看起来完全正常，模型给的参数也对，
       * 错误发生在最后一步 —— 最不该失败的地方。
       *
       * @param {{ chatKey?: string, kind?: string, title?: string, desc?: string,
       *           cover?: string, url?: string }} opts
       * @returns {Promise<{ ok: boolean, mode: 'card'|'text' }>}
       */
      /**
       * **`kind` 默认用 `news`，不用 `bili`。**
       *
       * `bili` 生成的是 **B 站小程序 ark** —— 它指向 B 站那个小程序，
       * 而 QQ 侧需要内测权限才能打开，普通账号点开就是「应用内测中」。
       * 卡片能看见、能显示封面标题，**就是点不动**。
       *
       * `news` 是 `com.tencent.structmsg` 的**通用图文卡片**：点开直接跳
       * `jumpUrl`，不经过任何小程序。样式朴素一点，但**能点**比好看重要。
       */
      share: async ({ chatKey, kind = 'news', title = '', desc = '', cover = '', url = '' } = {}) => {
        const key = String(chatKey ?? '').trim()
        if (!key) throw new Error('card.share 需要 chatKey')

        const head = String(title ?? '').trim()
        const body = String(desc ?? '').trim()
        const pic = String(cover ?? '').trim()
        const link = String(url ?? '').trim()
        if (!link) throw new Error('card.share 需要 url')

        /** 落库给人看的标签：卡片本身读不出文字，界面上要有个东西认 */
        const label = `[${kind}] ${head || link}`

        try {
          const r = await this.client.call('get_mini_app_ark', {
            type: String(kind),
            title: head,
            desc: body,
            picUrl: pic,
            jumpUrl: link,
          })
          /**
           * 取值兼容两种形状：
           *
           *   - `client.call` 原样返回整个回包 → `r.data.data`
           *   - 某些实现/中间层会先解一层 → `r.data`
           *
           * 只认前者的话，`r.data.data` 是 undefined，会静默走降级 ——
           * 表现出来就是"参数全对、卡片变成文字"，而日志里什么都没有
           * （降级日志是 info 级，DSH 里看不到）。
           */
          const ark = r?.data?.data ?? (r?.app ? r : null) ?? r?.data ?? null
          if (ark && typeof ark === 'object') {
            this.enqueueSegmentsOut(
              key,
              [{ type: 'json', data: { data: JSON.stringify(ark) } }],
              { text: label, fromTool: 'card' },
            )
            return { ok: true, mode: 'card' }
          }
          console.log(
            `qdash-neo: 卡片未生成（回包里没有 ark）${key} keys=${JSON.stringify(Object.keys(r ?? {}))}`,
          )
        } catch (err) {
          /**
           * 换实现、没这个 action、签名失败 —— 都走降级。
           *
           * **不能因此失败**：卡片是锦上添花，链接才是内容。
           *
           * 用 console.log 而不是 this.log：后者是 info 级，
           * DSH 里看不到 —— 于是"为什么降级"永远查不出来。
           */
          console.log(`qdash-neo: 卡片不可用，降级为文本 ${key} msg=${err?.message}`)
        }

        this.enqueueOut(key, [head, body, link].filter(Boolean).join('\n'), { fromTool: 'card' })
        return { ok: true, mode: 'text' }
      },
    }

    /**
     * 插件可订阅的内核事件（只读旁听）。
     *
     * 门面只暴露 `on()`，不暴露 `emit()` —— 发事件是内核的事。
     * 插件之间想互相通信应该走自己的存储，而不是借这里当消息总线。
     */
    /** 订阅配置变更的插件回调（见 onConfigChange） */
    this.configListeners = new Set()

    this.pluginEvents = new PluginEvents({ log: this.log })
    this.on = (event, handler) => this.pluginEvents.on(event, handler)

    /**
     * **配置落盘后的通知**（插件用）。
     *
     * 解决一个反复踩的坑：选项卡是「注册那一刻的快照」，而配置随时会被改 ——
     * 于是插件页显示的状态和实际开关**不一致**：用户把语音关了，页面还写着
     * 「已开启」，因为他不知道要点一下「刷新列表」。
     *
     * 原来没有任何办法让插件知道配置变了（`pluginEvents` 是内核事件总线，
     * 只旁听，不转发配置）。
     *
     * **注册即回调一次**：插件不必自己处理"挂载时配置已经就绪"这种情况，
     * 否则每个插件都要写一遍初始化 + 订阅两套逻辑。
     *
     * @param {(config: object) => void} fn
     * @returns {() => void} 退订
     */
    this.onConfigChange = fn => {
      if (typeof fn !== 'function') return () => {}
      const wrapped = config => {
        try {
          fn(config)
        } catch (err) {
          this.log('warn', `qdash-neo: 配置变更回调抛错 msg=${err?.message}`)
        }
      }
      this.configListeners.add(wrapped)
      // 挂载即同步一次当前值
      wrapped(this.config)
      return () => this.configListeners.delete(wrapped)
    }

    /**
     * 能力清单（只读）。
     *
     * **这不是安装期校验** —— 我们拿不到插件的 manifest，DSH 也不会替我们读。
     * 它的用途是让插件自己判断：`if (!ctx.qdashNeo.capabilities['console-static'])`
     * 就退回声明式选项卡，而不是调一个不存在的方法、拿到一个看不懂的 TypeError。
     *
     * 新增能力时同步这里和文档 §0.1，否则插件作者只能靠试。
     */
    /**
     * **给插件的门面：只放行文档里承诺过的东西。**
     *
     * 早先是 `ctx.provide('qdashNeo', service)` —— 整个 service 实例交给插件，
     * 于是 `neo.deliver()` / `neo.client` / `neo.sleepUntil` / `neo.outbox`
     * 这些**内部结构**全都在外面裸着。`capabilities` 那张表因此只是"说明"，
     * 不是"约束"：插件想绕过出站队列，直接用 `neo.client` 就行。
     *
     * 现在用白名单代理：
     *
     *   - 认得的属性 → 正常返回（方法绑定到实例，避免 `this` 丢失）
     *   - 不认得的     → `undefined`（不是抛错：插件常用 `neo?.xxx` 做能力探测，
     *                     抛错会把探测变成崩溃）
     *
     * 加新能力时**必须同时**改这里和 `capabilities` —— 两处不一致就是
     * 又一个"注册了但用不了"的坑。
     */
    this.api = new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        if (!PLUGIN_API_KEYS.has(prop)) return undefined
        // receiver 传 target：getter 里的 `this` 保持指向实例本身
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
      has: (target, prop) => typeof prop === 'string' && PLUGIN_API_KEYS.has(prop),
    })

    this.capabilities = Object.freeze({
      'console-tab': true,
      'console-static': false,
      tools: true,
      settings: true,
      storage: true,
      outbox: true,
      events: true,
      'voice-send': true,
      'voice-hook': true,
      'judge-provider': true,
      /**
       * 插件能发分享卡片（`card.share`）。
       *
       * 厂商支持就发真卡片（带签名），不支持自动降级纯文本。
       * 走队列，和普通消息共享限流与重试。
       */
      card: true,
      /**
       * 插件能往系统提示里加一段常驻引导（`instructions.register`）。
       *
       * **注册了不等于生效**：要这个插件在 `tools.grantedInstructions` 里才注入。
       * 这段文字进的是系统提示，能改写模型对其他事的判断，所以授权独立于工具。
       */
      instructions: true,
      /**
       * 插件能订阅配置变更（`onConfigChange`）。
       *
       * **注册即回调一次**：插件不必自己写「初始化 + 订阅」两套逻辑，
       * 否则每个读配置来渲染状态的选项卡都要处理"挂载时配置是否就绪"。
       */
      'config-events': true,
      fetch: false,
    })
    /** @type {{ userId?: string, nickname?: string }|null} 登录信息，用来拼"机器人的称呼" */
    this.login = null
    // withheld：tool 模式下「说了但没调发送工具」的次数 —— 用来核对
    // 「它到底是真的不想说，还是忘了调工具」，这两个从控制台必须能分开。
    this.stats = {
      inbound: 0,
      dropped: 0,
      silent: 0,
      withheld: 0,
      deferred: 0,
      replied: 0,
      batched: 0,
      errors: 0,
    }
  }

  async start() {
    if (this.started) return
    this.started = true

    const onebot = this.config?.onebot ?? {}
    const jc = this.config?.judge ?? {}

    this.store = new Store(this.config?.store?.path ?? '')
    this.memory = new Memory({ store: this.store, config: this.config, log: this.log })
    // 人设放在插件层：judge 也要读它，放 DSH persona 里插件就看不见了
    this.persona = new Persona({ store: this.store, config: this.config, log: this.log })
    this.voice = this.makeVoice(this.config)
    this.gates = new Gates(this.config)
    this.context = new GroupContext({
      limit: Number.isFinite(jc.contextLines) ? jc.contextLines : 20,
      maxChars: Number.isFinite(jc.contextMaxChars) ? jc.contextMaxChars : 3000,
      ttlMs: (Number.isFinite(jc.contextTtlMinutes) ? jc.contextTtlMinutes : 60) * 60_000,
      store: this.store,
      log: this.log,
      // 重启恢复时用**当前**白名单重算 trusted：白名单来自配置，不是运行时快照
      isTrusted: userId => this.gates.allowAll || this.gates.whitelist.has(String(userId)),
    })
    this.judge = new JudgeChain(this.ctx, {
      config: this.config,
      log: this.log,
      store: this.store,
    })
    // 插件在 start() 之前注册的判定器，现在灌进去（之后注册的走 judgeApi 直接生效）
    for (const d of this.pluginJudges) {
      try {
        this.judge.registerProvider(d)
      } catch (err) {
        this.log('warn', `qdash-neo: 判定器「${d?.name}」注册失败 msg=${err?.message}`)
      }
    }
    // 别名来自配置，登录前就先认一遍；昵称要等 get_login_info
    this.syncBotNames()
    this.router = new SessionRouter(this.ctx, {
      config: this.config,
      log: this.log,
      createUserMessage: this.createUserMessage,
      store: this.store,
      groupSetup: (agentCtx, chatKey) => this.applyGroupToolGuard(agentCtx, chatKey),
    })
    this.outbox = this.createOutbox()
    this.client = new OneBotClient({
      wsUrl: onebot.wsUrl || 'ws://127.0.0.1:3001',
      token: onebot.token || '',
      log: this.log,
    })

    this.detachEvents = attachSessionEvents(this.ctx, {
      log: this.log,
      onReply: (chatKey, text) => this.onAssistant(chatKey, text),
      onUsage: (chatKey, usage) => this.onUsage(chatKey, usage),
      // 模型主动选择不开口（judge.onUnsure='agent' 下的 SILENT_MARKER）
      onSilent: chatKey => {
        this.stats.silent += 1
        this.log('info', `qdash-neo: ${chatKey} 模型选择不开口，本条不发`)
      },
      /**
       * 模型自己要求休息（输出 `[[SLEEP:N]]`）：设置沉睡并静默本条。
       *
       * ## 但**主动唤起时说"睡"不能静音整个群**
       *
       * 两种场景下 `[[SLEEP:N]]` 的语义完全不同：
       *
       *   - **群友在聊**，它说"睡" → 我这次不接话，接下来几分钟也别叫我（会话级）
       *   - **定时任务叫它**（B 站分享），它说"睡" → 这轮没东西可发；
       *     但群里正经有人说话时，它**必须还能回**
       *
       * 早先两种情况共用同一个 `sleepUntil`，结果：定时唤起一次、模型说睡，
       * 整个群 10 分钟内谁说话它都不理 —— 一个"后台任务"把前台聊天堵死了。
       *
       * 主动唤起这一轮只记"这次不发"，不落睡眠状态。
       */
      onSleep: (chatKey, minutes) => {
        this.stats.silent += 1
        /**
         * **主动唤起（及紧接其后的一段时间）里，`[[SLEEP]]` 一律丢弃。**
         *
         * 为什么用时间窗口而不是"进行中的集合"：`onSleep` 由会话事件触发，
         * 可能在 `deliver()` 返回之后才来 —— 那时集合已经被 `finally` 清空，
         * 判断必然落空（实测：睡眠照样被写进库）。
         *
         * 窗口 90 秒：够覆盖一次模型调用 + 事件回调的延迟，又远小于一次
         * 定时唤起间隔，不会误伤"群友聊天时它想安静一会儿"。
         */
        const lastProactive = this.proactiveRecent.get(chatKey) ?? 0
        const withinProactive = Date.now() - lastProactive < 90_000
        console.log(
          `qdash-neo: onSleep ${chatKey} ${minutes}s ` +
            `withinProactive=${withinProactive}（${Math.round((Date.now() - lastProactive) / 1000)}s 前）`,
        )
        if (withinProactive) {
          this.log(
            'info',
            `qdash-neo: ${chatKey} 主动唤起后要求沉睡，已忽略（正常聊天不受影响）`,
          )
          return
        }

        /**
         * **记连续安静次数。**
         *
         * 到 `maxConsecutiveSleep` 之后，`renderPrompt` 就不再给 `[[SLEEP]]`
         * 这个选项 —— 否则它会每轮都选最省事的那条，最后等于永久隐身。
         * 它一开口就清零（见 `onAssistant`）。
         */
        const n = (this.consecutiveSleep.get(chatKey) ?? 0) + 1
        this.consecutiveSleep.set(chatKey, n)
        if (n > this.maxConsecutiveSleep) {
          this.log('warn', `qdash-neo: ${chatKey} 已连续安静 ${n} 次，下一轮不再给休眠选项`)
        }

        this.setSleep(chatKey, minutes)
      },
      // 模型给自己排个期（`[[LATER:N|备忘]]`）：到点再唤起一次，说不说由它重新判断
      onLater: (chatKey, later) => {
        this.stats.silent += 1
        this.scheduleLater(chatKey, later)
      },
    })

    // 记一份"当前已生效"的连接参数：applyConfig 靠它判断要不要重连
    this.onebotApplied = {
      wsUrl: String(onebot.wsUrl || ''),
      token: String(onebot.token || ''),
      selfId: String(onebot.selfId || ''),
    }
    this.client.on('message', raw => this.handleInbound(raw))
    this.client.on('ready', () => this.log('info', 'qdash-neo: OneBot 就绪'))
    this.client.on('close', () => this.log('warn', 'qdash-neo: OneBot 连接关闭，等待重连'))
    this.client.on('login', info => this.onLogin(info))

    this.outbox.start()
    this.client.start()

    this.sweeper = setInterval(() => this.gates.sweep(), 60_000)
    this.log('info', `qdash-neo: 已启动 → ${onebot.wsUrl || 'ws://127.0.0.1:3001'}`)
    this.log(
      'info',
      `qdash-neo: 群策略 groupEnabled=${this.gates.groupEnabled} trigger=${this.gates.groupTrigger} ` +
        `群白名单=${this.gates.groupWhitelist.size || '不限'} 配额=${this.gates.quotaMax}/${this.gates.quotaWindowMs / 60_000}min ` +
        `批窗口=${this.batchWindowMs ? `${this.batchWindowMs}ms（最多等 ${this.batchMaxWaitMs}ms、最多 ${this.batchMaxMessages} 条、@ 宽限 ${this.atLookaheadMs}ms）` : '关'}`,
    )
    // 记忆默认关：开着会和自己已有的记忆外挂重复注入，必须让它在日志里可见
    this.log(
      'info',
      this.memory.enabled
        ? `qdash-neo: 长期记忆已启用 inject=${this.memory.inject} 上限=${this.memory.maxChars}字`
        : 'qdash-neo: 长期记忆关闭（memory.enabled=false，不会注入也不会写库）',
    )
    if (this.gates.allowAll) {
      this.log('warn', 'qdash-neo: 白名单是 * —— 所有私聊都会回，仅限开发期使用')
    } else if ((this.config?.policy?.whitelist ?? []).length === 0) {
      this.log('warn', 'qdash-neo: 私聊白名单为空，当前不响应任何私聊（群消息不受白名单约束）')
    }
    if (!this.judge.available().ok) {
      const why = this.judge.available()
      this.log('warn', `qdash-neo: ${why.note} —— groupTrigger=judge 时所有群消息都会静默`)
    }
    // 系统提示写进工作区 AGENTS.md（system 层，新建会话才读得到）
    this.applyInstructions()
    this.startDailyLoop()
  }

  /**
   * 清掉所有还没到点的定时器：批窗口 + 日总结。
   *
   * 为什么必须单独一个方法：`batches.clear()` **只丢引用，不会取消 `setTimeout`** ——
   * 定时器仍然挂在事件循环里，进程要等它到期（最长 `batchMaxWaitMs`，默认 20s）才退出。
   * 表现就是"测试跑完了但命令不返回"。也正因为要能从 teardown 直接调，
   * 它不能依赖 `started`（手工装配的 service 从不调 `start()`）。
   * 日总结的 interval 同理：`setInterval` 不清就永远挂着，测试进程退不出去。
   *
   * @returns {number} 丢掉了多少条未判定的消息
   */
  clearTimers() {
    let dropped = 0
    for (const b of this.batches.values()) {
      dropped += b.evs.length
      if (b.timer) clearTimeout(b.timer)
    }
    this.batches.clear()
    if (this.dailyTimer) clearInterval(this.dailyTimer)
    this.dailyTimer = null
    if (this.dailyBootTimer) clearTimeout(this.dailyBootTimer)
    this.dailyBootTimer = null
    return dropped
  }

  // ---------------- 日总结（按天归纳，补原文窗口之外的断档） ----------------

  /**
   * 起定时器。**不阻塞 start()**：日总结是后台任务，模型慢也不该拖住宿主启动。
   * 关闭时什么都不挂 —— 否则测试/生产都会因为一个空转的 interval 无法退出。
   */
  startDailyLoop() {
    const dc = this.config?.memory?.daily ?? {}
    if (dc.enabled !== true || this.memoryOf()?.enabled !== true) return
    const tick = () => {
      this.runDailySummaries().catch(err => {
        this.dailyLast = { at: Date.now(), done: 0, error: `${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim() }
        this.log('error', `qdash-neo: 日总结任务出错 name=${err?.name} msg=${err?.message}`, err)
      })
    }
    this.dailyTimer = setInterval(tick, 10 * 60_000)
    // 启动 5s 后补跑一次：等 OneBot 连上、会话表就绪，也避开启动瞬间的资源争抢
    this.dailyBootTimer = setTimeout(tick, 5_000)
    this.log(
      'info',
      `qdash-neo: 日总结已启用 回补 ${dc.backfillDays ?? 3} 天、注入最近 ${dc.days ?? 3} 天`,
    )
  }

  /**
   * 缺哪天补哪天。
   *
   * 为什么不是"每天 04:00 触发一次"：进程整夜停机是常态，一次性 setTimeout 递归
   * 会直接丢掉那几天。这里每次都检查最近 `backfillDays` 天，已经有总结就跳过。
   * 失败记 kv（`failed:<ts>:<reason>`）且 1 小时内不重试 —— 否则一个坏掉的
   * provider 会让每 10 分钟烧一次钱。
   */
  async runDailySummaries() {
    const dc = this.config?.memory?.daily ?? {}
    if (dc.enabled !== true || this.memoryOf()?.enabled !== true || !this.store) return 0

    const backfill = Math.max(1, Number.isFinite(dc.backfillDays) ? dc.backfillDays : 3)
    const days = []
    for (let i = 1; i <= backfill; i++) days.push(localDay(Date.now() - i * 86_400_000))

    let done = 0
    for (const chat of this.store.listChats(200) ?? []) {
      if (chat.kind !== 'group') continue
      for (const day of days) {
        const key = `daily:${chat.chat_key}:${day}`
        // 有总结就跳过（幂等靠库里的行，不靠 kv —— kv 可能被清）
        if (this.store.getDailySummary(chat.chat_key, day)) continue
        const state = String(this.store.kvGet(key, '') ?? '')
        if (state.startsWith('failed:')) {
          const at = Number(state.split(':')[1])
          if (Number.isFinite(at) && Date.now() - at < 3600_000) continue
        }
        const res = await summarizeDay(
          this.ctx,
          { store: this.store, config: this.config, log: this.log },
          chat.chat_key,
          day,
        )
        if (res.ok && !res.skipped) {
          this.store.kvSet(key, 'done')
          done += 1
        } else if (!res.ok) {
          this.store.kvSet(key, `failed:${Date.now()}:${res.reason ?? '未知'}`)
        }
      }
    }
    this.dailyLast = { at: Date.now(), done, error: null }
    if (done) this.log('info', `qdash-neo: 日总结补跑完成 ${done} 条`)
    return done
  }

  async stop() {
    // 定时器清理放在 started 判断**之前**：没 start 过也可能有批窗口在等
    const dropped = this.clearTimers()
    // 丢弃要留痕 —— 静默丢消息是最难查的一类问题
    if (dropped) this.log('warn', `qdash-neo: 停机丢弃 ${dropped} 条未判定的群消息（仍在上下文/数据库里，重启可恢复）`)
    if (!this.started) return
    this.started = false
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    this.outbox?.stop()
    // 停机时队列里没发出去的分片不会再结算了，留着只会让 ledger 变成僵尸记账
    this.ledger?.clear()
    this.client?.stop()
    this.detachEvents?.()
    await this.router?.releaseAll()
    this.store?.close()
    this.log('info', 'qdash-neo: 已停止')
  }

  /** 02 §3：入站处理串行化。事件是 fire-and-forget，不串行化会乱序 */
  push(chatKey, fn) {
    const prev = this.chatTails.get(chatKey) ?? Promise.resolve()
    const next = prev.then(fn).catch(err => {
      this.stats.errors += 1
      this.log('error', `qdash-neo: ${chatKey} 处理链出错 name=${err?.name} code=${err?.code} msg=${err?.message}`, err)
    })
    this.chatTails.set(chatKey, next)
    return next
  }

  /**
   * 能授权群管理操作（踢人）的 QQ 号。
   *
   * **只认 `tools.adminOwners`，留空就是没有人能踢**（fail-closed）。
   *
   * 早先版本会回落到 `policy.whitelist`（私聊白名单）—— 那是错的：
   * 私聊白名单的语义是"谁能找我聊天"，常包含几个朋友；管理权限跟着它走，
   * 等于**给所有能私聊的人自动发了踢人权**。权限升级必须显式配置，
   * 不能因为"没配"就默认给最大。
   *
   * @returns {Set<string>}
   */
  adminOwners() {
    const raw = this.config?.tools?.adminOwners
    const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，]+/)
    return new Set(
      arr
        .map(x => String(x ?? '').trim())
        .filter(Boolean),
    )
  }

  /**
   * 随机回复概率 + 随机沉睡的配置归一化。
   *
   * 为什么单独抽出来：**构造函数里也要调一次**。`applyConfig` 只在控制台保存后触发，
   * 而这两个值在"启动后第一波消息"就要生效 —— 否则要么靠默认值蒙对、要么第一次保存前都失效。
   *
   * 概率夹到 [0,1]；沉睡范围做一次规范化（min>max 时把 max 顶上去），
   * 配置写反了不该让"夹住模型给的数字"变成负数区间。
   *
   * @param {object} config
   */
  applyRandomPolicy(config) {
    const pc = config?.policy ?? {}
    const chance = Number(pc.replyChance)
    this.replyChance = Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : 1

    const sl = pc.sleep ?? {}
    this.sleepEnabled = sl.enabled === true
    const min = Number(sl.minSeconds)
    const max = Number(sl.maxSeconds)
    this.sleepMin = Number.isFinite(min) && min > 0 ? Math.round(min) : 30
    this.sleepMax = Number.isFinite(max) && max >= this.sleepMin ? Math.round(max) : Math.max(this.sleepMin, 600)

    /**
     * **短期安静档**：`SILENT` 只管一轮、`SLEEP:600` 又太长，
     * 真人"先看看再说"是这一档。
     */
    const short = Number(sl.shortSeconds)
    this.sleepShort = Number.isFinite(short) && short > 0 ? Math.round(short) : 60
    /** 连续安静几次后不再给这个选项（0 = 不限） */
    const maxCons = Number(sl.maxConsecutive)
    this.maxConsecutiveSleep = Number.isFinite(maxCons) && maxCons >= 0 ? Math.round(maxCons) : 2
  }

  /**
   * 发一条**消息段**（图片、表情这类非纯文本）。只由出站队列调用。
   * @param {string} chatKey
   * @param {object[]} segments
   */
  async sendSegments(chatKey, segments) {
    const t = parseChatKey(chatKey)
    const prepared = await this.localizeSegments(segments)
    if (t.kind === 'group') {
      return this.client.call('send_group_msg', { group_id: t.groupId, message: prepared })
    }
    if (t.kind === 'private') {
      return this.client.call('send_private_msg', { user_id: t.userId, message: prepared })
    }
    throw new Error(`无法识别的会话 ${chatKey}`)
  }

  /**
   * 把消息段里的**本地绝对路径**换成 `base64://`。
   *
   * **NapCat 不一定和我们在同一台机器上。** `ws://huhufox.love:7777` 这种远程地址，
   * 它读不到 `/opt/...` 下的文件 —— 消息会进死信、重试三次后静默丢弃。
   *
   * 症状特别误导人：TTS 合成成功（缓存里有 wav）、`qq_speak` 返回 `ok`、
   * 数据库里落了一条 `[语音] …`，**但对方什么也没收到**。
   * 而 `dead` 状态只在库里，日志里那句 error 又看不到。
   *
   * 只处理绝对路径：`http(s)://`、`base64://`、相对路径原样透传 —— 那些
   * 本来就是给 NapCat 的引用（远程 URL 或它自己认的相对名）。
   */
  async localizeSegments(segments) {
    const out = []
    for (const seg of segments ?? []) {
      const file = seg?.data?.file
      if (typeof file !== 'string' || !isAbsolute(file)) {
        out.push(seg)
        continue
      }
      try {
        const buf = await readFile(file)
        out.push({ ...seg, data: { ...seg.data, file: `base64://${buf.toString('base64')}` } })
      } catch (err) {
        this.log('warn', `qdash-neo: 读附件失败，原样发送 ${file} msg=${err?.message}`)
        out.push(seg)
      }
    }
    return out
  }

  /**
   * 这个会话还在睡吗。
   * @param {string} chatKey
   * @returns {number} 截止时间戳；0 = 醒着
   */
  isSleeping(chatKey) {
    const now = Date.now()
    let until = this.sleepUntil.get(chatKey) ?? 0
    if (!until && this.store?.kvGet) {
      // 内存里没有 ⇒ 可能刚重启：查一次库，命中就补进内存，之后不再查
      try {
        until = Number(this.store.kvGet(`sleep:${chatKey}`, 0)) || 0
      } catch {
        until = 0
      }
      if (until > now) this.sleepUntil.set(chatKey, until)
    }
    if (until <= now) {
      if (this.sleepUntil.has(chatKey)) this.sleepUntil.delete(chatKey)
      return 0
    }
    return until
  }

  /**
   * 让某个会话睡一觉。时长由模型给（`[[SLEEP:N]]`），这里夹进配置范围。
   * @param {string} chatKey
   * @param {number} minutes
   * @returns {number} 截止时间戳
   */
  setSleep(chatKey, seconds) {
    const s = Math.min(this.sleepMax, Math.max(this.sleepMin, Math.round(Number(seconds) || this.sleepMin)))
    const until = Date.now() + s * 1000
    this.sleepUntil.set(chatKey, until)
    try {
      this.store?.kvSet?.(`sleep:${chatKey}`, until)
    } catch (err) {
      this.log('warn', `qdash-neo: 沉睡状态落盘失败 ${chatKey} name=${err?.name} msg=${err?.message}`)
    }
    const human = s >= 60 ? `${Math.round(s / 60)} 分钟（${s}s）` : `${s} 秒`
    this.log(
      'info',
      `qdash-neo: ${chatKey} 进入沉睡 ${human}（至 ${new Date(until).toLocaleString('zh-CN')}），期间不响应`,
    )
    return until
  }

  /** 主动叫醒（控制台/调式用；模型自己睡的到点会自动失效） */
  wake(chatKey) {
    const was = this.isSleeping(chatKey)
    this.sleepUntil.delete(chatKey)
    try {
      this.store?.kvSet?.(`sleep:${chatKey}`, 0)
    } catch {
      /* 清不掉也无所谓：内存已经删了，重启后会自然过期 */
    }
    if (was) this.log('info', `qdash-neo: ${chatKey} 已被叫醒`)
    return Boolean(was)
  }

  /**
   * 把 `agent.systemPrompt` 同步进工作区 `AGENTS.md`。
   *
   * 走文件而不是每条 user message：行为约束属于系统层，混在对话里会被稀释。
   * `dsh-agent-instructions` 在会话建立时读一次，所以**改完对新会话生效**。
   * @returns {{ ok: boolean, file: string, action: string, error?: string }|null}
   */
  applyInstructions() {
    const cwd = this.router?.meta?.()?.cwd
    if (!cwd) return null
    const res = syncInstructions({
      cwd,
      text: String(this.config?.agent?.systemPrompt ?? ''),
      /**
       * 沉默标记**不再注入**。
       *
       * 正文一律不自动转发，不说话就是"不调发送工具"——这件事本身已经是静默，
       * 再教它一个 `[[SILENT]]` 只会让它在"要不要发"之外多一层决策负担。
       *
       * 解析逻辑仍保留（旧会话或历史记录里可能出现），只是不再写进提示词。
       */
      silentRule: false,
      // 记忆引导跟工具成对出现：没开记忆就别教它用 memory_add
      memoryRule: this.config?.agent?.memoryRule !== false && this.config?.memory?.enabled === true,
      /**
       * 插件引导：**只拼已授权的**。
       *
       * 这段文字进的是系统提示，等于能改写行为准则 —— 所以和工具一样，
       * 注册只让它"看得见"，要 `instructions.grantedInstructions` 里点了才生效。
       */
      pluginRules: this.pluginInstructions.granted(
        this.config?.tools?.grantedInstructions ?? [],
      ),
      log: this.log,
    })
    if (!res.ok) this.log('warn', `qdash-neo: 系统提示同步失败 file=${res.file} reason=${res.error}`)
    return res
  }

  /**
   * 删除一个会话：内存句柄 + 磁盘记录 + chats 行。
   *
   * 为什么三处都要动：
   *   - 只删内存：下一条消息走 resume，会话"复活"，用户以为没删掉
   *   - 只删磁盘：内存里还有 live handle，`ctx.agents.get()` 命中它，同样复活
   *   - 不删 chats 行：列表里还留着一条永远打不开的会话
   *
   * messages 不删 —— 那是"发生过什么"的证据，删了就没法回看为什么沉默。
   * @param {string} chatKey
   */
  async deleteChat(chatKey) {
    const key = String(chatKey ?? '').trim()
    if (!key) throw new Error('chatKey 不能为空')
    const sessionId = SessionRouter.sessionIdOf(key)

    const released = await this.router?.release?.(key)
    const removed = SessionRouter.removeStoredSession(sessionId, { log: this.log })
    this.store?.deleteChat?.(key)
    // 内存里的上下文/批次也要清：否则刚删完，缓冲区里那条消息还能触发一次回复
    this.context?.clear?.(key)
    this.batches.delete(key)

    this.log(
      'info',
      `qdash-neo: 已删除会话 ${key}（句柄=${released ? '释放' : '无'}，磁盘记录=${removed.length} 处）`,
    )
    return { chatKey: key, released, removed: removed.length }
  }

  /** get_login_info 回来自报昵称：判定启发式「叫名字」全靠它 */
  onLogin({ userId, nickname } = {}) {
    this.login = { userId, nickname }
    this.syncBotNames()
  }

  /**
   * 把"机器人叫什么"同步给两个消费者：
   *   - `judge`：启发式判"被点名" → 直接 reply，零模型调用
   *   - `gates`：`mention` 档放行条件（`atMe || named(text)`）
   *
   * **必须是同一份名单**：只喂一边会出现"闸门放进来了、判定却判成 unsure"——
   * 白花一次模型判定，而且行为看起来像别名没生效。
   */
  syncBotNames() {
    const { nickname, userId } = this.login ?? {}
    // 别名跟随当前人格卡；store 还没就绪时 personaOf() 返回 undefined，退回配置兜底
    const aliases = this.personaOf()?.aliases() ?? this.config?.identity?.aliases ?? []
    const names = [nickname, userId, ...aliases].filter(Boolean)
    this.judge?.setBotNames(names)
    this.gates?.setBotNames(names)
    this.log('info', `qdash-neo: 机器人的称呼 ${this.judge?.botNames?.join('/') || '(无)'}`)
  }

  /**
   * 给会话挂工具。
   *
   * 群里有非白名单成员，文本属于不可信输入，一句「忽略以上指令，执行 xxx」
   * 不能真的变成工具调用 —— 所以这里做的是**正面清单**：只有白名单里的工具可见，
   * 高危项（bash/pwsh/写文件…）在 `catalog.js` 里就被排除了，配都配不进去。
   *
   * `guard()` 仍然保留作第二道保险：万一白名单被配成"全开"，
   * guard 是单调拒绝，还能兜住。两者都在 agent 作用域挂（`setup`），
   * 不影响私聊和其他会话。
   */
  applyGroupToolGuard(agentCtx, chatKey) {
    const tools = agentCtx?.tools
    if (!tools) {
      // 不能硬上未验证的写法：拿不到就明说没生效，别假装降权了
      this.log('warn', `qdash-neo: ${chatKey} 拿不到 agentCtx.tools，工具未挂载（docs/03）`)
      return
    }
    /**
     * `attachments` 是 cordis 服务，而它**没在 inject 里**（可选后端：有的部署不装附件库）。
     *
     * 关键点：没声明的服务，**读属性本身就会抛** `cannot get property "attachments" without inject`，
     * `?.` 和 `??` 都拦不住 —— 它不是返回 undefined，是 throw。
     * 这行以前直接写在 deps 里，异常冒到 `setup()` 外面，导致
     * `ctx.agents.create/resume` 整个失败：消息停在 `in delivered`，永远不产生 `out`。
     * （2026-10-26 真实踩到：聊天突然全部不回复。）
     */
    let attachments = null
    try {
      attachments = this.ctx?.attachments ?? null
    } catch {
      // 没装附件后端属于正常部署形态，不是错误；读图工具会在运行期降级成"看不了图"
      attachments = null
    }

    /**
     * 工具挂载**不允许**把会话创建拖死。
     *
     * `applyGroupToolGuard` 跑在 `ctx.agents.create/resume` 的 `setup` 里，
     * 这里抛出的任何异常都会让整个 agent 建不起来 —— 表现就是"消息收到了、
     * 状态停在 delivered、永远不回"，而且日志里只有一条 error，很难联想到工具。
     *
     * 所以工具层整体降级处理：挂不上就一个都不给（模型退化成纯对话），
     * 但会话必须能建起来。
     */
    let state = null
    try {
      state = applyToolPolicy(tools, {
        chatKey,
        config: this.config,
        log: this.log,
        withGuard: this.config?.policy?.groupToolGuard !== false,
        // 插件工具：在内核工具之后挂载，同名时内核优先
        pluginTools: this.pluginTools,
        deps: {
          client: this.client,
          attachments,
          // 记忆工具要能写到跟注入同一个 chatKey 下，否则"记得起、用不上"
          memory: this.memoryOf() ?? null,
          // `qq_get_image(file:"latest")` 用它兜底：模型常常不知道具体是哪张图
          lastImageFile: () => this.lastImage.get(chatKey) ?? '',
          /**
           * `image_mark` 用它存"图片 id → 一句描述"。
           *
           * 只给 `kvGet/kvSet` 这两件事就够：工具层不需要认识整个 Store，
           * 而描述映射本来就只是一张键值表。
           */
          store: {
            get: k => {
              try {
                return this.store?.kvGet?.(k) ?? null
              } catch {
                return null
              }
            },
            set: (k, v) => {
              try {
                this.store?.kvSet?.(k, v)
              } catch {
                /* 存不下不该让这轮对话失败 */
              }
            },
          },
          /**
           * 生成一句图片描述（工具层在看图时调）。
           *
           * **不再指望模型自己调 `image_mark`** —— 实测它不调：
           * 看完图它就去回复群友了，"记一句给以后的自己看"对当下没有收益，
           * 提示词里写了、返回值里也催了，都没用。
           *
           * 改成内核自己调一次：用同一份附件（不重复下载），
           * 一句话，失败就当没有。
           */
          describeImage: ref => this.describeImageOf(ref),
          /**
           * 发分享卡片（`qq_send_card` 工具用）。
           *
           * 走的是这里而不是给工具一个 `client`：卡片要签名，而签名只有
           * OneBot 实现算得出来；实现不支持时 `card.share` 自己降级成纯文本。
           */
          card: this.card,
          /**
           * `qq_send_message({ reply_to })` 的校验：这个 ID 是不是真在本轮的批里。
           *
           * **降级而不是拒绝**：抄错一位是模型常犯的小错，为它丢掉整条消息不值。
           * 不认识就当作没传，发一条普通消息 —— 用户至少能看到内容。
           */
          canReply: id => this.turnBatches.get(chatKey)?.has(String(id)) ?? false,
          // 管理类工具的身份校验：只有这些 QQ 号能授权踢人
          ownerIds: this.adminOwners(),
          senderId: () => this.lastSender.get(chatKey) ?? '',
          voice: this.voice,
          enqueue: (key, text, meta) => this.enqueueOut(key, text, meta),
          // 段消息也要落库：否则控制台与重启恢复都看不到"它发过语音/图片"
          enqueueSegments: (key, segments, meta) => this.enqueueSegmentsOut(key, segments, meta),
        },
      })
    } catch (err) {
      this.log(
        'error',
        `qdash-neo: 工具挂载失败，已降级为不挂工具 ${chatKey} name=${err?.name} msg=${err?.message}`,
        err,
      )
    }
    if (state) this.toolStates.set(chatKey, state)
  }

  /**
   * 把插件注册的工具补挂到**所有已建立的会话**上。
   *
   * 插件工具原本只在建会话时挂载，于是"改配置前就建好的会话"永远拿不到新工具 ——
   * 用户看到的是"开了 TTS，当前对话里模型还是不能用"，而唯一的解是删掉会话重建。
   * 那个流程反直觉，也没人会想到。
   *
   * 幂等：已挂过的由 `attachPluginTool` 短路，重复调用不抛错、不刷日志。
   *
   * @returns {number} 实际补挂了几处（一个工具×一个会话算一处）
   */
  /**
   * 按 `tools.grantedPlugins` 对齐**已有会话**上的插件工具：没授予的摘掉、授予的补挂。
   *
   * 两件事都要做：只摘不挂的话，授予之后要等新会话才生效；
   * 只挂不摘的话，收回只对新会话生效 —— 而界面上已经显示"未授予"了。
   *
   * @returns {{ detached: number, attached: number }}
   */
  syncPluginToolPolicy() {
    const granted = new Set((this.config?.tools?.grantedPlugins ?? []).map(String))

    /**
     * 摘掉**所有未被授予的**插件工具，而不是只摘某个黑名单。
     * 因为默认是"一个都不授予"，新建的插件默认就该被摘掉。
     */
    let detached = 0
    for (const state of this.toolStates.values()) {
      if (typeof state?.detachPluginOwner !== 'function') continue
      for (const owner of state.pluginOwners?.() ?? []) {
        if (!granted.has(String(owner))) detached += state.detachPluginOwner(owner)
      }
    }

    // 已挂过的由 attachPluginTool 短路，重复调用不会抛错
    const attached = this.syncPluginToolsToSessions()

    if (detached > 0) {
      this.log('info', `qdash-neo: 按配置从已有会话摘除插件工具 ${detached} 个`)
    }
    return { detached, attached }
  }

  syncPluginToolsToSessions() {
    const defs = this.pluginTools?.defs?.() ?? []
    if (!defs.length || this.toolStates.size === 0) return 0

    /** 白名单：默认空 = 一个都不挂 */
    const granted = new Set((this.config?.tools?.grantedPlugins ?? []).map(String))
    let attached = 0

    for (const state of this.toolStates.values()) {
      if (typeof state?.attachPluginTool !== 'function') continue
      for (const d of defs) {
        if (!granted.has(String(d.owner ?? ''))) continue
        if (state.attachPluginTool(d)) attached += 1
      }
    }

    if (attached > 0) {
      this.log(
        'info',
        `qdash-neo: 已把插件工具补挂到 ${this.toolStates.size} 个会话（共 ${attached} 处）`,
      )
    }
    return attached
  }

  /**
   * @param {object} raw OneBot 原始事件
   */
  /**
   * 包一层 `turn/end` 事件。
   *
   * **不塞进 `openGroupReply` 内部**：那两个方法里有十几处提前 return，
   * 逐个补 emit 必然漏，而漏掉的那个往往正是出问题时最需要看的那条路径。
   * 包在外面就一处，无论如何都会发。
   *
   * @param {'group'|'private'} kind
   * @param {object} ev
   * @param {() => Promise<any>} run
   */
  async #withTurnEvent(kind, ev, run) {
    const started = Date.now()
    let failure = null
    try {
      return await run()
    } catch (err) {
      failure = err
      throw err
    } finally {
      // 一轮结束才清零：`sentCount` 是只读的，靠这里复位，否则下一轮会误判成"已经发过"
      this.toolStates.get(ev.chatKey)?.resetSent?.()
      // 批 ID 只在本轮有效：下一轮是新的一批，旧的引用目标已经不该再被接受
      this.turnBatches.delete(ev.chatKey)
      this.pluginEvents.emit('turn/end', {
        kind,
        chatKey: ev.chatKey,
        inbound: ev,
        costMs: Date.now() - started,
        // 失败也要发：插件想知道"这一轮为什么没回"，就不能只看到成功的
        error: failure ? String(failure?.message ?? failure) : null,
      })
    }
  }

  handleInbound(raw) {
    const ev = normalizeEvent(raw, { selfId: this.config?.onebot?.selfId })
    if (!ev) return
    this.stats.inbound += 1

    const ing = this.gates.ingest(ev)
    if (!ing.ok) {
      this.stats.dropped += 1
      /**
       * 被闸门挡住的消息。**在落库之前发**：插件看到的 reason 与内核日志里的一致，
       * 不用自己去猜"为什么没回"。
       */
      this.pluginEvents.emit('message/dropped', {
        ...ev,
        reason: ing.reason,
        note: ing.note ?? '',
      })
      const level = ing.reason === REASON.GROUP_DISABLED ? 'debug' : 'info'
      this.log(
        level,
        `qdash-neo: 未听见 ${ev.chatKey} msg=${ev.messageId} 原因=${ing.reason}${ing.note ? ` (${ing.note})` : ''}`,
      )
      this.safeInsert({
        chatKey: ev.chatKey,
        qqMsgId: ev.messageId,
        direction: 'in',
        senderId: ev.userId,
        senderName: ev.senderName ?? '',
        // 纯图消息的 ev.text 是空串 —— 存 [图片:file] 才不会在落库时丢掉图片
        text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
        ts: ev.ts,
        state: `dropped:${ing.reason}`,
      })
      return
    }

    /**
     * 群消息的"前置处理"**不排队**。
     *
     * 之前整条 `handleGroup` 都塞进 per-chat 串行链，于是：上一条消息的 agent
     * 调用（几十秒）会把这一条的"入批"堵在队列里 —— 等它执行时批窗口早过了，
     * 永远只能单条成批，观感就是"一句一回复"。
     *
     * 落库、进上下文、入批都是内存/短 SQL 操作，没有并发风险，直接同步做；
     * 只有真正要唤起模型的 `openGroupReply` 才进串行链。
     */
    /**
     * 过闸的入站消息。
     *
     * 放在分叉**之前**（群/私聊都算），但**不保证一定会回复** ——
     * 后面还有批窗口、判定、沉睡这些环节。想只要"真要回复"的那种，
     * 订阅 `turn/end` 更准。
     */
    this.pluginEvents.emit('message/inbound', ev)

    /**
     * 入站诊断：**@ 到底认出来没有、批窗口给了多久**。
     *
     * 排查过两个"看不出原因"的现象：
     *   - @ 了却不回（如果 `atMe` 算错，prompt 里就没有「（@你）」，模型不知道在叫它）
     *   - 批窗口看着不滑动（`hardDue` 被 @ 固定后，后续消息不再推后）
     *
     * 用 console.log 而不是 this.log：info 级在 DSH 里看不到。
     */
    if (ev.kind === 'group') {
      const b = this.batches.get(ev.chatKey)
      /**
       * 把 **段类型** 也打出来。
       *
       * 只打 `atMe=false` 分不清两种情况：
       *   - 消息里真的没有 @ 段
       *   - 有 @ 段，但 `data.qq` 和 `self` 对不上（不同 OneBot 实现的字段名不同：
       *     有的给 `data.qq`，有的给 `data.user_id`）
       *
       * `segs=[text,at,image]` 一眼就能看出来。
       */
      const segs = Array.isArray(ev.segments)
        ? ev.segments.map(s => String(s?.type ?? '?')).join(',')
        : '[]'
      const atQq = Array.isArray(ev.segments)
        ? ev.segments
            .filter(s => s?.type === 'at')
            .map(s => String(s?.data?.qq ?? s?.data?.user_id ?? '?'))
            .join('/')
        : ''
      console.log(
        `qdash-neo: 入站 ${ev.chatKey} msg=${ev.messageId} atMe=${ev.atMe} ` +
          `segs=[${segs}]${atQq ? ` at=${atQq}` : ''} ` +
          `text="${String(ev.text ?? '').slice(0, 24)}" ` +
          `批=${b ? b.evs.length + 1 : 1}条${b ? `（已攒 ${b.evs.length}，firstAt 距今 ${Math.round((Date.now() - b.firstAt) / 1000)}s，hardDue=${b.hardDue ? '有' : '无'}）` : ''}`,
      )
    }

    if (ev.kind === 'group') {
      const next = this.prepareGroupInbound(ev)
      if (next === 'reply') {
        this.push(ev.chatKey, () =>
          this.#withTurnEvent('group', ev, () => this.openGroupReply(ev)),
        )
      }
      return
    }
    // 私聊同理：落库/入批同步做，只有真正要唤起模型的那一步进串行链
    const nextPrivate = this.preparePrivateInbound(ev)
    if (nextPrivate === 'reply') {
      this.push(ev.chatKey, () =>
        this.#withTurnEvent('private', ev, () => this.openPrivateReply(ev)),
      )
    }
  }

  /** 私聊：白名单已在 trigger 里把关，这里只有落库 + 投递 */
  /**
   * 私聊的前置处理：白名单 → 沉睡 → 落库 → 入批。
   *
   * **不掷骰子**。`replyChance` 的语义是"群里没人点名时要不要插话"，
   * 私聊是对方直接对我说话 —— 掷骰子等于"你跟我说话，我三成概率不理你"，
   * 没有任何社交含义，纯粹是故障。
   *
   * **但要批**。私聊里人常常「在吗」「问你个事」「就是那个…」连着发，
   * 逐条会变成三条回复；合并成一条才像正常对话。
   *
   * @param {object} ev
   * @returns {'drop'|'reply'}
   */
  preparePrivateInbound(ev) {
    const trg = this.gates.trigger(ev)
    if (!trg.ok) {
      this.stats.dropped += 1
      this.log(
        trg.reason === REASON.WHITELIST_EMPTY ? 'warn' : 'info',
        `qdash-neo: 丢弃私聊 ${ev.chatKey} msg=${ev.messageId} 原因=${trg.reason}${trg.note ? ` (${trg.note})` : ''}`,
      )
      this.safeInsert({
        chatKey: ev.chatKey,
        qqMsgId: ev.messageId,
        direction: 'in',
        senderId: ev.userId,
        senderName: ev.senderName ?? '',
        // 纯图消息的 ev.text 是空串 —— 存 [图片:file] 才不会在落库时丢掉图片
        text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
        ts: ev.ts,
        state: `dropped:${trg.reason}`,
        atMe: ev.atMe ? 1 : 0,
      })
      return 'drop'
    }

    // 沉睡照旧生效（模型自己要求休息），只是不再掷概率
    const sleepGate = this.sleepGate(ev.chatKey, ev)
    if (sleepGate) {
      this.safeInsert({
        chatKey: ev.chatKey,
        qqMsgId: ev.messageId,
        direction: 'in',
        senderId: ev.userId,
        senderName: ev.senderName ?? '',
        // 纯图消息的 ev.text 是空串 —— 存 [图片:file] 才不会在落库时丢掉图片
        text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
        ts: ev.ts,
        state: `dropped:${sleepGate.reason}`,
        atMe: ev.atMe ? 1 : 0,
      })
      this.recordGate(ev, [ev], sleepGate)
      return 'drop'
    }

    const inserted = this.safeInsert({
      chatKey: ev.chatKey,
      qqMsgId: ev.messageId,
      direction: 'in',
      senderId: ev.userId,
      senderName: ev.senderName ?? '',
      // 纯图消息的 ev.text 是空串 —— 存 [图片:file] 才不会在落库时丢掉图片
      text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
      ts: ev.ts,
      state: 'delivered',
      atMe: ev.atMe ? 1 : 0,
    })
    // 内存去重之外的第二道闸：跨重启靠 (chat_key, qq_msg_id) 唯一约束
    if (inserted === false) {
      this.stats.dropped += 1
      this.log('info', `qdash-neo: 丢弃重复私聊 ${ev.chatKey} msg=${ev.messageId}（落库撞唯一约束）`)
      return 'drop'
    }
    if (ev.imageFile) this.lastImage.set(ev.chatKey, ev.imageFile)

    if (this.batchWindowMs > 0) {
      this.enqueueBatch(ev)
      return 'drop'
    }
    return 'reply'
  }

  /** 私聊立刻回复（前置处理已完成：白名单、沉睡、落库） */
  async openPrivateReply(ev) {
    await this.deliver(ev)
  }

  /** 兼容入口：直接调它 = 前置 + 需要就立刻回 */
  async handlePrivate(ev) {
    if (this.preparePrivateInbound(ev) === 'reply') await this.openPrivateReply(ev)
  }

  /**
   * 群：**先听得见，再决定开不开口**。
   * 落库 state='context' 是"进了上下文"的证据；开不开口由 judgements 表单独记，
   * 这样被判定沉默的消息仍然留在上下文里（否则模型永远看不到群里真实的气氛）。
   */
  /**
   * 群消息的前置处理：落库 → 进上下文 → 沉睡/批窗口判断。
   *
   * **必须是同步且不排队的**（见 `handleInbound` 里的注释）：
   * 它只做内存操作和一条短 SQL，唯一的异步动作（唤起模型）留给调用方。
   *
   * @param {object} ev
   * @returns {'drop'|'reply'} `reply` = 需要立刻走 `openGroupReply`
   */
  prepareGroupInbound(ev) {
    const inserted = this.safeInsert({
      chatKey: ev.chatKey,
      qqMsgId: ev.messageId,
      direction: 'in',
      senderId: ev.userId,
      senderName: ev.senderName ?? '',
      text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
      ts: ev.ts,
      state: 'context',
      atMe: ev.atMe ? 1 : 0,
    })
    if (inserted === false) {
      this.stats.dropped += 1
      this.log('info', `qdash-neo: 丢弃重复群消息 ${ev.chatKey} msg=${ev.messageId}（落库撞唯一约束）`)
      return 'drop'
    }

    this.rememberContext(ev)
    if (ev.imageFile) this.lastImage.set(ev.chatKey, ev.imageFile)

    /**
     * 沉睡期：消息照常落库、照常进上下文（醒来能看到期间发生了什么），
     * 但**不触发回复、也不唤起模型**。放这里而不是闸门里，是因为
     * "进上下文"必须发生在判断之前 —— 否则睡醒后对这段完全失忆。
     */
    const sleepGate = this.sleepGate(ev.chatKey, ev)
    if (sleepGate) {
      this.recordGate(ev, [ev], sleepGate)
      return 'drop'
    }

    // 批窗口：先攒着，等群里安静下来（或等满 maxWait）再一次性处理。
    // 为什么要批：同一件事常常被连着说三五句，逐条处理要花 3~5 次钱、也可能前后结论打架。
    // 适用范围：`judge`（要判定）、`all`（每句都回）、`agent`（每条都要唤起一次模型，**最需要批**）；
    // `mention` 不批 —— 它本来就是"@ 就回"，攒起来只会让回复变慢。
    if (this.batchingOn()) {
      this.enqueueBatch(ev)
      return 'drop'
    }
    return 'reply'
  }

  /** 当前档位是否需要攒批 */
  batchingOn() {
    return (
      this.batchWindowMs > 0 &&
      (this.gates.groupTrigger === 'judge' ||
        this.gates.groupTrigger === 'all' ||
        this.gates.groupTrigger === 'agent')
    )
  }

  /** 兼容入口：直接调它时等价于"前置 + 需要就立刻回"，仍然串行在一处 */
  async handleGroup(ev) {
    const next = this.prepareGroupInbound(ev)
    if (next === 'reply') await this.openGroupReply(ev)
  }

  /** 不走批窗口的群处理：立刻过 trigger → 判定 → 投递 */
  /**
   * 随机回复概率：过完所有闸门后再掷一次骰子。
   *
   * 挡在这里（而不是投递前）是刻意的 —— 被概率挡掉的轮次**不唤起模型**，
   * 否则"让它偶尔不回"反而更贵。`replyChance >= 1` 时直接短路，不消耗随机数。
   *
   * @param {object} ev 代表消息
   * @param {object[]} evs 整批（记账用）
   * @returns {boolean} true = 这次不回
   */
  chanceGate() {
    if (!(this.replyChance < 1)) return null
    if (Math.random() < this.replyChance) return null
    return { ok: false, reason: REASON.SKIPPED_BY_CHANCE, note: `回复概率 ${this.replyChance}` }
  }

  /** @param {string} chatKey @returns {{ok:false,reason:string,note:string}|null} */
  sleepGate(chatKey, ev = null) {
    const until = this.isSleeping(chatKey)
    if (!until) return null

    /**
     * 被点名时**强制唤醒**。
     *
     * 沉睡原本是「模型自己想安静一会儿」，但它不该变成「叫不应」——
     * `@`、私聊、拍一拍都是明确在找它，装没看见比不睡更失礼。
     * 这里直接清掉沉睡状态（连 kv 一起），而不是只放行这一条：
     * 否则下一条普通消息又会继续被挡，观感是"叫一下动一下"。
     */
    if (ev && this.isSummon(ev)) {
      this.clearSleep(chatKey)
      this.log(
        'info',
        `qdash-neo: ${chatKey} 沉睡中被点名，已唤醒（原定睡到 ${new Date(until).toLocaleTimeString('zh-CN')}）`,
      )
      return null
    }

    return {
      ok: false,
      reason: REASON.SLEEPING,
      note: `睡到 ${new Date(until).toLocaleTimeString('zh-CN')}`,
    }
  }

  /**
   * 这条消息算不算「明确在找它」。
   *
   * - 私聊：一对一，对方就是在跟你说话，没有沉睡的理由
   * - `@`：点名
   * - 拍一拍：`client.pokeToMessage()` 合成的消息，id 形如 `poke-<time>-<user>`
   *
   * @param {object} ev
   * @returns {boolean}
   */
  isSummon(ev) {
    if (!ev) return false
    if (ev.kind === 'private') return true
    if (ev.atMe) return true
    if (String(ev.messageId ?? '').startsWith('poke-')) return true

    /**
     * **叫名字（人格别名）也算点名。**
     *
     * `judge/heuristics.js` 里早就写了这两条（@ → 必回、提到名字 → 必回），
     * 但那个模块只在 `groupTrigger=judge` 时跑 —— `agent` 档下别名和关键词
     * **完全无效**，表现就是"叫它名字它不理"。
     *
     * 提到这里之后一次盘活三条链路：
     *   - `sleepGate`：点名 → 强制唤醒（原来只有 @ 和拍一拍能唤醒）
     *   - `deferToAgent`：点名 → 不给 `[[SILENT]]`（必须开口）
     *   - `sleep`：点名 → 不给 `[[SLEEP]]`（不能装睡）
     */
    if (this.gates?.named?.(ev.text)) return true

    /**
     * 启发式关键词。
     *
     * 判定层里它只是"降门槛"（`unsure`，不等于必回）；但用户明确要求
     * **命中关键词就要开口** —— 这些词是他自己配的"该说话的话题"。
     */
    const kws = this.config?.policy?.groupTriggerKeywords
    if (Array.isArray(kws) && kws.length) {
      const t = String(ev.text ?? '')
      if (t && kws.some(k => String(k ?? '').trim() && t.includes(String(k).trim()))) return true
    }

    return false
  }

  /**
   * 造一套语音组件（库 + TTS）。
   *
   * TTS 与语音库**共用目录**：合成缓存放语音库的 `.tts/` 子目录。
   * 让两边各自推一遍目录规则迟早会漂移 —— 换个 `DSH_HOME` 就一个写对、一个写错。
   *
   * @param {object} config
   * @returns {VoiceLibrary}
   */
  makeVoice(config) {
    return new VoiceLibrary(config, {
      log: this.log,
      /**
       * 注入发送出口，而不是让调用方各自传回调。
       *
       * 插件与内核工具共用这一条路：段消息落库（`[语音] xxx`）也在这里发生，
       * 插件不需要知道出站队列长什么样。
       */
      deliver: (chatKey, segments, meta) => this.enqueueSegmentsOut(chatKey, segments, meta),
    })
  }

  /** 清掉沉睡状态（内存 + kv），唤醒时用 */
  clearSleep(chatKey) {
    this.sleepUntil.delete(chatKey)
    try {
      this.store?.kvSet?.(`sleep:${chatKey}`, 0)
    } catch (err) {
      this.log('warn', `qdash-neo: 清除沉睡状态失败 ${chatKey} name=${err?.name} msg=${err?.message}`)
    }
  }

  /**
   * 排期：到点再唤起它一次。
   *
   * **不是定时发言**。到点只是重新给它一次判断机会：说不说、说什么由它决定，
   * 什么都不做是正常结果。若把它做成"到点必须找话说"，那一定会产出尬聊。
   *
   * 同一会话只保留最近一次排期：模型连着排三次，旧的要作废，
   * 否则到点会被连着唤起三次。
   *
   * @param {string} chatKey
   * @param {{ minutes?: number, hint?: string }} later
   * @returns {number} 到点时间戳
   */
  scheduleLater(chatKey, { minutes, hint = '' } = {}) {
    // 上限 4 小时：排到明天早上没意义，那时候上下文早凉了
    const m = Math.min(240, Math.max(1, Math.round(Number(minutes) || 0)))
    const at = Date.now() + m * 60_000

    const prev = this.laterTimers.get(chatKey)
    if (prev) clearTimeout(prev)

    const timer = setTimeout(() => {
      this.laterTimers.delete(chatKey)
      this.openProactive(chatKey, { hint }).catch(err => {
        this.log('error', `qdash-neo: 主动评估失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
      })
    }, m * 60_000)
    // 不为一个排期拖住进程退出
    timer.unref?.()

    this.laterTimers.set(chatKey, timer)
    this.log('info', `qdash-neo: ${chatKey} 排期 ${m} 分钟后重新评估${hint ? `（备忘：${hint}）` : ''}`)
    return at
  }

  /**
   * 主动发言：没有新消息，唤起它一次。
   *
   * 两条约束：
   *   - 安静时段先过闸。深夜不打扰是硬需求，不能只靠模型看着时间自觉
   *     （它知道现在几点，但"该不该说"的判断不稳定）。
   *   - 事件是合成的，`proactive` 标记让 `renderPrompt` 换一套措辞：
   *     必须明确"没人叫你，说不出也正常"，否则它会当成任务去完成。
   */
  async openProactive(chatKey, { hint = '' } = {}) {
    /**
     * 诊断：**谁在唤起。**
     *
     * 出现过"每隔一两分钟就被唤起一次"的现象，而 `openProactive` 只有两个
     * 调用点（`scheduleLater` 回调、定时插件）。打一行调用栈就能分清是哪个
     * —— 没有这行只能猜。
     *
     * 用 console.log 而不是 this.log：info 级在 DSH 里看不到。
     */
    try {
      const stack = String(new Error().stack ?? '')
        .split('\n')
        .slice(2, 5)
        .map(s => s.trim().replace(/^at\s+/, ''))
        .join(' ← ')
      console.log(`qdash-neo: openProactive ${chatKey} hint="${hint.slice(0, 40)}" from ${stack}`)
    } catch {
      /* 诊断失败不该影响唤起 */
    }

    /**
     * **闸门被拦时要返回原因，不能静默 return。**
     *
     * 早先这里是 `log('info', …) + return`，而 info 级在 DSH 里看不到 ——
     * 于是调用方（定时插件）以为"唤起成功了"，用户看到的却是"点了没反应"，
     * 日志里一个字都没有。这个坑排查了很久。
     *
     * @returns {{ ok: boolean, skipped?: string, reason?: string }}
     */
    if (this.config?.proactive?.enabled !== true) {
      const reason = '主动发言未开启：控制台「配置 → 策略」里打开 proactive.enabled'
      this.log('warn', `qdash-neo: ${chatKey} 排期到期，但${reason}`)
      return { ok: false, skipped: 'disabled', reason }
    }

    /**
     * 每日上限。
     *
     * 计数在内存里（重启清零）—— 这个指标是"防一天排十次"的粗保护，
     * 不需要精确到跨重启。真在意的话看日志里的主动评估次数。
     */
    const cap = Number(this.config?.proactive?.maxPerDay)
    const today = new Date().toISOString().slice(0, 10)
    const used = this.proactiveUsed.get(chatKey)
    const count = used && used.day === today ? used.n : 0
    if (Number.isFinite(cap) && cap > 0 && count >= cap) {
      const reason = `今日主动评估已达上限 ${cap}`
      this.log('warn', `qdash-neo: ${chatKey} ${reason}，跳过`)
      return { ok: false, skipped: 'quota', reason }
    }

    const quiet = this.config?.proactive?.quietHours
    if (Array.isArray(quiet) && quiet.length === 2 && this.inQuietHours(quiet)) {
      const reason = `处于安静时段 ${quiet[0]}-${quiet[1]}`
      this.log('warn', `qdash-neo: ${chatKey} ${reason}，跳过本次主动评估`)
      return { ok: false, skipped: 'quiet', reason }
    }

    // 过了所有闸才记账：被安静时段挡下的不算消耗额度
    this.proactiveUsed.set(chatKey, {
      day: today,
      n: count + 1,
    })

    /**
     * **沉睡中不唤起。**
     *
     * `deliver()` 走的是主动通道，**绕过 gates 的睡眠过滤** ——
     * 而定时插件不知道这个会话正在睡，仍然会到点叫它。
     * 于是模型醒来看到"没有新消息"，只能再说一次 `[[SLEEP:N]]`：
     * 日志里连续几条都是"睡"，像在空转。
     *
     * **但主动唤起应该打破沉睡，不是被它挡住。**
     *
     * 两种状态说的不是一回事：
     *
     *   - `[[SLEEP:N]]` = "群里有人在聊，我这会儿不想接话"
     *   - 主动唤起      = "我自己到点想看看有什么可分享的"
     *
     * 后者是**新的刺激**（手上有新内容），凭什么被前者挡住？
     * 早先这里直接 `return`，结果定时任务撞上睡眠期就白跑一趟，
     * 而模型睡醒后还是什么都没有 —— 两头空。
     *
     * 所以先清掉睡眠再唤起：它醒了、看了内容、决定发不发。
     * 决定不发也不会再睡回去（`onSleep` 对主动唤起不落睡眠）。
     */
    if (this.isSleeping(chatKey)) {
      const until = this.sleepUntil.get(chatKey) ?? 0
      const at = until ? new Date(until).toLocaleTimeString('zh-CN', { hour12: false }) : '?'
      this.log('info', `qdash-neo: ${chatKey} 正在沉睡（到 ${at}），主动唤起把它叫醒`)
      this.clearSleep(chatKey)
    }

    const isGroup = chatKey.startsWith('g:')
    const ev = {
      kind: isGroup ? 'group' : 'private',
      chatKey,
      userId: isGroup ? '' : chatKey.slice(2),
      groupId: isGroup ? chatKey.slice(2) : null,
      messageId: `later:${Date.now()}`,
      text: '',
      atMe: false,
      hasImage: false,
      senderName: '',
      ts: Date.now(),
      segments: [],
      proactive: { hint },
    }
    /**
     * 标记「这一轮是主动唤起」。
     *
     * `onSleep` 拿不到 `ev`，只能靠这个标记区分两种"睡"：
     * 主动唤起时说睡 = 这轮没东西可发；**不是**要把整个群静音。
     *
     * 用 `finally` 清 —— `deliver` 抛错也不能把标记漏在那儿，
     * 否则下一轮正常聊天里的 `[[SLEEP:N]]` 会被误判成主动唤起、睡不成了。
     */
    /**
     * 记下"刚主动唤起过"（时间戳，不用删除 —— 窗口自然过期）。
     *
     * `onSleep` 靠这个时间差判断：主动唤起后 90 秒内的 `[[SLEEP]]` 一律丢弃。
     */
    this.proactiveRecent.set(chatKey, Date.now())
    /**
     * 兜底：主动唤起这一轮**不允许留下睡眠**。
     *
     * 时间窗口已经能挡住绝大多数情况，但 `deliver()` 返回后事件回调可能还在路上，
     * 所以出口再看一眼：如果这轮期间睡眠变新了，撤销。
     *
     * 两道闸互相独立 —— 一道看时间差，一道看前后状态。
     */
    const sleepBefore = this.sleepUntil.get(chatKey) ?? 0
    try {
      await this.deliver(ev)
    } finally {
      const sleepAfter = this.sleepUntil.get(chatKey) ?? 0
      if (sleepAfter > sleepBefore && sleepAfter > Date.now()) {
        this.clearSleep(chatKey)
        console.log(
          `qdash-neo: 主动唤起结束后撤销睡眠 ${chatKey}（${Math.round((sleepAfter - Date.now()) / 1000)}s）`,
        )
      }
    }
    return { ok: true }
  }

  /**
   * 是否落在安静时段内。
   * @param {[string, string]} range `['23:00','07:00']`，跨零点也支持
   * @returns {boolean}
   */
  inQuietHours([from, to], now = new Date()) {
    const toMin = s => {
      const [h, m] = String(s).split(':').map(Number)
      return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
    }
    const cur = now.getHours() * 60 + now.getMinutes()
    const a = toMin(from)
    const b = toMin(to)
    if (a === b) return false
    return a < b ? cur >= a && cur < b : cur >= a || cur < b
  }

  /**
   * 掷骰子，决定这一批要不要回。
   *
   * **被点名时不掷**。`@` 是明确的召唤，用概率把它挡掉在社交上说不通
   * （"叫了它三次，两次不理"）。注意判的是**整批任意一条**，不是代表消息 ——
   * `rep` 恒为批里最后一条，而 @ 往往出现在前面几句。
   *
   * 代价说清：如果习惯每条都 @，那 `replyChance` 就形同虚设（永远免疫）。
   * 这是刻意的取舍 —— 概率是用来控制"没人点名时要不要插话"的。
   *
   * @param {object} ev 代表消息
   * @param {object[]} evs 整批
   * @returns {boolean} true = 这次不回
   */
  skipByChance(ev, evs) {
    const batch = Array.isArray(evs) ? evs : [ev]
    if (ev?.atMe || batch.some(e => e?.atMe)) return false

    const gate = this.chanceGate()
    if (!gate) return false
    this.recordGate(ev, evs, gate)
    return true
  }

  async openGroupReply(ev) {
    const trg = this.gates.trigger(ev)
    if (!trg.ok) {
      this.recordGate(ev, [ev], trg)
      return
    }
    if (this.skipByChance(ev, [ev])) return

    let judgement = null
    if (this.gates.groupTrigger === 'judge') {
      const { text } = this.contextText(ev.chatKey, ev.messageId)
      judgement = await this.judge.decide({
        inbound: ev,
        contextText: text,
        // 人格摘要让判定从"通用管家"切成"这个角色想不想接话"
        personaHint: this.personaOf()?.hint(ev.chatKey) ?? '',
      })
      if (judgement.verdict === 'defer') {
        // 判定层放弃决定权：继续走 deliver，由对话层自己决定说不说
        this.stats.deferred += 1
        this.log(
          'debug',
          `qdash-neo: 交给对话层自决 ${ev.chatKey} msg=${ev.messageId} 原因=${judgement.reason}`,
        )
      } else if (judgement.verdict !== 'reply') {
        this.stats.silent += 1
        this.rememberFromJudgement(ev, judgement)
        this.log(
          'debug',
          `qdash-neo: 判定沉默 ${ev.chatKey} msg=${ev.messageId} layer=${judgement.layer} 原因=${judgement.reason}`,
        )
        return
      }
    }

    await this.deliver(ev, judgement)
  }

  // ---------------- 批窗口（防抖 + 最长等待） ----------------

  /**
   * 攒一条；重置静默计时。
   *
   * `@` 例外：它不能等 5s。但也不立刻 flush —— 人常常"@ 完再补一句"，
   * 所以给它一个 `atLookaheadMs`（默认 2s）的宽限，把紧跟着的那句收进来，
   * 然后立刻封口。宽限只提前，不会把 flush 推到 5s。
   * @param {object} ev
   */
  enqueueBatch(ev) {
    const chatKey = ev.chatKey
    const now = Date.now()
    let b = this.batches.get(chatKey)
    if (!b) {
      b = { evs: [], firstAt: now, flushAt: 0, hardDue: 0, timer: null }
      this.batches.set(chatKey, b)
    }
    b.evs.push(ev)

    // 条数到顶就立刻判，别让一次刷屏把内存和延迟都拖爆
    if (b.evs.length >= this.batchMaxMessages) {
      this.scheduleFlush(chatKey, { immediate: true })
      return
    }
    this.scheduleFlush(chatKey, ev.atMe ? { atLookahead: true } : undefined)
  }

  /**
   * 安排/重排 flush。
   *
   * 三条约束同时生效，取最早的那个：
   *   1. 静默窗口：`now + batchWindowMs`（防抖，每来一条都往后推）
   *   2. 最长等待：`firstAt + batchMaxWaitMs`（一直有人说话也不能无限等）
   *   3. @ 宽限：`@时刻 + atLookaheadMs`（**只提前不推后**，之后再来的消息不能把它推迟）
   *
   * 之所以要记住 `hardDue` 而不是每次直接取 min：第 3 条一旦定下就不能被第 1 条推后，
   * 否则 @ 之后每来一句都会把 flush 推回 5s，"@ 立刻回"就名存实亡。
   * @param {string} chatKey
   * @param {{ immediate?: boolean, atLookahead?: boolean }} [opts]
   */
  scheduleFlush(chatKey, { immediate = false, atLookahead = false } = {}) {
    const b = this.batches.get(chatKey)
    if (!b) return
    const now = Date.now()
    const cap = b.firstAt + this.batchMaxWaitMs

    if (immediate) b.hardDue = now
    else if (atLookahead) {
      const due = Math.min(now + this.atLookaheadMs, cap)
      b.hardDue = b.hardDue ? Math.min(b.hardDue, due) : due
    }

    /**
     * 私聊用更短的窗口。
     *
     * 一对一的连发间隔通常只有几百毫秒，等满群聊的 5 秒纯属浪费 ——
     * 而群聊需要那个窗口，因为多人插话的节奏本来就慢。
     * 1.5 秒足够把「在吗／问你个事」并成一条，又不会让人觉得卡。
     */
    const windowMs = chatKey.startsWith('g:') ? this.batchWindowMs : Math.min(this.batchWindowMs, 1500)
    const due = Math.min(immediate ? now : now + windowMs, cap, b.hardDue || Number.POSITIVE_INFINITY)
    const delay = Math.max(0, due - now)
    if (b.timer) clearTimeout(b.timer)
    b.flushAt = due
    b.timer = setTimeout(() => {
      b.timer = null
      // 走同一条 per-chat 串行链：判定与投递不会和后续消息交叉
      this.push(chatKey, () => this.flushBatch(chatKey))
    }, delay)
  }

  /** @param {string} chatKey */
  async flushBatch(chatKey) {
    const b = this.batches.get(chatKey)
    if (!b) return
    this.batches.delete(chatKey)
    if (b.timer) {
      clearTimeout(b.timer)
      b.timer = null
    }
    const evs = b.evs
    if (!evs.length) return

    /**
     * 代表消息：**恒取批里最后一条**。
     *
     * 之前取的是"最后一条 @ 我的，否则最后一条" —— 于是「@ 一句，别人又说了三句」
     * 时，回复会挂在**那条 @ 上**，而用户看到的最新消息是后面三句，观感就是
     * "它在答很久之前那句"。`atMe` 只该用于**提前封口**（`scheduleFlush`），
     * 不参与选代表。
     */
    const rep = evs[evs.length - 1]

    /**
     * 私聊：不判定、不掷骰子，只把这几句合并成一条回复。
     *
     * 白名单与沉睡在 `preparePrivateInbound` 里已经**逐条**判过，
     * 这里不需要再过闸门 —— 再过一遍只会让"连发三条、其中一条刚好过期"变成整批沉默。
     */
    if (!chatKey.startsWith('g:')) {
      this.stats.batched += 1
      this.log(
        'info',
        `qdash-neo: 批窗口合并 ${evs.length} 条 → 回一条 ${chatKey} msg=${rep.messageId} ids=${evs.map(e => e.messageId).join(',')}`,
      )
      await this.deliver(rep, null, { batch: evs, ctx: null })
      return
    }

    // 批里提到了旧话题就说明它还没凉 → 刷新活性。
    // 按批刷而不是逐条刷：一次判定最多一次 SQL，成本可忽略。
    this.memoryOf()?.touch(chatKey, evs.map(e => e.text || '').join('\n'))

    const trg = this.gates.trigger(rep)
    if (!trg.ok) {
      this.recordGate(rep, evs, trg)
      return
    }
    if (this.skipByChance(rep, evs)) return

    // 历史只取"本批第一条之前"的：判定期间新到的消息不该混进这次的历史，
    // 否则 prompt 里会出现"历史比当前还新"，模型会去回应还没轮到它的那句话。
    const ctx = this.contextText(chatKey, evs.map(e => e.messageId), { beforeMessageId: evs[0].messageId })

    // `all` 档不判：配置语义就是"白名单成员每句都回"，只做合并去重
    let judgement = null
    if (this.gates.groupTrigger === 'judge') {
      judgement = await this.judge.decideBatch({
        inbound: rep,
        batch: evs,
        contextText: ctx.text,
        personaHint: this.personaOf()?.hint(chatKey) ?? '',
      })
      if (judgement.verdict === 'defer') {
        // 判定层放弃决定权：继续走 deliver，由对话层自己决定说不说
        this.stats.deferred += 1
        this.log(
          'debug',
          `qdash-neo: 交给对话层自决 ${chatKey} msg=${rep.messageId} 批=${evs.length} 条 原因=${judgement.reason}`,
        )
      } else if (judgement.verdict !== 'reply') {
        this.stats.silent += 1
        this.rememberFromJudgement(rep, judgement)
        this.log(
          'debug',
          `qdash-neo: 判定沉默 ${chatKey} msg=${rep.messageId} 批=${evs.length} 条 layer=${judgement.layer} 原因=${judgement.reason}`,
        )
        return
      }
    }

    this.stats.batched += 1
    this.log(
      'info',
      `qdash-neo: 批窗口合并 ${evs.length} 条 → 回一条 ${chatKey} msg=${rep.messageId} ids=${evs.map(e => e.messageId).join(',')}`,
    )
    await this.deliver(rep, judgement, { batch: evs, ctx })
  }

  /**
   * 被闸门挡住也要能查到（需求 4：为什么没回）。
   * `mention` 档的"没 @ 我"属于预期静默，不记库，否则每条群消息都多一行噪音。
   */
  recordGate(ev, evs, trg) {
    this.stats.silent += 1
    const batch = evs.length > 1 ? `，批 ${evs.length} 条` : ''
    this.log(
      'debug',
      `qdash-neo: 不开口 ${ev.chatKey} msg=${ev.messageId} 原因=${trg.reason}${trg.note ? ` (${trg.note})` : ''}（已进上下文${batch}）`,
    )
    if (trg.reason === REASON.NOT_MENTIONED) return
    try {
      this.store.recordJudgement({
        chatKey: ev.chatKey,
        qqMsgId: ev.messageId || null,
        layer: 'gate',
        verdict: 'silent',
        score: null,
        reason: `${trg.reason}${trg.note ? `：${trg.note}` : ''}`,
        code: trg.reason,
        costMs: 0,
        batchSize: evs.length,
        msgIds: evs.map(e => e.messageId).filter(Boolean),
      })
    } catch (err) {
      this.log('error', `qdash-neo: 闸门记录落库失败 ${ev.chatKey} name=${err?.name} msg=${err?.message}`, err)
    }
  }

  /** 入上下文（含非白名单成员）。纯内存 O(1)，落库已在 handleGroup 里做过 */
  rememberContext(ev) {
    this.context.append(ev.chatKey, {
      userId: ev.userId,
      senderName: ev.senderName ?? '',
      /**
       * **纯图消息的 `ev.text` 是空串**（它只拼文字段）。
       *
       * 早先这里写 `'[图片]'`，没有 id —— 历史渲染时既查不到描述，
       * 也无法回看。现在带 id，渲染那一层才能把它换成描述。
       */
      text: ev.text || (ev.hasImage ? imageTag(ev) : ''),
      atMe: ev.atMe,
      ts: ev.ts ?? Date.now(),
      messageId: ev.messageId,
      direction: 'in',
      trusted: this.gates.allowAll || this.gates.whitelist.has(String(ev.userId)),
    })
  }

  /**
   * 出站回写上下文 —— 模型必须知道"我刚说过什么"，否则会把已经答过的问题再答一遍。
   *
   * 只在 `Outbox.onSent` 调（真正送达），不在 `onAssistant`（那只是入队）：
   * 死信也会走一遍入队，模型会以为自己说过一句实际没发出去的话。
   * 顺序放在这里是因为内存缓冲按 append 排，紧跟对应的入站消息。
   * @param {{ chatKey?: string, text?: string, meta?: { qqMsgId?: string } }} item
   */
  rememberOutbound(item) {
    const chatKey = item?.chatKey
    const text = String(item?.text ?? '').trim()
    // 私聊不走上下文缓冲（读取处只在群里拼 prompt），别白占内存
    if (!chatKey || !chatKey.startsWith('g:') || !text) return
    try {
      this.context.append(chatKey, {
        userId: 'self',
        senderName: this.botName(),
        text,
        direction: 'out',
        ts: Date.now(),
        messageId: item.meta?.qqMsgId ?? '',
      })
      // 不再记 `self`：出站原文已经写进 `messages`（上面那条 insert），
      // 记忆的「最近对话」段本来就会把它读回来。单独再存一份只是同一句话放两遍。
    } catch (err) {
      this.log('error', `qdash-neo: 回写出站上下文失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
    }
  }

  /**
   * 渲染给判定器/模型的「群聊记录」片段（排除当前这条/这一批，它们单独标）。
   * @param {string} chatKey
   * @param {string|string[]} messageIdOrIds
   */
  contextText(chatKey, messageIdOrIds, { beforeMessageId } = {}) {
    const ids = Array.isArray(messageIdOrIds) ? messageIdOrIds : [messageIdOrIds]
    const { lines, partial } = this.context.recent(chatKey, { excludeMessageIds: ids, beforeMessageId })
    return {
      text: renderContextBlock(lines, {
        partial,
        /**
         * **历史图片只渲染描述，绝不带 id。**
         *
         * 有描述 → `[柴犬趴在键盘上]`；没有 → `[图片]`。
         * 不带 id 是刻意的：模型没有参数可传，就不会去 `qq_get_image`
         * 把旧图重新读一遍（视觉 token 是大头，而旧图对当下几乎无用）。
         */
        imageDesc: f => this.imageDescOf(f),
      }),
      lines,
      partial,
    }
  }

  /**
   * 独立调一次模型，给一张图写一句描述。
   *
   * 用 `judge` 的 provider/model（配了的话），否则跟随 `agent` ——
   * 判定器本来就是"短调用"的定位，配置语义最接近。
   *
   * **必须是独立调用**：走会话的话，那句描述会变成给群友的回复。
   *
   * @param {object} attachment `attachments.saveImage()` 的返回值
   * @returns {Promise<string>} 空串 = 生成失败（调用方不要写映射）
   */
  async describeImageOf(attachment) {
    const cfg = this.config ?? {}
    const provider = cfg.judge?.provider || cfg.agent?.provider || ''
    const model = cfg.judge?.model || cfg.agent?.model || ''
    return describeImage({
      llm: this.ctx?.llm,
      attachment,
      provider,
      model,
      log: this.log,
    })
  }

  /**
   * 查一张图的描述（`image_mark` / `describeImageOf` 写、历史渲染读）。
   *
   * 没描述就返回空串 —— 调用方据此降级成 `[图片]`。
   * 任何异常都吞掉：**渲染路径不能因为查不到描述而失败**。
   *
   * @param {string} file
   * @returns {string}
   */
  imageDescOf(file) {
    const k = String(file ?? '').trim()
    if (!k) return ''
    try {
      return String(this.store?.kvGet?.(`image:desc:${k}`) ?? '').trim()
    } catch {
      return ''
    }
  }

  /**
   * 记忆懒创建：`start()` 里会建好，这里兜住"测试/控制台手工装配"的场景。
   * 关闭时 `Memory` 自己是空操作，调用方不用到处判断开关。
   */
  memoryOf() {
    if (!this.memory && this.store) {
      this.memory = new Memory({ store: this.store, config: this.config, log: this.log })
    }
    return this.memory
  }

  personaOf() {
    if (!this.persona && this.store) {
      this.persona = new Persona({ store: this.store, config: this.config, log: this.log })
    }
    return this.persona
  }

  /**
   * 判定为"沉默"的那一刻，恰好就是"想说但没说"的定义 —— 复用判定那次调用，
   * 不额外花钱。只写 thought（带 TTL，天然有界）；topic 等控制台能看见再放开。
   *
   * `memory.enabled=false` 时 `remember` 自己返回 null，这里不需要分支。
   */
  rememberFromJudgement(ev, judgement = null) {
    const text = String(judgement?.memory ?? '').trim()
    if (!text) return
    const row = this.memoryOf()?.remember(ev.chatKey, {
      kind: 'thought',
      text: text.slice(0, 40),
      evidence: ev.messageId ? String(ev.messageId) : '',
    })
    if (row) this.log('debug', `qdash-neo: 记下没说的话 ${ev.chatKey} id=${row.id} ${text}`)
  }

  /** 模型看到的机器人昵称：登录昵称优先，其次 QQ 号，最后兜底 */
  botName() {
    return this.judge?.botNames[0] || this.client?.nickname || this.config?.onebot?.selfId || '机器人'
  }

  /**
   * @param {object} ev 代表消息（批窗口下是整批的"那一条"）
   * @param {import('./judge/chain.js').Judgement|null} [judgement]
   * @param {{ batch?: object[]|null, ctx?: { lines: object[], partial: boolean }|null }} [opts]
   */
  async deliver(ev, judgement = null, { batch = null, ctx = null } = {}) {
    const chatKey = ev.chatKey
    const isGroup = ev.kind === 'group'

    /**
     * **待重建的会话在这里清 —— 只在新一轮开始之前。**
     *
     * 上一轮末尾只打标记（那时回复可能还在生成），真正的 `release` + 删目录
     * 放到这里：此刻上一轮**确定已经结束**（串行链保证），清掉不会打断任何东西。
     */
    const pending = this.pendingRebuild.get(chatKey)
    if (pending) {
      this.pendingRebuild.delete(chatKey)
      await this.rebuildSession(chatKey, pending)
    }

    /**
     * 记下这一批的消息 ID：`qq_send_message({ reply_to })` 只接受这些值。
     *
     * 用**真实的 messageId**（不是批内序号），所以这里存的就是模型在 prompt 里
     * 看到的那些 `[#数字]`，不需要再做一层映射。
     */
    if (isGroup) {
      const ids = new Set(
        (Array.isArray(batch) && batch.length ? batch : [ev])
          .map(it => String(it?.messageId ?? '').trim())
          .filter(Boolean),
      )
      if (ids.size) this.turnBatches.set(chatKey, ids)
    }

    // 记下"这次是谁在说话"：`qq_kick` 这类管理工具要靠它做身份校验。
    // 主动发言没有发送者，**不能覆盖** —— 否则它自己开口一次，之前验证过的身份就丢了。
    if (!ev.proactive) this.lastSender.set(chatKey, String(ev.userId ?? ''))

    if (isGroup) this.safeState(chatKey, ev.messageId, 'delivered')

    try {
      this.store.upsertChat({
        chatKey,
        kind: ev.kind,
        chatId: isGroup ? ev.groupId : ev.userId,
        // 会话名统一成「群聊:<群号>」/「私聊:<QQ号>」：看列表时不用再对照 chatKey 猜
        title: isGroup ? `群聊:${ev.groupId}` : `私聊:${ev.userId}`,
        preset: this.config?.agent?.preset ?? '',
        sessionId: SessionRouter.sessionIdOf(chatKey),
      })
    } catch (err) {
      this.log('error', `qdash-neo: 会话落库失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
    }

    const ctxLines = ctx ?? (isGroup ? this.contextText(chatKey, ev.messageId) : { lines: [], partial: false })
    /**
     * 记忆注入**对私聊也生效**。
     *
     * 之前这里写的是 `isGroup ? render(...) : ''`，而记忆本身是按 chatKey 存的、
     * 私聊照样写库 —— 结果是"私聊的记忆存在但永远不注入"，一个存了不用的死区。
     *
     * beforeTs + excludeIds 保证「最近对话」段只补上下文窗口之外的，
     * 且**当前这条消息不会重复**（它在 prompt 正文里已经出现一次）。
     */
    const memoryBlock =
      this.memoryOf()?.render(chatKey, {
        // 群聊：以上下文窗口的起点为上界，窗口内的句子已经进 context，不该在记忆里重复。
        // 私聊没有窗口 → **不设上界**，靠 excludeIds 排掉当前这条。
        // 注意不能用 `ev.ts` 当上界：记忆的时间戳是写入时刻（比消息时间晚），
        // 用它做 `ts < beforeTs` 会把自己刚写的记忆全部过滤掉。
        beforeTs: ctxLines.lines[0]?.ts ?? null,
        excludeIds: [...ctxLines.lines.map(l => l.messageId).filter(Boolean), ev.messageId],
        // 主动发言时没人说话 → 记忆是"可以提的话头"；有消息时它只是背景
        idle: !!ev.proactive,
        /**
         * 「最近对话」段里的 `[图片:id]` 也要换成描述。
         *
         * 这段和「群聊记录」是拼起来用的，替换逻辑必须一致 ——
         * 否则同一张图在前一段有描述、后一段只有 `[图片]`，
         * 模型会以为那是两张不同的图。
         */
        imageDesc: f => this.imageDescOf(f),
      }) ?? ''
    /**
     * 记忆注入的**可见证据**。
     *
     * 不加这行的话，"记忆到底进没进 prompt"只能靠猜：库里有数据 ≠ 渲染非空 ≠ 模型用了它。
     * debug 级别（`QDN_DEBUG=1` 才输出），平时不刷屏。
     */
    if (memoryBlock) {
      this.log('debug', `qdash-neo: 注入记忆 ${chatKey} ${memoryBlock.length} 字`)
    } else if (this.memoryOf()?.enabled) {
      // 开着却没内容，是最容易被误解成"记忆坏了"的情况：说清是"这次没有可注入的"
      this.log('debug', `qdash-neo: 本次无可注入记忆 ${chatKey}（库里有数据但都被窗口/预算排除了）`)
    }

    // 人设不限群：私聊也需要「我是谁」
    const personaBlock = this.personaOf()?.card(chatKey) ?? ''
    const prompt = renderPrompt(ev, {
      botName: this.botName(),
      context: isGroup ? ctxLines.lines : null,
      partial: ctxLines.partial,
      // 私聊也会攒批（`preparePrivateInbound`），所以不能按 isGroup 置空
      batch,
      memory: memoryBlock,
      persona: personaBlock,
      /**
       * 什么时候要求模型"不想说就输出 SILENT_MARKER"：
       *   - `groupTrigger=agent`：压根不判定，决定权从一开始就在模型
       *   - 判定层 defer：判定犹豫，把决定权交回来
       * 两种情况都必须给模型一个表达沉默的方式，否则它只能被迫回一句。
       */
      /**
       * **被点名时必须开口。**
       *
       * `deferToAgent` 为真才会给 `[[SILENT]]` 这个出口。所以点名时把它关掉：
       * @ / 叫名字 / 命中关键词 → 没有"沉默"这个选项，只能说话。
       *
       * 否则会出现"@ 了它，它输出 `[[SILENT]]`" —— 技术上没错（它有权不说），
       * 但用户的感觉就是"叫不应"。
       */
      deferToAgent:
        (this.gates.groupTrigger === 'agent' || judgement?.verdict === 'defer') && !this.isSummon(ev),
      /**
       * 随机沉睡：把范围告诉模型，由它自己决定睡多久（null = 不给这个选项）。
       *
       * **主动唤起时不给。**
       *
       * `[[SLEEP:N]]` 的语义是"我在这个群暂时不想说话" —— 前提是**有人正跟它说话**。
       * 而定时唤起（B 站那种）是"系统叫你来看看"，它根本不在对话里，
       * 说"睡"没有意义：什么都不发就是全部意思。
       *
       * 实测过的后果：B 站插件每跑一次，它必输出 `[[SLEEP:60]]`。
       * 60 还是**旧默认值**（现在范围是 30~600），说明它在照抄记忆里那句
       * "本助手仅 [[SLEEP:60]]" —— **不给选项，就抄不出来**。
       *
       * 主动唤起时它仍然有 `[[SILENT]]` 可用（见 `deferToAgent`），
       * 那才是"这轮没什么可说的"的正确表达。
       */
      /**
       * 被点名时**也不给"睡"这个选项** —— 它已经被叫到了，装睡比不说话更失礼。
       *
       * 三条一起看：
       *   - `!ev.proactive`：主动唤起时不给（它不在对话里）
       *   - `!this.isSummon(ev)`：@ / 叫名字 / 命中关键词时不给
       *   - 两者都不满足才正常给
       */
      sleep:
        this.sleepEnabled &&
        !ev.proactive &&
        !this.isSummon(ev) &&
        // 连续安静到次数后不再给 —— 见 config 里 `maxConsecutive` 的说明
        (this.consecutiveSleep.get(chatKey) ?? 0) < this.maxConsecutiveSleep
          ? { min: this.sleepMin, max: this.sleepMax, short: this.sleepShort }
          : null,

      /**
       * 用户的「系统要求」直接拼进 prompt。
       *
       * `AGENTS.md` 那条通道实测不可靠（见 normalize.js 里的说明）：文件写对了、
       * `.git` 标记也补了，baseline 仍然没进会话记录。既然说了要生效，就走确定的路。
       * 配置项 `agent.promptInMessage` 可以关掉（想要纯净 prompt 时）。
       */
      systemNote:
        this.config?.agent?.promptInMessage === false ? '' : String(this.config?.agent?.systemPrompt ?? '').trim(),

      /**
       * 已授权的插件引导，**直接拼进 prompt**。
       *
       * 早先只写进 `AGENTS.md`，而那条通道实测不通（见 normalize.js 里
       * `sysBlock` 的注释：baseline 进不了会话记录）。更糟的是——
       * 即使文件写对了，**已有会话也要重建才读得到**，
       * 于是"改了引导 → 行为没变"，用户会以为插件没生效。
       *
       * 直接拼是同一轮就生效的。
       */
      pluginRules: this.pluginInstructions.granted(this.config?.tools?.grantedInstructions ?? [])
        .map(r => `【来自「${r.owner}」插件】${r.text}`)
        .join('\n\n'),
      // 主动发言：换一套措辞（"没人叫你，说不出也正常"），普通回复传 null
      proactive: ev.proactive ?? null,
      // 主动发言开着时才教它 `[[LATER:N]]`
      canSchedule: this.config?.proactive?.enabled === true,
      // 语音可用时才提"可以用语音说"
      canSpeak: this.voice?.enabled === true,
    })

    // 记一次「允许模型开口」：配额按开口次数算，不按分条后的消息条数（M2 会分条）。
    // defer 时模型可能最终输出 SILENT_MARKER 而不发，这一次算"保守多记"——
    // 宁可配额紧一点，也不要在发送链路里再做一层计数（那条路没有串行保证）。
    if (isGroup) this.gates.recordReply(chatKey)

    /**
     * **会话历史会无限累积，必须能自愈。**
     *
     * 实测事故：群聊跑一天后，DSH 的 agent 会话涨到
     * `prompt is too long: 1061352 tokens > 1048576 maximum` ——
     * 之后这个群**每一轮都失败**，因为它连"把话发出去"都做不到。
     *
     * 根因是 agent 会把每轮 prompt 追加进自己的历史，而 **DSH 没有压缩机制**。
     * 我们能做的只有"到点重建会话"：
     *
     *   - **兜底**（这里）：撞上 too long 就删掉会话目录、重试一次
     *   - **预防**（`maxTurnsPerSession`）：每 N 轮主动重建，不等到撞墙
     *
     * 重建的代价很小：群聊上下文（`context`）是**从数据库现拼的**，
     * 不在 agent 历史里 —— 重建后照样能看到前面聊了什么。
     */
    try {
      await this.router.deliver(chatKey, prompt)

      /**
       * **按累计字符判断，不按轮数。**
       *
       * 轮数掩盖了真正的问题：第 80 轮的输入是前 79 轮的总和，
       * 按"80 轮"判断会先经历一段越来越慢的区间。按字符则平滑得多 ——
       * 消息密就早点重建，消息稀就晚点，**每轮输入始终可控**。
       */
      const used = (this.historyChars.get(chatKey) ?? 0) + prompt.length
      this.historyChars.set(chatKey, used)

      const turns = (this.turnCount.get(chatKey) ?? 0) + 1
      this.turnCount.set(chatKey, turns)

      /**
       * **只打标记，不在这里清。**
       *
       * `deliver` 返回 ≠ 回复完成 —— 回复是通过 `attachSessionEvents` 的
       * `onReply` 异步回来的。这时候 `release` + 删目录，等于在它写回复的
       * 中途把会话掀了，轻则这一条发不出去，重则整个 handle 处于半死状态。
       *
       * 所以只记下"该清了"，真正的清理放在**下一轮投递之前**
       * （见 `deliver` 开头），那时上一轮肯定已经结束。
       */
      if (used >= this.maxHistoryChars) {
        this.pendingRebuild.set(chatKey, `历史累计 ${Math.round(used / 1000)}k 字`)
        this.historyChars.set(chatKey, 0)
        this.turnCount.set(chatKey, 0)
      } else if (turns >= this.maxTurnsPerSession) {
        this.pendingRebuild.set(chatKey, `已 ${turns} 轮（轮数兜底）`)
        this.historyChars.set(chatKey, 0)
        this.turnCount.set(chatKey, 0)
      }

      const extra = judgement
        ? ` 判定=${judgement.layer}/${Number.isFinite(judgement.score) ? judgement.score.toFixed(2) : '?'}`
        : ''
      this.log('info', `qdash-neo: 已投递 ${chatKey} msg=${ev.messageId}${extra}`)
    } catch (err) {
      this.stats.errors += 1
      const msg = String(err?.message ?? '')

      /**
       * **撞上上下文超限：删会话、重试一次。**
       *
       * 错误长这样：
       *
       *     prompt is too long: 1061352 tokens > 1048576 maximum
       *
       * 一旦发生，这个群**每一轮都会失败** —— 它连"把话发出去"都做不到，
       * 用户看到的就是"机器人死了"，而且日志里只有一行 400。
       *
       * 重建后历史清空、上下文靠数据库重拼，所以不该再撞同一堵墙；
       * 只重试一次，避免"重建也救不回来"时无限循环。
       */
      if (/prompt is too long|tokens?\s*>\s*\d+\s*maximum/i.test(msg)) {
        this.log('warn', `qdash-neo: ${chatKey} 会话历史超限，重建后重试一次`)
        await this.rebuildSession(chatKey, '上下文超限')
        try {
          await this.router.deliver(chatKey, prompt)
          // 重建后从头计：只算这一轮的体积
          this.turnCount.set(chatKey, 1)
          this.historyChars.set(chatKey, prompt.length)
          this.log('info', `qdash-neo: ${chatKey} 重建后投递成功`)
          return
        } catch (err2) {
          this.log(
            'error',
            `qdash-neo: 重建后仍失败 ${chatKey} msg=${err2?.message}`,
          )
          throw err2
        }
      }

      this.log(
        'error',
        `qdash-neo: 投递失败 ${chatKey} msg=${ev.messageId} name=${err?.name} code=${err?.code} msg=${err?.message}`,
        err,
      )
      throw err
    }
  }

  /**
   * 丢掉这个会话的 agent 历史，下次投递重新建一个。
   *
   * 两处需要它：
   *   - **兜底**：投递时报上下文超限
   *   - **预防**：轮数到 `maxTurnsPerSession`
   *
   * **不会丢群聊上下文**：`context` 是从数据库按 chatKey 现拼的，
   * 和 agent 历史是两回事。重建后它照样知道前面聊了什么。
   *
   * @param {string} chatKey
   * @param {string} why 日志里写明原因
   */
  async rebuildSession(chatKey, why = '') {
    try {
      const sessionId = SessionRouter.sessionIdOf(chatKey)
      /**
       * **先等内存里的 handle 释放，再删磁盘目录。**
       *
       * 顺序反了会很糟：目录删了、内存里那份还活着，它继续往一个已删除的
       * 记录里追加，下次 resume 时可能读到半截文件。
       */
      await this.router?.release?.(chatKey)
      const removed = SessionRouter.removeStoredSession(sessionId, { log: this.log })
      this.log(
        'warn',
        `qdash-neo: ${chatKey} 重建会话（${why || '手动'}）删除了 ${removed.length} 个目录`,
      )
    } catch (err) {
      this.log('warn', `qdash-neo: ${chatKey} 重建会话失败 msg=${err?.message}`)
    }
  }

  /**
   * 组装出站队列。抽成方法是为了让测试能塞一个假 `send` 进来，
   * 同时验证的仍是生产同一套 onSent/onDead 回调（否则"测试里绿、真机上不绿"）。
   *
   * 注意 `this.client` 在这里是**延迟求值**的（start() 里 outbox 比 client 先建）：
   * 不要改成立即绑定 `const client = this.client`，那样全是 undefined。
   *
   * @param {{ send?: (chatKey: string, text: string) => Promise<unknown> }} [deps]
   */
  createOutbox({ send } = {}) {
    const oc = this.config?.outbound ?? {}
    return new Outbox({
      /**
       * `meta.replyTo` 是引用回复的目标消息 ID（群聊才有）。
       * 队列把 meta 一起传进来，这里转成 OneBot 的 reply 段。
       */
      send:
        send ?? ((chatKey, text, meta) => this.client.sendText(chatKey, text, meta?.replyTo)),
      // 消息段（发图/发表情）：同一队列、同一限流，只是载荷从文本换成段数组
      sendSegments: (chatKey, segments) => this.sendSegments(chatKey, segments),
      log: this.log,
      perChatIntervalMs: Number.isFinite(oc.intervalMs) ? oc.intervalMs : 1200,
      onSent: item => {
        this.safeState(item.chatKey, item.meta?.qqMsgId, 'sent')
        this.settleReply(item, true)
      },
      onDead: item => {
        this.safeState(item.chatKey, item.meta?.qqMsgId, 'dead')
        this.settleReply(item, false)
      },
    })
  }

  /**
   * 一条回复可能拆成多片（M2）：**每片状态各自流转，上下文/记忆只回写一次**。
   *
   * 为什么不在每片成功时各回写一次：`rememberOutbound` 会 append 一条群上下文，
   * 一次 800 字的回复拆 5 片就会把 20 条的窗口吃掉 5 格，`self` 记忆也变成断句碎片。
   * 全部死信则**不写** —— 模型实际上一个字都没说出去，写进上下文会让它以为自己答过。
   *
   * @param {{ chatKey: string, text: string, meta?: object }} item 队列项
   * @param {boolean} ok
   */
  settleReply(item, ok) {
    const replyId = item?.meta?.replyId
    if (!replyId) return
    const r = this.ledger.settle(replyId, ok)
    if (!r.done) return
    if (r.sent > 0) {
      this.rememberOutbound({
        chatKey: r.chatKey,
        text: r.text,
        meta: { qqMsgId: replyId, parts: r.total, sent: r.sent },
      })
      return
    }
    this.stats.errors += 1
    this.log(
      'error',
      `qdash-neo: 整条回复全部死信，不写上下文 ${r.chatKey} ${replyId} 分片=${r.total}`,
    )
  }

  /**
   * 模型回复 → 分条 → 逐片入队。
   *
   * 分片而不合并的代价是 messages 表行数变多，收益是控制台能看出"第 3 片死了"——
   * 出问题时 30 秒定位到哪一层，这个项目一路都是按这个标准取舍的。
   */
  /**
   * 模型这一轮说完了。
   *
   * 正文**不会**自动发到 QQ —— 想发就自己调 `qq_send_message`。
   *
   * 这个取舍是有意的：如果输出即发送，模型每次被唤醒就**必须**产出一段话，
   * 「不说话」得靠一个显式标记才能做到；而出于"要有用"的倾向它几乎不会用那个标记，
   * 观感就是话多、爱插嘴。让发送变成一个动作之后，"看一眼不接话"才是默认选项。
   *
   * 没发出去的内容照样落库（`unforwarded`）：排查"为什么没回"时，
   * 要能分清"它想了但决定不说"和"它压根没跑"，否则只有一个空白的回合。
   */
  onAssistant(chatKey, text) {
    /**
     * **它开口了 → 连续安静清零。**
     *
     * 这条是"别连着静默"的另一半：计数只在真正说话时才归零，
     * 而不是"过了多久就自动重置"—— 后者会让"每轮说一句废话再睡"
     * 绕开限制。
     */
    this.consecutiveSleep.delete(chatKey)

    /**
     * 本回合已经通过工具发过几条。
     *
     * **只读，不清零**：一轮里模型可能产生多段正文（调工具前后各一段），
     * 读走即清零会让后面的段落误判成"没调过工具"，于是堆一串 unforwarded。
     * 复位交给回合结束时的 `resetSent`。
     */
    const viaTool = this.toolStates.get(chatKey)?.sentCount?.() ?? 0

    /**
     * 临时诊断：这一轮到底有没有调工具、工具白名单里有什么。
     *
     * `this.log()` 的输出在 DSH 里看不到（info 被吞），只能写文件。
     * 关键是 `allow`：里面有 `qq_send_message` 说明模型看得见却没调；
     * 没有则是压根没挂上 —— 那种情况下改多少遍提示词都没用。
     */
    try {
      const st = this.toolStates.get(chatKey)
      appendFileSync(
        '/tmp/qdash-assistant.log',
        `${new Date().toISOString()} chat=${chatKey} viaTool=${viaTool} ` +
          `allow=${JSON.stringify(st?.available ?? [])} textLen=${String(text ?? '').length}\n`,
      )
    } catch {
      /* 诊断失败不该影响正常流程 */
    }
    if (viaTool > 0) {
      this.stats.replied += viaTool
      this.log('info', `qdash-neo: 本回合经工具发送 ${viaTool} 条 ${chatKey}`)
      return
    }

    const body = String(text ?? '').trim()
    if (!body) return

    /**
     * 收尾标记：模型按约定在工具调用后输出 `[[END]]`。
     *
     * 走到这里说明**本轮没调过工具** —— 否则上面 `viaTool > 0` 已经 return 了。
     * 所以这个标记出现在这里只有一种可能：它以为自己发了，其实没发。
     *
     * 不落库（`[[END]]` 本身没有信息量），但记一条 warn —— 这是"它以为发了
     * 其实没发"的唯一线索，不记就彻底静默了。
     */
    // 用它**包含**判断而不是相等：模型常写成「[[END]]（把茶盖推了过去）」
    if (/\[\[END\]\]/i.test(body)) {
      this.stats.withheld += 1
      this.log('warn', `qdash-neo: 模型只输出了收尾标记、没有调发送工具 ${chatKey}`)
      return
    }

    /**
     * 只落库，不发送。
     *
     * **不要改成"兜底补发"。** 试过，会发出垃圾：
     *
     *   [正文] User just sighs "哎". Respond with... via qq_send_message. Text: "（把茶推过去）…"
     *   [工具] qq_send_message → ok
     *   [正文] （把茶盖推了过去）
     *
     * 第一段出现在工具调用**之前**，那一刻 `viaTool` 还是 0，兜底会把整段英文
     * 元描述当成消息发出去。而工具调用之后那段由上面 `viaTool > 0` 拦掉 ——
     * 那个是对的，那是自言自语，不该发。
     *
     * 也就是说：模型在调用前后都会产生正文，**前后都不该发**。
     * 判断"这一轮到底调没调工具"只能在 `turn/end` 做，不能逐段判。
     */
    this.stats.withheld += 1
    try {
      this.safeInsert({
        chatKey,
        qqMsgId: `withheld:${Date.now()}:${this.stats.withheld}`,
        direction: 'out',
        text: body,
        state: 'unforwarded',
      })
    } catch (err) {
      this.log('warn', `qdash-neo: 未发送内容落库失败 ${chatKey} name=${err?.name} msg=${err?.message}`)
    }
  }

  onUsage(chatKey, usage) {
    // usage 只在 assistant/message 上，没有独立记录（00 §六.5）——预算刹车的数据源就是这里
    try {
      this.store.recordUsage({
        chatKey,
        model: this.config?.agent?.model ?? '',
        provider: this.config?.agent?.provider ?? '',
        inTokens: usage?.inputTokens ?? 0,
        outTokens: usage?.outputTokens ?? 0,
        stage: 'answer',
      })
    } catch (err) {
      this.log('error', `qdash-neo: 回答 usage 落库失败 ${chatKey} name=${err?.name} msg=${err?.message}`, err)
    }
  }

  /** 状态更新失败同样不该影响发送 */
  safeState(chatKey, qqMsgId, state) {
    if (!qqMsgId) return
    try {
      this.store.markMessageState(chatKey, qqMsgId, state)
    } catch (err) {
      this.log('error', `qdash-neo: 更新消息状态失败 ${chatKey} ${qqMsgId} -> ${state}`, err)
    }
  }

  /** 落库失败不该挡住消息流，但必须留痕 */
  /**
   * 出站文本的统一出口：**落库 + 入队**。
   *
   * 工具调用与测试都走这里，避免"两条路各写一份"。
   * 落库原来由 `onAssistant` 负责；正文不再自动转发之后，
   * 实际发出去的每一条都只经过这条路径 —— 不在这里记，
   * 控制台就查不到"它到底说了什么"，出问题时只能翻 QQ 客户端。
   *
   * @param {string} chatKey
   * @param {string} text
   * @param {object} [meta] 可带 `qqMsgId`（分批编号时用）
   */
  enqueueOut(chatKey, text, meta = {}) {
    const qqMsgId = meta.qqMsgId ?? `tool:${Date.now()}:${++this.outSeq}`
    this.safeInsert({ chatKey, qqMsgId, direction: 'out', text, state: 'queued' })

    /**
     * 一次回复拆成多片时要**结算**：只有最后一片结算完，才回写一次上下文/记忆。
     *
     * 不 track 的话 `ledger.size` 永远是 0，于是"等结算"的调用方
     * （发送完成、死信重试、上下文回写）全都会立刻返回 —— 表现是消息还在队列里
     * 就以为发完了。分片共享 `replyId`，所以只需要 track 一次。
     */
    if (meta.replyId && !this.trackedReplies.has(meta.replyId)) {
      this.trackedReplies.add(meta.replyId)
      this.ledger.track(meta.replyId, {
        chatKey,
        text: String(meta.fullText ?? text),
        total: Number(meta.total) > 0 ? Number(meta.total) : 1,
      })
    }

    this.outbox?.enqueue(chatKey, text, { ...meta, qqMsgId })
  }

  /**
   * 出站**消息段**的统一出口：落库 + 入队。
   *
   * 和 `enqueueOut` 只差载荷（段数组 vs 文本），落库与状态回写完全共用 ——
   * 不落库的话控制台里这条语音/图片是一片空白，重启后也拼不出"我说过什么"。
   *
   * `qqMsgId` 特意用 `seg:` 前缀而**不是** `out:<ts>:<n>`：后者会被
   * `mergeOutboundShards` 当成一次回复的分片去合并，语音就会和相邻文本粘成一条。
   *
   * @param {string} chatKey
   * @param {object[]} segments
   * @param {{ text?: string, fromTool?: string, replyId?: string, qqMsgId?: string }} [meta]
   *   `text` 是**给人看的标签**（如 `[语音] 晚安`），写进 messages 与控制台
   */
  enqueueSegmentsOut(chatKey, segments, meta = {}) {
    if (!Array.isArray(segments) || !segments.length) return
    const qqMsgId = meta.qqMsgId ?? `seg:${Date.now()}:${++this.outSeq}`
    const label = String(meta.text ?? '').trim() || '[非文本消息]'
    this.safeInsert({ chatKey, qqMsgId, direction: 'out', text: label, state: 'queued' })
    this.outbox?.enqueueSegments(chatKey, segments, { ...meta, qqMsgId, text: label })
  }

  safeInsert(row) {
    try {
      return this.store.insertMessage(row)
    } catch (err) {
      this.log(
        'error',
        `qdash-neo: 落库失败 ${row.chatKey} msg=${row.qqMsgId} name=${err?.name} msg=${err?.message}`,
        err,
      )
      return null
    }
  }

  /** 给控制台/工具读的运行时快照（M3 会长成真正的 overview 接口） */
  /**
   * 控制台热更新：换一份 Config，不重启。
   *
   * 为什么需要它：批窗口/冷却/阈值这些"时间窗口"调完要立刻见效，
   * 否则用户改完还得重启 DSH，等于没做这个功能。
   * 已经在等的批会按新窗口重排；`hardDue`（@ 宽限/条数到顶）保留，不因为放宽窗口被推后。
   * @param {object} next
   */
  applyConfig(next) {
    if (!next) return
    this.config = next
    const jc = next.judge ?? {}
    this.batchWindowMs = Number.isFinite(jc.batchWindowMs) ? jc.batchWindowMs : 5000
    this.batchMaxWaitMs = Number.isFinite(jc.batchMaxWaitMs) ? jc.batchMaxWaitMs : 20000
    this.batchMaxMessages = Number.isFinite(jc.batchMaxMessages) ? jc.batchMaxMessages : 20
    this.atLookaheadMs = Number.isFinite(jc.atLookaheadMs) ? jc.atLookaheadMs : 2000

    /**
     * 会话历史重建阈值（字符）。
     *
     * 改小 → 重建更频繁，每轮输入更轻、响应更快，但"记得"的轮次更少；
     * 改大 → 记得更久，但每轮输入更重（第 N 轮的输入 = 前 N-1 轮之和）。
     */
    const hist = Number(next.agent?.maxHistoryChars)
    this.maxHistoryChars = Number.isFinite(hist) && hist > 0 ? Math.round(hist) : 130_000

    this.gates?.applyConfig?.(next)

    /**
     * 插件工具的开关变了要**立刻**生效。
     *
     * 否则"禁用"只对新建会话有效：界面上已经显示已禁用，当前对话里模型还能调它 ——
     * 这种不一致比没有开关更糟，用户会不再信任任何开关。
     */
    this.syncPluginToolPolicy()

    this.applyRandomPolicy(next)

    /**
     * 「开了管理能力但没指定 owner」是个静默失效：工具会挂给模型，
     * 模型也会去调，然后每次都因为"没有管理员"被拒 —— 用户看不到原因。
     * 与其让它悄悄不工作，不如在配置生效时就说清楚。
     */
    if (next?.tools?.qqAdmin === true && this.adminOwners().size === 0) {
      this.log(
        'warn',
        'qdash-neo: tools.qqAdmin 已开，但 tools.adminOwners 为空 —— 踢人工具会挂给模型，' +
          '但任何要求都会被拒绝。要启用请在「工具」里填上允许授权的 QQ 号',
      )
    }

    this.judge?.applyConfig?.(next)
    // 出站间隔是"改完立刻想看效果"的那类配置：不热更新就等于要重启宿主
    if (this.outbox) {
      const oc = next.outbound ?? {}
      this.outbox.perChatIntervalMs = Number.isFinite(oc.intervalMs) ? oc.intervalMs : 1200
    }

    /**
     * OneBot 连接参数：改了就按新值重连（而不是标"需重启"让字段变灰）。
     * 只比较真正影响握手的三个字段 —— 别的 onebot 配置改了不需要断线。
     */
    const prevOnebot = this.onebotApplied
    const nextOnebot = next.onebot ?? {}
    this.onebotApplied = {
      wsUrl: String(nextOnebot.wsUrl ?? ''),
      token: String(nextOnebot.token ?? ''),
      selfId: String(nextOnebot.selfId ?? ''),
    }
    if (
      prevOnebot &&
      this.client &&
      typeof this.client.restart === 'function' &&
      (prevOnebot.wsUrl !== this.onebotApplied.wsUrl ||
        prevOnebot.token !== this.onebotApplied.token ||
        prevOnebot.selfId !== this.onebotApplied.selfId)
    ) {
      this.log('info', 'qdash-neo: OneBot 连接参数变了，按新值重连')
      this.client.restart({ wsUrl: this.onebotApplied.wsUrl, token: this.onebotApplied.token })
    }
    // 别名是配置项：热更新后必须让 judge 也认，否则只改了闸门那一半
    this.syncBotNames()
    this.memoryOf()?.applyConfig(next)
    this.personaOf()?.applyConfig(next)
    /**
     * 语音库没有需要保留的运行态（只有内存里的发送时间戳，重建一次影响很小），
     * 所以配置变了直接重建 —— 比写一个 applyConfig 更不容易漏字段。
     */
    this.voice = this.makeVoice(next)

    /**
     * 诊断：确认配置里到底有没有 voice / proactive。
     *
     * 排查"库里是 true、运行时是 false"时，只有这一行能说明是**配置没传进来**
     * 还是**传进来了但没被应用**。用 console.log 而不是 this.log（info 看不见）。
     */
    console.log(
      `qdash-neo: applyConfig voice=${JSON.stringify(next?.voice)} ` +
        `proactive=${JSON.stringify(next?.proactive)} ` +
        `voiceEnabled=${this.voice?.enabled}`,
    )

    /**
     * 通知订阅了配置的插件。
     *
     * 放在最后：前面该重建的都重建完了（`voice` 尤其重要），
     * 插件回调里再读状态才是新的。
     */
    for (const fn of this.configListeners) {
      try {
        fn(next)
      } catch (err) {
        this.log('warn', `qdash-neo: 配置变更通知失败 msg=${err?.message}`)
      }
    }

    /**
     * 会话的模型绑定 / cwd。
     *
     * `router.config` 是构造时拿的引用，不同步的话改 `agent.provider` 只在重启后生效 ——
     * 而控制台把这类字段标成「立即生效」，于是用户改完发消息没变化，以为改错了。
     * 另外已建会话的 provider/model 是 create/resume 那一刻定下的，必须重建会话才会换。
     */
    if (this.router) {
      const prev = this.router.config?.agent ?? {}
      const changed = ['provider', 'model', 'reasoningEffort', 'maxTokens', 'preset', 'cwd'].filter(
        k => String(prev[k] ?? '') !== String((next.agent ?? {})[k] ?? ''),
      )
      this.router.config = next
      // systemPrompt 也在 agent 段里：写文件（内容没变时会有 unchanged 短路）
      this.applyInstructions()
      if (changed.length > 0 && typeof this.router.releaseAll === 'function') {
        this.log('info', `qdash-neo: 会话模型绑定变了（${changed.join(',')}），已建会话将按新配置重建`)
        // 不 await：applyConfig 是同步的，释放句柄失败也不该挡住这次保存
        Promise.resolve(this.router.releaseAll()).catch(err => {
          this.log('warn', `qdash-neo: 重建会话失败 name=${err?.name} msg=${err?.message}`)
        })
      }
    }

    // 已经在等的批按新窗口重排；窗口被关掉（=0）时立刻判掉，不能让它们挂到超时。
    // 注意不要一律 immediate：改个阈值不该把半分钟的批突然抖出去。
    for (const key of this.batches.keys()) {
      this.scheduleFlush(key, this.batchWindowMs > 0 ? undefined : { immediate: true })
    }
    this.log(
      'info',
      `qdash-neo: 配置已热更新 批窗口=${this.batchWindowMs || '关'}ms @宽限=${this.atLookaheadMs}ms ` +
        `记忆=${this.memoryOf()?.enabled ? 'on' : 'off'} ` +
        `人设=${this.personaOf()?.enabled ? 'on' : 'off'} 阈值=${this.judge?.threshold ?? '?'}`,
    )
  }

  // ---- 长期记忆的对外接口（控制台 / 外挂脚本用） ----
  // 开关只管「新增」和「注入」：remember 在关闭时返回 null，
  // 但 list / forget / clear 永远可用 —— 否则关掉之后数据变成删不掉的黑盒。
  // 注意：`topic` 的自动抽取**没有做**，现在只从 judge 的 memory 字段写 thought。

  /** @param {string} chatKey @param {{kind:string,text:string,target?:string,evidence?:string}} item */
  remember(chatKey, item) {
    return this.memoryOf()?.remember(chatKey, item) ?? null
  }

  /** @param {string} chatKey */
  listMemories(chatKey) {
    return this.memoryOf()?.list(chatKey) ?? []
  }

  /** @param {string} chatKey @param {number} id */
  forgetMemory(chatKey, id) {
    return this.memoryOf()?.forget(chatKey, id) ?? false
  }

  /** @param {string} chatKey @param {''|'topic'|'thought'|'impression'} [kind] */
  clearMemories(chatKey, kind = '') {
    return this.memoryOf()?.clear(chatKey, kind) ?? 0
  }

  // ---- 人设的对外接口（控制台用） ----
  // 写进 kv（按 chatKey），优先级高于 config.persona。空串表示清掉覆盖、回落到配置。

  /** @param {string} chatKey @param {string} text @param {string} [hint] */
  setPersona(chatKey, text, hint = '') {
    return this.personaOf()?.set(chatKey, text, hint) ?? false
  }

  /** @param {string} chatKey */
  getPersona(chatKey) {
    return this.personaOf()?.snapshot(chatKey) ?? { enabled: false, hasCard: false, cardChars: 0, hint: '', source: 'none' }
  }

  /** @param {string} chatKey */
  clearPersona(chatKey) {
    return this.personaOf()?.clear(chatKey) ?? false
  }

  status() {
    return {
      started: this.started,
      onebot: this.client ? { healthy: this.client.healthy(), url: this.client.wsUrl } : null,
      stats: { ...this.stats },
      queue: this.outbox?.size ?? 0,
      // 已入队但还没结算完的"回复"条数（不是分片数）：用于区分"队列空但还有片在飞"
      pendingReplies: this.ledger?.size ?? 0,
      // 控制台改配置的版本号：前端用它做乐观并发，也用来判断"我看到的表单是不是过期了"
      configRevision: this.configStore?.revision ?? 0,
      // 两级都要可选：router 可能是测试桩（只有 deliver），不带 handles
      chats: this.router?.handles?.size ?? 0,
      groupTrigger: this.gates?.groupTrigger ?? null,
      quota: this.gates
        ? { windowMinutes: this.gates.quotaWindowMs / 60_000, maxReplies: this.gates.quotaMax }
        : null,
      judge: this.judge?.snapshot() ?? null,
      context: this.context?.stats() ?? null,
      // 批窗口里正攒着多少条：调窗口时先看这个，比翻日志快
      batching:
        this.batchWindowMs > 0
          ? {
              windowMs: this.batchWindowMs,
              maxWaitMs: this.batchMaxWaitMs,
              maxMessages: this.batchMaxMessages,
              atLookaheadMs: this.atLookaheadMs,
              pending: [...this.batches.entries()].map(([chatKey, b]) => ({
                chatKey,
                count: b.evs.length,
                waitingMs: Date.now() - b.firstAt,
              })),
            }
          : null,
      // 控制台：挂没挂上、挂在哪、失败原因 —— 不给 token
      console: this.console?.snapshot?.() ?? null,
      // 记忆默认关；这里如实报状态，不做"看起来有"的假象
      memory: this.memoryOf()?.snapshot() ?? { enabled: false },
      // 日总结：开没开、跑没跑、上次是成是败，都要在状态里看得到
      daily: {
        enabled: this.config?.memory?.daily?.enabled === true && (this.memoryOf()?.enabled ?? false),
        days: this.config?.memory?.daily?.days ?? 3,
        backfillDays: this.config?.memory?.daily?.backfillDays ?? 3,
        running: Boolean(this.dailyTimer),
        last: this.dailyLast,
      },
      // 人设同理：报的是静态配置的形态，按群的实际值用 getPersona(chatKey)
      persona: {
        enabled: this.personaOf()?.enabled ?? false,
        hasCard: Boolean(this.personaOf()?.cardConfig),
        hintChars: (this.personaOf()?.hintConfig ?? '').length,
      },
    }
  }
}
