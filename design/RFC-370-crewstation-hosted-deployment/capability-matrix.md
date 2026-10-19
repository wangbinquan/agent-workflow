# RFC-370 托管能力矩阵（v3）

> 2026-10-16 按 [v2 重设计 §9](./redesign-v2-20261014.md) 重写。旧版矩阵描述的恢复 hold / 保留卷 / 检查卷、工作卷捕获重建、事件来源切换与五种恢复动作已随 v3 删除（§9.3）。
> 本表只列实现落点与验收方式；集中验证与实机证据统一记在 [status.md](./status.md)。用户裁定：真实 CLI 只验收 OpenCode。

| 能力                                          | 实现落点                                                                                        | 验收方式                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 控制面、网关身份、PG 配置                     | `bootstrap/crewstation.ts`、identity-access CrewStation 适配器                                  | M0 已验收；新版本发布后回归                    |
| 执行权、写屏障、迁移就绪（V7）                | system-operations `crewStationExecutionAuthority.ts`、写窗口屏障、只增 schema verify            | 蓝绿发布与带迁移的发布                         |
| 根 Agent 执行与模型映射（V1）                 | task-execution `crewstation/execution.ts`、`crewstationAgentInvocation.ts`；`AW_AGENT_PROFILES` | 真实工作流运行 Agent 节点                      |
| 取消、超时、重启接管（V1）                    | detach / 用户取消 / 超时三分；启动恢复按原 ID 交还调度器；后台结算器                            | 运行中取消；运行中重启服务                     |
| 原生材料：指令、技能、MCP、插件、子代理（M2） | `compileHostedNativeMaterial` → CS nativeConfig / 材料对象                                      | 带技能 / MCP / 子代理的 Agent 节点             |
| 子代理不同模型（CS RFC-040）                  | AW 映射 Manifest Agent profile；CS 固定 compute revision                                        | 主 Agent 委派到另一模型的子代理                |
| 卷内命令通道（V2）                            | source-control `workspaceCommands.ts`、`platform/crewstation/subtaskStream.ts`                  | 仓库准备、上传、脚本节点                       |
| 工作区生命周期（V3）                          | `taskWorkspace.ts`、`workspaceLifecycle.ts`、`volumeActivity.ts`                                | 任务结束后父任务暂停；续跑时恢复；删除时关闭   |
| Git 包装器、隔离、合并、多仓（V3）            | 卷内原生 owner；粗粒度命令                                                                      | git wrapper 工作流；fan-out 隔离合入           |
| 发布与候选推送（V3，C13）                     | `publicationTransport.ts`；部署级 Git 凭据                                                      | commit-and-push 节点推送到本机 GitLab          |
| 人工门、续跑、节点重试                        | 原业务命令（托管与单机一致，V4）                                                                | 评审 / 反问通过后继续；失败节点重试            |
| 平台恢复动作（V4）                            | task-execution `recoveryConsumer.ts`；Manifest 声明 `resume-task` / `rebuild-workspace`         | CS 恢复页对父任务发起动作                      |
| 内容对象与保留（V6）                          | system-operations `objectPublications.ts`；各 owner sweep                                       | 端口产物下载、任务删除后释放                   |
| 数据库备份 / 恢复（V5，CS RFC-042）           | `crewstation/databaseBackups.ts`、`databaseRestoreInstallation.ts`                              | 设置页手工备份 → CS 独立空库恢复 → 校验 → 切换 |
| 事件入站（V8）                                | integration `crewstation/eventInbox.ts`、`eventContract.ts`                                     | CS 事件投递到规则 / Reaction                   |
| 系统 Agent、诊断、意图（M2）                  | `crewstationSystemAgentRunFamily.ts`、`crewstationMcpDiagnostics.ts`                            | MCP 诊断、运行时冒烟                           |
| API 自动化（M3）                              | CS 用户会话 + 同一 AW 用户的 PAT                                                                | 外部客户端调用 AW API                          |
| 平台冻结期间排空写者（§10 V14）               | source-control `workspaceLifecycle.ts` 的迁移排空、system-operations 冻结授权                   | CS RFC-042 恢复切换越过 `freezing`             |
| 工作树文件下载（§10 V15）                     | `routes/worktree-files.ts` 经 Source Control 工作区内容端口                                     | 文件页下载、端口产物下载回退                   |
| 代码评审读取（§10 V16）                       | source-control `RepositoryRevisionContent` / `code-review` 命令、code-capability 评审产物存储   | 任务「变更」页：结构化 diff、叙述、文件、符号  |
| 仓库选择器与登记（§10 V17）                   | source-control `RepositoryMirrors` / `repository-remote` 命令                                   | 向导分支 / 文件选择器、批量导入、刷新          |
| 开发任务卷内树操作（§10 V18）                 | development-automation `repository-facts-scan`、`seed-tree-*`、动作工作区读端口                 | 开发任务：仓库事实、上传种子、动作工作区       |
| 程序工具（§10 V19）                           | task-execution `ProgramToolSource`、`execution-contract-fixture` 命令                           | 数字员工程序工具校验 / 发布、Reaction 执行     |
| 记忆 → 技能融合（§10 V20）                    | resource-catalog `SkillTreeVersionOperations`、source-control `fusion-workspace` 命令           | 发起融合 → 提案 → 批准为新技能版本             |

本表是验收清单，不改变 RFC-370 的完整交付标准。原正式 AW 始终保留；不通过停止或删除它来做破坏性验收。
