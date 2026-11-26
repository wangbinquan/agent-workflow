# 模块对外合同与用例防护

本轮基于 2026-11-25 的主树，对 RFC-294 划分的 18 个正式后端模块、仍保留的
`code-capability` 兼容模块，以及前端的数据消费与公共集合组件进行功能用例审视。
新增文件采用 `module-contract-*` 命名，沿用现有 Bun / Vitest 自动发现入口。
不新增模块注册表、不复制公开 API 清单。首次补测的生产修正是旧工作项历史分页的续页条件：按已有的
`createdAt + id` 游标规格处理相同时间戳，避免漏行；没有更改游标编码、DTO、页大小或历史归档格式。后续 RFC-602 的四项查询优化与新增证据单列如下。

## 判定口径

模块目录存在、公开类型可编译、路由登记成功，只能证明结构和接线的一部分。
行为证据必须实际调用生产的公开函数、装配返回的 command / query / participant，或真实渲染其前端消费者。
替身只放在外部效果和 required port；断言落在返回值、持久化状态、对外调用、失败语义和调用预算上。

| 维度 | 本轮使用的判据                                                                         |
| ---- | -------------------------------------------------------------------------------------- |
| 功能 | 输入通过真实业务入口后产生约定结果；已有完整工作流、CRUD、恢复和跨模块事务用例继续复用 |
| 规格 | 字段、版本、排序、筛选、游标、错误码、幂等结果及事务所有权有可执行断言                 |
| 边界 | 空集合、缺失项、重复项、相同排序值、精确时间或版本界限、满批次与尾批次                 |
| 异常 | provider / 存储 / 后置效果失败时不返回伪成功；检查必要的回滚、保留结果与后续重试       |
| 性能 | 确定性的查询次数、单批行数、批量而非逐项读取、并行扇出、维护续片与停止预算             |

性能用例不以开发机的一次耗时当作 SLA。固定规模的调用预算能防止 N+1 和无界扫描，不能证明
生产环境的吞吐、P95/P99 延迟、长时间内存占用或真实 runtime 的承载上限。
已有行为证据与本轮新增证据分别列出；源文本检查不计作功能覆盖，未重跑的旧用例不计作本轮通过。

## 模块证据

下表的旧文件均位于 `packages/backend/tests/`。旧证据是本轮读过的行为断言，不代表本轮重新执行了该文件。
新增文件链接对应本轮实际补充；验证结果见本文末尾。

### 执行、协作与运行支撑

