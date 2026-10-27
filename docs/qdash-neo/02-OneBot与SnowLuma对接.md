# 02 OneBot 与 SnowLuma 对接

SnowLuma 把 QQ NT 客户端翻译成 OneBot v11。它是**外部进程**，我们不启动、不停止、不部署（EULA §5.4：并入安装包/镜像或自动化部署需书面授权）。

---

## 0. 传输层：内核用 SDK 直连，不用 MCP

这条是核实 `@snowluma/mcp` 与 `@snowluma/sdk`（都是 v2.2.0）源码后的修正，**推翻了「保留 snowluma MCP 不动」的旧结论**。

### 0.1 MCP 的真实形态：6 个 meta 工具，不是一批具名工具

`@snowluma/mcp` 的自我描述是「exposes the SnowLuma OneBot **action catalog** (docs + JSON Schemas) and optional execution」。实际工具：

| 模式 | 工具 | 作用 |
|---|---|---|
| docs（默认） | `list_actions({category?})` | 目录索引：name / category / summary / aliases / readOnly / stream |
| | `get_action({name})` | 单个 action 的完整文档 + `inputSchema` |
| | `search_actions({query})` | 模糊搜 |
| | `list_categories()` | 分类与计数 |
| read/write | `query_action({action, params?})` | 调只读 action（`get_*` / `can_*`） |
| write | `invoke_action({action, params?, execution?})` | 调**任何** action，含发消息、改群、踢人 |

另有资源 `snowluma://onebot/actions` 暴露整个目录。

### 0.2 这击穿了「按工具粒度做白名单」的设计

旧方案 §5.6 举例的工具 id 是 `snowluma/send_group_msg` —— **这个工具不存在**。真实世界只有一个 `invoke_action`，参数里写 `action: "send_group_msg"`。

后果：如果在工具白名单里授予 `invoke_action`，等于**同时授予发消息、改群名、踢人、发文件、操作好友**——粒度粗到失去意义。

两条出路：
- **A（推荐）**：内核用 SDK 直连，自己做 action 级白名单（我们控制了调用点，想限哪些 action 就限哪些）
- **B**：仍然接 MCP，但白名单粒度下沉到「工具 + action 参数」，等于在宿主工具系统之外再造一层策略，且 `invoke_action` 的 `destructiveHint` 会让宿主每次都要审批

### 0.3 SDK 更适合我们，理由是可验证的

`@snowluma/sdk@2.2.0`，`dependencies: null`（**零依赖**）：

```ts
import { SnowLumaHttpClient, SnowLumaWebSocketClient, text, message } from '@snowluma/sdk'

const bot = new SnowLumaWebSocketClient({
  url: 'ws://127.0.0.1:3001/',
  accessToken: process.env.SNOWLUMA_TOKEN,
  reconnect: true,                  // ← 自带重连
})

bot.onGroupMessage(async (event, ctx) => { /* ... */ })
await bot.sendPrivateMessage(10001, text('pong'))
const data = await bot.raw('set_group_ban', { group_id, user_id, duration })  // 任意 action
```

| 维度 | SDK | MCP |
|---|---|---|
| 依赖 | 0 | 要起一个 npx 子进程 |
| 调用路径 | 进程内直接 HTTP/WS | 内核 → MCP 子进程 → HTTP → SnowLuma |
| action 准入 | **我们自己的代码决定** | 只能靠 `invoke_action` 整体授予 |
| 延迟 | 一跳 | 两跳 + 进程 IPC |
| 事件 | WS 客户端自带 reconnect + 中间件 | 事件仍要自己连 WS（MCP 不管事件） |

→ **MCP 连事件流都不提供**，它只是 action 目录 + 执行器。我们要收事件无论如何都得自己连 WS。既然如此，多挂一个 MCP 进程没有收益。

### 0.4 结论

