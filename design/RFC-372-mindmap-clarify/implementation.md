# RFC-372 实施记录

> 当前有效范围已收敛为 v6「现有反问的脑图模式」，原独立 Session、Task host、材料、交付和模板回流实现已退役。当前实现、验收及未完成发布状态以 [轻量验收记录](./lightweight-acceptance.md) 为准。以下内容保留为收敛前的历史实施记录，不继续授权旧需求，也不代表当前功能。

> 2026-10-12：用户已明确批准实现。已写入内容基础、持久化/HTTP/正式路由及同事务开图接点，M1 真实任务闭环尚未完成；不代表功能已上线或可验收。

用户随后明确要求完整实现、提交推送及完整本地功能验证，覆盖此前不运行本地 AW 的限制。此前“未运行”的记录保持原时点含义；本轮实际回归、失败修正及正式功能验证另行追加，不能用源码检视代签运行成功。

最新用户指定先发布设计、再完成整体开发、最后集中功能验证。以下旧段落保持各自记录时点；当前实现新增原 continuation 正常材料等待、不可变材料版本、真实 native 运行器完整提示词检查、原成功输出/merge 事务消费、完成页 delivery 查询及原 requestId 材料刷新恢复。0246/PG 0022 已由共享发布 134603ad 释放；Task 五表 0247/PG 0023 已生成但未发布。

此前已执行的正式迁移双 provider 开门回归 18 pass / 0 fail（164 expect）记录于 `/private/tmp/rfc372-opening-current-source-formal-r2.log`；预算/原 native runner/消费/continuation 四文件 17 pass / 0 fail（121 expect）记录于 `/private/tmp/rfc372-business-runner-dual-r4.log`。native 测试实际启动 fixture CLI 子进程，并证明完整 prompt 超限或容量失效不启动进程、不受理消费；它尚未覆盖完整 TaskEngine/正式路由 UI/真实模型。前端预算组件 2 pass / 0 fail；工作区、持久草稿、完成页 21 项通过。整体功能验收尚未执行。

最新只读功能检视发现完成后恢复被 round readOnly 禁用、首次无 stamp 后 delivery 状态不再更新、以及按 mutable runtime 名称预算与原冻结 run 分叉三项；正在修复。同快照的新材料版本与准备并发已改为 `material_version_changed` 正常等待，保留较新计划、无 acceptance；相应竞态用例正在补齐，未记录为运行通过。M1 仍未关闭，全部 112 项目标保留，M2～M5 继续开发。

## 本批代码

| 范围                                | 已写入的内容                                                                                                                                  | 实际边界                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| shared                              | 模式解析、递归模板配置校验、稳定选项和条件引用、工作区/节点/分页/命令 DTO                                                                     | 两种反问节点 strict schema 与格式 v7/migration 已接入；模板编辑组件尚未挂入 inspector                   |
| collaboration/domain/mindmap        | 确定性模板实例、保存/确认/追加/范围/人工标准命令、三态条件、版本与上下文冲突、整树聚合、自身状态与分支状态、版本绑定分页/搜索、确定性快照候选 | 仍由纯函数决定内容语义；FinishMindmap 及最终业务消费尚未接入                                            |
| frontend                            | MindmapWorkspace、MindmapCanvas、共享草稿状态、IndexedDB 恢复、基本编辑/确认控件、全景/聚焦切换、状态提示、中英文本                           | 已挂入现有反问详情路由并使用真实 HTTP 合同；runtime 自动创建入口与完成续跑未接通                        |
| 大图                                | Worker 布局、迭代遍历、Canvas 轻量绘制、空间查询、标签避让、虚拟大纲、20 项聚焦分页、长祖先路径折叠、搜索追加结果                             | 5000 节点/100 层结构已有回归用例；没有正式浏览器性能实测                                                |
| collaboration/infrastructure + HTTP | 五张 companion 表、双 provider 迁移、快照读取、版本化命令、节点历史、幂等回执、提交后 WS 失效通知；普通问卷入口拒绝脑图写入                   | 查询尚读取完整 session 内容；大图服务端容量与性能未实测；不能把读写接口当作业务闭环                     |
| human gate opening                  | v2 clarify-open manifest 冻结模板和 task 提供的 entry/source 身份；原 TaskPark 同一事务创建 round、session、节点和历史；保留 v1 问卷合同      | 接点已写入，task-execution 的权威 entry 映射和 runtime 前置调用尚未装配，实际 Task 还不能自动走到此入口 |

