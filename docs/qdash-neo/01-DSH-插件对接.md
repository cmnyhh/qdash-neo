# 01 DSH 插件对接

本章只写"怎么跟宿主说话"。业务逻辑在 03。

---

## 1. 包的形状

```
qdash-neo/
├── package.json
├── cordis.patch.yml
├── src/
│   ├── index.ts            # 插件入口：name / inject / Config / apply
│   ├── service.ts          # class QdashNeo extends Service —— 对外暴露 ctx.qdashNeo
│   ├── onebot/
│   ├── pipeline/
│   ├── session/
│   ├── store/
│   └── console/
└── public/                 # 控制台前端（纯静态）
```

`package.json` 关键字段：

```jsonc
{
  "name": "qdash-neo",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "^0.2.0",
    "@deepseek-ai/dsh-session": "^0.2.0",
    "@deepseek-ai/dsh-llm": "^0.2.0",
    "@deepseek-ai/dsh-tools": "^0.2.0",
    "@deepseek-ai/dsh-settings": "^0.2.0"
  }
}
```

`cordis.patch.yml`（只放需要被部署方覆盖的引导参数）：

```yaml
- insert:
    - id: qdash-neo
      name: 'github:you/qdash-neo'
      config:
        enabled: true
        console:
          mount: '/qdash-neo'
```

> ⚠️ `config` 整块替换：用户只要改一个键，也必须把整块重述。所以 `Config` 里每个字段都要 `.default()`。
> ⚠️ `id` 定了别改，改了就所有 patch 层失效（只有一行 warn）。

---

## 2. 入口：三个导出 + 两个可选

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'qdash-neo'
export const inject = ['agents', 'sessions', 'tools', 'webServer']

// 部署方视角的配置（patch 层）
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关'),
  dataDir: z.string().default('').description('数据库与日志目录，留空用 profile data 目录'),
  console: z.object({
    mount: z.string().default('/qdash-neo').description('控制台挂载路径'),
    token: z.string().default('').description('留空则首次启动生成'),
  }),
})

export function apply(ctx: Context, config: typeof Config.Type) {
  if (!config.enabled) return
  ctx.plugin(QdashNeoService, config)   // class 形态，向其他插件暴露 ctx.qdashNeo
}
```

为什么要 `Service` 而不是全写在 `apply` 里：社区插件要 `inject: ['qdashNeo']` 才拿得到我们的能力，而 **只有 class 继承 `Service` 才能注册 `ctx.qdashNeo` 这个 key**。

```ts
import { Service } from '@deepseek-ai/cordis'

export class QdashNeoService extends Service {
  static inject = ['agents', 'sessions', 'tools', 'webServer']
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'qdashNeo')            // ← 服务名，社区插件靠它 inject
  }
}
```

> 服务名一旦发布就是公共 API，改名等于破坏所有下游插件。v1 定 `qdashNeo`，之后只加方法不减。

---

## 3. 生命周期

| 阶段 | 该做什么 | 不该做什么 |
|---|---|---|
| `constructor` / `apply` | 建 store、注册服务、注册路由、**登记 disposer** | 发起网络连接、启动定时器 |
| `ctx.on('ready')` | 连 OneBot、拉起 outbox 泵 | 在这里注册工具（已晚了） |
| `dispose` / `ctx.effect` | 关 OneBot、关 outbox、flush store、关 http | 依赖其他插件已卸载 |

```ts
apply(ctx, config) {
  ctx.effect(() => {
    const stop = () => { onebot.close(); outbox.stop() }
    return stop        // 卸载时调用
  })
}
```

**顺序清理的陷阱**：多个 disposer 逆序**开始**但**并发**执行。如果"先 flush 队列再关 sqlite"有顺序要求，必须写成**一个** disposer，内部 `await` 串行。

```ts
ctx.effect(() => {
  let done = false
  return async () => {
    if (done) return
    done = true
    await outbox.drain()        // 必须先完成
    await store.close()         // 再关库
  }
})
```

> 注意 `ctx` 注册的一切会自动回收（事件、工具、路由）。只有自己 new 出来的资源（socket、sqlite、定时器）需要 `ctx.effect`。

---

## 4. 会话：chatKey → agent handle

### 4.1 sessionId 约定

```ts
const sessionId = SessionId(`qq:${chat.kind === 'group' ? 'g' : 'p'}:${chat.chatId}`)
```

- `SessionId` 是 branded string，格式插件自定，DSH 没有「平台/通道/用户」三段式内建概念
- **只用白名单字符**：小写字母、数字、`:`、`-`。不要出现 `/` `\` `..`
- 一个 QQ 会话一个 session，映射持久化在 `chats.session_id`
- 重置会话 = **换新 id**（加 generation 后缀 `#2`），不要复用旧 id