1. **内核（出站/入站/历史拉取）全部走 `@snowluma/sdk`**，不经 MCP
2. **action 白名单**：内核维护一份「允许调用的 action 名集合」，粒度是 `send_group_msg` / `get_group_msg_history` 这一级。这才是旧方案 §5.6 想要的那层控制，只是因为 MCP 形态而必须自己做
3. **`@snowluma/mcp` 降级为可选**：只在「想让 agent 自己探索 OneBot 能力、调我们不认识的 action」时才挂，且**默认 docs 模式**（只读），write 模式要显式开
4. 旧方案里「保留 snowluma MCP 不动」这句作废——改成「可选，默认 docs 模式」

### 0.5 法务（新增风险项）

SnowLuma 是**源码可见但非 OSI 开源**：允许学习、非商业自托管、私下修改；**商业使用、公开发布修改版或衍生版需事先书面授权**（`LICENSE` / `EULA.md` / `PRIVACY.md`，商业授权联系见仓库）。随附原生组件为专有。

→ 如果 qdash-neo 有商业化打算，这条要提前处理，不能等上线后再说。

---

## 1. 端口与 token：两个 token 不是同一个

| 端口 | 默认 | 用途 | token |
|---|---|---|---|
| WebSocket 服务端 | 3001 | **收事件**（正向 WS，我们当客户端连它） | WS token |
| HTTP API | 3000 | 发消息、拉历史、发语音、查状态 | HTTP token |

**同一个 QQ 账号的 HTTP token 与 WS token 是不同的值。** 后果：

> 每次启动的首次 WS 连接几乎必然失败一次（`code=1006`），自愈发现正确 WS token 后重连成功。
> **这条序列是正常的，不是故障。**

实现要求：
1. 首次连接失败不要报 error，报 info 并进入自愈流程
2. 自愈：从 `snowluma.homeDir` 下的配置/日志里重新发现 WS token 与端口
3. 自愈连续失败 3 次才升级为 error，并在控制台显示「连不上 + 排查顺序」
4. `httpUrl` 填成 WS 端口 → 发消息报 **HTTP 426**，这是最常见的配置错误，配置校验时就要分端口检测

另一个坑：**端点自愈会覆盖人工配置的 `wsUrl`**。它不区分"配置里是过期值"和"你就是要指向别处"。多实例或指向另一份 SnowLuma 时必须关掉自愈（原项目叫 `snowluma.followDiscoveredEndpoint: false`）。

---

## 2. 健康判断：连上 ≠ 收得到

最贵的坑：SnowLuma 的 `[Hook]` 会退化——进程活着、WS 活着、日志里有「已连接」，但**收不到任何 QQ 消息**。

判断信号按可靠性排序：

| 信号 | 频率 | 说明 |
|---|---|---|
| `meta_event/heartbeat` 载荷里的 `status.good` | 30s | **主信号**。静默约 105 秒后翻 `false` |
| `get_status` → `{online, good}` | 60s 兜底 | 主信号超时未到时主动问 |
| `bot_status` | 事件 | 仅 SnowLuma ≥ 1.14.20 有，更早版本没有 |

**绝对不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`。SDK 不校验 data 载荷 ⇒ 不报错、`good` 永远 `null`、判断变成永不触发的死代码。原项目第一版正是这么写错的。

实现：`degraded` 状态必须在控制台「总览」显示成一张卡片（不是只写日志）。退化时入站继续落库但不回复，标 `degraded`。

---

## 3. 事件与消息段

只订阅、只处理这些：

```ts
type OneBotEvent =
  | { post_type: 'message'; message_type: 'group' | 'private'; ... }
  | { post_type: 'meta_event'; meta_event_type: 'heartbeat' | 'lifecycle'; ... }
  | { post_type: 'notice'; notice_type: string; ... }   // 只记日志，不触发 agent
