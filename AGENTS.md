# qdash-neo 重构 — 项目交接书

> 这份文件是给**任何新接手的 agent 或人**看的：这个项目是什么、到哪一步了、哪些决定不能推翻、环境有哪些坑。
> 读完这一页，再进 `docs/qdash-neo/` 看细节。

---

## 1. 一句话

**从零实现的 DSH 插件**：跑在宿主进程内，用 `ctx.agents` 管会话、`session/event` 收回复、`approval/request` 接审批、`ctx.webServer` 挂自己的控制台。

**和上游 [Derpyu520/qq-bridge] 的关系只有「参考其踩坑记录」，不是 fork，也没有代码复用**：那边是「独立进程 + 反向调 DSH Web API + 离线铸 Cookie」，架构上跟插件内化不兼容。证据：`package.json` 的 `dependencies` 为空，`peerDependencies` 只有 5 个 DSH 官方包；`src/` 的外部 import 全部是 `node:` 内置模块。`_ref/` 是 git 忽略的只读副本，唯一用途是查它踩过的坑（SnowLuma 端点自愈覆盖 `wsUrl`、undici `headersTimeout` 掐长轮询、发送类工具与自动转发重复发）。

### 1.1 命名：叫 qdash-neo（2026-10-26 定名）

原来是 `qq-bridge`，已**全量改名、不留兼容**。下面这些旧值一律失效，看到就当历史遗留：

| 项 | 旧 | 新 |
|---|---|---|
| 包名 / 插件 id | `qq-bridge` | `qdash-neo` |
| 能力面 | `ctx.provide('qqBridge')` | `ctx.provide('qdashNeo')` |
| 控制台挂载 | `/qq-bridge` | `http://127.0.0.1:7800/`（独立端口；`attach` 模式才是路径前缀 `/qdash-neo`） |
| 数据库 | `~/.dsh/storages/qq-bridge.db` | `qdash-neo.db` |
| 环境变量 | `QQB_*` | `QDN_*` |
| 探针包 | `qqb-probe` | `qdn-probe` |
| 文档目录 | `docs/qq-bridge/` | `docs/qdash-neo/` |
| 服务类 | `QqBridgeService` | `QdashNeoService` |

改之前必须知道的三件事：

- **上游原项目仍然叫 `Derpyu520/qq-bridge`**，不是我们的项目名。批量替换误伤过一次，`_ref/`、`.gitignore`、文档里的"原项目"都是指它。
- **仓库目录已改名为 `qdash-neo`（2026-10-26 完成）**。原先卡住的原因是 **IDE 持有工作区根目录句柄**：`Rename-Item` / `cmd move` / `[IO.Directory]::Move` 三路都报「另一个进程正在使用此文件」，但子目录能改 ⇒ 锁只在根上。
  做法是**完全退出 IDE → 独立 PowerShell 执行 `Rename-Item -LiteralPath '<本机路径>\projects\qq-bridge' -NewName 'qdash-neo'` → 重开 IDE 到新路���**。
  git 不受影响（`git status` 仍识别为 rename），仓库内也没有硬编码旧路径。
- **`~/.dsh/profiles/web/node_modules/qdash-neo/` 是拷贝，不是链接**（`LinkType` 为空的真实目录）。改名不影响它继续跑，但它是旧时刻的快照，**不会跟着源码变**；改完 `src/` 要重跑 `scripts/setup.sh` 重新拷贝才会生效。
- **旧库留在原地、不迁移**：`~/.dsh/storages/qq-bridge.db` 连同 `-shm` / `-wal` 原样保留，当作回滚点；新库 `qdash-neo.db` 从空开始跑（2026-10-26 决定）。真要捞旧数据，停掉宿主后复制三个文件并改名，别在运行时复制——会拿到半截 WAL。

## 2. 目录

仓库根：`<本机路径>\projects\qdash-neo`（2026-10-26 从 WorkBuddy 会话目录搬出后又从 `qq-bridge` 改名，路径已定，见 §1.1）

