# RFC-362 技术设计

## 1. 当前基线与已完成工作

路径均相对仓库根目录，源码基线见 proposal。

| 当前 owner / 路径                                                             | 已有能力                                                      | 本 RFC 应用方式                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `modules/task-execution/infrastructure/taskRouteLaunchOperations.ts`          | provider-neutral launch kernel                                | 作为行为 oracle，禁止新增平行启动实现           |
| `modules/task-execution/composition/taskRouteLaunch.ts`                       | 注入 launch participant                                       | 标出后继 provider 接入位置，本 RFC 不切生产绑定 |
| `modules/task-execution/infrastructure/taskRouteOperations.ts`                | 统一 task route operations                                    | 按操作逐项记录实际 consumer 与返回值            |
| `services/task.ts`                                                            | 仍有 `startTaskWithLocalRepo/startTask/startTaskImpl` helpers | 保留当前单一算法，不能记为已经物理删除          |
| `modules/task-execution/infrastructure/nodeRunMintParticipant.ts`             | 唯一 nodeRun mint program                                     | 所有测试装配复用它，不造第二个 INSERT           |
| `modules/source-control/public/participants.ts` 与 workspace/publication 实现 | 已有 scope/workspace/publication seam                         | 只补 E1 所需窄合同；整体 SC 归位留 W5           |
| `platform/persistence/databaseTransaction.ts`                                 | `DatabaseSession.transaction/serializable/snapshotRead`       | 同事务接缝使用现有 async 原语                   |

目标合同采用 RFC-294 design §3.5 的具体类型，结合其更新后的 §4.3 异步规则。本 RFC 不重新设计该总纲的身份、事件或执行链。

## 2. 合同集合与字段账

| 合同                                             | owner / 用途                               | 输入 / 输出                                                                                        |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `PublicRepositorySourceSealPort.seal`            | SC offered，一次解析公共 repository source | 当前 source input → sealed source ref；既有 scheme/URL 判据不变                                    |
| `RepositoryLaunchSnapshotInTx.resolveAuthorized` | SC offered，Task admission 同事务消费      | current authority + sealed/versioned repository source → `Promise<FrozenRepositoryPreparationRef>` |
| `RepositoryPreparationParticipant.prepare`       | SC offered，事务外执行准备                 | task adapter 转换的 SC capability、operation ref、frozen source → workspace preparation outcome    |
| `TaskWorkspaceReadPort`                          | Task required，工作区读取                  | 已绑定 task 的 workspace capability + bounded content query，不另传 workspace identity             |
| `WorkspaceContentParticipant.list/read`          | SC offered，读取同一 workspace snapshot    | authorized snapshot + relative path/page/byte bounds → bounded content                             |

现有 `RepositoryScopeAuthorizationInTx` 是 W4-E2 已交付的 seam，应复用；不可为 E1 重写第二套 scope 查询。
SC 只拥有 repository/workspace preparation facts，Task owns admission、synthetic run、status 与 recovery ownership。
raw source input 只在 seal 的单次调用边界使用；后续保存/准备消费冻结 ref。Task schema/table、ownership token、terminal reason
不成为 SC public 输入。SC 也不直接实现 Task required SPI：Task 的 infrastructure adapter 调用 SC offered participant。

T1 的逐字段账必须覆盖 launch_origin/child inheritance、catalog_visibility、SourceTerminationSnapshot 与 source/effect revision、
Task/DE case ref、runtime launch policy、working branch、upload artifact、clone/baseline 参数与取消 receipt。
新增 contract 不得把 JSON blob 当作遗漏字段的兜底。parent/frame 字段沿用 RFC-354，不新增 seq/generation identity。

## 3. 两条准备 lane

### 3.1 Repository preparation

保持 RFC-287 的 normal task execution ownership 与 `__repo_prep__` wire。snapshot 的 DB 读取在同一
`DatabaseSession` 事务完成；clone、fetch、workspace mutation 和 process 等 effect 在事务外，经当前 record-before-act / claim
机制推进。不得把 repository preparation 迁为独立 daemon worker。