```

消息段（`message` 为**数组**，不是字符串——SnowLuma WebUI 里必须把消息格式设成 `array`，否则拿到 CQ 码字符串）：

| 段 | 处理 |
|---|---|
| `text` | 正文 |
| `at` | 命中自己 → `mention` 触发；`at` 全员 → 不当 mention |
| `image` | 安全下载（字节上限 8MB、像素上限 64MP、单条最多 5 张）→ 走多模态；拿不到字节用 `[图片]` 占位 |
| `reply` | 解析被引用消息：`[引用 张三：原文]` 前缀注入；引用机器人自己 → 视为必回 |
| `record` | **收：只放 `[语音]` 占位，不做转写**；发：见 §5 |
| `face` / `mface` | `[表情]` 占位 |
| 其他 | `[不支持的消息类型]` 占位 |

**归一化要早做**：把 OneBot 事件转成内部 `IncomingMessage` 后，`pipeline` 就再也不用看 OneBot 的形状。这是"上游换了协议端也不动内核"的唯一办法。

---

## 4. 发送

```ts
// HTTP API
POST {httpUrl}/send_group_msg    { group_id, message: Segment[], auto_escape: false }
POST {httpUrl}/send_private_msg  { user_id,  message: Segment[] }
```

| 规则 | 值 | 原因 |
|---|---|---|
| 单条字符上限 | 300（可配） | 超长被截断或风控 |
| 同 chat 间隔 | ≥ 1200ms | 防频率限制 |
| 全局并发 | ≤ 3 | 防风控 |
| 分条 | 优先换行 → 超长再按句末标点 → 最后按 `Intl.Segmenter` | 必须用 `Array.from` / Segmenter，**不能用 `slice`**，否则切碎 emoji 代理对 |
| 引用回复 | `reply` 段 + 已知 `message_id` | 需要真实 id，见 §6 |
| 失败 | 重试 3 次 → 死信 | 死信控制台可见、可手重发 |

Markdown 清洗（模型输出到 QQ 的必经步骤）：

- 去 `**` `__` `` ` ``、标题 `#`、表格竖线
- 代码围栏：**保留内容、去掉围栏**
- 链接 `[文字](url)` → `文字 (url)`
- 列表符号统一成 `· `
- 清洗后再判长度、再分条

---

## 5. 语音发送

SDK 提供了专门的 record 方法，**不需要自己拼 `record` 消息段，也不用管 base64**——它内部走分片上传，拿到服务端路径后再发最终 action：

```ts
import { localFile } from '@snowluma/sdk/node'      // 注意：media 工具只在 /node 子路径

await bot.sendGroupRecord(groupId, await localFile('./tts_out.mp3'), {
  record: { /* 媒体属性 */ },
  signal: AbortSignal.timeout(60_000),
  onProgress: ({ uploadedBytes, fileSize }) => { /* 进度 */ },
})
// 返回 { message_id }
```

对称方法：`sendPrivateRecord` / `sendGroupImage` / `sendPrivateImage` / `sendGroupVideo` / `sendPrivateVideo` / `sendGroupFile` / `sendPrivateFile`。

### 实现要点（源码核实后的修正）

1. **走 outbox**，与文本同一套限流/分条/死信，不另开通道
2. 语音不参与"分条"（一条语音就是一条），但**独占一个发送槽**，前后各留 1200ms
3. **`localFile(path)` 只在 `@snowluma/sdk/node` 导出**，根入口和浏览器入口不引入 Node fs。它返回**文件支持的 Blob，不整读进内存**；发送完成前文件必须保持不变，缺失/非普通文件/被改动都会报错
4. 也可传 `Uint8Array` / `Blob` / `ReadableStream` / `AsyncIterable<Uint8Array>`；流式和异步可迭代**必须**给 `fileSize`
5. **超时语义要小心**：`timeoutMs` 是**每次上传请求和最终发送请求**的超时，不是整个操作的总期限，也不覆盖源读取。要总期限请自己传 `AbortSignal`（如上例）
6. 错误带 `stage: 'upload' | 'send'` 和原始 `cause`；**"取消或超时发生在 dispatch 之后"不能证明消息没发出去** —— 这种情况按"可能已发送"处理，不要盲目重试，否则会重复发语音
7. 失败**降级成文本发送**并记 warn（绝不静默丢消息）
8. 生成语音的 TTS 是**可选 feature**（见 04）：内核只提供 `sendRecord(chatKey, audio)` 能力，不内置 TTS
9. 收语音不做转写（范围表已定），只占位

