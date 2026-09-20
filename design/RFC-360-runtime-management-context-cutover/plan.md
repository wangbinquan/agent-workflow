# RFC-360 实施计划

- 状态：Done（2026-09-20；实现与托管验收见本文末尾）。关闭 RFC-294 W4-E4b 与本域 B/D；driver、Task mechanics、MCP 全流程和根物理迁位按 exact 清单交后继。
- T1～T8 按当前源码与托管证据完成；历史实施批次记录保留于 §4。

## 1. 任务与提交批次

| 任务       | 工作                                                                                                    | 依赖 / 验收                                            |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| RFC-360-T1 | 冻结 current-source 字段、入口、callsite、error wire 与 exact debt 清单；记录 provider/consumer         | 用户批准；逐项 source→ledger 与 ledger→source 对拍     |
| RFC-360-T2 | 提炼 RM domain/profile DTO 与分组 public commands/queries；定义 config/probe/model/usage required ports | T1；现有字段/default/nullable 无丢失                   |
| RFC-360-T3 | 将唯一 registry 实现归 RM；接入 RC 的同事务试跑失效 participant                                         | T2；双库写入/回滚与竞争用例通过                        |
| RFC-360-T4 | 管理、probe、status/model-list 路由及 CLI consumer 切 public application                                | T3；HTTP/CLI golden、别名与 probe receipt 不变         |
| RFC-360-T5 | TaskExecution runtime selection 以同一事务程序接 offered participant                                    | T2/T3；唯一 mint、freeze/resume 与 17 项热配置回归通过 |
| RFC-360-T6 | bootstrap 构造一次；删除已无 consumer 的 registry facade；逐条转交其他 owner debt                       | T4/T5；本域 B/D 同步退出，不能只给 E4b 勾选            |
| RFC-360-T7 | 重采 canonical/report/status 并做功能审查，按源改动选择托管验证                                         | T6；不手改 generated status、不用大目录过滤隐藏残留    |
| RFC-360-T8 | 发布并核对 exact-SHA Main CI；更新本 RFC、RFC-294、STATE/index                                          | T7；AC-1～AC-8 全满足后才 Done                         |

建议三个可发布提交批次：T1/T2 合同与判据；T3/T4 管理纵切；T5/T6 执行消费与根收缩，T7/T8 收口。
每批都保留单一生产 writer；兼容 facade 只转发，禁止并存新旧业务算法。

## 2. 文件归属与协作

- 独立开发面：`modules/runtime-management/**`、本 RFC 测试与文档。
- 迁位面：`services/runtimeRegistry.ts`、`platform/runtime-registry/**`、`routes/runtime.ts`、`routes/runtimes.ts`。
- 短时协调面：`server.ts`、daemon bootstrap、TaskExecution runtime composition/mint consumer、RC 试跑失效 participant、
  architecture manifests、RFC-294、STATE/index。
- 他人 WIP 一律保留；同文件联合产出可以整体提交，但提交前必须明确包含的贡献。所有 Git 发布操作串行。

与 RFC-361 的 EC provider 不相互依赖；与 RFC-362 共用 TaskExecution composition 时错开接线。
全局 source-control、driver 改造、W9 后台 registry 不并入本 RFC。

## 3. 验证与完成清单

- [x] T1 冻结完整字段、真实生产入口和 exact IDs；无凭旧桶计数认领。
- [x] domain/use-case 行为与当前 oracle 一致；新增 public 合同有生产 consumer。
- [x] profile/MCP session 同事务联动在 SQLite/PostgreSQL 故障注入下共同回滚。
- [x] route/CLI parity、probe 竞争、默认值/别名、首次 dispatch/resume、热配置均有托管证据。
- [x] 本批 owned IDs=0；移交项明确 owner/removeWave 与仍在生产的原因；全局债务无未解释增长。
- [x] 最终提交为 origin/main 的祖先；Main CI 终态成功；按实际改动补需要的进程/平台证据。
- [x] RFC-294 只按达到的退出条件更新，W4 与父 RFC 不提前 Done。

回滚：按批回退调用绑定与兼容 DTO，持久数据不反迁；profile 写入与 session invalidation 必须始终在同一 owner。
禁止以回滚为由恢复两套 provider 实现或改变现有运行时能力。

## 4. 历史实施记录（以下各批次当时尚未完成）

T1 current-source 清单见 `implementation-baseline.json`（source SHA `47ebc43e1160dbab88a882550f412ccb84a68f20`，
7 个 owned 实现/route 文件、18 个生产引用文件，保留原 exact IDs 与 source hash）。
第一批将两组 HTTP adapter 的管理/probe/status/model 用例迁入 `application/runtimeManagement.ts`，
由同一实例提供分组 public commands/queries；两种 provider 的组合根使用同一 factory。
新增真实双库 application characterization，原 HTTP 测试继续作为 wire oracle。

本批只推进 T2/T4。底层 registry 仍在 legacy 路径，T3 的事务 participant 归位、T5 的执行选择与 T6 的完整根收缩仍未完成；
不能将这个中间批次作为 RFC-360 或 W4-E4b Done。RFC-361/362 已批准，尚待接续其实施任务。

第二批继续 T2/T3：profile DTO、纯 profile 判据、注册表 application/boot 和唯一持久化迁入 RM；driver 能力、缓存驱逐和旧配置读取通过 required effect port 注入。
RC 的试跑失效 participant 与 RM-required 引用 participant 复用同一 live transaction；继承失效的 runtime 名单由 RM 返回，不再让 RC 查询 runtimes 表。
新增双库故障注入覆盖更新/停用/删除/继承失效的共同回滚，以及同事务未提交 Agent 引用可见性。

短期兼容：`services/runtimeRegistry.ts`、`platform/runtime-registry/**` 只转发到唯一 RM 实现；八条新增 R1 import/export
逐条登记至 commons-debt，owner 为 RFC-360 T6。不得因实现已搬迁而宣称这些入口/执行选择/根绑定已经退役。
具体字段与接续面见 `implementation-progress.md`。

第三、四批候选完成 T5 与 T6 接线：选择与 NodeRun 快照使用同一事务；分组 public consumer、HTTP 归位、配置判据与启动根注入完成，七个初始 owned 路径和临时转发删除。当前仍等待本批 exact-SHA 托管验证，不提前勾选完成清单。细节见 `implementation-progress.md`。

## 2026-09-20 完成验收

实现取证 SHA `123ce2dbc94b10d2c88bf978437bfa0db1b898ba`，Main CI [35492271521](https://github.com/wangbinquan/agent-workflow/actions/runs/35492271521) **46/46 success**。
逐 job 和目标 suite 见 [共同验收记录](../RFC-294-backend-layered-target-architecture/acceptance-rfc360-362-2026-09-20.json)。
Windows 原生流程 [35491113835](https://github.com/wangbinquan/agent-workflow/actions/runs/35491113835) 在祖先 `59c1fff1c` success；
其后根注入由本次 Main 的多 OS binary/e2e 覆盖，不混称 Windows workflow 为本 SHA 结果。

AC-1/2/4/7：分组 public 管理入口、单一 registry/persistence、必填 RC participant 根注入；AC-3/5：同事务选择/冻结与 profile/session 回滚、原热配置 oracle；AC-6：7 个旧路径与认领 ID 归零，60 条通用 E4b bucket 明确转交；AC-8：本页托管证据。

关闭 RFC-294 W4-E4b 与本域 B/D；driver、Task mechanics、MCP 全流程和根物理迁位按 exact 清单交后继。后续纯文档提交的最终整仓 CI 与远端同步在发布时继续核对。