普通分组需要明确确认；根范围单独确认，不能自动代替分组判断。未回答单选保持未知，已明确确认的多选空集合可以判为未选择。全景与聚焦共享完整聚合，不用当前页的绿色判断整图完成。本地草稿、读取未完成、投影版本不一致或重取失败会遮罩当前工作区的完成呈现。

快照函数仅创建冻结候选，保留原话、稳定选项与文字/解释、事实值、理由、范围和确认依据；没有把 live session 标记完成，也没有交给任务执行器。最低实质深度和图件确认尚无正式实现，目前保留明确 blocker，不会被默认当作满足。

## 正式画布交互约束

- 取消“放大此分支”；双击无缩放行为。单击只选中并联动同一个编辑区。
- 空白拖动、空格拖动、中键拖动平移；拖动阈值区分点击和拖动。
- Ctrl/⌘ 加滚轮与双指缩放保持指针/手势中心对应的世界坐标；缩放松开一指后可继续单指平移。
- 搜索/下一项仅在目标不可见时平移定位，不改变缩放比例；小地图定位同样不改变比例。
- 首次进入适配全图；之后只有显式“适配全图”或画布键盘 0 才重新适配。编辑、确认和视图切换不自动适配。
- 两个视图保持挂载并共用相机/选中/草稿状态；内容状态变化不触发结构布局，结构变化尽量保持选中节点的屏幕锚点。
- 画布键盘事件局限在画布焦点内；表单输入不会触发平移或缩放。相机移动延后保存，避免每次 pointer move 都写入 IndexedDB。

## 功能检视

本批按 CLAUDE.md 使用独立功能检视，限定为这些基础文件；未把后续数据库、HTTP、宿主、AI 等未交付项当作本批已完成内容。检视发现并修正：

1. 未选单选被错误判为 false，以及修订时多选空集合的差异。
2. 未确认的分组自动完成。
3. 跨 session 沿用旧草稿和恢复期间覆盖输入。
4. 父范围排除后仍存在 current 孩子；本批明确拒绝这些组合。
5. 草稿/读取中仍显示审阅完成，包括尚无任何 overview 节点的边界。
6. 双指缩放松开一指后无法平移。
7. “下一项待处理”漏掉分组和根范围，或反复指向自身已经确认的祖先。
8. 全局搜索仅显示前 50 个命中。
9. 候选 Markdown 只有选项 ID，没有选项含义。

首批限定复核 **PASS**：原 6 项及增量 3 项功能问题均已关闭，未发现与这些修复直接相关的新增阻断。所有检视均为源码结论，不是测试通过证据。

第二批存储/HTTP/正式路由检视发现并修正三个问题：

- 只监听 beforeunload 不能保护站内导航：接入公共 UnsavedChangesGuard，只对未本地持久化的文本阻拦；保存失败保持输入，重试成功才允许离开。
- 追加成功但响应丢失后可能使用新 requestId 重复追加：新增独立 IndexedDB 命令槽，POST 前持久化完整请求；未知结果沿用原请求恢复。写槽使用同一 readwrite transaction，不能覆盖另一个标签页尚未确认的命令。
- 其他标签页更新后旧分页游标一直失败：children query 绑定 session revision，新版本首次渲染就回到有效第一页，保留选中节点。

第二轮发现保存回执 generation 复用可能删掉新输入，已同时匹配原命令完整内容与 generation；旧回执不能倒退较新的草稿基线。限定复核 **PASS**。追加标题、人工标准备注也只在内容仍与提交值相同时清除。初始读取失败不会以空工作区覆盖旧草稿/未结命令。

开图接点单独检视发现 trim 后标题与原输入重放比较不一致，已改为 prepare 开头规范化一次，首次冻结与重放共同使用规范化值，并补 prepared / committed 两种带空白标题回归。最终限定复核 **PASS**；真实原事务写入/回滚接点、v1/v2 合同、终态 Task 投影及两项数量配套未发现额外功能阻断。该结论不涵盖尚未实现的 runtime entry 或 Finish。

