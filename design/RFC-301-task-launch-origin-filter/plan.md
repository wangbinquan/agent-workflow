# RFC-301 任务启动来源归一与筛选补全 — 实施计划

状态：**Implementing（2026-08-14，用户已批准完整实现与提交上库）**

## 1. 前置门

- [x] 读取 `CLAUDE.md`、`STATE.md` 与当前 migration/RFC 规则。
- [x] 核对 shared origin 枚举、TaskOperations SQL、tasks 持久字段、ActorSource 与 ExecutionInvoker。
- [x] 枚举统一 execution 路由、Scheduled/Webhook、call child 与 Fusion 直接 `startTask` seam。
- [x] 用户确认四类来源口径、认证判据、invoker 优先、子任务继承与历史 API 不猜测。
- [x] 读取 RFC-294 摘要/目标/技术设计，登记 task-execution owner、层次、过渡债务与零新增偏离。
- [x] RFC-301 proposal/design/plan、总索引与 STATE 落档。
- [x] 用户明确批准 RFC-301 后才允许修改 production/test/migration 代码。
- [x] 开工时重新读取 live `CLAUDE.md`/`STATE.md`、检查共享工作树与下一个空闲 migration 编号。
- [x] 请批前设计门以 source HEAD `1a8f0e8a` 核对来源写入全清单、迁移可终止性、wire 负空间与
      RFC-294；4 条 P2 已修订，复核 0 条未处置 P1/P2（记录见 §7）。

## 2. 实施批次

### 批 A — Shared contract 与持久化

| #          | 任务                                                                                    | 验证                         |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| RFC-301-T1 | 新增 `TASK_LAUNCH_ORIGINS`，扩 `TASK_LIST_ORIGINS` 为五个筛选值                         | shared 正反/变异测试         |
| RFC-301-T2 | 从最新 journal 分配 migration，增加 `tasks.launch_origin` CHECK/default + child trigger | fresh/upgrade schema tests   |
| RFC-301-T3 | 写确定性历史回填：局部证据 + 根到后代传播 + dangling/cycle 终止                         | 旧库矩阵 fixture             |
| RFC-301-T4 | 更新 Drizzle schema、snapshot/journal、rolling upgrade 计数与显式列 fixture             | backend schema/upgrade tests |

退出门：新旧库都可启动；历史 API 不被猜测；任务树回填一致；当前生产代码尚未依赖新列也不报错。

### 批 B — 创建时来源归一

| #          | 任务                                                                                        | 验证                         |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| RFC-301-T5 | 在 task-execution domain 落 closed provenance→origin 归约；trusted inbound 单点映射认证通道 | domain/adapter unit          |
| RFC-301-T6 | execution deps 按 user/scheduled/webhook/node 收敛来源，Scheduled/Webhook 优先              | invoker matrix               |
| RFC-301-T7 | initial INSERT 写来源；子任务在 parent 状态事务内读取并继承，加入根元数据一致性守卫         | task service integration     |
| RFC-301-T8 | Fusion create 与 reject/relaunch 接同一 helper                                              | fusion route/service tests   |
| RFC-301-T9 | 枚举所有生产 root `startTask` seam并建 ratchet，锁零新增跨域 import/facade/route 判断       | source/architecture mutation |

退出门：每个新根任务恰有一个可信来源；所有深度的 child 都继承；客户端无可写 seam；retry/resume 不变。

### 批 C — 查询与前端筛选

| #           | 任务                                                                          | 验证                         |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------- |
| RFC-301-T10 | TaskOperations 删除 NULL 推断，统一使用 `b.launch_origin = ?`                 | 四来源 + 组合筛选 + cursor   |
| RFC-301-T11 | 双语补 `webhook`/`api`，筛选 Dialog 自动渲染五项                              | i18n 1:1 + frontend render   |
| RFC-301-T12 | 保持 Apply/Reset/URL/focus，锁定 390px 内滚动、触控、键盘与无页面 overflow    | frontend + Playwright + a11y |
| RFC-301-T13 | 更新 E2E fixture 的内部来源构造，不向 TaskOperations wire 增加 `launchOrigin` | contract/source ratchet      |

退出门：用户可稳定筛选四类来源；响应 item 零新增字段；原有 view/status/search/subject/scope/facet 行为逐字不变。

### 批 D — 系统 E2E、回滚与门禁

| #           | 任务                                                                                 | 验证                  |
| ----------- | ------------------------------------------------------------------------------------ | --------------------- |
| RFC-301-T14 | 真实 daemon 创建 session/PAT/scheduled/webhook 根，其中至少一条产生多层 child        | system E2E            |
| RFC-301-T15 | 浏览器逐项筛选，验证树不拆、切换 cursor、390px/desktop/light/dark                    | browser/visual/a11y   |
| RFC-301-T16 | mixed-version/rollback fixture：旧 writer 不 500、降级边界明示、新 writer 精确值保留 | rolling-upgrade tests |
| RFC-301-T17 | 独立实现门审查 migration、所有 writer、并发/失败路径与 wire 负空间，逐条处置 finding | 固定 SHA review       |
| RFC-301-T18 | 定向测试、三包 typecheck/lint、`bun run gate:local`                                  | 全门禁                |