### 3.2 Pre-materialized admission

direct multipart、fusion/call 已物化 artifact 继续在准备完成后建 task；不能为了接口统一改为先建 task 再上传/物化。
接口输入用 lane 判别和 prepared artifact ref 区分，repository lane 不接受 prepared artifact，反向也不自动转换。
知识融合的内部 workspace compensation 保留原 owner。

## 4. 事务、恢复与取消

所有 `...InTx` provider 在同一 live scope 构造，异步方法必须 await，scope 返回后失效；禁止分别开 TE 与 SC 两个事务冒充原子性。
Git/process/FS 不在数据库事务中执行。仅需单条 CAS 的地方不为统一外观额外套事务。

取消/恢复沿用 RFC-303/328 的 source termination 和 execution ownership 规则，以及 RFC-356 的 workspace/process ownership。
测试必须覆盖 prepare 前取消、clone 中取消、workspace 已准备但 admission 失败、重启接管、重复准备与同逻辑 request replay。
保留 `rfc319-task27-de28-manual-retry-and-host-anchor` 的手动重试 initiator 和数字员工人审 host anchor。
本 RFC 不增加新 durable journal schema；若测试 adapter 无法在现有存储语义下实现某个目标合同，记录为后继实现设计决策，
不能通过默认成功的 stub 宣称 AC 完成，也不能静默新增生产 writer。

## 5. 本批落位与后继生产接入

合同归 `source-control/public/{participants,types}` 与 Task application-owned ports，纯值/codec 放对应 domain；
测试 provider/harness 留 tests，仅包装当前唯一实现。尚无生产 consumer 的合同在 canonical 中明确 declared-only，带
consumer=TaskExecution、removeWave=W4-E1 或 W5、后继任务；这是有终点的前置，不能汇总成 active required port。

后继 E1 生产 RFC 依次切：SC source resolution → Task launch/admission adapter → preparation/resume/cancel → workspace query
→ 本域 HTTP/MCP/CLI bindings → root 收缩与 legacy deletion。每刀需同一 production provider，并保持原 service helpers 只有转发层。
`services/task.ts`、scheduler assembly、TaskExecution composition 与 RFC-360/361 共享；schema/mint/freshness 不在本批修改面。
完整 W5 repository/cache/submodule/git SCC 和 WorkspaceInsight cutover 另外处理。

## 6. 验证

复用 `rfc359-w5hn-multipart-launch-provider-parity.test.ts`、`rfc359-w5hn-workflow-route-launch-provider-parity.test.ts`、
`rfc359-w5hn-workgroup-launch-provider-parity.test.ts`、`rfc301-task-launch-origin-architecture.test.ts`、
`rfc319-task27-de28-manual-retry-and-host-anchor.test.ts` 及当前 repository preparation/cancellation suites。
T1 精确列出相关 suite，避免因旧文件名变更漏覆盖。新合同测试使用真实 SQLite/PG、真实临时 Git 仓库和可控 effect faults，
验证输入/receipt、事务回滚及 lane 不混用；不用仅复制接口的 mock 测试代替行为。

本 RFC 只增加合同和测试适配，回滚删除尚未接入的合同即可；不得回退 RFC-359 统一链。
后继生产 cutover 必须另外设计 active task / prepared workspace 的 forward convergence，再取得实施批准。

## 7. 候选对拍与接口细化

具体字段、当前源码、测试能力边界和后继任务见 [implementation-ledger.md](implementation-ledger.md)。
CurrentAuthorityInTx 尚未有已交付类型，本批合同使用已有 RequestAuthority，真实 live-scope 工厂留后继；
SC 返回自身 RepositoryPreparationReceiptRef，由后继 Task adapter 转成 Task receipt，避免 SC 反依赖 Task。
引用 codec 仅负责 `sc:<kind>:v1:<ULID>` 语法；绝不代表对应持久记录已实现。
Workspace reader 保留现有 UTF-8 display text 与列表截断语义，不把测试 wrapper 当新 raw byte API。