```
README.md                ← 怎么跑起来（先看这个，5 分钟）
AGENTS.md                ← 本文件

docs/qdash-neo/          ← 设计文档，唯一真相源（7 个文件，先看 README.md）
  00-事实核查表.md         已核实/待验证/已推翻，逐条带源码行号
  01-DSH-插件对接.md       DSH 插件契约（manifest/生命周期/会话/事件/审批/路由/配置）
  02-OneBot与SnowLuma对接.md  OneBot v11 落地 + 原项目踩过的坑
  03-内核实现要点.md       pipeline/session/outbox/store 怎么写
  04-插件开发规范.md       ★ 插件作者必读：能力面、控制台选项卡、准入
  05-施工计划.md           M0–M4，细化到文件与验收命令

probe/                   ← M0 探针包（qdn-probe v8），验证 DSH 运行时能力
  lib/index.js             假 provider + 真工具执行 + 事件打点（可移植，无硬编码路径）
  lib/client.js            浏览器半实验（已验证，但方案未采用，见 04 §10.1）

src/                     ← 产品代码（M1 + 群内自主发言 + 完整对话记忆 + 只读控制台）
  pipeline/                gates（ingest/trigger 两段）+ context（群上下文缓冲＝短期记忆）
  judge/                   heuristics / llm（ctx.llm.stream）/ chain（阈值与兜底）
  memory/                  Memory（社交记忆：topic/thought/impression）+ daily（日总结）
  persona/                 Persona（角色卡：card 给回复、hint 给判定，默认关闭）
  onebot/                  client（原生 WS）+ normalize（含群聊记录渲染）
  session/                 router（create/resume 互斥）+ events（session/event → outbox）
  console/                 server/auth/api（只读控制台）+ public/（无构建单页）
  outbox/ store/           发送队列 / sqlite（node:sqlite）
  config.js service.js index.js host.js

test/                    ← 测试件（不进产品代码）
  core.test.js            归一化/闸门/上下文/存储/控制台查询
  judge.test.js           判定链：阈值、超时、截断、冷却、解析失败
  memory-daily.test.js    日总结：幂等、补跑、输入裁剪、失败留痕、注入窗口
  service.test.js         串联：10 条群消息 ≤3 回复、上下文恢复、@ 直回、出站回写
  console.test.js         控制台：鉴权/cookie/Host/穿越/方法/API 形状/limit 夹紧
  fake-onebot.mjs         假 OneBot 服务端（私聊 / 群两个场景）
  fake-model/             假 LLM provider（群里够用，不烧钱）
  patches/                group.patch.yml（假模型）/ group-real.patch.yml（真网关）

scripts/
  setup.sh                 装依赖 + 把探针/插件放进 DSH profile
  start.sh                 启动并打印带 token 的控制台地址
  group-real.ps1           真模型群场景集成测试（需要 QDN_LLM_KEY + DSH_RUN）

dsh-run/                 ← DSH 可运行实例（只有 package.json + probe.patch.yml，node_modules 靠 setup.sh 装）
dsh-src/                 ← 源码事实来源（304 包 / 7466 个 .d.ts），只读，node_modules 同样靠装
_ref/                    ← 原项目只读副本（不照搬，只对照），git 忽略
_scratch/                ← 过程产物，git 忽略，可随时删
```

**`node_modules` 不要进 git**（几百 MB，`npm i` 可重建）。`docs/`、`probe/`、`scripts/` 是真正的资产。

## 3. 当前状态（2026-10-26）

### 已实测通过

| 能力 | 结论 |
|---|---|
| `ctx.webServer.register({kind:'prefix'|'exact', path, handler})` | 200；prefix 按路径段边界匹配，`/qdn-probe` 不误吞 `/qdn-probes` |
| `ctx.agents.create({sessionId, meta:{agentPreset}, agentOptions})` + `agent.followup(msg)` | 通；`dispose()` 会**移除 session**，不能当暂停 |
| `ctx.on('session/event')` | 序列完整：`turn/start → user/message → assistant/message → turn/end`，`assistant/message` 带 `usage` |
| 假 `LlmAdapter` 驱动真实工具执行 | 通（工具拿到真实 `working_directory`） |
| `ctx.on('approval/request', h, {prepend:true})` | 钩子挂得上，四种 outcome 类型已确认 |
| profile 插件的浏览器半（`dsh.client`） | 会被自动扫进 `__DSH_BOOT__` 并 200 送出；**方案未采用** |
| 探针可移植性（v8） | 换目录后无需改代码：`dsh-llm` 入口在运行时从 DSH 启动脚本往上找，日志/工作目录走环境变量 |

> 最近一次完整通过：2026-10-26，`probe` v8，`STREAM turns: 3`、`turn/end{"kind":"completed"}`、`dispose 语义：before=present after=absent`。

### M0 已全部跑完（2026-10-26 晚，两条结论已改实现）

1. **审批时序**：`tool/call`(seq15) → `approval/asked`(16) → `approval/decided`(18) → `tool/result`(19)。
   审批在 tool/call **之后**；**拒绝时 tool/result 照样产生**（`Error: the user rejected tool "…"`, `isError:true`）
   → 超时拒绝对模型天然可见，不用额外补消息。详见 00 §3.1。
2. **双持有者**：live 冲突抛**普通 `Error`**（无 `code`、无自定义字段），跟真失败不可区分
   → `ensure()` 必须自建互斥。另外 `dispose()` 之后**磁盘记录还在**，同一个 id 再 `create` 必失败
   （`SessionAlreadyExistsError`），只能 `resume()`。详见 00 §3.2。

### 已开始

M1 骨架已起草（`src/` + `test/{core,judge,service}.test.js`，`npm test` **39 项全绿**）。

**已验证**：`2026-10-26` 把 `src/` 装进 `~/.dsh/profiles/web/node_modules/qdash-neo/`，
用 `--patch _scratch/qdn.patch.yml` 起 `dsh web` → 宿主正常启动、插件 ACTIVE、
`~/.dsh/storages/qdash-neo.db` 建出 7 张表（`chats/messages/usage/outbox/judgements/memories/kv`）。
`Config`（schemastery）、`inject`、`ctx.provide` 三处都没炸。

**也验证了全链路**（`test/fake-onebot.mjs` 假 OneBot 服务端 + `test/fake-model` 假模型）：
私聊消息进 → `followup` → `assistant/message` → outbox → `send_private_msg` 出，
重复 `message_id` 只回一条；`kill -9` 重启后走 `resume` 而不是重建会话。

**真 SnowLuma 也连上了**：`ws://onebot.example.com:7777`，token 走 header，`get_login_info` = `100000001`。

