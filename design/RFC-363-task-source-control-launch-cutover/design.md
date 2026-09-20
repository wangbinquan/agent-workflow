# RFC-363 技术设计

状态：Done（2026-09-20）。实现与原设计的对应、兼容边界和最终测试见 [acceptance.md](./acceptance.md)。

## 1. 当前链路和目标 owner

以 [RFC-362 implementation-ledger](../RFC-362-task-source-control-launch-contracts/implementation-ledger.md) 为完整入口/字段基线。本次 [source-baseline.json](./source-baseline.json) 钉住已完成 RFC-360 后的源码，不能沿用 provider 合一前调用图。

| 当前事实                                                           | 目标落位与约束                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `taskRouteLaunchOperations` 共用 Workflow/Agent/Workgroup kernel   | `task-execution/application/launch` 编排；现 kernel 保持唯一 writer                |
| `taskRouteWorkspaceParticipant` + `services/task.ts` 准备          | Task adapter 消费 SC public offered seam；物理 materializer 收入 SC infrastructure |
| `repositoryPreparationStep` / retry command / auto resume          | Task 继续持有 claim、终态、`__repo_prep__`；调用 SC effect participant             |
| `cached_repos` 没有 content revision；`repo_groups.version` 已存在 | SC 持有具名源事实快照；group version 只锁 layout，不冒充 Git commit                |
| `worktreeFiles` 先截断列表、按 UTF-8 文本读取                      | SC 先排序后分页、按字节读取；Task HTTP adapter 保留旧展示投影                      |

Application 只依赖自身 ports 与跨域 exact public；Git、路径、配置、process 留 infrastructure。Root 注入同一实例，禁止 Task→SC composition 或 SC→Task internal import。保留未在本次迁移的 repo/cache 公共机制并逐条记债，不能新增横向万能 service。

## 2. 合同与字段

逐字消费 RFC-362 `repositoryLaunch.ts` / `workspaceLaunch.ts` 中已有合同；不是再造一套近义 SPI：

| 合同                                             | 生产语义                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `PublicRepositorySourceSealPort.seal`            | 在现有幂等命令 scope 创建 durable source，原 raw URL 只进 SC 内部持久化；返回 sealed ref |
| `RepositoryLaunchSnapshotInTx.resolveAuthorized` | 同一 Task live tx 重验当前可用性，冻结 repository/group/sealed source；返回 frozen ref   |
| `RepositoryPreparationParticipant.prepare`       | effect capability + operation ref + frozen source，重放返回已落 SC receipt；不写 Task    |
| `WorkspaceContentParticipant.list/read`          | 已绑定 snapshot + 相对路径/分页/字节预算；不接 Task row、绝对根路径                      |
| `TaskWorkspaceReadPort.list/read`                | Task 先按现权限与 workspace binding 铸 capability，再由 adapter 委托 SC                  |

`RepositoryLaunchSource` 三分支、`TaskWorkspaceLaunchLane` 两分支保持闭合。`sc:<kind>:v1:<ULID>` 只是 ref codec；必须查 durable record，不能以 decode 成功代替存在。所有 factory 在所属 live tx 内创建，结束后不可继续使用。

现 HTTP 只提交 repository/group ID 或 URL 的入口不新增必填 revision：application 在当前 admission scope 解析现事实并形成内部 versioned ref，随后在同一 live tx 消费；不能要求旧客户端升级后才能启动。effect capability 由 Task-owned attempt scope 绑定现 cancellation/ownership fence，SC adapter 据此使用既有 abort 机制，不把 AbortController、Task row 或任意 callback 加入 public DTO。

Task 字段分四组锁定：① owner/initiator、`launch_origin`、source IDs/trigger；② launchRevision、effectRevision、termination snapshot/fence；③ workflow/agent/workgroup/resource/runtime policy 与首次 NodeRun 冻结；④ parent/frame、DE case/action provenance、catalog visibility、working branch/upload。完整 54 项继承 RFC-362 账本，逐项记录 writer、consumer、来源和原缺省值；不得折叠成任意 metadata JSON。SC receipt 经 Task adapter 投影到现 task repos/workspace 记录。