| 模块 / 主要合同                                                        | 已有行为证据                                                                                                                                                                                                                                                                                                                                                                                                                         | 本轮补充                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution：启动、恢复/重试、取消、生命周期参与者、历史/输出、修复 | `task-start-pre-worktree.test.ts` 验证预建工作区与启动输入；`resume-task-idempotent.test.ts` 验证恢复状态、重复恢复及真实 stash；`review-cancel-concurrency.test.ts` 验证父子取消；`rfc359-w16-task-lifecycle-write-sequence.test.ts` 验证 CAS、事件与同行写入共同回滚；`api-tasks-repair.test.ts` 验证修复 HTTP / 持久化 / 事件；`process-node-concurrency.test.ts` 与 `scheduler-boundary-fanout-concurrency.test.ts` 验证准入上限 | [历史与 frame 合同](../packages/backend/tests/module-contract-task-execution.test.ts)：组合筛选、seq 边界、顺序不变；128 层环每祖先只读一次；缺祖先停止，读取失败原样传播                                           |
| collaboration：review、clarify、feedback、已提交事件                   | `clarify-review-combination-scenarios.test.ts` 验证批准、迭代、并行分支；`rfc326-review-decision-transaction.test.ts` 验证多处写入回滚与提交后失败；`rfc395-clarify-target-concurrency.test.ts` 验证草稿、部分/最终封存及变更版本；`rfc372-async-followup.test.ts` 验证生成、取消、重复请求与 HTTP 202/200；`task-feedback-service.test.ts` / `routes-task-feedback.test.ts` 验证留言与蒸馏关联                                      | [feedback 合同](../packages/backend/tests/module-contract-collaboration.test.ts)：入队抛错仍保留已写留言且不隐式重试；25 条数据下 limit 3 只查询并返回 3 条，默认 20、零上限与未知任务                              |
| source-control：仓库目录/镜像、组、工作区命令、版本内容、维护          | `rfc248-repo-group-service.test.ts` 验证组嵌套、冲突、OCC 与级联删除；`rfc359-w20-repository-search-conformance.test.ts` 验证实际数据库搜索；`rfc370-v3-volume-repository-mirrors.test.ts` 验证真实 Git 冷/热复用；`rfc370-m1-workspace-commands.test.ts` 验证重放、取消和失败；`rfc370-v16-hosted-revision-content.test.ts` 验证批量内容与旧版本错误                                                                                | [组装配合同](../packages/backend/tests/module-contract-source-control.test.ts)：嵌套组与待导入 URL 的预览不产生导入/写入；RFC-602 后预览恰好 3 次可达图 SELECT；过期替换保留胜出版本的元数据和布局                  |
| runtime-management：profile、默认选择、状态/模型、探测、执行快照       | `runtime-registry.test.ts` 验证 CRUD、禁用/启用、数值范围与重启不复活禁用项；`rfc360-runtime-management-application.test.ts` 验证异步配置、失败回滚、探测结果与 disabled 过滤；`rfc370-task-runtime-bindings.test.ts` 验证冻结的运行时选择跨恢复保留                                                                                                                                                                                 | [状态查询合同](../packages/backend/tests/module-contract-runtime-management.test.ts)：普通列表不启动探测；一份配置、每启用 profile 一次并行探测、明确 timeout；倒序完成仍按登记顺序返回                             |
| run-observability：调用生命周期、计价、聚合、分页、HTTP 参数           | `rfc371-v2-observation-store.test.ts` 验证 accept/usage/finish/repair 与定价版本；`rfc371-v2-observation-queries.test.ts` 验证批次 500 与结果上限；`rfc371-v2-observation-http.test.ts` 验证时间窗、游标与缺失对象；`rfc371-v2-observation-domain.test.ts` 验证整数计价和连续时间桶                                                                                                                                                  | [观测合同](../packages/backend/tests/module-contract-run-observability.test.ts)：左闭右开时间窗、筛选与汇总口径；同时提交的结束/迟到更新不覆盖首个终态；63 条调用的页面最多 3 次 SELECT、50 条返回、51 行 lookahead |
| workspace-insight：结构 diff、文件、symbols、索引、调用图、叙述        | `rfc370-v16-code-review-services.test.ts` 验证批读与终态缓存；`task-file-content.test.ts` 验证真实文件/Git、重命名与多仓；`rfc258-file-symbols.test.ts` / `rfc258-code-intel.test.ts` 验证 parser、单次索引与 LRU；`call-graph-worktree.test.ts` 验证磁盘跨文件调用；`change-narrative.test.ts` 验证单次生成、失败与删除中的结果处理                                                                                                 | [内容装配合同](../packages/backend/tests/module-contract-workspace-insight.test.ts)：工作区移动后重新定位；每请求一次读取、传递字节预算和仓库自己的 base；missing / binary / oversized 保持约定结果与错误码         |

首次补测时，仓库组的 5 次 SELECT 只限制数据库往返，整组图快照仍可能很大；该读取范围由后续 RFC-602 收窄，见下方。
观测页的返回行数预算仍不证明 SQL 执行计划或扫描行数的复杂度，不能据此宣称大型数据集已经过容量验证。