### 4.2 获取 handle

```ts
async ensure(chat: ChatRef): Promise<AgentHandle> {
  const id = sessionIdOf(chat)
  const live = this.ctx.agents.get(id)
  if (live) return live

  const known = this.store.getSessionId(chat)
  const agentOptions = this.modelBinding.forPreset(chat.preset)   // 见 03 §5

  try {
    const handle = known
      ? await this.ctx.agents.resume({ resumeSessionId: known, agentOptions, setup: this.setupFor(chat) })
      : await this.ctx.agents.create({ sessionId: id, agentOptions, setup: this.setupFor(chat) })
    this.store.setSessionId(chat, id)
    return handle
  } catch (e) {
    // 同一 session 已有 live 持有者 → 说明是并发 ensure，退避重试一次
    if (isLiveConflict(e)) { await sleep(200); const again = this.ctx.agents.get(id); if (again) return again }
    this.markBroken(chat, e)        // 标 broken，不静默回退
    throw e
  }
}
```

**纪律**：拿不到目标 preset / 模型 → 拒绝建会话并标 `broken`，绝不回退到带 bash 的默认 preset。原项目在这条上是刻意 fail-closed 的，照抄。

### 4.3 投递消息

```ts
deliver(handle: AgentHandle, text: string) {
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}
```

- 返回的是**入队回执**，不是结果
- `assertive` 档不要 `followup`，用 `inject` + 让模型自己调工具（见 03 §3）
- cron / 后台补投用 `source.kind = 'cron'`，便于日志区分

---

## 5. 事件：出站与生命周期

```ts
ctx.on('session/event', (session, event) => {
  const chatKey = this.store.chatKeyOfSession(session.header.id)
  if (!chatKey) return                                   // 不是我们的会话，直接丢
  this.serializer.push(chatKey, () => this.onEvent(chatKey, event))   // ← 串行化
})
```

`onEvent` 的最小映射：

| 事件 | 处理 |
|---|---|
| `turn/start` | 该 chat 标 busy，启动占用租约（15 分钟自动过期） |
| `assistant/message` | 提取 `content[].type==='text'` → 入 outbox（分条 + 清洗） |
| `assistant/chunk` `text-delta` | 忽略（QQ 不要流式）；`usage` → 记 usage 表 |
| `tool/call` | `{ name, arguments }` 落库；用于审计与"是否在本轮已手动发过消息"判断 |
| `tool/result` | 按 `callId` 配对，更新状态 |
| `turn/end` | 清 busy、释放租约；`reason.kind==='error'` 时写审计并考虑回复一句兜底 |
| `todo/write` | 可选，控制台展示进度 |

**三条硬纪律**：

1. **只取 `assistant/message`，不接 delta**。QQ 不需要逐字，接了只会把分条与清洗复杂度拉满。
2. **必须自己串行化**。事件是 post-commit fire-and-forget，不保证处理时序；同一 chat 的 outbox 追加必须有序。
3. **必须按 session id 过滤**。所有会话的 `session/event` 都进同一个监听器。

### 5.1 提取文本

```ts
function extractAssistantText(event): string {
  return event.data.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('')
}
```