## 工作流格式与模板编辑增量

工作流格式升为 v7，v1～v6 迁移仅升级格式号，不把旧问卷自动转换为脑图。`clarify` 与 `clarify-cross-agent` 共用 interactionMode/config 校验；缺省仍为 questions，选择 mindmap 必须具有有效模板。合法的保留模板允许随 questions 一并保存，切换不会销毁配置或 sessionMode。旧问卷的无循环提示保持，脑图不继承该问题语义。

格式增量独立功能检视修正了 intent 字段闭合集合遗漏、codec 默认版本与摘要、fusion 旧 golden 被格式号影响三项问题，限定复核 PASS。旧 fusion fixture 仍验证完整图结构与正文，仅把最新格式号归一到原 golden 的 v6 后比对。

新增共享模板编辑组件，提供 required/on_demand、reentry、说明和逐分支问题编辑、稳定 key、20 项同层分页与祖先返回。它尚未挂入两种 inspector：实际 runtime 入口和续跑未接通，当前不把它呈现为可用功能。编辑草稿保留标题/问题/说明的原始输入，包括尾随空格、换行、临时空值和超限文字；严格 schema 在执行/验证阶段判断有效性。独立检视修正了输入即时 trim、超限后编辑区消失、规范化 key 后占位文字无法恢复三项问题，限定复核 PASS。新测试同时覆盖不可变深层替换、模式往返、隐藏标准保持和第 45 个同层分支可达。

## 宿主进入判定增量

`task-execution/domain/clarifyEntry.ts` 实现进入判定：通道绑定真正的宿主 occurrence 路径与 shard instance；完整 Loop 路径只改变 host entry。completed 的 explicit 复用和 each_iteration 新进入区分，输入变化返回 source_changed，显式请求核对通道头；open coalesce，opening/superseded 保留明确等待。按需的 not_requested 只接受准确 source run 及其输入版本的已提交事实，不能将旧运行的无图结果套给新的 pending/failed 运行。

独立功能检视修正了附加运行元数据错误进入身份哈希的问题，改为按合同字段显式投影，复核 PASS。该模块目前只有领域判定及 6 条回归声明，没有生产调用方；宿主持久映射、mint 继承与 scheduler 接入仍由 T02/T03/T11 落实。它不自行拼 containerRunId、不把 technical run ID 当作逻辑通道，也不构成真实 runtime 入口已完成的证据。

## 验证记录

已编写 68 条针对性回归用例声明（其中存储 7 条与开图 3 条由双 provider harness 展开），分布于：

- `packages/shared/tests/rfc372-mindmap-config.test.ts`
- `packages/shared/tests/rfc372-workflow-mode.test.ts`
- `packages/backend/tests/rfc372-workflow-validation.test.ts`
- `packages/backend/tests/rfc372-clarify-entry.test.ts`
- `packages/frontend/tests/rfc372-mindmap-template-editor.test.tsx`
- `packages/backend/tests/rfc372-mindmap-content.test.ts`
- `packages/backend/tests/rfc372-mindmap-queries.test.ts`
- `packages/backend/tests/rfc372-mindmap-store.test.ts`
- `packages/backend/tests/rfc372-mindmap-opening.test.ts`
- `packages/frontend/src/features/clarify/__tests__/mindmap-interaction.test.ts`
- `packages/frontend/tests/rfc372-mindmap-canvas.test.tsx`
- `packages/frontend/tests/rfc372-mindmap-workspace.test.tsx`

用例覆盖配置循环/稳定 key、原话与确认分离、三态条件、范围连接性、版本分页与搜索、快照保真、相机几何、5000 节点/100 层布局、迟到保存回执、双视图草稿、会话切换、加载/草稿遮罩、超过 50 项搜索和实际 pointer 事件。新增声明覆盖命令提交前本地持久化、刷新/未知结果重放、导航保护接线、peer revision 分页恢复、数据库内容/历史/回执同事务、旧问卷模式隔离、终态任务漏扫，以及原 TaskPark 中插入历史失败后的整笔回滚与重试。