Task 启动和恢复还核对了 `rfc294-task-execution-compat-oracles.test.ts` 的实际 `runTask`、DB、Git 与受控子进程断言：
一次派发、resume/retry 同拍仅一次胜出、daemon shutdown → interrupted → 新 generation 恢复 → done。
当前没有独立的 Task pause command；等待/暂停由人机门和 interruption 语义承担。新增 Task 测试还通过真实 DB 验证 stdout
达到 UTF-8 字节预算后不读取外部归档，不再用“归档目录恰好不存在”间接推断零读取。

### 员工、自动化、事件与兼容历史

| 模块 / 主要合同                                                                  | 已有行为证据                                                                                                                                                                                                                                                                                                                                                                                                     | 本轮补充                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| digital-employee：作者发布、精确修订、Case、reaction、上传/维护                  | `rfc310-digital-employee-authoring.test.ts` 验证类型→岗位→工具的发布闭环与不可变修订；`rfc310-employee-case-runtime.test.ts` 验证结算一次与坏 Case 不饿死其他 Case；`rfc368-reaction-admission.test.ts` / `rfc368-reaction-dispatch.test.ts` / `rfc368-reaction-settlement.test.ts` 验证事务、重放、有限重试及终止；`rfc310-digital-employee-system-mock-e2e.test.ts` 等既有完整旅程贯通 Issue→事件→MR→修复→合并 | [员工合同](../packages/backend/tests/module-contract-digital-employee.test.ts)：25 个并发 load 共用完整快照；500 轮精确修订读不再访问模板；兼容迁移保留精确 Agent/work item；1000/1000/7 续片及异常重试                              |
| development-automation：Mission admission、reconcile/drive、恢复、查询、evidence | `rfc310-pr2-admission.test.ts` 验证 body/files、认领、回滚、选择和取消；`rfc310-pr2-reconciler.test.ts` / `rfc310-mission-driver.test.ts` 验证驱动与停止；`rfc310-pr2-recovery.test.ts` 验证 epoch、wake 和 settle；`rfc311-mission-page.test.ts` 验证 ties 与 64 组筛选；`rfc310-pr6-evidence-read.test.ts` 验证范围、tail、clamp 与 truncation                                                                 | [自动化合同](../packages/backend/tests/module-contract-development-automation.test.ts)：1000/17/0 上传清理续片；retention 四计数不丢；坏 cursor 零调用；真实完整装配遇 missing Mission 一步停止，空 wake sweep 为零                  |
| event-center：目录、观察/订阅/消费、observer、作者、response、durable delivery   | `rfc359-w12-event-center-composition.test.ts` 验证重装配、独立投递和晚订阅；`rfc310-event-center.test.ts` 验证观察轮转、不丢 nudge、零订阅停止、作者脚本与自动化失败隔离；`rfc341-committed-event-store.test.ts` 验证原子追加、FIFO、有限 dead-letter 与重试                                                                                                                                                     | [事件合同](../packages/backend/tests/module-contract-event-center.test.ts)：23 事件以 5/5/5/5/3/0 排空；重复 accept 幂等；重装配后 pending/accepted/event 页一致；错误精确引用不落部分事实；失败不损坏已有投递                       |
| integration：webhook 构造/分发、交付持久化/诊断、恢复/保留                       | `rfc257-webhook-dispatch.test.ts` 验证 workflow/agent payload、fan-out、supersede、串行、launch 错误与坏行隔离；`rfc359-w4-d2-adapters.test.ts` 验证去重、恢复及两阶段 GC；`rfc261-webhook-delivery-pagination.test.ts` 验证 limit 200、120 个同时间戳分页和组合过滤                                                                                                                                             | [交付合同](../packages/backend/tests/module-contract-integration.test.ts)：续片保持初始 cutoff，时钟前进也不扩大本轮清理；每片最多改 1 行；进行中/精确边界保留；恢复幂等；坏 batch/cursor 零修改，存储失败不伪报完成                 |
| execution-contract：注册/guide、输入输出 envelope、Agent/Program 校验            | `execution-contract-platform.test.ts` 验证各 guide、矛盾注册、输入投影、缺项/额外项和跨 round；`rfc361-execution-contract-providers.test.ts` 验证 pairing、validator receipt、机制失败、参数、清理、nonzero exit 与超时                                                                                                                                                                                          | [执行规格合同](../packages/backend/tests/module-contract-execution-contract.test.ts)：150 个候选按精确修订去重至 3 次 inspect，各失败回执独立；空批零 IO；缺/矛盾注册、依赖错误和下一请求恢复；失败程序回执仅执行一次并保留原 check  |
| code-capability：旧 matrix/metrics/template upstream、只读历史投影               | `rfc359-w8-code-capability-read-conformance.test.ts` 验证 matrix 批读及 metrics 四桶/窗口；`rfc304-template-upstream.test.ts` 验证 current/快进/冲突/删除/digest；`rfc349-code-template-upstream-postgresql-adapter.test.ts` 验证真实 PG 同事务决定与写入                                                                                                                                                        | [历史读取合同](../packages/backend/tests/module-contract-code-capability.test.ts)：105 项按 100+5 翻页、25 轮仅返 20 并报告隐藏数、205 attempts 限 200、stage 顺序、项目/关联链/失败诊断；非法 limit 预先拒绝，reader 异常不伪装空页 |