只取 `text`，不要 reasoning。空文本（纯工具调用回合）不入 outbox。

---

## 6. 审批拦截

```ts
ctx.on('approval/request', async (req, next) => {
  const sessionId = req.agent.session.header.id
  const chatKey = this.store.chatKeyOfSession(sessionId)
  if (!chatKey) return next()                     // 不是 QQ 的会话，交回宿主

  const outcome = await this.approvals.askOnQQ({
    chatKey,
    toolName: req.toolName,
    reason: req.reason,
    signal: req.signal,                           // abort → 立即返回 cancelled
  })
  return outcome                                  // 'allowed-once' | 'rejected' | 'cancelled'
}, { prepend: true })
```

要点：

- `{ prepend: true }` 让我们排在 Web UI 的 answerer 之前。不加就是"谁先注册谁先答"，QQ 那条永远走不到
- **四种 outcome 只有 `allowed-once` 算通过**，`unavailable` 是"没有 answerer 时的 fail-closed 结果"
- `req.signal` 被 abort 时必须 resolve `cancelled`，否则宿主一直等
- 超时：QQ 侧 5 分钟无回复 → `rejected`，并回一句"超时按拒绝处理"（比静默好，模型下一轮能读到）
- 挂起表要能持久化：插件重载时把挂起项标 `cancelled`，不要留悬空的 Promise

---

## 7. 控制台：自己的页面，挂宿主路由

**控制台是自己造的**（和原项目一样：自己的端口、自己的 web 页面、自己的 API），不是 DSH 控制台的一部分。理由见 04 §10.1。

宿主只借两样东西：一个 HTTP 入口，一个生命周期。

### 7.1 HTTP 入口：`ctx.webServer`（首选）

```ts
const dispose = ctx.webServer.register({
  kind: 'prefix',                            // 已实测：prefix/exact 均 200
  path: this.config.console.mount,           // '/qdash-neo'
  handler: (req, res) => this.console.handle(req, res),
})
ctx.effect(() => dispose)
```

这一个 handler 同时服务四类请求：

| 路径 | 内容 |
|---|---|
| `GET /qdash-neo/` | 控制台页面（单个 HTML，无构建） |
| `GET /qdash-neo/assets/*` | 页面用的 css/js/图标 |
| `GET /qdash-neo/api/*` | 数据面 |
| `GET /qdash-neo/plugin/<id>/*` | 插件 `pages/` 下的静态页（custom 选项卡） |

要点：

- 同一 `(kind, path)` 重复注册**直接抛错**（路由是组合级契约，冲突即配置错误）→ 路径里必须带包名
- 匹配顺序：全表精确 → 最长前缀 → fallback；prefix 按**路径段边界**匹配，`/qdn-probe` 不会误吞 `/qdn-probes`
- `registerFallback` 只有一个 owner，被宿主 SPA 占着，**不要碰**
- 拿到实际端口：`ctx.webServer.port`（配置 `port: 0` 时读 OS 实配）
- 同端口意味着**天然同源**，控制台的 cookie 与 DSH 一致，不用处理 CORS

### 7.2 备选：自己起端口（约定 7800）

`ctx.webServer` 签名变了、或要让控制台活过 DSH 重启时，退回自己 `http.createServer` 绑 `127.0.0.1:7800`。代价全自己扛：

1. 端口占用检测与提示
2. 自己的 token 鉴权（控制台首次访问打印带 token 的 URL，和 `dsh web` 一个套路）
3. 自己的 `Host` 校验（挡 DNS rebinding）
4. 静态资源的 path traversal 防护

### 7.3 生命周期

控制台服务随 fiber 回收（`ctx.effect`），**但已打开的面板不会自己刷新**。所以内核在 dispose 时向所有 SSE/WS 连接推一条 `shutdown` 事件，前端显示"内核已卸载，请重启 DSH 后刷新"——比白屏好。

### 7.4 前端形态