### 群内自主发言（M4 的一块）—— 2026-10-26 已落地并真模型实测

入站改成两段闸：`ingest`（听得见：去重/群开关/空消息）→ **上下文缓冲** →
`trigger`（可能开口：白名单只约束私聊 / @ / 限流 / 回复配额）→ `judge`（启发式 → `ctx.llm.stream` → 阈值）→ `deliver`。
群判定先过**批窗口**：最后一条之后静默 `batchWindowMs=5000` 才送判定，有人接着说就重置，
但最多等 `batchMaxWaitMs=20000`（一直有人说话也必判一次）；一次判定覆盖整批，
落库 `judgements.batch_size/qq_msg_ids`。细节在 `docs/qdash-neo/03` §2，施工记录与证据在 `docs/qdash-neo/05` M4。

| 项 | 结果 |
|---|---|
| 单测 | 182 项全绿（`npm test` 八个文件：core / judge / memory-daily / outbox / config / tabs / service / console；含上下文截断/恢复/`atMe`/时间后缀、启发式、阈值、超时、配额、**10 条群消息 ≤3 回复**、批窗口、记忆开关语义/活性刷新/thought 写入、人设注入两档粒度、`onUnsure` 三态与非法值回退、`SILENT_MARKER` 出站拦截、`judgements.code` 老库补列、别名放行与"别名不提前封口"、出站回写与死信排除、记忆窗口去重、日总结幂等/首尾各半/失败留痕、控制台鉴权/Host/穿越/limit 夹紧、出站分条字素/断点/截断标注、队列间隔从"发送完成"起算、分片聚合回写与重启恢复合并） |
| 真模型群场景 | `scripts/group-real.ps1` → `PASS：配额生效，10 条群消息回了 1 条`（批窗口合并 10 条、判定 0 次模型调用） |
| 批窗口 | 静默 5s 送判定、最多等 20s；`FAKE_AT_INDEX=-1` 实测一次判定覆盖整批（2.4s，370/68 token） |
| 判定质量 | 10 条纯闲聊 **0 条**被判回复（score 0.05~0.20），约 **1.9s/次**（flash） |
| 判定落库 | `judgements` 表 10 行（`heuristic/reply` 1 + `llm/silent` 9），`usage.stage='judge'` 单列 |
| 群会话工具降权 | 已挂 `tools.guard()`，日志可见 |

**别名（叫名字）—— 2026-10-26 落地**：`identity.aliases` 可配多个称呼，命中即等同被点名：
跳判定器直接回（零模型调用），但**不提前封口**批窗口 —— 只有 `@` 走 `atLookaheadMs`。
理由：@ 是明确对着它说话，叫一声名字可能只是顺口提到，拿它去打断"有人还在补充"就是抢话。
名字集合 = 登录昵称 + QQ 号 + 别名，由 `service.syncBotNames()` **同时**喂 judge 与 gates
（只喂一边会出现"闸门放行、判定却判成 unsure"的白花钱）；单字别名会被过滤 —— 它几乎命中每句话，
等于把 `mention` 档关掉。`mention` 档下别名现在也能触发（以前只认 `atMe`）。

### 两套记忆（2026-10-26 落地，同日扩成"完整对话"）

| | 短期（群上下文） | 长期（Memory） |
|---|---|---|
| 装什么 | 最近 20 条原文，**含自己说过的话** | 结论 + 摘要：`self` / `topic` / `thought` / `impression` / `daily` |
| 真相源 | `messages` 表（入站 `context/delivered`，出站 `sent`），内存 `GroupContext` 只是缓存 | `memories` 表 |
| 谁写 | 入站自动写；出站**送达后**由 `Outbox.onSent` 回写（死信/未发送不回写） | judge 的 `memory` 字段（只写 `thought`）；出站写 `self`（每条都记）；日总结写 `daily`；`service.remember()` 供控制台/外挂 |
| 谁读 | 判定（`contextText`）+ 回复（`renderPrompt`） | 只喂回复，**不进判定** |
| 失效 | 20 条 / 3000 字 / 60 分钟；内存保 80 条 | `thought` 2h；`self` 24h；`topic` 24h 未提及；`daily` 30 天；容量 100 / 60 / 60 / 150 |
| 开关 | 无（总要听得见） | `memory.enabled` 默认 **false**；日总结再加 `memory.daily.enabled` |

**注入分三段，窗口必须错开**（同一句出现两次，模型会当成两件事）：

```
【最近对话】上下文窗口之外的原文（beforeTs + excludeIds 双保险）
【最近几天】daily 归纳，只取早于原文窗口的日子
【你记得的事】self → topic → impression → thought
```

- 去重按 **messageId**，不按 ts：入站 ts 是 QQ 秒级，出站是本地毫秒，同一秒内会错位。
- 截断按**行**累加 —— 旧实现整块 `break`，一个大的印象块会把后面的 thought 全挤掉。

改之前先看这几条：