首次补测时，`code-capability` 的 `history.rows(table)` 仍可能加载全表；后续 RFC-602 将正常查询迁至持久派生索引，见下方。
自动化 retention 的单次命令/计数断言也不证明其内部已经按数据库行数分片；事件消费的批量返回上限不证明索引执行计划。
这些既有实现限制与新测试的实际证明范围分开记录。

本轮边界审视发现并修复了一个具体合同缺陷：`codeMatrixQuery.ts` 定义的游标为时间戳与 ID，但历史 adapter 原来只比较时间戳。
三条同时间戳记录 `c/b/a`、页大小 2 时，第一页为 `c/b`，第二页会漏掉 `a`。当前 adapter 按降序复合键续页，
新增真实历史包回归验证不同时间戳和同时间戳穿插时完整且不重复。旧 epoch fixture/oracle 保持历史原貌。
这是 `CLAUDE.md` 允许直接提交的局部 bug 修复，未借补测引入新的查询体系。

### 资源、知识、用户与系统

| 模块 / 主要合同                                                      | 已有行为证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 本轮补充                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resource-catalog：六类资源、摘要、内容/版本、资源包提交与恢复        | `agents.test.ts`、`skills.test.ts`、`mcp-service.test.ts`、`plugins-http.test.ts`、`workflows.test.ts`、`rfc164-workgroups.test.ts` 分别验证真实 CRUD、缺失/冲突、版本和引用；`rfc359-w29-mcp-application-lifecycle.test.ts` 验证去重、失败重试和停止；`rfc359-w12-resource-package-commit-provider.test.ts` 验证多类资源包创建/覆盖/重放；`rfc359-w8-resource-package-maintenance-conformance.test.ts` 验证回滚、补偿与已提交内容继续完成                                          | [六类摘要合同](../packages/backend/tests/module-contract-resource-catalog.test.ts)：跨 kind 分页不重不漏、revision 判别值、详情回读；每类一次有界查询、重复 kinds 不重复读；literal 搜索、空 kinds、非法 limit/cursor 零查询                          |
| memory：手工/候选 CRUD、审批与替代、注入、蒸馏、技能成员关系         | `memory-service.test.ts` 验证创建、批准、替代、拒绝、归档、删除与链；`rfc352-memory-list-page-query.test.ts` 验证分页/全量等价；`memory-inject.test.ts` 验证去重、裁剪和各 scope 预算；`memory-distiller.test.ts` 验证蒸馏→批准→注入及执行失败；`rfc367-distill-followup-loop.test.ts` 验证整链预算、重试上限和部分有效候选                                                                                                                                                         | [catalog 合同](../packages/backend/tests/module-contract-memory.test.ts)：45 行稀疏过滤以 10 次查询 × 4 行停止且游标可继续；摘要字段与稳定排序；坏游标零查询；写后失败回滚全部内容与版本，显式重试成功                                                |
| knowledge-evolution：fusion、版本发布、恢复协调                      | `fusion-engine.test.ts` 验证状态、审批、冲突、重复批准、取消及提交前后恢复；`rfc370-v20-fusion-orchestration.test.ts` 验证数据库快照、候选树、版本发布失败恢复、重跑和工作区释放                                                                                                                                                                                                                                                                                                    | [真实跨模块参与者](../packages/backend/tests/module-contract-knowledge-evolution.test.ts)：KE 公开 participant 接真实 memory participant；只处理严格较新版本，清空 provenance，重复为空；调用方事务失败完整回滚；64 条成员一次 UPDATE，确定性返回顺序 |
| intent：session、草稿/slot/commit、排队续跑、apply/recovery、scratch | `rfc234-intent-routes.test.ts` 验证创建→草稿→commit→资源、迭代/排队及分页；`rfc355-intent-apply-changeset-validation.test.ts` 验证 changeset 错误；`rfc343-intent-apply-correctness.test.ts` 验证发布、队列释放、损坏 journal 和一次尾部发布；`rfc370-intent-queued-resumption.test.ts` 验证通知去重、停止、ACK 与失败                                                                                                                                                              | [maintenance 合同](../packages/backend/tests/module-contract-intent.test.ts)：真实持久化恢复仅处理启动时捕获的 turn；保留完整 capture；scratch 精确 cutoff、运行中及删除失败不清理；两次批量读/一次标记更新；inventory 错误不产生部分清理             |
| identity-access：本轮审视的用户资料与目录功能                        | `rfc349-identity-access-promise-contract.test.ts` 验证 Promise 与资料写入；`users-service.test.ts` 验证用户名冲突和目录；`auth-routes.test.ts` 验证用户编辑自身 profile/Git identity；`rfc359-w7-catalog-composition-roots.test.ts` 验证双库装配                                                                                                                                                                                                                                    | [资料合同](../packages/backend/tests/module-contract-identity-access.test.ts)：Unicode 名称和 Git identity 投影一致；同值保存零写入；40 用户的重复/缺失 ID 查找一次批读、按首次出现排序；空查找零查询；email 冲突保留原资料                           |
| system-operations：配置、备份/恢复、资产、迁移、daemon 状态          | `rfc370-application-configuration-binding.test.ts` 验证持久化 receiver、listener ACK 与错误；`rfc359-w8-system-operations-recovery-conformance.test.ts` 验证恢复暂存/取消/失败重试；`rfc359-w9-system-operations-application-assets-conformance.test.ts` 验证规范导出与字节上限；`rfc370-backup-scheduler-drain.test.ts` 验证停止等待；`rfc349-migration-long-transaction-faults.test.ts` 验证迁移中断、数量不符和超时；`rfc370-daemon-runtime-query-bindings.test.ts` 验证状态读取 | [配置装配合同](../packages/backend/tests/module-contract-system-operations.test.ts)：listener 失败隔离；相同描述 key 的实例不串通知；load/preview/apply 各一次；已提交后 reconcile 失败保留配置、停止后续热应用；retention 相等可保存，大于在写前拒绝 |