前端 Workspace 用例的 Guard 和 IndexedDB 被 mock，只覆盖组件与接口合同；不作为真实路由阻拦、跨标签页 IndexedDB 竞争或浏览器操作通过的证据。

仅执行本批文件的 Prettier 与 ESLint 静态检查；未执行上述测试、全仓 typecheck/build、AW 服务、浏览器验收、真实任务或 CI。本批没有提交、推送或部署。

## 迁移编号恢复与共同发布边界

Drizzle 生成器按 journal idx=245 选择文件前缀 0245，与已有 RFC-371 的 0245 发生碰撞。生成器覆盖了未提交的 0245_snapshot.json；原 RFC-371 SQL 和 journal 条目保留。已先保全生成结果，再将本次完整结果放入 0246_snapshot.json，仅从原编号副本移除本次五表并恢复原 identity 链。没有从 HEAD 重写共享文件或移除对方开发内容。

独立源码与产物核对 PASS：0244 为 241 表，0245 为 244 表且只增加原三表，0246 为 249 表且只增加脑图五表；所有既有表对象及其他 metadata 逐项相同。0246 等于保全的生成产物；UUID 前驱链正确，journal 相对生成时保全版本只改本次 tag。PostgreSQL 0022 的前驱 digest、合同/SQL/SQLite hash 均匹配，原 0021 未改写。初次核对仅有结构恢复证据；并行会话随后提供 v385 的生成前完整备份，独立复核确认当前 0245 与原文件逐字节相同：804661 bytes，SHA-256 `dc23ba56b994173a4aa10e91458cf3516285343b4d91c52c2f42a8e71e0e0372`。十文件的完整独立证据见 [五表 SOURCE 报告](reviews/schema-source-review-20261012.md)。

`db:generate` 与 PostgreSQL append 生成器已执行，但本会话没有在实际产品数据库应用迁移。共享测试人口配套为 243 active tables、246 个 SQLite journal entries（包括 RFC-371 的 0245 和本次 0246）；原 RFC-371 断言与其他源码保持。

五表增量可随共同候选发布，但 0246/0022 依赖对方 0245/0021 先序链，不能只提交共享 journal 或 schema 而遗漏任一方依赖。共享发布范围见 [schema-publication.md](schema-publication.md)。用户已明确授权本次共享文件与发布协调，已向“设计运行观测统计全景”会话交接五个新增文件与五个共享文件，并冻结这十条路径。对方已核对完整 SOURCE 报告及十文件当前哈希；尚未通知进入 staging/commit/push 临界区。其他 RFC-372 工作流、UI 和域文件仍由本会话继续实施，不随此次 schema 交接扩大提交范围。

## 下一实施出口

继续按 M1 完成一个 required 小模板的原任务闭环，不能把现有组件或快照候选当作此出口已经完成：

1. 工作流 schema/version migration v7 与旧 questions 回归已写入；实际编辑器入口在 runtime 开图接通后挂入。
2. 将已写入的持久化/HTTP/同事务开图接点装配到实际入口；继续补历史查询与容量验证。
3. task-execution 确定性开图、权威进入身份与 pre_business 停靠；保持原 Task binding。
4. 对已挂入详情路由的组件核对真实草稿冲突、刷新恢复、站内离开保护和窄屏操作。
5. 完成预览、正式不可变快照、FinishMindmap、原人工门决定事务与 durable continuation，证明 asker 消费同一快照且不重复运行。
6. 对确切候选运行托管 CI 与获授权的实际任务/浏览器验收，然后再记 M1 完成。

M2～M5 的完整依赖/证据、AI 与图件、cross/多运行时、材料预算和模板回流继续按 plan.md 推进。该记录不缩减已批准的 112 项目标。

## 本轮已执行的针对性验证与运行接线

本轮执行了 shared、backend、frontend 的针对性测试。shared 配置/格式 9 项、backend 内容/查询/进入/工作流 21 项通过。frontend 首次两个恢复按钮断言使用了过期文本，已按实际功能文本修正并通过；最新工作区与持久化 14 项通过。shared 与 frontend typecheck 通过；backend 新代码的类型问题已修正，当前全包仍有并行观测缓存文件的类型错误，不能记录全包通过。没有运行完整本地门禁。