- **开关只管"新增"和"注入"**。`list`/`forget`/`clear` 永远可用，否则关掉之后库里的记忆变成看不见也删不掉的黑盒。
- **出站进上下文是"别重复回答"的前提，不是可选项**。`renderPrompt` 已经允许"补答更早的提问"，没有出站记录它就会把答过的再答一遍。反过来，只改提示词不加出站信息 = 直接制造重复回答。
- **`self` 每条都记**：模型不会主动记"我答过什么"，过滤靠容量淘汰而不是规则（规则越多，越难解释"为什么这句没被记住"）。
- **thought 是白嫖 judge 得到的**：判定为沉默的那一刻就是"想说但没说"。复用同一次调用，零额外成本。judge 的 `maxTokens` 因此从 1024 抬到 1280。
- **`topic` 不自动写**：会被高频刷新成噪音清单，等 M3 控制台能看见再放开。
- **`last_seen_at` 靠 `Memory.touch()` 刷新**，在批窗口 flush 时调一次（话题前 10 字命中即算提到，和原项目同构）。不刷新的话话题会永远停在创建时刻，被 prune 当最旧的删掉。
- **日总结幂等靠 `delete + insert`**：unique 约束含 `text`，直接 upsert 会让同一天出现两份总结。
- **日总结失败要落 `kv['daily:<chatKey>:<day>']`**：否则表现是"记忆里少了两天，但没有任何报错"。失败后 1 小时内不重试，避免坏 provider 每 10 分钟烧一次钱。
- 判定链**看不到**长期记忆：要不要开口不该被旧印象影响。真要影响就用 `heuristics` 加分，别往判定 prompt 塞全文。
- 每轮都重拼完整 prompt 进同一个 session，`in_tokens` 会随轮次上涨（O(n²)）。**暂不处理**，先看 `usage` 表数据再决定要不要做增量注入。

### 人设（角色卡）—— 插件层注入，2026-10-26 落地

人设**不用** DSH 的 `@deepseek-ai/dsh-persona`。那套是 preset 里的静态行：模型看得到、**插件读不到**，而判定层必须知道"这个角色爱不爱接话"，否则通用判据会把话多的角色判成一潭死水。

一份人设，两档粒度，不是重复配置：

| 字段 | 给谁 | 写什么 |
|---|---|---|
| `persona.text` | 回复 prompt（`renderPrompt` 的 `persona` 参数） | 完整角色卡：身世、外貌、口癖、教养 |
| `persona.judgeHint` | 判定 prompt（`buildSystem` + user 消息） | 50~100 字性格摘要：只写性格与参与意愿 |

- `judgeHint` 留空时**直接用全文**（单一真相源，避免"改了角色卡忘改摘要"这种查不出来的 bug）；摘要只是可选优化
- 判定侧**两处都放**：SYSTEM 里切判据（"性格外向 vs 冷淡"），user 消息里放人格正文 —— `system` 是否透传到 adapter 取决于实现，赌不起
- 有人格时判据从「纯属闲聊时不该插话」换成「这个角色此刻会不会想接」；**人格只决定想不想说，不决定该不该说**
- 私聊也注入（`renderPrompt` 原来私聊直接返回正文，已改）
- 按群覆盖走 kv（`persona:<chatKey>` / `persona_hint:<chatKey>`），优先级高于静态配置；接口 `setPersona` / `getPersona` / `clearPersona`
- 控制台 UI 未做（M3），现在只能改配置或调接口

**judge 的已知缺口（2026-10-26 决定搁置，不是忘了）**

judge 现在能拿到 `personaHint`，但拿不到下面这些东西，所以它只能做"这条消息值不值得接"的判断，做不了"我现在该不该开口"：

1. ~~出站消息不进上下文~~ —— **2026-10-26 已修**：`recentContextMessages` 改为双向取（出站只 `sent`、死信排除），
   judge 通过 `contextText` 能看到自己刚接过什么，可以判断"我已经接了三条该停了"。渲染上出站标 `你：`。
2. **`memory` 不进 judge**：`llmJudge` 没有该参数 → `thought`（想说还没说的）写了没人消费，闭环断裂
3. **`judge.enabled=false` 的语义是「一律不回」**（优先于 `onUnsure`）：想"不判、交给对话层" 要用 `judge.onUnsure='agent'`，不是关 `enabled`
4. **没有 `reasoningEffort` 透传**：DSH 的 `LlmCallControls` 支持该字段，设 `low` 能砍掉判定里 250~512 个思考 token

补完 2 之后，judge 的判断信息量就接近 agent（历史那部分已由出站上下文 + 记忆替代）。待验证项：`ctx.systemPrompt.assemble({scope})` 能取到含其他插件注入的完整投影，但 **`ScopeKey` 如何从 sessionId 映射没查过**，且首轮无 session 时无从 assemble。

### laya（`/v1/systemone`）能不能用 —— 2026-10-26 实测

它**不是聊天模型**：`output_tokens: 0`，返回的是每个命题的 `noul` 分数（0~1）。探针在 `_scratch/laya-*.mjs`（git 忽略）。

| 用途 | 结论 |
|---|---|
| 演角色（生成回复） | ✗ 根本不生成文本 |
| 人设遵循度评审 | ✗ 排序会反：客服腔 0.9786 > 符合人设 0.9021；只换标记文字，同一候选从 0.2607 跳到 0.9786 |
| judge 判据 | ⚠️ 有一种格式能排序全对（0.867 / 0.676 / 0.549 / 0.513），但余量仅 0.076，换格式立刻崩 |
| 稳定性 | ✓ 同输入 5 次极差 0.0000；延迟 350~760ms，比 flash 的 1.9s 快 |