## 3. 持久化与 revision 定义

以下四表已由 SQLite 0227 / PG 0003 的 additive migration 实施，两库共用映射；历史 schema prefix 与旧行 shape 保留。

| 记录 / owner                         | 最小字段与唯一性                                                                                                                                     | 生存期                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `sc_repository_sources` / SC         | source ref、kind、格式版本、规范事实 digest、SC-private URL/credential handle、repo 或 group fact；sealed command key 唯一                           | 未被引用的 prepared 前记录可回收；已被 plan 引用不能先删    |
| `sc_repository_snapshots` / SC       | frozen ref、source ref、content revision、group root version、完整展开 layout 和各成员配置                                                           | 不可变；Task 终态不立即删除恢复证据                         |
| `sc_preparation_operations` / SC     | operation ref、snapshot ref、attempt、状态、已解析 commit 集、workspace binding、物理 receipt、failure/cleanup receipt                               | 同 operation 重放；最终绑定和 cleanup 均持久化              |
| `task_workspace_preparations` / Task | plan/artifact ref、lane、来源与 request digest、Task admission key、SC operation ref、当前 Task ownership fence、prepared/admitted/compensating 状态 | 唯一 admission key；准备失败可保留补偿记录，不能写占位 Task |

repository `revision` 定义为版本化 canonical **准备源配置事实**的 SHA-256：仓库身份、规范 source 标识、默认分支配置和影响 materialization 的选项；不含 localPath、lastFetchedAt、lastAutoRefreshAt、探测遥测或 secret 明文。`base` 仍是独立 launch 输入。首版不把这个 revision 称为 Git tree revision。SC 内部保留不可变事实副本，后续 credential 解析按已有规则进行。

group 在 admission tx 校验 root 的 version，展开嵌套 group，记录每个 group 的 version、每个 mount 的路径/ref/subdir/readonly 与 repository revision。展开读取须处于同一一致性 snapshot；组编辑后新任务消费新事实，已有任务不再回读 live group。依当前校验拒绝环/冲突，不改变合法 group 布局能力。

**分支移动语义**：branch/tag/默认分支的 Git 解析仍在当前 prepare 阶段执行。解析前可按原重试策略 fetch；首次取得一组具体 commit 后先持久化该组和操作阶段，再开始 worktree 物化。崩溃重试同 operation 使用已记 commits，不重新解析到另一个 branch head。手动新 attempt 是否重新 fetch/解析必须按旧 retry oracle 决定，记录新 operation 关联，不冒用旧成功 receipt。

任务 admission 没有第二个 scheduler lease。Task journal 上的 fence 复用当前 Task owner/launch/effect revision；pre-materialized 阶段尚无 Task，沿用请求幂等与当前 preparation lease。SC operation 的状态仅描述物理效果，不能自主推进 Task。

## 4. 两条生产链

### 4.1 Repository preparation lane

1. 按入口当前时序做解析与 admission；同 tx 创建 frozen source + Task-owned plan，并由唯一 kernel 写现有 Task / synthetic preparation run。
2. 提交后 normal Task ownership 调用 `repositoryPreparationStep`，用 plan 获取同一 SC operation；不注册新 daemon worker。
3. SC 在事务外执行 Git/FS，阶段性落 durable receipt；Task 在自己的事务校验当前 fence 后接受结果并推进原执行链。
4. Cancel/retry/auto resume 都走现有 Task command。SC cancel/cleanup 回执描述物理事实，Task 判定当前终态与是否允许继续。

以上只适用于目前允许 deferred preparation 的入口；direct Agent/Workgroup 等同步准备路径保持原顺序。不得借统一 port 把所有入口改成建 Task 后准备。

### 4.2 Pre-materialized lane

