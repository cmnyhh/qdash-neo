/**
 * 静态 Config（schemastery）。
 *
 * 为什么必须是 schemastery 对象而不是 TS interface（docs/qdash-neo/00 §一.5）：
 *   - 没有 schema = 没有校验、没有默认值 = 「装了却什么都不发生」的头号原因
 *   - 控制台表单是从 Config 自动派生的，`ctx.settings.describe()` 读的就是它
 *   - patch 层的 `config` 是整块替换不是深合并 → 每个字段都要有 `.default()`
 *
 * 分层原则（00 §一.5）：静态 Config 放**部署方**的东西（端口/端点/密钥），
 * 用户可改的开关阈值也放这里（那边没有第二套用户 schema），靠 `applies: 'live'` 生效。
 */
import { hostImport } from './host.js'

export async function createConfig() {
  const mod = await hostImport('@deepseek-ai/schemastery')
  const Schema = mod.default ?? mod

  return Schema.object({
    onebot: Schema.object({
      wsUrl: Schema.string()
        .default('ws://127.0.0.1:3001')
        .description('OneBot v11 正向 WS 地址（由 SnowLuma 提供）'),
      token: Schema.string()
        .role('secret')
        .default('')
        .description('OneBot access token（HTTP 与 WS 可能是不同值）'),
      selfId: Schema.string().default('').description('机器人 QQ 号，留空则用事件里的 self_id'),
    }).description('OneBot 连接'),

    /**
     * 机器人身份：除了 get_login_info 给的昵称和 QQ 号，还能额外配几个称呼。
     *
     * 为什么需要：QQ 昵称常常是"小助手"这种通用词，而群里实际叫的是"小白""绫绫"。
     * 只认登录昵称等于只认一半 —— 用户喊破嗓子，判定器也看不见。
     *
     * 命中的语义与 @ 相同（跳判定器、直接回），但**时序强度更弱**：
     * @ 会提前封口批窗口，别名不会（详见 docs/qdash-neo/03 §批窗口）。
     */
    identity: Schema.object({
      aliases: Schema.array(Schema.string())
        .default([])
        .description('兜底别名。别名现在跟着人格卡走，这里只在没选卡时生效'),
    }).description('机器人身份'),

    agent: Schema.object({
      // 必须是 DSH 里**已注册 adapter** 的 route id（`ctx.llm.listProviders()` 里的那个）。
      // 写错不会在保存时报错，而是每次调用抛 `no adapter registered for provider "xxx"`，
      // 表现成"消息收到了但一直不回"—— 2026-10-26 就是这么排查出来的。
      provider: Schema.string().default('deepseek-official').description('provider id（须是 DSH 已注册的 route）'),
      model: Schema.string().default('deepseek-v4.1-flash').description('模型 id'),
      /**
       * 思考强度。取值由 adapter 定义（`ReasoningEffortId` 是 branded string），
       * 内核无法枚举 —— 所以这里是自由文本 + 常见候选，留空表示"用 provider 默认"。
       */
      reasoningEffort: Schema.string()
        .default('high')
        .description('思考强度：off / low / medium / high（取值由 provider 决定）；留空用默认'),
      maxTokens: Schema.natural().default(0).description('单次回复最大输出 token；0 = 用 provider 默认'),
      preset: Schema.string().default('qq-chat').description('agentPreset 名（在 patch 里声明）'),
      cwd: Schema.string()
        .default('')
        .description('agent 工作目录；留空用 ~/.dsh/workspaces/qdash-neo（不存在时自动创建）'),
      /**
       * 用户自定义的系统级提示。
       *
       * DSH 没有「插件追加 system prompt」的公开 API，唯一的官方通道是工作区的
       * `AGENTS.md` —— 它由 `dsh-agent-instructions` 在首次请求前载入 durable context。
       * 所以这里的文本会写进 `<cwd>/AGENTS.md` 的标记块（不动用户自己写的内容），
       * **新建会话时生效**（baseline 只在会话建立时读一次）。
       */
      systemPrompt: Schema.string()
        .default('')
        .description(
          '自定义系统要求：拼在每条消息开头并声明优先于人格卡（立即生效）；同时写入工作区 AGENTS.md 的标记块',
        ),
      /**
       * 插件规则块的开关。规则与用户内容分成两个块维护，所以清空上面的
       * `systemPrompt` 不会连规则一起删掉 —— 这两件事的生命周期不同。
       */
      promptInMessage: Schema.boolean()
        .default(true)
        .description('把上面的「系统提示」拼进每条消息（**唯一可靠通道**）；关掉则只写 AGENTS.md（依赖 DSH 的 baseline 加载）'),
      silentRule: Schema.boolean()
        .default(true)
        .description('是否注入「不想说话就输出 [[SILENT]]」的约定（只在触发策略为 agent / 判定交给模型时才有意义）'),
      memoryRule: Schema.boolean().default(true).description('是否注入 memory_add 的使用引导（记忆关闭时不会注入）'),
    }).description('会话模型绑定'),

    policy: Schema.object({
      whitelist: Schema.array(Schema.string())
        .default([])
        .description('私聊白名单：QQ 号，多个用逗号或换行分隔。空 = 不接受任何私聊'),
      groupEnabled: Schema.boolean().default(true).description('是否响应群消息（总开关）；默认开，装好就能用'),
      groupWhitelist: Schema.array(Schema.string())
        .default([])
        .description('群号白名单：多个用逗号或换行分隔。空 = 机器人所在的群都允许（仍需 groupEnabled）'),
      groupTrigger: Schema.union(['mention', 'all', 'judge', 'agent'])
        .default('agent')
        .description(
          '触发策略：mention 仅 @ 或叫名字 / all 每句都回（群白名单已配时全群生效）/ ' +
            'judge 走判定链 / agent 不判定、直接交给对话层自决（"不想说"由模型输出 SILENT_MARKER，注意每条群消息都会唤起一次模型）',
        ),
      groupMentionOnly: Schema.boolean()
        .default(true)
        .description('[兼容] 旧开关，groupTrigger 非法时兜底'),
      groupTriggerKeywords: Schema.array(Schema.string())
        .default([])
        .description('判定启发式的"值得考虑"关键词（只降门槛，不等于必回）'),
      groupToolGuard: Schema.boolean()
        .default(true)
        .description('群会话挂工具守卫：拒绝写文件/执行命令类工具（群消息是不可信输入，防提示注入）'),
      groupReplyQuota: Schema.object({
        windowMinutes: Schema.natural().default(10).description('配额窗口（分钟）'),
        maxReplies: Schema.natural().default(0).description('窗口内最多开口次数，0 = 不限'),
      }).description('单群回复配额（滑动窗口，防刷屏）'),
      ratePerMinute: Schema.natural().default(20).description('单个 chat 每分钟最多进入触发判定的次数'),
      /**
       * 随机回复概率：过完所有闸门之后，再掷一次骰子。
       *
       * 放在闸门最后一环（而不是投递前）是刻意的：被概率挡掉的轮次**不唤起模型**，
       * 否则"让它偶尔不回"反而更费钱。默认 1 = 每次都回（行为不变）。
       */
      replyChance: Schema.number().default(0.95).description('过闸门后真正回复的概率（0~1，1 = 总回，0.3 = 三成）'),
      /**
       * 随机沉睡：由**模型自己决定**睡多久（范围在这里配），睡着的这段时间完全不响应。
       *
       * 为什么时长交给模型而不是插件随机：它手上有一整段对话和当前情绪，
       * "刚被呛了一句就睡十分钟""聊得正热就说不睡"比均匀随机自然得多。
       * 插件只负责给范围、识别 `[[SLEEP:分钟]]` 标记、以及到点叫醒。
       */
      sleep: Schema.object({
        enabled: Schema.boolean().default(true).description('允许模型自行决定闭麦休息一段时间'),
        // 用秒而不是分钟：等待类参数在配置里混单位最容易出错（乘 60 漏了或乘两次）
        minSeconds: Schema.natural().default(1).description('沉睡时长下限（秒），也是提示词里给模型的范围下界'),
        maxSeconds: Schema.natural().default(60).description('沉睡时长上限（秒），超出会被夹到这个值'),
      }).description('随机沉睡：模型自己决定休息多久（秒），期间完全不响应'),
    }).description('准入策略'),

    /**
     * 工具：给 agent 挂什么能力。
     *
     * 分两类来源：
     *   - **QQ 能力**（插件自己注册的 `qq_*`），按读/写/管理三档开关
     *   - **DSH 里已注册的工具**（内置 + MCP 外部），按名字勾选
     *
     * `bash` / `pwsh` / 写文件 / subagent 这类**永远不给**（见 `tools/catalog.js` 的
     * `DENY_PATTERNS`）：群里是提示注入的重灾区，一个能被说服的模型配一把 shell
     * 就等于把机器交出去。它们是"不出现在列表里"，不是"默认关"。
     */
    tools: Schema.object({
      enabled: Schema.boolean().default(true).description('给 agent 挂工具（关掉则一个都不给）'),
      imageMode: Schema.union(['auto', 'on', 'off'])
        .default('auto')
        .description('读图口径：auto 交给模型看、不支持时降级为文字 / on 必须看（不支持就报错）/ off 只给链接'),
      qqRead: Schema.boolean()
        .default(true)
        .description('QQ 只读能力：看图片、表情包、单条消息、群历史、合并转发、群资料、群成员、群文件'),
      qqWrite: Schema.boolean()
        .default(true)
        .description('QQ 写能力：发消息、发图、发表情、撤回、戳一戳、表情回应（都走出站队列）'),
      qqAdmin: Schema.boolean().default(false).description('QQ 管理能力（踢人）；默认关，误用代价太大'),
      /**
       * 让插件注册的工具出现在模型可见清单里。
       *
       * 默认开 —— 装插件本来就是为了加能力，默认关会让"装了没反应"变成常态。
       * 留这个开关是为了出问题时能一键摘掉：插件工具忘了做参数校验、或者某个插件
       * 注册了做危险操作的工具，关掉它比卸载插件快。
       *
       * 关掉不等于插件不加载，只是它的工具不会被挂到会话上。
       */
      allowPluginTools: Schema.boolean()
        .default(true)
        .description('允许插件注册的工具挂到会话上（关掉则插件工具对模型不可见）'),
      /**
       * 授予哪些插件的工具。
       *
       * **默认是空数组 = 一个都不授予。**
       *
       * 这是安全默认：插件能自己注册工具，但**不能自己给自己授权**。
       * 否则装上一个插件就等于把它的全部能力交给模型，管理员没有任何决策点。
       *
       * 注册之后工具会出现在控制台「工具」页（看得见），但模型拿不到，
       * 直到有人在那里点「授予」。
       *
       * 填的是插件的 `owner`（注册工具时传的名字，默认「未署名插件」）。
       */
      grantedPlugins: Schema.array(Schema.string())
        .default([])
        .description('授予哪些插件的工具（默认空 = 一个都不授予）。在控制台「工具」页点授予，或在这里手填 owner'),
      adminOwners: Schema.array(Schema.string())
        .default([])
        .description(
          '能授权群管理操作（踢人）的 QQ 号，多个用逗号或换行分隔。' +
            '**留空 = 没有人能踢**（不会沿用私聊白名单：那等于给所有能私聊的人发管理权限）',
        ),
      internalAllow: Schema.array(Schema.string())
        .default([])
        .description('额外允许的 DSH 内置工具名（只读类默认已允许，这里用于加例外）'),
      externalAllow: Schema.array(Schema.string())
        .default([])
        .description('允许的外部 / MCP 工具名，多个用逗号或换行分隔'),
    }).description('工具'),

    /**
     * 出站形态（M2）：一条长回复怎么变成 QQ 上的几条。
     *
     * 默认值选的是聊天场景的安全侧：QQ 单条上限远大于 500，但**800 字连发**会被客户端截断，
     * 密集连发在群里就是刷屏。想让它一条发完，把 `split` 关掉即可。
     */
    outbound: Schema.object({
      /**
       * 拆条模式。原来是 boolean（split: true/false），只有"按语义边界拆"和"不拆"两种，
       * 而模型实际会输出**按行/按自然段**排版的文字（一段一条才是它的意图）。
       * `line` 就是给这种输出用的：每行一条，空行只作分隔不计入。
       */
      split: Schema.union(['smart', 'line', 'off'])
        .default('line')
        .description('长回复怎么拆：smart 按语义边界 / line 按换行（每行一条，适合分段写的回复）/ off 一条发全文'),
      maxChars: Schema.natural().default(500).description('单条上限（按字素计：一个 emoji 算 1 字）'),
      maxSegments: Schema.natural()
        .default(5)
        .description('一次回复最多拆几条；超出部分丢弃，并在末条标注已省略多少字'),
      intervalMs: Schema.natural()
        .default(1200)
        .description('同一会话相邻两条的最小间隔（从上一条发送**完成**起算），不同会话互不影响'),
      plainText: Schema.boolean()
        .default(true)
        .description('Markdown 转纯文本（QQ 不渲染）'),
    }).description('出站形态（分条 / 限流 / 清洗）'),

    /**
     * 主动发言：没有新消息时，它自己排期、到点自己决定要不要开口。
     *
     * **默认关**。它带来"像人"，也带来打扰：群里半夜冒一句的社交成本很高，
     * 而模型判断"此刻该不该说"并不稳定。开的人应该知道自己开的是什么。
     *
     * 真正的闸在 `openProactive`：安静时段是硬性的（不靠模型自觉），
     * 每日上限兜底（防它一天排十次）。
     */
    /**
     * 语音库：把准备好的音频当 QQ 语音发出去。
     *
     * **默认关**。语音是"开口说话"的强表达，而且它需要你先往库里放音频——
     * 库是空的却开着开关，模型只会得到一串错误。放几个 .mp3/.silk 再打开。
     *
     * **不做 TTS**。合成质量、音色一致性、外部服务依赖都是另一条产品线的事；
     * 把它塞进来等于要求用户先配一个 TTS 才能用语音。
     */
    voice: Schema.object({
      enabled: Schema.boolean().default(false).description('允许模型发语音（默认关，需先往语音库放文件）'),
      dir: Schema.string()
        .default('')
        .description('语音库目录；留空用 <DSH_HOME>/qdash-voice（不存在时自动创建）'),
      maxSeconds: Schema.natural().default(60).description('单条语音最长秒数，超过拒发'),
      maxBytes: Schema.natural().default(8 * 1024 * 1024).description('单个音频文件大小上限（字节）'),
      maxPerMinute: Schema.natural().default(2).description('每分钟最多发几条语音（0 = 不限）'),
      maxPerHour: Schema.natural().default(10).description('每小时最多发几条语音（0 = 不限）'),
      allowAbsolutePath: Schema.boolean()
        .default(false)
        .description('允许用绝对路径发任意本地音频；默认只从语音库目录取（防 prompt injection 读任意文件）'),
    }).description('语音发送（内核的开关与限制；TTS 合成本身在插件选项卡里，默认关）'),

    proactive: Schema.object({
      enabled: Schema.boolean().default(false).description('允许模型排期后主动开口（默认关）'),
      quietHours: Schema.array(Schema.string())
        .default(['23:00', '07:00'])
        .description('安静时段，如 ["23:00","07:00"]（跨零点可用）；这段时间内到点也不唤起'),
      maxPerDay: Schema.natural().default(1).description('每个会话每天最多主动评估几次（0 = 不限）'),
    }).description('主动发言（默认关）'),

    judge: Schema.object({
      enabled: Schema.boolean().default(true).description('判定器总开关（关掉则启发式不确定的一律不回）'),
      /**
       * 启发式判不出来时，决定权往哪走。三态比一个 boolean 精确：
       * "关掉模型判定"和"干脆不回"是两件不同的事，混在一起会互相覆盖。
       */
      onUnsure: Schema.string()
        .default('agent')
        .description(
          '启发式不确定时：agent=交给对话层自决（默认）/ llm=调模型判定 / silent=一律不回。' +
            'agent 下模型会被要求"不想说就只输出 SILENT_MARKER"',
        ),
      provider: Schema.string().default('').description('判定用的 provider，留空跟随 agent.provider'),
      model: Schema.string().default('').description('判定用的 model，留空跟随 agent.model'),
      timeoutMs: Schema.natural().default(8000).description('判定超时，超时一律静默'),
      maxTokens: Schema.natural()
        .default(1280)
        .description(
          '判定输出的 token 上限。推理模型会先花掉一部分预算（实测 250~512），' +
            '设太小会出现「判定被 max-tokens 截断 → 解析不出 → 永远沉默」；' +
            '判定结果里还要带一句 memory，所以默认留足 1280',
        ),
      threshold: Schema.number().default(0.6).description('0~1：判定分数达到该值才开口（超出范围按边界处理）'),
      batchWindowMs: Schema.natural()
        .default(5000)
        .description(
          '批窗口（防抖）：群消息进来后先攒着，最后一条之后再静默这么久才送判定；' +
            '期间有人接着说就重新计时。0 = 关闭（逐条判）',
        ),
      batchMaxWaitMs: Schema.natural()
        .default(20000)
        .description('批窗口最长等待：一直有人在说话也最多攒这么久就送判定，避免永远等不到静默'),
      batchMaxMessages: Schema.natural().default(20).description('一批最多合并多少条，到量立即送判定'),
      atLookaheadMs: Schema.natural()
        .default(2000)
        .description(
          '被 @ 时提前封口：@ 之后再等这么久就送判定（0=立刻）。' +
            '2s 是为了收进「@ 完再补一句」的常见说法，同时不让 @ 的回复拖太久',
        ),
      maxPerMinute: Schema.natural().default(6).description('单群每分钟最多调用模型判定的次数（成本闸）'),
      errorCooldownMs: Schema.natural().default(60_000).description('判定失败后该群的冷却时间，冷却期内一律静默（避免连续烧钱）'),
      contextLines: Schema.natural().default(20).description('拼进 prompt 的群聊记录条数上限'),
      contextMaxChars: Schema.natural().default(3000).description('群聊记录的字符预算（双重截断）'),
      contextTtlMinutes: Schema.natural().default(60).description('多旧的群聊记录不再进入上下文'),
    }).description('群消息判定器'),

    /**
     * 长期记忆：默认**关闭**。
     *
     * 默认关不是保守，是怕重复：很多人（包括这个项目的作者）在别处已经有一套记忆外挂，
     * 我们再把同类内容注入一遍，等于同一件事在 prompt 里出现两次，既费 token 又会让模型
     * 把两条相似记忆当成"两件事"。要开就显式开，开之前先确认另一套已经关掉。
     *
     * 关闭的边界：只停"新增"和"注入"。查看/删除永远可用 ——
     * 否则关掉之后库里的记忆变成看不见也删不掉的黑盒，只能删库。
     * 如果两边都开着、只是"抢注意力"，是可以接受的：措辞差异带来的重复远小于重复写库。
     */
    /**
     * 社交记忆：只做三类短期状态（进行中的话题 / 对群友的印象 / 想说还没说的）。
     *
     * **不做长期事实层**：已有外部记忆库时，内置再存一份只会重复注入、各自过期不一致。
     * 也不记 `self`（自己说过的话）—— 原文在 `messages` 里，「最近对话」段已经会带上。
     */
    memory: Schema.object({
      enabled: Schema.boolean().default(true).description('社交记忆总开关；默认开，配合 memory_add 工具使用'),
      inject: Schema.boolean().default(true).description('启用时是否把记忆拼进 prompt（关掉则只存不用）'),
      maxChars: Schema.natural().default(4000).description('记忆片段的字符预算（按行截断，不会一个大块挤掉后面的）'),
      maxTopics: Schema.natural().default(60).description('每群最多保留多少个进行中的话题'),
      maxThoughts: Schema.natural().default(60).description('每群最多保留多少条「想说还没说的」'),
      maxImpressions: Schema.natural().default(150).description('每群最多保留多少个群友印象（超出按最久未提及淘汰）'),
      maxMemoryChars: Schema.natural().default(600).description('单条记忆的字符上限（长回复不能被拦腰截断）'),
      recentLines: Schema.natural().default(20).description('「最近对话」段补多少条上下文窗口之外的原文'),
      topicTtlMinutes: Schema.natural().default(1440).description('话题多久没再被提起就淘汰'),
      thoughtTtlMinutes: Schema.natural().default(120).description('「想说还没说的」默认保留多久'),
      /**
       * 按天自动总结：把一天的对话压成一段摘要。
       * 补的是"原文窗口之外那些天"的断档 —— 昨天下午定的事，今天要能想起来。
       */
      daily: Schema.object({
        enabled: Schema.boolean().default(false).description('按天自动总结（默认关，会每天每群多一次模型调用）'),
        days: Schema.natural().default(3).description('注入最近几天的总结'),
        backfillDays: Schema.natural().default(3).description('启动时回补最近几天（停机期间漏掉的）'),
        keepDays: Schema.natural().default(30).description('总结保留多少天'),
        maxMessages: Schema.natural().default(300).description('归纳时最多读多少条消息（首尾各一半，别丢掉早上定的结论）'),
        maxChars: Schema.natural().default(10000).description('归纳输入的字符预算，超出会标「仅总结部分」'),
        maxTokens: Schema.natural().default(800).description('归纳输出的 token 上限'),
        timeoutMs: Schema.natural().default(30000).description('单次归纳超时'),
        provider: Schema.string().default('').description('留空跟 judge.provider'),
        model: Schema.string().default('').description('留空跟 judge.model'),
      }).description('按天自动总结（默认关闭）'),
    }).description('社交记忆（默认关闭）'),

    /**
     * 人格（角色卡）：**插件层注入**，不做成 DSH 的 dsh-persona 配置。
     *
     * 为什么放在插件里：judge 层也必须知道"这个角色爱不爱说话"，否则通用判据
     * （"纯闲聊不该插话"）会把一个本来爱接话的角色判成一潭死水。
     * 放 DSH persona 里模型能看到，但插件读不到，判定就只能靠猜。
     *
     * 两个字段的分工不是重复：
     *   - `text`       完整角色卡 → 拼进回复 prompt（模型的"我是谁"）
     *   - `judgeHint`  性格摘要   → 拼进判定 prompt（判定器的"他是什么脾气"）
     * 摘要只写性格与参与意愿，不写身世外貌口癖 —— 那些对"要不要开口"没有信息量。
     *
     * 控制台改人设走 kv（按 chatKey），优先级高于这里的静态配置。
     */
    persona: Schema.object({
      enabled: Schema.boolean().default(false).description('人设注入总开关'),
      text: Schema.string()
        .default('')
        .description('完整角色卡，拼进回复 prompt。留空则不注入'),
      judgeHint: Schema.string()
        .default('')
        .description('判定用的性格摘要；留空用角色卡全文'),
    }).description('人格（插件层注入，默认关闭）'),

    /**
     * 只读控制台：挂宿主端口（同源无 CORS），生命周期跟插件 fiber 走。
     *
     * `mount` 不能是 `/` —— 宿主的 SPA 占了 fallback，抢根路径直接抛错（01 §7.1）。
     * `token` 留空则首次启动生成并落 kv：部署方不填也能用，填了则以配置为准
     * （反向代理/HTTPS 场景通常希望自己管口令）。
     */
    console: Schema.object({
      enabled: Schema.boolean().default(true).description('是否启动控制台'),
      /**
       * 独立端口 vs 借宿主端口。
       *
       * 默认独立：端口归自己，宿主的端口规划/反向代理不用为它让路，
       * 也不会因为插件加载顺序抢不到 `webServer` 而静默 404（旧版是前缀挂载）。
       * `attach` 保留给"宿主端口已经在反代后面、不想再开一个端口"的场景。
       */
      mode: Schema.union(['standalone', 'attach'])
        .default('standalone')
        .description('standalone 独立端口 / attach 挂宿主前缀'),
      port: Schema.natural().default(7800).description('独立模式监听端口（避开 DSH 的 3081）'),
      host: Schema.string()
        .default('127.0.0.1')
        .description('独立模式监听地址；要局域网访问改 0.0.0.0，并把来源加进 allowedHosts'),
      mount: Schema.string().default('/qdash-neo').description('attach 模式下的路径前缀；独立模式挂在根 /'),
      username: Schema.string().default('admin').description('登录用户名'),
      password: Schema.string()
        .role('secret')
        .default('')
        .description('登录口令（同时用于脚本的 Bearer）；留空则首次访问时由你在设置页自行设定'),
      sessionHours: Schema.natural().default(12).description('登录会话有效期（小时，滑动续期）'),
      /**
       * Host 白名单。
       *
       * 这层防的是 **DNS rebinding**：恶意站点把自己的域名解析到 127.0.0.1，
       * 借同源策略读本机控制台的响应。`['*']` 等于关掉这道防线，
       * 换来的是"反代时不用手动加域名"。
       *
       * 默认全开是因为大部分人不做反代、也不知道该往里加什么，
       * 而把域名填错的后果是 403 + 一句看不懂的提示。代价由两道兜住：
       * 控制台有口令，且免登录的 `/setup` 自己校验 Origin。
       */
      allowedHosts: Schema.array(Schema.string())
        .default(['*'])
        .description('Host 白名单；`*` = 放行任意 Host（默认）。改成具体域名可恢复 DNS rebinding 防护'),
      pollMs: Schema.natural().default(5000).description('前端轮询间隔（毫秒，最小 1000）'),
    }).description('控制台（独立端口 + 登录鉴权）'),

    store: Schema.object({
      path: Schema.string().default('').description('sqlite 路径，留空落在 ~/.dsh/storages/qdash-neo.db'),
    }).description('存储'),
  }).description('qdash-neo：把 QQ 接进 DSH 的宿主插件')
}