硬约束：中文 state 上限约 **1900 字**，超了**静默砍尾部**（看 `truncated` / `state_tokens_dropped`）。我们 `contextMaxChars=3000` 且当前消息排在最后，直接用会把它砍掉。

结论：**judge 继续用 flash**。要再试，唯一靠谱的形态是"辅助否决"（flash 判回之后用 laya 复核），前提是先建 20+ 场景回归集。

**还没验**：真 QQ 群里的往返、图片消息、出站分条（M2）、
以及"偶尔自然地接一句"的参与度调优（当前纯闲聊 0/10，属于策略问题不是 bug）。
`policy.whitelist: ['*']` 是开发期全放行，生产必须换具体 QQ 号。

### 只读控制台（M3 第一阶段）—— 2026-10-26 落地

`ctx.webServer` 前缀 `/qdash-neo`，无构建单页 + 七个只读 API。目标不是"先有界面"，而是
**出问题时 30 秒定位到哪一层挡的**：`messages.state`（听过/投递/入队/已发/死信/丢弃原因）
与 `judgements`（层/结论/分数/原因码/耗时/覆盖几条）已经全部落库，控制台只是把它们摆出来。

| 项 | 结论 |
|---|---|
| 鉴权 | **登录式**：`/login` 表单 → `POST /login`（`config.console.username` + `config.console.password`）→ 会话 cookie `qdn_sid`（HttpOnly/SameSite=Strict，默认 12h 滑动续期，内存存储，**重启即失效**）。留空口令首启生成并落 `kv['console:password']`（重启不变，日志只打印一次）。`?token=` **已废弃**；脚本走 `Authorization: Bearer <口令>` |
| 端口 | 默认**独立端口** `127.0.0.1:7800`（`console.mode: standalone`，路径挂在根 `/`）；`mode: attach` 才回落到宿主 `webServer` 的 `console.mount` 前缀。长期调试用 `npm run console`（无 DSH 宿主，独立库 `~/.dsh/storages/qdash-console-standalone.db`） |
| 配置页结构 | **左侧分组导航 + 右侧单组表单**（`#/settings/<group>`）；一屏只对付一组。窄屏（≤1080）导航变顶部横向 chips |
| 随机性 | policy.replyChance（过闸后掷骰子，被掷掉不唤起模型）/ policy.sleep.*（模型输出 [[SLEEP:N]] 自己决定睡多久，范围由配置给；沉睡期消息仍进上下文，状态存 kv sleep:<chatKey>） |
| 工具 | src/tools/catalog.js（纯判定：QQ 清单 + 高危名单 + 白名单求交集）+ src/tools/index.js（注册/读图/白名单生效）。读图走 ctx.attachments.saveImage + exec.deferContext；写类走出站队列；qq_kick 默认不注册 |
| 分组归属 | 由 `runtime.js` 的 `GROUP_LAYOUT` 决定（**只动呈现层**，schema 与落盘键不变）：连接与身份 3 / 人格与提示 4 / 模型 6 / 谁能触发 7 / 频率与配额 4 / 出站形态 4 / 群内判定（可选）15 / 社交记忆 20 / 控制台与存储 10。`agent.systemPrompt` 归「人格与提示」且是多行框（`MULTILINE_PATHS`）；`outbound.intervalMs` 与限流配额同在「频率与配额」 |
| 身份与人格 | `identity` 段合并进 `persona` 组（label「身份与人格」），`onebot.selfId` 从 OneBot 组挪进来；**别名归人格卡**（每张卡一组 `aliases`，换卡即换称呼），`identity.aliases` 降为兜底且**不上表单**（`runtime.js` 的 `HIDDEN_FIELDS`） |
| 人格卡 | 卡库存 kv：`persona:cards`（JSON 数组，≤20 张）+ `persona:active`（选中 id）。`GET /api/persona`（`?cardId=` 取全文）、`POST /api/persona`（save/delete/activate）。优先级：按群覆盖 → 当前卡 → 部署层静态人设；别名不受 `persona.enabled` 影响（它管路由不管 prompt） |
| 生效三档 | `live` 保存即生效 / `reconnect` 保存后自动重连（`onebot.wsUrl|token|selfId`）/ `restart` 下次启动生效（端口、库路径、挂载）。**只有被 patch 锁定的字段才禁用**；`restart` 与 `secret` 都可编辑，靠徽标说明时机 |
| 改口令 | 顶栏「口令」弹窗（写 kv `console:password`）。配置页**不再显示** `password`（`HIDDEN_FIELDS`），避免两个入口改同一个概念 |
| 出站分条 | `outbound.split` 三档：`smart` 语义边界 / `line` 按换行（每行一条）/ `off` 不拆。`resolveMode()` 兼容旧的 boolean |
| 删会话 | 会话列表每行右侧垃圾桶 → `POST /api/chats {action:'delete'}`：释放内存句柄 + 删磁盘 `~/.dsh/sessions/<cwd>/<编码id>/` + 删 `chats` 行（messages 保留） |
| provider/model | 配置页「会话模型绑定」「判定器」「长期记忆」里的 provider/model 是 **input + datalist**，候选值来自 `GET /api/llm`（宿主 `ctx.llm.listProviders/listConfigurableProviders/listModels`，每次现取不缓存）。独立进程没有 `ctx.llm` → 顶部提示条 + 只能手填 |
| Host | 只放行 `127.0.0.1` / `localhost` / `[::1]`，LAN 要显式配 `console.allowedHosts`（挡 DNS rebinding） |
| 静态 | 白名单三条映射（`index.html` / `assets/app.js` / `assets/theme.css`），不读目录 → 穿越不存在 |
| 方法 | 只 GET/HEAD；其余 405 |
| 失败形态 | store 未开 → 503 `not-ready`；库已关 → 503 `kernel-stopped`；500 不回堆栈 |
| 前端 | 五视图（总览/会话/会话详情/判定/用量），5s 轮询、`document.hidden` 暂停、切路由 abort；**一律 `textContent`**，不拼 HTML |
| 测试 | `test/console.test.js` 11 项（真 `node:http`）：401/302+cookie/Host 403/穿越 404/405/API 形状/limit 夹紧/口令持久化 |