首次补测时，资源目录的 `getVisibleSummary` 仍逐页寻找目标；RFC-602 已改为一次精确查询，并补命中/缺失时最多一行的真实 SQL 预算。
资源包、融合、蒸馏、备份与迁移已有独立完整流程套件；新增的摘要/参与者/配置测试不能替代这些流程的执行结果。

### task-catalog

对外入口是 `composeTaskCatalog().queries` 和 `mountTaskCatalogRoutes`；RFC-590 已将其内部查询类型收回模块内，
因此不能用“是否有 public 目录”决定该模块是否需要合同测试。

- 已有：`rfc310-task-catalog.test.ts` 验证来源注册与统一页、Case 状态转换；
  `rfc310-task-catalog-case-state.test.ts` 验证 waiting / blocked 与终态筛选；
  `rfc310-task-catalog-internal-execution.test.ts` 验证内部执行树不进入公开目录；
  `task-catalog-launch-origin-filter.test.ts` 在实际来源查询中验证 origin 分桶与穷尽性。
- 新增：[module-contract-task-catalog.test.ts](../packages/backend/tests/module-contract-task-catalog.test.ts)。
  锁住全量筛选透传、来源身份、统一 DTO 严格形状、按 branch 时间和 id 排序、facet 合并、独立游标续读、
  耗尽来源不重读、层级支持边界、provider 异常与后续成功请求。
