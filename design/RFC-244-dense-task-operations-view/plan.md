# RFC-244 · 高密度任务运行中心 — plan

状态：Visual Contract Correction Complete Locally / Publication In Progress（推荐方向已确认；三轮
设计门最终 `APPROVED — P0=0/P1=0/P2=0`；2026-08-01 用户以 “ok” 正式批准；首个实现提交后
发现界面与已批准原型存在偏差，当前以 `visual-contract.md` 为基线修正）。

交付形态：一个 RFC / 一个 PR，按三个可独立验证的提交批次推进；不得为了前后端并行留下
「新 backend 已默认改变旧列表」或「frontend 指向尚未存在的 wire」窗口。

## 任务

### T0 · 设计与批准

- [x] **RFC-244-T1 现状核对**：读取当前 `/tasks` route、legacy API、list service、shared schema、
      task indexes、Owner 与父子任务契约；确认 500 条 client filter、完整 task-row projection、
      flat/nested 双形态与 1280/mobile overflow 是改造边界。
- [x] **RFC-244-T2 推荐方案定档**：用户确认完整前后端改造、默认「全部」、子任务统一入树与紧凑
      行高。
- [x] **RFC-244-T3 三件套与登记**：proposal/design/plan、`design/plan.md` 索引、`STATE.md` 顶部
      进行中条目。
- [x] **RFC-244-T4 设计门**：按 design §10 攻击 ACL recursive CTE、分页、facet、lightweight mapper、
      responsive a11y 与 index；首轮 0 P0 / 5 P1 / 3 P2 已修订进 Draft v2，focused 复审新增
      0 P0 / 1 P1 / 1 P2（revalidation 冻结窗口、`MultiSelect` searchable contract）并修订进 Draft
      v3；closing 复审 `APPROVED — P0=0/P1=0/P2=0`，完整记录见
      `design-gate-2026-08-01.md`。
- [x] **RFC-244-T5 用户正式批准**：2026-08-01 用户在设计门闭合与批准提示后回复 “ok”；进入
      T6，但该批准不授权 commit、push 或发布。

### PR 批次 1 · Shared / DB / Backend

- [x] **RFC-244-T6 shared contract**：新增 view/status single-source 常量、query/cursor codec、
      `TaskOperationsListItemSchema`（含 RFC-207 execution clock）、root/child discriminated page strict
      schema与 additive `task.members.changed` / `lifecycle.alert.resolved`；穷举 `TASK_STATUS`。
- [x] **RFC-244-T7 migration 0128**：建立 started/status/parent/owner + startedAt/id composite index；
      以 query-plan test 确认覆盖后删除冗余旧 index；schema 与 migration 同步。
- [x] **RFC-244-T8 filter + authorization parser**：抽 alias-aware ACL-only authorization helper；route
      canonicalize view/q/statuses/subject/scope/origin/parent/limit/cursor；ownership scope 仅进 self
      filter，按 actor permission 收敛并 URL replace；fingerprint 绑定 actor/capability 与统一 422。
- [x] **RFC-244-T9 lightweight rows**：显式列 projection + list-only mapper，禁止
      workflowSnapshot/inputs/workgroupConfigJson/refClosureJson 完整载入；冻结 workgroup name 的
      projection/search 共用 `json_valid/json_type` fail-soft expression；execution clock 进新 strict wire。
- [x] **RFC-244-T10 authorized tree query**：ACL-only authorized CTE；ownership/search/view self matches；
      可见祖先闭包、unauthorized/dangling root、context/match count；root global plan 与 child bounded-
      subtree plan 分离，分别 keyset page，坏环防御。
- [x] **RFC-244-T11 facets/enrichment + dirty truth**：facets 只在 root conditional aggregate；Owner、
      alert、failure code、direct authorized child count 按页批量补齐；member before/after audience、
      awaited revalidation 后的 member-change、alert resolved 通知与 parent cascade 的逐 task frozen
      delete audience 广播，无冻结窗口丢帧、N+1 或权限泄漏。
- [x] **RFC-244-T12 static route**：在 `/:id` middleware 前挂 `GET /api/tasks/page`，route response
      过 strict schema；legacy `/api/tasks` wire 与 tests 零变化。
- [x] **RFC-244-T13 backend verification**：ACL-vs-scope/context、unauthorized/dangling、corrupt JSON、
      search/filter/view/facet/cursor/tie/member audience/delete cascade audience/alert resolved/cycle/
      projection/query-plan/legacy matrix；锁住 member event 在 revalidation 完成前不发、完成后可达及
      异常 fail-closed；20k 数据下记录 1 root + 20 child expansions 非 flaky benchmark。

### PR 批次 2 · Frontend UX