> 编码格式：旧文档写"最稳是 silk/amr，传入前先探测能力"。SDK 的 record 方法接受常见音频字节，但**具体支持的编码仍取决于 QQ 协议端**。M0 阶段应实测一次 mp3/silk 各发一条，把结论写死在这里，不要留"应该可以"。

原项目把发语音放在独立工具（`../voice-tool/`）且默认关闭（`socialV2.voice.enabled` / `tools.sendVoice` 默认 `false`）。我们保留"默认关"这个态度，但把它做成 feature 而不是外挂目录。

---

## 6. 历史与补偿

```ts
POST {httpUrl}/get_group_msg_history { group_id, message_seq?, count: 50 }
POST {httpUrl}/get_friend_msg_history { user_id, message_seq?, count: 50 }
POST {httpUrl}/get_msg  { message_id }        // 单条，用于解析引用
```

补偿流程（重连成功后）：

1. 对每个活跃 chat 调 history(`since: lastMsgId`, `limit: 50`)
2. 逐条过 pipeline，打标 `backfill: true`
3. `backfill` 消息**只更新上下文、不触发自动回复**（否则重连瞬间会炸出一堆延迟回复）
4. `followup(createUserMessage({ source: { kind: 'cron' } }))` 而非 `kind:'user'`，让模型知道这不是实时对话

> 注意：`backfill` 消息一旦 `followup` 就会形成日志事件（"模型可见 = 已记录"），所以"只更新上下文"是通过 prompt 前置说明实现的，不是靠不入库。

---

## 7. 断线与重连

```
退避 min(30s, 1s * 2^n) + jitter(0~500ms)，无限重试，每 5 次记一条 warn
```

- 心跳：30s 无任何事件 → 主动 `get_status`；连续两次失败判死并重连
- 所有调用 15s 超时；**超时不等同失败**（可能是慢），记 warn 后按失败重试一次
- 重连成功后立即跑 §6 的补偿，再恢复发送泵
- 单实例锁：同一数据目录只允许一个进程/实例，重复启动直接拒绝

---

## 8. 长轮询（给 `qq_wait_for_messages` 用）

原项目踩过的坑：Node 的 undici 默认 `headersTimeout` 是 300s，长轮询等着等着就被掐。**用 `node:http` 手写，绕开 undici**。

```ts
// 伪代码：5 分钟长轮询
const req = http.request({ host, port, path: '/...', headers, timeout: 0 })
// 自己控制超时：5 分钟到点返回空结果 + 一句"无新消息"
```

---

## 9. 配置校验（启动时就要拦）

| 检查 | 失败表现 | 处理 |
|---|---|---|
| `wsUrl` 协议是 `ws://`/`wss://` | 填了 http → 握手失败 | 拒绝启动并给出正确示例 |
| `httpUrl` 端口 ≠ `wsUrl` 端口 | 发消息 426 | 拒绝启动（这是最高频错误） |
| `homeDir` 可读 | 自愈无从下手 | warn，提示"只填 token 也能跑，但换账号后会连不上" |
| 白名单为空且 `allowAllWhenEmpty=false` | 一条都不回 | 启动日志明确写「白名单为空，当前不响应任何消息」 |
| 白名单为空且 `allowAllWhenEmpty=true` | 全放行 | **启动时红字警告**：等于把账号交给模型 |