- HTTP 规格：实际挂载路由并请求，验证 `type → sourceId`、`parent_id → parentItemId`、中文与 `+` 编码、
  version 1 JSON 文档、422 与稳定错误码。不是只读取路由源文件的检查。
- 性能：发现来源不读 provider；所有独立来源在首个结果完成前均已启动；每来源每页恰好一次读取；
  1 / 100 行两种规模下调用次数不随行数增加。`limit` 仍由各来源解释，不虚构全局分页上限。

### 前端公共集合消费者

已有 `resource-list-shell.test.tsx`、`resource-split-page.test.tsx` 验证加载/删除/刷新、搜索、空态、失败保留旧卡片及并行 busy 状态；
`pagination.test.tsx` 验证首页/末页、跳页和非法输入；`virtual-list.test.tsx` 验证 1,000 项下 DOM 只呈现 viewport + overscan、
near-end 与短列表续页；`empty-state.test.tsx`、`loading-state.test.tsx` 验证真实渲染语义。

新增 [公共集合合同](../packages/frontend/tests/module-contract-ui-collections.test.tsx)，通过真实 `renderHook` 与 `QueryClient` 验证：

- disabled 和终页不发多余请求；下一页失败保留已有结果，显式重试使用原游标。
- 筛选变更保留旧行过渡，新筛选从第一页开始；旧请求被取消，迟到结果不能覆盖当前筛选。
- `maxPages=2` 实际限制保留页数，淘汰旧页后游标仍正确。
- 删除失败保留列表且不刷新；使用编码后的稳定 id 重试成功，仅刷新一次。

### 前端任务数据消费者

新增 [数据消费合同](../packages/frontend/tests/module-contract-data-consumers.test.tsx)，使用真实 hook、API serializer、共享 DTO parser：

- 50+1 分页，特殊字符筛选和 opaque cursor 正确编码；末页不发第三次请求。
- 第二页 schemaVersion 错误保留第一页；重试使用同一游标。
- 后端真实 `{ok:false,code,message,details}` 错误封套传至调用方，显式重试后清除错误。
- disabled 零请求，两个在途等值查询共用请求，不同 source 分开缓存；最后消费者卸载会取消请求。
- 列表和详情共享同一 parent 的子任务查询，仅失效该 parent 时只追加一次请求。

现有 `task-operations-sync.test.tsx` 和 `rfc152-use-ws-invalidation.test.tsx` 已覆盖 WS 合并、重连、缓存保留和 socket 释放。
业务页的实际消费还由 `code-missions-page.test.tsx`、`code-mission-detail-ux.test.tsx`、前端
`rfc261-webhook-delivery-pagination.test.tsx`、`execution-contract-guide-panel.test.tsx` 等承担。
首次补测锁定的是固定 500 条窗口下的共享请求语义；后续 RFC-602 改为完整分页链，见下方。

### 前端事件中心

此前 `rfc310-event-center-ui-contract.test.ts` 与 `rfc341-event-center-committed-deliveries.test.ts` 主要约束源码，
本轮新增 [事件页行为合同](../packages/frontend/tests/module-contract-event-center.test.tsx) 直接渲染真实 Events Route：