两条容易踩的：

- **`Number(null) === 0`**：没传 `limit` 会被当成 0 再夹到 1 → "列表只显示一条"。`intParam` 必须先挡 null/空串。
- **CSP `style-src 'self'` 会拦 inline `style="..."`**：动态尺寸必须走 CSSOM（`el.style.width = ...`），否则页面布局全是默认值。

**验证边界**（2026-10-26）：单测已到 206 项（十个文件）；五视图 + 配置页用 `agent-browser` 在独立演示实例
（真 `ConsoleServer` + 真 sqlite + 真 schema，见 `_scratch/console-demo-m3.mjs`）逐页截图核对过。
**真 DSH 宿主已验**（`dsh web --patch`，3081）：`/qdash-neo/health` 200、`/api/config` 70 字段、写入 → revision 递增 →
重启重放 → 改回默认值删键，全链路走通（详见 05 M3 第二阶段记录）。

窄屏（2026-10-26 补做）：390 / 768 / 1440 三档逐视图截图核对，`scrollWidth == innerWidth`、越界元素为 0。
改了两处，都是"桌面上看不出来"的类型：

- **表格在 ≤640px 改卡片**：原先只 `display:none` 掉 `thead`，六列仍按内容撑开，判定页连"原因"整列都在视口外。
  现在 `td` 带 `data-label`（列名来自 `table()` 的 `columns`），靠 `::before` 把列名补回来 —— 加列时不用改 CSS。
- **单列后 `.app-shell` 要 `align-content: start`**：`min-height:100vh` + 两条 auto 行，默认 `stretch` 会把多余空间
  平分给侧栏那一行，顶部导航下面凭空多出上百像素空白。桌面是单行，永远碰不到。
- **首屏 `dom.view.focus()` 会在整页外面画一圈框**：`#view` 是 skip-link 落点（`tabindex=-1`），
  `:focus-visible` 给它描了 `2px solid var(--accent)`，一进来就 focus 等于给内容区套个青色外框（看着像 bug）。
  已改成首屏不抢焦点，并给 `#view` 单独 `outline: none` —— 它不是控件，Tab 到链接/按钮的焦点环不受影响。

**没做**（后续阶段，别当 bug）：改白名单/配置、插件选项卡注册表、custom iframe、SSE 推送、出站分条。

真模型实测踩到的坑（都在 05 M4 末尾，改代码前先看）：
`inject` 必须声明 `llm`；`dsh-llm-pi-ai` **已在 dsh-base 里以 id `llm-pi-ai` 挂载**（再 insert 会冲突）；
`FinishReason.kind` 是 `'max-tokens'` 不是 `'length'`，推理模型会先烧 250~512 token；
两个 DSH 抢同一个 session 会 `SessionAlreadyOwnedError`。


## 4. 不能推翻的决定

这几条是花了时间定下来的，改之前先读理由再动手：

1. **不另造 `FeatureModule` 契约**。插件就是 DSH 插件：`inject: ['qdashNeo']` + `apply` 里注册能力面。理由：DSH 已有 Fiber 生命周期、依赖注入、schemastery 校验、运行时配置，再造一套等于重演原项目"绕开公开 API"的错误。
2. **插件作者零前端**。控制台选项卡是**声明式 JSON**（`form`/`table`/`status`/`actions` 四种块），内核渲染。要画图才写一个纯静态 HTML，内核塞 sandbox iframe。
3. **控制台自己造**，不挂 DSH 控制台槽位。自己的地址、自己的页面。理由：地址和页面必须归我们，管理面要比 DSH 前端的 lifespan 长（04 §10.1）。
4. **走 `@snowluma/sdk` 直连，不走 `@snowluma/mcp`**。MCP 只有 6 个 meta 工具（`invoke_action` 一个就等价于全部 OneBot action），工具级白名单在那种形态下形同虚设。
5. **安装 ≠ 启用**。patch 的 `insert` 行是唯一真相源，不扫目录。
6. **失败必须可见**。`catch {}` 和 `String(err)` 是禁止的（原项目把 MCP 错误对象这么丢掉过，排查了两天）。

## 5. 环境

### 从零跑起来

```bash
bash scripts/setup.sh     # 装 DSH 依赖 + 把探针放进 ~/.dsh/profiles/web/node_modules/qdn-probe/
bash scripts/start.sh     # 启动，直接打印带 token 的控制台地址
```

### 关键事实