- [x] **RFC-244-T14 URL state + operations data/sync hooks**：扩 `TasksSearch` canonicalizer；新增独立
      `['task-operations']` root/child `useInfiniteQuery`、explicit load more、id de-dupe；
      `useTaskOperationsSync` 仅 dirty/banner，用户或 15s 原子重建，reconnect/disconnected fallback。
- [x] **RFC-244-T15 toolbar**：四业务视图 + facet、search、公共 `Dialog` filter、状态使用既有
      `MultiSelect(allowCustom=false)` 默认 searchable combobox、active count、clear；移除原始 status
      chip 行和 top/all child scope；scope 用「我参与的/与我共享/全部归属」；zh-CN/en-US 完整。
- [x] **RFC-244-T16 dense record grid**：nested-list row 的任务/执行/时间/Owner/展开五列；主体/repo/
      id/source 合并 metadata；RFC-207 running clock helper；公共 `OwnerLabel.wrap` 最小扩展使 display/
      unique identity 正文可换行；普通父行 56px、子行 48px `min-height`。
- [x] **RFC-244-T17 unified tree**：context ancestor 自动展开、manual collapse 优先、unauthorized/
      dangling parent 中性态、递归 child pagination、分支内 loading/error/retry；删除前端 parent probe。
- [x] **RFC-244-T18 responsive/a11y**：原生 nested `<ol>/<li>` + 稳定 branch id/sr-only field labels；
      ≤720px 同 DOM 单列 reflow、44px expand、无列表横向滚动；原生主 link、focus restore、managed
      live-region、soft keyboard、VoiceOver/键盘场景；不使用半套 treegrid/native table sibling tree。
- [x] **RFC-244-T19 frontend verification**：URL/tab/filter/search（含状态 MultiSelect label/value 键盘搜索）/
      tree/pagination/error/long content/Owner/row-nav/WS/dedupe/i18n/axe 与 CSS source locks。

### PR 批次 3 · Acceptance / 门禁 / 收尾

- [x] **RFC-244-T20 Playwright seed**：30+ task、八状态、alert、scheduled、三层树、父未授权 child、
      异常 dangling、admin shared-scope context 反例、大量 siblings、长内容与深层 child-only search。
- [ ] **RFC-244-T21 browser/visual**：1280×800、390×844、390×568；无横向 overflow、紧凑行、
      filter/keyboard/touch、搜索恢复、root/child load more、错误恢复；按 `visual-contract.md` 核对统一
      surface、左侧展开/右侧详情提示、inset child well 与单行任务名；更新 hosted-Ubuntu 基线。
- [x] **RFC-244-T22 full gates**：运行完整 typecheck、lint、test 与 format check；失败按 ownership
      归因，不能用定向绿冒充全量绿。完整命令：
      `bun run typecheck && bun run lint && bun run test && bun run format:check`。
- [ ] **RFC-244-T23 实现门**：对已固定 SHA 审核 backend/frontend/API/ACL/pagination/mobile/a11y/negative
      paths；P0/P1 全修，P2 修复或登记后复跑受影响门禁。
- [ ] **RFC-244-T24 文档收口**：proposal/design/plan 与真实行为同步，`design/plan.md`/`STATE.md`
      更新为 Done，记录 exact SHA、测试、浏览器与 gate 证据。

本地交付记录：T6–T20 与 T22 已完成。T21 尚差 hosted-Ubuntu screenshot baseline 与 Safari
VoiceOver 人工走查；用户已授权精确提交，T23 将对固定 SHA 执行，不能用工作区预门代替；T24 因此
保持未完成。当前预门记录见
[implementation-gate-2026-08-01.md](./implementation-gate-2026-08-01.md)。

## 依赖顺序

```text
T1 → T2 → T3 → T4 设计门 → T5 用户批准
                         ↓
T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13
                                            ↓
T14 → T15 → T16 → T17 → T18 → T19
                                  ↓
T20 → T21 → T22 → T23 实现门 → T24
```

T6–T13 可在同一批次内部先写 schema/fixture，再写 service；T14 不得在 T12 可用前合入。T16/T17
必须同批完成，不能先删除旧 scope toggle 却让可见 child 失去入口。

## 验收清单映射