1. multipart 按当前顺序 buffer/validate → prepare → applyUploads，先写 Task-owned preparation journal，物理效果在事务外。
2. 完成后产生 opaque artifact；admission tx 消费 artifact，唯一 kernel 建 Task、绑定工作区和来源；提交成功后执行现有 lease commit / drive。
3. crash-after-prepare-before-admit 从 journal 识别可复用 artifact；admission key 查到同一 Task 则只补齐 receipt。不能再新建 Task，也不能在失败清理时删除已绑定工作区。
4. call/fusion/sourceTaskId/DE internal workspace 复用各自原准备与补偿算法；适配为本 lane 时逐入口证明顺序不变。KE 只持自己 artifact compensation，不能持有 Task writer。

## 5. 失败、恢复与回滚

| 崩溃窗口                      | 恢复动作                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| snapshot / Task tx 回滚       | 同 tx 记录全部回滚；事务中没有 Git/FS 副作用                                              |
| Git 已完成、SC receipt 未提交 | 按确定性 operation 工作区 identity 验证现有物理结果，补记 receipt；不能重复创建不同工作区 |
| SC receipt 已存、Task 未接受  | 重返同 receipt；Task current fence 决定接受或补偿                                         |
| 上传完成、Task 尚不存在       | journal 驱动请求重放或既有回收机制补偿，禁止新后台 worker                                 |
| 取消与成功同时发生            | Task 终态/fence CAS 唯一裁决；陈旧成功不能 revive Task；保留 cleanup receipt              |
| task 已绑定、清理重放         | 先验证 binding，不能按旧失败状态删除活动工作区                                            |

不启用有副作用的双跑。分阶段 expand → 新 reader/恢复兼容 → 单入口 writer cutover → consumer-zero → 删除旧 facade。切换前无 journal 的旧任务继续读现有 task snapshot；遇到旧对象首次由新实现处理时建立有来源的兼容映射，不伪造旧 commit/revision。

回滚下限是**已能读取新 journal 的兼容版本**。新格式写入后不能直接回退到 `cae3e4e` 并假称可恢复；保留表、ref 和新恢复 reader，暂停新 writer 后排空已有 operation 再退入口。Task 状态/worker 单写规则不变。

## 6. Workspace reader

SC 内部使用现有过滤/路径语义，全量枚举当前目录、沿用 comparator、增加同名比较的稳定 tie-break，再按 offset/maxEntries 切页，不能先按旧上限截断再生成假 nextOffset。offset 只保证一次目录观测的分页；目录并发变化沿用现有 best-effort，不能声称跨请求 immutable FS snapshot。

read 按真实字节返回 base64、size/offset/nextOffset/oversized，覆盖 UTF-8 多字节边界和二进制。Task HTTP adapter 的旧入口仍保持超大文件返回空 content、原 UTF-8 display 与旧目录上限/truncated；内部新能力不改变现 URL/响应。旧 workspace binding 解析由 Task adapter 提供，SC 不查询 Task DB。

## 7. 验证、账本与退出

沿用 `rfc362-launch-contracts`、`rfc359-w5hn-{multipart,workflow-route,agent,workgroup}-launch-provider-parity`、`rfc287-t13-deferred-prep`、`rfc287-t13-git-abort`、`rfc303-worktree-abort-cleanup`、`rfc303-runtime-ownership`、`rfc319-task27-de28-manual-retry-and-host-anchor`、`rfc359-w8-child-launch-conformance`、`call-graph-worktree`、`fusion-engine`、`rfc349-fusion-route-provider`、`rfc353-fusion-inbound`、`upload-apply-to-worktree`、`runtime-freeze` 与 worktree-files suites。

新增真实 SQLite/PG transaction、跨进程重启、真实 Git/group/fetch、字节/分页、取消窗口用例，禁止只用进程内 Map 模拟恢复。当前 repository source revision 无存量列，必须验证 expand/backfill/旧任务路径；性能至少对拍 admission tx 无外部 I/O、重复请求无额外 clone。

实现后记录 public symbol/field/provider/consumer、required port、owned import/facade/root 精确清单；生成 canonical 只在生产 owner/seam 变更时运行。RFC-362 declared debt 只按真实生产接入注销；剩余 Git SCC/cache/repository 管理和 Task detail/catalog 项逐条记 owner/removeWave，不凭数字下降领取整波完成。