- Node **24.17.0** / Python 3.13.12（本机托管路径见系统提示；Node 24 才让 `node:sqlite` 无 flag 可用）
- DSH 版本 `0.2.1-rc.2`。**当前真正能跑的那份在
  `<本机路径>\WorkBuddy\2026-10-26-08-32-04\dsh-run`（305 包，带 `lib/*.js`）**；
  仓库里的 `dsh-run/` 目前只有 `package.json` + `probe.patch.yml`，**没有 node_modules**，
  `scripts/start.sh` 会直接报「缺少依赖」。
  ```bash
  cd /c/Users/lenovo/WorkBuddy/2026-10-26-08-32-04/dsh-run
  node node_modules/@deepseek-ai/dsh/lib/bin.js \
    --profile web --patch ./probe.patch.yml --port 3081 --no-open
  ```
  **参数顺序照抄这条**（实测能跑的那一个）。token 只打在 stdout，要重定向到文件再 grep。
- 插件解析以 **profile 目录**为基准 → 探针必须复制到 `~/.dsh/profiles/web/node_modules/qdn-probe/`（`setup.sh` 干这件事）
- 本机**没有 C++ 编译器**（VS 只装了 Redist），`koffi` 类原生包编译不过 → `npm i` 必须加 `--ignore-scripts --omit=optional`
- **真模型可用（2026-10-26 起）**：OpenAI 兼容网关 `https://api.example.com/v1`，
  密钥只走环境变量 `QDN_LLM_KEY`（`~/.dsh/.credentials.yaml` 里仍然只有浏览器 session 凭据）。
  DSH 侧不用装新东西：`@deepseek-ai/dsh-llm-pi-ai` 已经以 id `llm-pi-ai` 挂在 `dsh-base` 里（dormant），
  按 id 覆盖它的 `config.providers` 就多一条路由，见 `test/patches/group-real.patch.yml`。
  **判定/测试用 `deepseek-v4.1-flash`**（1.4~2.5s/条；`deepseek-v4-pro` 是 3.4~4.0s/条），
  集成测试从 3.5 分钟降到 **约 70 秒**。网关所有模型都会先烧思考 token（40~500），
  所以 `judge.maxTokens` 默认 1024，别再往下调。
- 探针的所有可变路径都走环境变量：`QDN_DSH_LLM` / `QDN_PROBE_LOG` / `QDN_PROBE_CWD` / `DSH_PROFILE_DIR`（见 README 表）

### 踩过的坑（会再踩）

| 现象 | 原因 |
|---|---|
| `curl` 本地端口返回 502 | 系统代理配在 `127.0.0.1:10808` 但进程没跑 → 加 `--noproxy '*'` |
| `dsh web` 的 token 拿不到 | token 只打在 stdout。重定向到文件再 grep `token=` |
| 起完的服务立刻死 | 用 `(... &)` 后台起会被沙箱回收。必须用工具的后台任务机制（或 `nohup` 外部壳） |
| `npm init -y` 在 `.probe` 目录报 Invalid name | 目录名不能带点 |
| 插件属性读不到 | cordis 的 `inject` 是强制声明，没声明就没属性 |
| 探针 `import '@deepseek-ai/dsh-llm'` 解析不到 | profile 的 node_modules 里只有探针自己。v8 改成从 DSH 启动脚本往上找，别改回裸包名 |
| 探针插件"装了没反应" | 缺 `exports["./client"]` 或文件不存在时**宿主静默跳过**，不报错 |
| 真模型判定全部静默、日志 `finish=max-tokens` + 空正文 | 推理模型把 `judge.maxTokens` 的预算烧在思考上 → 默认 1280（带 `memory` 字段后 1024 不够）；且 `FinishReason` 是 `'max-tokens'` |
| `cannot get property "llm" without inject` | 插件 `inject` 没声明 `llm`。单测的 ctx 是假的，只有真宿主会报 |
| insert `dsh-llm-pi-ai` 报 `provider "amazon-bedrock" is already declared` | 它已在 dsh-base 里以 id `llm-pi-ai` 挂载 → 按 id 覆盖 config，别再 insert |
| 重启后 `SessionAlreadyOwnedError` | 上一次的宿主还活着、握着同一个 session 的写租约。清进程或换群号（`FAKE_GROUP_ID`） |
| `node --test` 跑完不返回、看起来"卡死" | 批窗口的 `setTimeout` 没被 `clearTimeout`。`batches.clear()` **只丢引用**，定时器仍挂在事件循环里（最长 20s）。用 `service.clearTimers()`，测试 teardown 必须调它 |
| 测试里 `await feed()` 之后再也不返回 | `feed` 会等整条 per-chat 串行链；如果上一个 flush 正卡在测试自己的 barrier 上，就是死锁。喂"判定期新消息"时**别 await feed**，直接调 `handleInbound` |

## 6. 下一步

按**对实际使用的影响**排序，不是按里程碑阶段。已完成的里程碑见 `05-施工计划.md`。

### P0 —— 影响日常使用

- [ ] **日预算 / 单会话限额**（M4 未开始，计划 `budget/guard.ts`）
      现在没有任何上限。超限时应只回一句提示、不调模型；提示每小时最多一次。
      `usage` 表已有数据，差的是一个闸。

- [ ] **审批转发到 QQ**（M4 未开始，计划 `approvals/broker.ts`）
      `approval/request` 目前一批放行，所以问题还没暴露；一旦收紧，
      请求只会出现在 DSH 控制台、QQ 里收不到，模型干等到超时。
      要做成「要执行 X，回复 通过/拒绝」，5 分钟不回复按拒绝处理，模型能读到"超时被拒"。