- 加载、投递详情、50 条分页、阶段筛选复位、aggregate ID 去空白以及筛空后的分页状态。
- 重试请求携带所见行的 `observedLeaseEpoch` / `observedUpdatedAt`，URL 正确编码；pending 期间不可重复操作。
- 成功只刷新平台投递 feed；失败保留原行并显示错误，显式再次操作后恢复，没有自动重复 POST。

测试仅替换 HTTP effect 和全站导航根壳。当前页面的读取错误会进入整页错误态，未把不存在的“读取失败保留列表”
写成合同；保留行的断言针对重试 mutation。作者操作的全部浏览器路径及视觉验收仍不由这三条用例穷尽。

### bootstrap / platform

本轮只读核对这一层的已有行为证据：`rfc359-w4-d6c-bootstrap-idempotency.test.ts` 的并发登记幂等、
`rfc379-passive-composition.test.ts` 的显式初始化与单次加载、`rfc370-daemon-host-lifecycle.test.ts` 的真实 listener
及 shutdown ACK 顺序、`rfc370-backup-scheduler-drain.test.ts` 与 `rfc370-maintenance-worker-real-effects.test.ts` 的排空和停止准入。
这些是实际生命周期测试，不只是目录或源码形状锁；本轮没有据此增加第二套装配框架。

## RFC-602：四项查询优化

本次优化保留已有业务输出口径，分别约束读取范围与必要的完整输出成本。全部实现、升级资产和用例完成后集中执行，修复后只复验受影响范围。后端相关 70 文件合并有效结果为 813 条通过，前端 5 文件 96 条通过；RFC-294 仅计两项相关合同检查，RFC-329 计四项路由覆盖检查，API 合同集计新 children happy case，并发 RFC-603 用例不计入本任务结果。完整类型检查、任务范围静态质量、schema-history、依赖边界及独立功能复核均通过。详细执行和修复记录见 [RFC-602 实施计划](../design/RFC-602-bounded-module-queries/plan.md)。

| 范围     | 当前合同与新防护                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 历史查询 | 初始化时一次构建持久派生索引；正常请求只读元数据和所需投影。覆盖冷 reader、分页/筛选/排序、metrics 精确时间界限、错误诊断、失败重建和升级保值。原历史包及旧 ID 索引保持原样。               |
| 资源摘要 | 六种资源均按 kind/ID 精确点读，保留各自 revision 和目录条件；大量背景行下，命中或缺失均一次 SELECT、最多一行；坏目标与无关坏行分别测试。                                                    |
| 仓库组   | layout/launch/get/preview 读取相关闭包；update 包括祖先的兄弟分支；delete 只取相关引用；保留全局版本集合与 OCC。验证结果、零预览副作用、循环/深度/展开边界和实际读取行数。                  |
| 子任务   | 新窄接口默认 100、最大 200，使用既有 parent/startedAt/id 索引；前端消费到末页且共用完整链。覆盖 0/1/100/500/501/1201 条、相同时间戳、取消、跨父切换、失败恢复、重复游标和刷新期的导航判定。 |

子任务接口同时登记 API 响应合同与 MCP 的 list_task_children 工具；每次工具调用只读一页，使用相同严格 DTO 和游标诊断。配套防护包含 operation 绑定闭包、独立完整 JSON Schema、路由错误覆盖、模型夹具写入边界、244 表备份规格，以及旧版 converted 安装的 daemon 启动回归。

主要新增用例位于后端 `rfc602-*.test.ts` 和前端 `rfc602-child-pagination.test.tsx`；资源和真实消费者扩展已有 `module-contract-*`、`task-detail-child-task-link` 与 `call-node-click-nav` 用例。

性能断言约束实际 SQL 次数、返回行数、绑定参数和索引计划，前端约束 HTTP 页数与发布时机，不把一次本地耗时当作 SLA。
完整仓库组列表、全局 OCC 轻索引、完整 delivery correlation 和全部子任务的总成本仍随必要输出增长。
历史原包每次 GET 不再全量验字节；只改原包字节而不改声明元数据的外部损坏，由显式 `db rebuild-code-history-index` 检出。
子任务分页是实时读取，跨页不承诺数据库快照；后续变化通过既有 WS 和轮询刷新。

