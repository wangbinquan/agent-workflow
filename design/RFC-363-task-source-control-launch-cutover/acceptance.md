# RFC-363 验收与转交

候选源码及 canonical provenance：`f24b7b5effcc046f5a9e4d6700498dc36191da33`（实现提交 `6d81188460f4cb8fce373dd242bb6df41613709a`）。以下实现映射已经核对；Main CI 尚待终态，当前不记 Done。

## AC 逐项映射

| 判据 | 实现与保留行为                                                                                                                                                                                                                     | 托管测试证据入口                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | `application/launch/launchTask.ts` 持有 prepare → uploads → admission → commit → publish → submit 顺序；原唯一 root writer 的 54 字段保持。child/fusion 各自原 writer、origin/lineage/visibility、首次 runtime freeze 不重写。     | RFC362 字段账；`rfc363-launch-application`、`rfc349-task-route-launch-postgresql-adapter`、`rfc349-child-execution-launch-postgresql-adapter`、W5hn launch parity、W8 child conformance、RFC287/RFC303/RFC319 原恢复 oracle。 |
| AC-2 | SC source/snapshot/operation 与 Task preparation 四表持久化；首次具体 commits 先落 journal 再执行 Git；source revision 不含 fetch telemetry；逐文件上传 intent/receipt 支持中断重放。                                              | `rfc363-source-snapshot`、`rfc363-preparation-journal`、`rfc363-preparation-driver`；两个 `rfc363-*-process-recovery` suite，真实子进程、Git、SQLite 文件及 PG。                                                              |
| AC-3 | snapshot factory 只在所属 live tx 有效；Task admission 与 snapshot/plan 接受共用原 transaction；SC Git/FS 在事务外，由 Task 当前 fence 检验。                                                                                      | `rfc363-source-snapshot`、`rfc363-task-preparation-admission`、`rfc363-transferred-workspace-admission` 的真实双库回滚、重建、同事务投影和原融合 writer 用例。                                                                |
| AC-4 | `TaskRoutePreparedWorkspace.admit` 必填并返回闭合 lane；repository lane 不能带已物化路径，pre-materialized 必须先有 artifact；继续由原 Task execution/owner 推进，未新增 worker 或 NodeRun writer。                                | `rfc362-launch-contracts`、`rfc363-launch-application`、admission/driver suites；canonical `nodeRunInsertSites` 仍只有 `nodeRunMintParticipant.ts`。                                                                          |
| AC-5 | source seal、snapshot、preparation、content 四个 SC offered seam 与 Task reader 在三个生产根实际装配；新 root/Agent/Workgroup/multipart 不再从 Task service 获取物理机制。无 journal 的历史任务经 root-owned legacy binding 恢复。 | `rfc363-launch-application`、Task admission/reader、W29 composition guards、canonical C2；RFC362 声明债 22 → 0，SC 零 consumer 声明回到原基线 136。历史 private service 残项见下方转交，不称全仓 legacy 清零。                |
| AC-6 | SC 先完整排序再分页，按真实字节读；Task adapter 保留原 HTTP UTF-8 展示、截断与超大文件空内容。query capability 不跨绑定或存活期。                                                                                                  | `rfc363-workspace-content`：超过旧列表上限、UTF-8 跨页、二进制、oversized、回收/失效；原 `routes-worktree-files` 与 `worktree-files`。                                                                                        |
| AC-7 | additive schema 保留旧行；旧任务无 journal 可恢复；已有 GC 接管过期未绑定 artifact，admitted artifact 不清理；caller 转交的目录仍由 call/KE/DE 持有。                                                                              | `rfc363-additive-schema`、旧 backup/PG migration history；Task admission、transferred admission 与真实进程 suite；回滚边界及剩余 owner 如下。                                                                                 |
| AC-8 | Main 必须为当前源码终态成功，Windows 另取同 SHA 原生 Git/process 证据。                                                                                                                                                            | [Main CI 35510835709](https://github.com/wangbinquan/agent-workflow/actions/runs/35510835709) 待终态；[Windows 35510835760](https://github.com/wangbinquan/agent-workflow/actions/runs/35510835760) success。                 |

## 实际版本与恢复边界

SQLite `0227_rfc363_workspace_preparation_journals.sql` / PG `0003_rfc363_workspace_preparation_journals` 仅新增四表；188 logical tables = 182 active + 6 archive，原 PostgreSQL migration prefix 与历史 row shape 保留。新 journal 不是旧 `cae3e4e` 能消费的格式。

回退新 writer 前必须保留这些表、SC receipt reader、Task preparation reader 和对应补偿 driver，排空已记录 operation。当前只把上述验收源码作为完整恢复实现的支持下限；不声称任一早期“仅建表”提交足以恢复所有 Git/上传窗口。禁止 schema downgrade 或直接回退至 RFC363 前版本后继续处理新 journal。

两份真实进程测试分别覆盖 SC 七个窗口与 Task/upload 八个窗口；后者在 prepare、scratch root、文件 intent、文件写入、完整 receipt 与 Task admission 之间中断。重建后验证原 HEAD、文件/路径、一个 Task 及 admitted artifact 不被 GC 删除。Windows 使用原生 SQLite；Ubuntu 的同一测试使用 SQLite 与 PG，macOS 使用 SQLite。

## 剩余 E1/W5 逐项转交

这些是母项的开放范围，不是本次启动路径允许新增的 fallback。精确当前 ID 见 [residual-debt.json](./residual-debt.json)，canonical 源清单仍是唯一总账。

| 剩余项                                                                                                                                       | owner / remove wave                                                | 退出要求                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `services/task.ts` 私有历史/本地 helper 和既有融合兼容 writer 仍引用 SC composition 机制；Task service 的其他 execution/query 代码未整体搬迁 | Task Execution + Source Control / W4-E1、W5；精确 SC 边沿原账为 W5 | 逐 consumer 迁移，保留历史恢复与现有融合顺序；不得恢复已删除的物理导出。                           |
| DE provenance/detail link、Task catalog/detail query、purpose-specific visibility 的完整 E1 退出                                             | Task Execution，配合 Digital Employee / W4-E1                      | 按母项 E1 的每条 source/detail/visibility oracle 单独验收；本项只保留其现有写入，不领取整个 E1。   |
| repo/cache/group CRUD、refresh 与 Git SCC；SC composition 的剩余内部装配入口                                                                 | Source Control / W5                                                | repo/cache 所有者与依赖图单独收口；当前 backend Git SCC 四文件、repo SCC 三组仍开放。              |
| terminal workspace claim/final stamp、publication 的 opaque WorkspaceRef、Workspace Insight 内容/叙事 artifact                               | Task Execution + Source Control + Workspace Insight / W5           | 按各自 snapshot/claim/receipt/GC 合同切换，不能将 Task reader 的成功视为 WI 或所有工作区能力完成。 |
| shared outputKinds 和 frontend recursive renderer 两组 SCC                                                                                   | 对应 shared/frontend owner / W5                                    | 依赖环单独清零；不在本批 source/control 启动迁移中扩大范围。                                       |

本项不关闭 RFC294、完整 W4-E1/W4-B/W4-D、W5、W6 或 W9。RFC365 仍只交付 T1 兼容性报告与特征测试。