本任务独立 PostgreSQL 16 临时库及 SQLite 中，存储 14、原 TaskPark 开图 6、完成事务 12 个展开用例通过。完成回归覆盖最终 committed event 故障导致整笔回滚、原 requestId 重放、不重复 continuation，以及 Task 仍 running 时保留活跃 sibling 的运行时钟和状态。PG 原生异常由 query Error 包装，故障测试沿 cause 链核对准确异常；没有放宽回滚断言。完成适配器仍未装配到正式 HTTP 和 durable continuation，不能据此标记 M1 完成。

实际 Chromium 155.0.8059.40 原生 IndexedDB 验证通过：正式 store 保存/恢复暂时空标题、超限原答和 false；非法命令不占 outbox；close-pending 连接恢复；真实页面 reload 保留原答、相机与 requestId；真实同源双标签页的迟到旧回执保留新命令；旧非法 payload 可按原 requestId 清理。`errors:[]`，证据 `/private/tmp/rfc372-native-idb-results.json`。这只覆盖正式 store 的浏览器持久化路径，尚非完整生产工作区或原 Task 执行验收。

新增 task-owned host/entry 存储代码及真实 node-run mint 接点，映射 occurrence 与精确继承来源；wrapper 跨 Loop 迭代沿用逻辑槽，新的 fanout shard 分配独立实例，技术 retry/cascade 传递原行身份。调度器采纳 pending 行限制为当前 wrapper 帧。required 入口已写入 pre-business adapter，并以原协作开图服务承接；TaskPark 同事务绑定 entry。新 Task companion 的迁移尚待共享 schema 释放后追加，host/entry 的实际双 provider 和运行器接线仍需验证。

共享 fixture 恢复修复的有限核对发现随机顺序依赖并推动 R2 修正。相同 seed=1 在双 provider 运行恢复与 logical-target 限定文件 14 pass / 0 fail，唯一 finding 关闭；这是冻结迁移释放所必需的协调，不代表 RFC-371 整体验收。详见 [有限报告](reviews/shared-source-revision-restore-review-20261012.md)。

### 本轮开门恢复、真实来源与工作区完成接线（2026-10-12）

独立功能检视指出 prepared 开门沿用旧 Task revision、工作区来源仅取启动 baseCommit、以及开门无条件停止整个 Task 的三处问题。现 v2 在原 TaskPark 内绑定确切 entry/head/source/gate 后加入当前已锁定 Task revision，保留原 prepared operation；开门沿真实跨 frame 调度 frontier 判断独立工作，保留运行分支的状态和计时；来源读当前选定 workspace 的完整内容 tree 和实际子模块 tree，正常重试时未变内容保持稳定。原问卷路径保持原版本要求。

实际 SQLite/任务专用 PostgreSQL 16 随机顺序验证：`rfc372-mindmap-opening.test.ts` 10 pass / 0 fail（92 expect），包括同事务回滚、原 entry/operation 重放、prepare 后合法 Task revision 推进、独立 sibling 保留运行计时。日志 `/private/tmp/rfc372-opening-restore-branches.log`。Task companion 迁移因共享三 schema 路径冻结，当前此轮测试明确使用暂时 fixture DDL；最终必须改为正式迁移建库后再验，不能以 fixture DDL 作为迁移成功证据。

`rfc372-mindmap-runtime-entry.test.ts` 3 pass / 0 fail（11 expect）：选定 workspace 未提交 tree 与子模块内容、原业务 admission 相同 ports/inputs/baseCommit 仅改当前 tree 后 source_changed、阻塞 source 下游和 running 祖先 wrapper 不算独立工作，而实际 ready/in-flight sibling 算。日志 `/private/tmp/rfc372-runtime-entry.log`。

工作区内 Finish preview/finish HTTP 已写，共享 outbox slot 新增严格 Finish 记录，保存原 request identity 后才发 POST，跨窗口旧回执不能删除新操作。界面与恢复回归尚在进行；续跑正常材料等待、能力/预算读取、真实调用接受和业务消费尚未闭环。Backend typecheck 本轮也指出模型参数不在 agent 行（运行参数属于 runtime profile），已改回明确未选择并继续接正式运行配置；其他 RFC-371 中间态类型错误归其所属会话，不以其作为 RFC-372 功能失败或通过证据。
