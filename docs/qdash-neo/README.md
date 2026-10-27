# qdash-neo 重构：分文件设计与规范

这套文件取代原先单篇《qdash-neo 重构方案》中**与实际 API 不符的部分**。原因是：那份方案里关于 DSH 的调用方式（`session.prompt` / `session.onAssistant` / `sessionProjections.stateOf`）是从原项目行为反推的假设，而真实的 DSH 插件 API 是另一套（`ctx.agents` + `ctx.sessions` + `session/event` + `approval/request`）。照着假设开工会在 M1 撞墙。

## 阅读顺序

| 文件 | 内容 | 谁看 |
|---|---|---|
| [00-事实核查表.md](./00-事实核查表.md) | 已核实 / 待验证 / 已推翻，逐条带来源 | 所有人，先看 |
| [01-DSH-插件对接.md](./01-DSH-插件对接.md) | DSH 插件体系的真实契约：manifest、生命周期、会话、事件、审批、路由、配置 | 内核开发 |
| [02-OneBot与SnowLuma对接.md](./02-OneBot与SnowLuma对接.md) | OneBot v11 落地细节与原项目踩过的坑 | 内核开发 |
| [03-内核实现要点.md](./03-内核实现要点.md) | 用真实 API 重写 pipeline / session / outbox / store | 内核开发 |
| [04-插件开发规范](https://github.com/cmnyhh/qdash-neo-plugins/blob/main/docs/plugin-development.md) | **已迁至 `qdash-neo-plugins`**（连同 TTS 插件一起）。插件生态不属于内核仓库、准入 | 插件作者（必读） |
| [AGENTS.md](../../AGENTS.md) | 项目交接书：给任何新接手的 agent/人看的状态与纪律 | 新接手者（先看这个） |
| [05-施工计划.md](./05-施工计划.md) | M0–M4 细化到文件与验收命令 | 所有人 |

## 四句话结论（2026-10-26 实机跑通后更新）

1. **可行性成立，已从"推断"变成"跑过"**：DSH `0.2.1-rc.2` 装在本机 `dsh-run/`（613 包），`dsh web` 起得来。已实测：`ctx.webServer` 注册路由 200、`ctx.agents.create + followup`、完整事件序列（`turn/start → user/message → assistant/message → turn/end` + `usage`）、假模型驱动真实工具执行、`approval/request` 钩子挂得上。
2. **两处设计已推翻重做**：① 社区插件不该另造 `FeatureModule`，应直接是 DSH 插件（`inject = ['qdashNeo']`），见 04；② **内核不该走 snowluma MCP，应直连 `@snowluma/sdk`**——MCP 只有 6 个 meta 工具（`invoke_action` 一个就等于全部 OneBot action），工具级白名单在那种形态下无效，见 02 §0。
3. **控制台定案：自己造**。自己的 HTTP 入口（`ctx.webServer` 的 `/qdash-neo` 前缀，或独立 7800 端口）+ 自己的无构建页面，和原项目一个形态。曾评估过"挂到 DSH 控制台槽位"（技术可行，已实测），因地址与页面都不归我们而放弃，理由见 04 §10.1。
4. **未知项只剩两个运行时问题**：审批与 `tool/call` 的时序、同 session 双持有者的报错形态。两者都不动架构。

## 与旧文档的关系

旧文档（资料库《qdash-neo 重构方案》）仍然有效的是：范围与取舍、预设组合思路、模型绑定、判定器、控制台页面设计、设计原则。**被本套文件取代的是**：§3 目录结构（改为插件形态）、§3.1 社区插件准入（改为 DSH 插件契约）、§5.3 session 接口、§5.6 工具白名单（meta 工具需参数级授权）、§9 未验证项清单。§10.1 控制台服务**保留原设计**（自建端口 + 自建页面），只是实现细节改为优先复用 `ctx.webServer`。等 M0 跑完，按 05 的清单回写旧文档。


## 文档状态约定

- 🔒 **源码验证**：能指到 `node_modules/@deepseek-ai/<pkg>/lib/types/<file>.d.ts:<line>`，版本 `0.2.1-rc.2`。**这是唯一算数的等级**
- ✅ **已核实**：有官方文档或仓库依据，但没有本地源码印证
- ⚠️ **未核实**：只有社区文档/博客依据
- ❓ **待验证**：无依据，必须实测

### 复现验证（不需要 DSH 能跑）

```bash
mkdir dsh-src && cd dsh-src && npm init -y
npm install @deepseek-ai/dsh@0.2.1-rc.2 --omit=optional
# install 可能因 koffi（native，需 CMake）报错退出，但类型定义已落盘
ls node_modules/@deepseek-ai | wc -l          # 本机实测：304
find node_modules/@deepseek-ai -name "*.d.ts" | wc -l   # 本机实测：7466
```

**新规矩**：任何"DSH 的 API 是 X"的说法，指不到行号就当作假设，必须进 00 §三 待验表。