## 验证方式与边界

2026-11-25 集中验证记录（首轮与修复后仅受影响文件的有效复验合并，未重复运行全仓本地 gate）：

| 检查                | 有效结果                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 新增后端 19 文件    | 133 个执行用例全部通过；持久化用例同时运行 SQLite 与本任务独立 PostgreSQL 17，其余为 provider 无关用例                  |
| 新增前端 3 文件     | 15 条全部通过，Vitest shuffle；真实 hook / QueryClient / 页面与受控 HTTP effect                                         |
| 关联回归 7 文件     | 136 条全部通过：历史响应 parity、只读性、历史装配、原 code queries、矩阵读面、任务目录与 origin 筛选                    |
| 仓库测试策略 6 文件 | 96 条通过：test-suite-policy、architecture ledgers、corpus floor、negative fixture、root entrypoint、PostgreSQL surface |
| 类型                | backend 与 frontend 的完整 `tsc --noEmit` 通过；backend 使用与 CI 相同的 6 GB Node heap                                 |
| 静态质量            | 修改范围 ESLint `--max-warnings=0`、Prettier 通过；本文相对文件链接存在性检查通过                                       |
| 功能复核            | 独立只读复核聚合目录合同及历史分页修复，没有阻塞性问题；没有替代执行结果                                                |

首轮暴露并修正了测试自身的三类问题：Program digest 夹具不满足已有输入格式；Resource Catalog 使用了错误种类的
context 夹具；两个 React Query hook 测试没有在 render 中订阅被断言的分页字段。修复后保留原有行为/预算断言，
只复验相应文件。历史 parity 原先固定了漏行行为，已按上文说明保留冻结参照并明确现行修复差异。
首次 backend 类型检查因默认 4 GB heap 耗尽未完成；采用 CI 的 6 GB 配置后修正测试类型问题并完整通过。
GitHub Actions 的全仓结果不计入上述本地数字，发布后应按具体提交 SHA 查询。

首个发布提交 `1ebe493f9` 的主 CI 又定位到一处新增测试的旧路径导入：execution-contract 用例从 composition
转出位置取 development 注册表，触发 RFC-494 依赖边界守卫。现已改从 application 拥有者位置导入，
未改变守卫、生产行为或测试断言；按 CI 原 seed 58771 复验该合同文件与 RFC-494 守卫，12 条全部通过。
修正后的全仓结论应查询后续提交，不能把首轮 CI 描述为全绿。

全部用例编写完成后集中执行。后端持久化用例使用现有 `describeEachProvider`；默认要求 SQLite 和真实 PostgreSQL，
不能把缺少 PostgreSQL 连接写成静默跳过。本地确需只跑 SQLite 时，必须明确记录 `AW_TEST_PROVIDERS=sqlite`。

```sh
# 在仓库根目录；双库模式需要预先配置 AW_TEST_POSTGRESQL_URL。
bun test --isolate --randomize packages/backend/tests/module-contract-*.test.ts

# 在 packages/frontend 目录。
bunx vitest run --sequence.shuffle --maxWorkers=2 tests/module-contract-*.test.tsx
```

新的模块合同用例由既有测试入口自动纳入 CI，不需要第二套执行器。新增测试文件后还需检查测试策略与架构守卫的
枚举约束，防止引入 focus / skip 或改变守卫语料口径。最终全仓结论以对应提交的 GitHub Actions 为准。

这份文档是一次行为证据整理，不代表所有导出函数的每个输入组合均已穷尽，也不把静态测试文件数量当作覆盖率。
新增或修改公开合同后，应更新拥有该合同的用例；消费方增加不同的解释时，应补跨边界用例，而不只更新接口类型。