退出门：Proposal 全部 AC 有自动化证据；实现门无未处置 P1/P2；全量本地门禁绿后才更新 Done 状态。

## 3. 用例矩阵

### 3.1 正常根任务

| Invoker/入口                | actor.source | 预期来源  |
| --------------------------- | ------------ | --------- |
| direct task/agent/workgroup | session      | manual    |
| direct task/agent/workgroup | pat          | api       |
| direct task/agent/workgroup | daemon       | api       |
| scheduled fire              | daemon       | scheduled |
| webhook fire                | daemon       | webhook   |
| Fusion create/relaunch      | session      | manual    |
| Fusion create/relaunch      | pat/daemon   | api       |

每行同时断言数据库值、筛选可见性，以及 Task/TaskSummary/TaskOperations response 不出现新字段。

### 3.2 子任务与生命周期

- manual、scheduled、webhook、api 各自产生 workflow child 与 workgroup child；
- Scheduled → workflow child → workgroup grandchild，三行均为 scheduled；
- Webhook → workgroup child → workflow grandchild，三行均为 webhook；
- 子任务本地含 trigger context 但不能覆盖 parent origin；
- 同一 parent 并发创建多个 child，全都读到同一 immutable origin；
- retry、resume、recovery、cancel/restart 不执行来源 UPDATE；
- parent 不存在/状态不允许、显式 child origin 冲突都保留具体错误，不回落 manual。

### 3.3 非法与攻击面

- create body 带 `launchOrigin`、`launch_origin`，query/header 带同名值都不能控制服务端结果；
- session 调用方伪装 User-Agent 为 API 仍是 manual；PAT 从浏览器发请求仍是 api；
- scheduled 缺 `scheduledTaskId`、webhook trigger/fire/context 缺任一项、manual/API 带 trigger 根字段都
  fail closed；
- 非法 DB 值受 CHECK 阻止；未知 filter query 仍返回当前 validation error；
- actor auth/permission error 不因来源逻辑被改写成普通启动失败。

### 3.4 历史迁移

- 无任何证据的旧根与后代 → manual；
- scheduled 根与多层后代 → scheduled；
- webhook ID/canonical context 根与多层后代 → webhook；
- 后代局部证据与根冲突 → 根来源；
- 非法 JSON 不命中 webhook；
- dangling parent 与无根 cycle 保留最佳局部来源并完成迁移；
- 可疑 direct API fixture 仍为 manual；
- 已升级 DB 重开/再跑 admission 不改变结果。

### 3.5 查询、分页与 UI

- 四个来源分别组合 view、status、search、subject、scope；all 返回并集；
- 每一筛选结果只包含所选来源的完整树，facet/排序不变；
- 各来源 cursor 不能跨来源复用，切换来源后页码/cursor 重置；
- 五项中英文显示、Apply/Reset/Escape/点击外部/focus return；
- 390×844 的 segment 内部可横向滚动但 Dialog/page `scrollWidth` 不增长；
- touch 与键盘均能选中首尾项，选中样式在 light/dark 下可辨。

## 4. 验收映射

| Proposal AC                      | 实施任务     |
| -------------------------------- | ------------ |
| 五值 shared/UI contract          | T1、T10-T12  |
| direct actor 与 invoker 精确归类 | T5-T9        |
| 子任务整树继承                   | T7、T14      |
| 持久字段与历史回填               | T2-T4        |
| 精确 SQL、分页与组合筛选         | T10、T14-T15 |
| wire/request 负空间              | T9、T13、T17 |
| 390px/键盘/a11y                  | T12、T15     |
| 正常/异常/并发/回滚/真实 E2E     | T3、T5-T18   |
| 全门禁与实现门                   | T17-T18      |

## 5. 提交建议

用户批准后在共享 `main` 按 owner 路径精确提交，不建分支、不 broad-stage：

1. `feat(tasks): RFC-301 持久化任务启动来源`
2. `feat(execution): RFC-301 统一根任务来源并继承到子任务`
3. `feat(tasks): RFC-301 补全 Webhook 与 API 来源筛选`
4. `test(e2e): RFC-301 锁定四类来源与任务树筛选`

每个生产提交同时携带对应测试，migration 与 schema 不拆成会使任一中间 commit 无法启动的状态。提交前
按 owned paths/hunks 精确暂存；若本 Codex session 有实质贡献，使用真实模型 trailer，并在 push 前运行
`git show -s --format=%B HEAD` 核验。