- **无构建**：单 HTML + 原生 ES module，不走 webpack/vite。理由：控制台不是产品级前端，引入构建链会让"改一个字段要装 200MB 依赖"
- **服务端给数据，前端只渲染**：页面里的选项卡内容由 `/api/tabs/<id>` 返回的 JSON 描述驱动（declarative 块），前端只有一个通用渲染器
- **主题与语言**：内核提供 CSS 变量（`--qq-*`）和 `zh/en` 词表，页面启动时拉 `/api/meta` 拿到，localStorage 记住用户选择

> 必须校验 `Host` 是 `127.0.0.1` 或 `localhost`（挡 DNS rebinding），除 `/health` 外都要 token。

## 8. 配置：两层各管一段

### 8.1 静态（部署方）

`Config` 里只放"装的人该定"的：目录、挂载路径、端口、初始 token。

### 8.2 运行时（终端用户）

```ts
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const NS = settingsNamespace('qdash-neo')     // ⚠️ 与 UI 半共用同一个常量

const UserSchema = z.object({
  dailyBudget: z.number().default(15).description('每日预算（元）'),
  inboundPerMin: z.number().default(20).description('单会话入站限流'),
  judgeProvider: z.string().default('cheap-llm'),
})

const scope = ctx.settings.register(NS, UserSchema, { base: config.defaults })
const user = scope.get()                       // 深冻结快照，不能直接改
```

- `scope.update(patch)` 只写用户层，带 revision 乐观并发；stale 写入被拒而不是覆盖
- 订阅 `settings/document-updated` 保证界面与插件一致
- 用户层优先于组合基线（`base`），组合基线优先于 schema 默认值

**不要**把用户偏好塞进 patch：patch 是机器级/profile 级，多用户场景必然串味。

---

## 9. 工具注册（给 agent 用的 QQ 动作）

原项目用独立 MCP server 提供 `qq_get_unread_messages` 等。进程内化之后有两条路：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. `ctx.tools.register`（推荐）** | 无需 MCP 进程、参数校验内建、工具目录天然可见 | 工具集由 preset 决定，需配合我们的工具白名单 |
| B. 保留独立 MCP server | 与原项目一致、可跨进程复用 | 多一个进程、多一层配置 |

```ts
ctx.tools.register(defineTool({
  name: 'qq_send_message',                       // 名字即模型可见 API，别改
  description: '在指定 QQ 会话发送消息。text 传数组表示分条发送。',
  parameters: {
    chatKey: { type: 'string', required: true },
    text: { type: 'array', items: { type: 'string' }, required: true },
  },
  async execute(args) { /* 走 outbox，不走 OneBot 直连 */ },
}))
```

**必须走 outbox**：工具调用发出去的消息与 `assistant/message` 自动转发的消息共用同一个队列，否则限流与分条会被绕过（原项目踩过：要在回合内检测"发送类工具已调用"并跳过自动转发）。

---

## 10. 版本兼容

| 我们的行为 | 依赖的宿主版本 | 失效表现 |
|---|---|---|
| `agents.create/resume` + `followup` | ≥ 0.1.x | 建会话失败，需换 API |
| `approval/request` 四态 | ≥ 0.2.0 | 应答值不被识别 → 审批永远 pending |
| `Config.volatile()` 进表单 | 0.2.0 起 | 字段不出现在界面 |
| `ctx.webServer` | ✅ 已实测（prefix/exact 均 200） | 拿不到服务 → 退独立端口 |
| `ctx.slots` + `dsh.client` | ✅ 已实测可用，但**本方案不采用**（04 §10.1） | 与我们的控制台无关 |

**锁定策略**：`peerDependencies` 写具体 minor（`^0.2.0`），启动时比对 `ctx.get('dsh')?.version`，不匹配就 warn 并把控制台总览标黄——原项目有一次升级后 `{{cwd}}` 变量被删，导致每个回合在系统提示词装配阶段直接 error、模型一次都不跑，QQ 侧表现是"发消息完全没反应"。这类问题必须在启动时就喊出来。
