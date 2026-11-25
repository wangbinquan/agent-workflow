# RFC-583 system-operations 的配置、文档与 PlantUML 路由归入模块 inbound，两个 HTTP 传输小工具归入 platform（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第八批）

- **状态**：Done（2026-11-25，落地 `1e6e2a282`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2、§3 与 plan §4.6 W9-D；上一批见
  [RFC-582](../RFC-582-task-execution-port-artifact-worktree-file-routes-into-inbound/proposal.md)。

## 1. 背景

RFC-582 之后 `routes/` 余 21 个文件。架构报告的归属表把其中 8 个记为 platform：路由的传输工具 `registry`、`operationRoute`、`verifiedBodyLimit`、
`publicOrigin`，与 `config`、`docs`、`health`、`plantuml` 四个绑定。RFC-294 design §3 规定 platform 不依赖任何 `modules/`，而这 8 个里只有
`verifiedBodyLimit` 现在就满足：

| 文件                         | 取的模块 / legacy                                                             | 处置                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `verifiedBodyLimit`          | 无（只取 Hono）                                                               | 迁入 `platform/http/`                                                        |
| `publicOrigin`               | system-operations `public/queries` 的配置查询类型（只读其中 `publicBaseUrl`） | 换成 platform 自己声明的中性形状后迁入 `platform/http/`                      |
| `config`                     | system-operations `public/commands`                                           | 是 system-operations 配置用例的绑定，迁入它的 `inbound/http/`                |
| `plantuml`                   | system-operations `public/queries`                                            | 同上（读守护进程配置里的 PlantUML 服务地址）                                 |
| `docs`                       | system-operations `public/queries`、`@/auth/actor`、`publicOrigin`            | 同上（API 文档与 `/.well-known/mcp`）                                        |
| `health`                     | task-execution `public/types`                                                 | 不动：放进 system-operations 会产生 DAG 之外的边，与另五个路由一起等用户定   |
| `registry`、`operationRoute` | `@/auth/actor`（路由的鉴权门读请求上的 actor）                                | 不动：改它要动 HTTP 鉴权门读 actor 的方式，与 identity-access 的路由一起暂缓 |

## 2. 目标

- **G1**：`config`、`docs`、`plantuml` 原样迁入 `modules/system-operations/inbound/http/`（`configRoutes.ts`、`docsRoutes.ts`、`plantumlRoutes.ts`），挂载
  函数经 `composition/routes.ts` 转出，`server.ts` 改从那里取；`verifiedBodyLimit`、`publicOrigin` 迁入 `platform/http/`。旧位置都不留转出。
- **G2**：`config` 迁入后，`public/commands` 的 `ApplicationConfigurationCommands` 在模块外没有消费者，随绑定撤回 application（与它的工厂放在一起）。
- **G3**：`legacy-horizontal-files` 69 → 64；public 类型偏差 29 → 28（撤回的那个带一条 open-type 记录）；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `health`、`registry`、`operationRoute`（见上表）；identity-access 与凭据相邻的路由；等用户定的五个路由；task-catalog。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：五个旧路径不存在，全部源码、用例与脚本不再取它们；三个绑定与原文件相比只改 import（`config` 另删去为旧路径保留的两个类型转出）；
  两个传输工具只改 import 与说明注释。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 69 → 64；public 类型偏差上限 29 → 28；未消费 public 符号保持 0；DAG 之外的边不增加；架构报告的归属表删去
  五行；新增 RFC-583 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