## 6. 完成与回滚定义

- 未获 RFC 明确批准前，只允许本三件套、索引与 STATE 文档，不修改生产、测试或 migration；
- T1-T18、全部 AC、设计门/实现门、定向测试、真实 E2E 与 `bun run gate:local` 全部完成才可标 Done；
- migration 上线后不 DROP `launch_origin`，代码按批次逆序回滚；
- 回滚报告必须区分：数据库可读写、筛选功能降级、旧 writer 期间来源精度、已写历史是否可恢复；
- 无法证明的历史 API 或旧 writer 窗口数据永远不得以启发式“修复”为 api。

## 7. 请批前设计门记录

审查范围固定为本 RFC 三件套，源码基线 `1a8f0e8aa8a230b23685de8d65e6175d72c52bd7`。曾在只含本
RFC 文档的 `/private/tmp` 隔离 clone 中尝试仓库规定的外部 `codex review --uncommitted`；本机安全策略因
“可能向外部服务发送未提交仓库、用户未授权源码外传”拒绝执行。未提权绕过，也未把源码发送出去；改由当前
Codex 会话按相同清单逐项核 live source。

第一轮得到并修订 4 条 P2：

1. **P2-A，raw origin 可错配**：初稿让调用方直接传 `launchOrigin`，且 domain helper 读取 `Actor`，与
   RFC-294 owner/layer 冲突，也允许“webhook 值 + 无归属证据”。改为 trusted adapter 生成
   `DirectTaskInitiator`、task domain 只归约 closed `TaskLaunchProvenance`，Fusion 只接解析后的 initiator。
2. **P2-B，Webhook 半态被放行**：初稿把 trigger/fire/context 写成 OR；具体失败输入是只传 context 的
   webhook root，会出现在 Webhook 筛选中却没有 delivery/source-link。新写入改为三件套全必需；宽松证据仅用于
   历史 backfill。
3. **P2-C，索引无法命中**：初稿给 `(launch_origin,started_at,id)` 建索引，但 live query 在
   `base AS MATERIALIZED` 后才过滤 `b.launch_origin`，索引不会参与表扫描。已删除死索引，并明确在 internal base
   projection 携列、response mapper 丢弃。
4. **P2-D，rollback 可拆树**：仅靠新 application writer 时，旧 binary 可在精确非 manual parent 下插入默认
   manual child。增加同事务 child-inherit trigger；旧 writer 的根精度仍按能力影响清单降级，但树不再混源。

相邻遗漏复核还确认：生产 `tasks` INSERT 唯一在 `services/task.ts`；root raw `startTask` 生产旁路只有 Fusion，
agent/workgroup 均由 executor 进入，workgroup frozen call 是 child；TaskOperations 真实组合过滤是
view/status/search/subject/scope（无 owner/date filter，初稿误写已删除）。修订后当前会话复核为 **0 条未处置
P1/P2**。若用户希望补跑外部 companion，需另行明确授权源码外传。

## 8. 实现门记录

实现门在共享 `main` 的 RFC-301 工作差异上逐项核对 domain/admission、全部生产 root/child writer、
migration/rollback trigger、TaskOperations query/projection、公开 wire 负空间与真实 daemon/browser 链路。
第一轮发现并处置 3 条 P2 与 1 条测试邻接遗漏：

1. **P2-E，空白冲突字段可绕过 admission**：仅用 non-empty 判定时，direct root 可携
   `webhookFireId: ' '`，webhook root 也可携 `scheduledTaskId: ' '`。禁止项改为按字段 presence fail closed，
   必需 ID 仍要求 trim 后非空；domain 与 child 测试锁定两种空白输入。
2. **P2-F，Dialog 初始焦点打开 portal 遮住后续来源控件**：共享 `MultiSelect` 增加默认保持兼容的
   `openOnFocus`，任务筛选显式关闭“聚焦即展开”，ArrowDown/Enter/pointer 仍可打开；unit 与 browser
   同时锁定初始 listbox 关闭及键盘可达。
3. **P2-G，Agent multipart 被内部标成 direct-json**：虽然最终 manual/API 值相同，但这会破坏 closed
   provenance 的通道真实性。Agent route 改为根据 uploads 选择 `direct-json | direct-multipart`，架构锁与
   multipart 真路由测试覆盖。
4. **邻接测试遗漏，call-workgroup 未直接断言来源继承**：既有真实工作组全链 fixture 将 parent 设为
   webhook，并断言 child 与 parent 的 `launchOrigin` 相等；workflow 多层、并发 sibling 与 DB trigger
   仍由 RFC-301 专属测试分别覆盖。

处置后实现门结论为 **0 条未处置 P1/P2**。最终固定提交 SHA、完整 gate 与 exact-SHA CI 证据在完成发布后
回填本节与状态索引；在此之前保持 Implementing，不提前标 Done。