- [ ] **队列持久化 + 断线补投**（M2 后半段，`onebot/history` 未开始）
      `systemctl restart` 时队列里未发出的消息会丢；OneBot 断开期间的消息不补。
      验收：拔网 30 秒后恢复，不重复、不丢，补投打 `backfill` 且不触发自动回复。

### P1 —— 特定场景才发现

- [ ] `kill -9` 断电测试（依赖上面第 3 项）
- [ ] 慢工具调用期间出站不被阻塞（两条链路本来就分开，未实测）
- [ ] `memory` 进 judge —— `thought` 类记忆写了没人消费，判定链看不到
      （2026-10-26 决定搁置；现在"该不该开口"已整体交给模型，影响比当时小）

### P2 —— 面向插件作者，不是使用者

- [x] 语音插件的两个能力面：`ctx.qdashNeo.tools.register()`（插件注册工具）与
      `ctx.qdashNeo.voice.send()`（插件产出的音频交主框架安全发送）。
      TTS 已搬进 `examples/qdash-neo-plugin-voice`，主框架保留 `qq_send_voice` / `qq_voice_list` 与全部防护
- [ ] custom iframe 选项卡（要动 CSP）
- [ ] 插件失败页（现在挂载失败只记日志 + `status().console.error`）
- [ ] `feature_*` 表隔离与插件卸载
- [ ] SSE 推送（控制台现在是轮询）
- [ ] 插件运行层 settings（form 块现在只读）

### 已知取舍（别当成 bug 去修）

- **出站分条只在单测里验过**，没跑真 QQ（随 P0 第 3 项一起做）
- **群内参与度**：判据是「想不想说 / 合不合时宜」，话多话少交给角色卡 —— 有意为之，不是"该收紧的 bug"
- **单工作区**：所有 QQ 会话共用一个 `cwd`，共享 `AGENTS.md` 与工具白名单。
  按会话拆分会带来"改一次提示要同步 N 个文件"，刻意不做
- **沉睡上限 60 秒**：不做"无限期潜水 + 唤醒条件配置"——那套设计服务的是长时潜水，
  我们的量级（1 分钟）配不上它；叫不应才是真问题，已用 `@`/私聊/拍一拍强制唤醒堵住
- **OneBot transport** 是原生 WS，不是 `@snowluma/sdk`；接 sdk 只换 `src/onebot/client.js`
- **真 QQ 群往返、图片消息**仍需人工验，假 OneBot 只覆盖协议与链路

## 6.5 主框架与插件的边界（2026-10-27 定）

**主框架定死现有功能不改，其余功能都由插件扩展。**

判断一个新需求该落在哪：

1. 是不是「每个使用者都需要」的 QQ 交互？→ 主框架（**冻结期内不改**）
2. 漏了会不会出安全事故？→ **必须主框架**（路径校验、限流、落库、白名单只能有一个实现）
3. 需要外部服务 / 只有部分人想要 / 能独立发版？→ **插件**
4. 两者都不是 → **默认插件**

第 4 条是关键：**默认值是「插件」，不是「看情况」**。没有默认值，每次都要从头吵一遍。

**冻结期的例外**：可以修 bug 与安全问题、可以改实现（行为不变、更清楚/更快）、
可以补测试与文档；**不可以**加新能力、改行为语义、加配置项。

理由：冻结是为了让主框架**稳定**，不是为了让它**僵化**。

**插件契约现状**（写代码前先看这张表，别假设）：

| 能力 | 状态 |
|---|---|
| `console.registerTab` | ✅ |
| `tools.register` | ✅ |
| `settings.register` | ✅（2026-10-27） |
| `storage.forFeature` | ✅（KV only，2026-10-27） |
| `console.registerStatic` | ❌ 未实现（高风险：路径穿越 + CSP） |
| `fetch` | ❌ 未实现（**建议不做**：插件是可信代码，绕过内核直接用原生 fetch 也行，内核提供它收益≈0 而风险自负） |
| `judge.registerProvider` | ❌ 未实现（中风险：插件抛错不能拖垮判定链） |

## 7. 改文档的纪律

- 任何"DSH 的 API 是 X"的说法，**必须能指到** `<可真跑的那份 DSH>/node_modules/@deepseek-ai/<pkg>/lib/types/<file>.d.ts:<line>`（`dsh-src/` 现在没有 node_modules，指向它等于没指）。指不出来就是假设，进 `00-事实核查表.md` §三 待验表。
- 运行时行为（源码答不了的）指到 `_scratch/m0-2b.log` 这类**探针日志**，并写清用的是哪个 session id。
- 结论变了要**就地改**，不要追加一段"补充说明"——文档里同时存在两种说法是最常见的返工原因。
- 代码里**不许出现本机绝对路径**。需要路径就走环境变量或运行时发现（`probe/lib/index.js` 是范例）。

## 8. 这份文件怎么用

它是给接手者的**入职手册**。接手后先自测三个问题：

1. 这个项目在做什么？
2. 现在做到哪一步了（哪些验过、哪些没验、哪些没开始）？
3. 下一步做什么？

答不出来说明这份文件写得不够，**回来补它**，不要默默猜。