| Proposal AC                         | 实施任务                    |
| ----------------------------------- | --------------------------- |
| AC-1 业务视图与单源状态             | T6、T11、T15、T19           |
| AC-2 URL 搜索/筛选                  | T8、T14、T15、T19           |
| AC-3 有界服务端分页                 | T8、T10、T12、T13           |
| AC-4 cursor / 实时去重              | T10、T14、T19               |
| AC-5 统一树 / context               | T10、T17、T19、T21          |
| AC-6 ACL / scope / unavailable 边界 | T8、T10、T13、T17、T23      |
| AC-7 56/48px 与 Owner               | T16、T18、T19、T21          |
| AC-8 mobile 无 overflow             | T18、T21                    |
| AC-9 反馈与恢复                     | T14、T17、T19、T21          |
| AC-10 lightweight / no N+1          | T9、T11、T13、T23           |
| AC-11 dirty / alert / delete 真值   | T6、T11、T13、T14、T19、T23 |
| AC-12 legacy 兼容                   | T12、T13、T22               |
| AC-13 门禁与文档                    | T20–T24                     |

## 不变约束

- 所有 tree/facet/search/count/enrichment 必须以 ACL-only authorized task set 为上游；ownership scope
  仅筛 self-match，不得把 authorized parent 伪装成 unavailable。
- 旧 `GET /api/tasks`、TaskSummary、TaskListItem、详情、overview、scheduled history 与既有 WS message
  形状不改；仅 additive member-change/alert-resolved 通知和非序列化 audience context。
- `TaskListItem.childCount` 保留直接可见 child 语义；query-specific 展开数使用新字段，不偷换旧字段。
- attention 与 `openAlertCount` 共用 unresolved lifecycle alert 口径；无 JS 二次定义。
- 不显示动态执行的虚假 `N/M` 或百分比；只显示持久化真实状态、告警、失败摘要和计时。
- list SQL 不选择大 JSON；冻结 workgroup JSON 先 `json_valid/json_type` fail-soft；no N+1；limit 默认
  50、最大 100；root 与 child 都 keyset，但 child plan 不算 global facets。
- parent 不可用合并 unauthorized/dangling；正常 delete 级联移除后代并逐 task 发 frozen-audience dirty
  signal；前端不 probe、不展示父投影或 dead link。
- operations query key 与 legacy `['tasks']` 分离；task/alert event 只标 dirty，用户或 15s 后整棵重建，
  不做局部 payload 猜测。
- 56/48 是 ordinary-content `min-height` 目标，不是固定裁切；Owner 唯一 identity 保持可见、可换行。
- ≤720px 不把 desktop 宽表简单塞进 horizontal scroller；主要触控目标至少 44px；原生 nested list
  DOM 跨 breakpoint 不变。
- 所有新 UI 文案 zh-CN/en-US 同批落地；状态多选复用 `MultiSelect`，只复用/扩公共组件，不手写
  checkbox/popover/table 平行 chrome。
- shared `main` 保留他人 WIP；精确 path staging，不碰现有并行视觉基线改动。

## 风险登记

| 风险                                           | 缓解                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| scope 被误当 ACL 导致 context/可见性错误       | ACL-only authorized set；scope 仅 self-match；admin shared-scope 反例锁                                             |
| child 展开倍增全局递归/facet 查询              | root/child 独立 plan；child 先 parent index 限 subtree、无 facets；1+20 benchmark                                   |
| corrupt frozen config 拖垮整页                 | `json_valid/json_type` fail-soft expression；default/search/legacy parity tests                                     |
| 成员/删除/alert resolve 无法使 operations 回真 | member audience union + awaited revalidation 后广播、alert-resolved、cascade frozen audience、dirty hook + fallback |
| context 分支与 sibling cursor 漏/重            | branchStartedAt + id keyset；actor/filter-bound cursor；id 去重；dirty 后整棵重建                                   |
| 列表 mapper / running clock 漂移               | new strict wire；纯 helper；legacy 公共字段与 corrupt/clock parity tests                                            |
| substring 搜索全扫描                           | lightweight projection、composite index、20k 1+N benchmark；FTS 另立 RFC                                            |
| 密集行损伤移动端/a11y                          | native nested list；min-height 非 fixed；44px；390×568/844 + axe/VoiceOver/keyboard                                 |
| 新 endpoint 与旧 consumers 互相影响            | 静态新 route、旧 endpoint byte-compatible；独立 query key；frontend 可切回 legacy                                   |
| 0128 重复 index 增加写放大                     | query-plan 证明覆盖后在同迁移删除被完整前缀覆盖的旧 index                                                           |

## 提交与发布边界

- RFC 正式批准才授权实现；批准本身不授权 commit、push 或发布。
- 实施时只提交 RFC-244 精确路径；任何并行 WIP 都不修改、不暂存、不清理。
- 发生实际 commit 时，按 AGENTS.md 为真实参与的模型添加非重复 `Co-Authored-By` trailer，并在
  push 前用 `git show -s --format=%B HEAD` 核验。
- 不 amend/rebase/force-push shared history；push 与 exact-SHA CI 需另有用户授权并单独报告。
