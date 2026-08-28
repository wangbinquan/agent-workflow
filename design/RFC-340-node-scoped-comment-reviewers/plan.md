# RFC-340 实施计划 — 节点级意见型评审人授权与配置

状态：In Progress；T2～T8 候选实现与定向验证完成，T9～T11 等待 RFC-338 发布、最终全门、推送与 exact-SHA CI。

current-source：`5128efad55ba55fc95205c6dfd9b148916a181d1`

## 1. 实施原则

1. 只在共享 primary checkout 的 `main` 上开发；精确维护本任务路径，保留 RFC-338 / RFC-339 等并发产物。
2. 用户明确批准 proposal D1～D14 和本计划 T2～T11 前，不改 production schema / backend / frontend / MCP / E2E。
3. reviewer assignment、access matrix 与 comment capability 的唯一 owner 是 `modules/collaboration`；route / MCP 不复制策略。
4. 只扩 assigned reviewer 的节点级意见能力；owner / collaborator / observer / admin 的 current-source 功能逐项保持。
5. selection 与 final decision 不接 reviewer；RFC-333 decision / continuation transaction 不修改。
6. 所有 UI affordance 与 backend capability 同步，包含键盘、窄屏、轮询和失败态，不以“按钮点后 403”作为正常交互。
7. 实现门只检查功能与明确的架构归属，不新增安全策略或无关限制。
8. 本地只跑与候选内容成比例的 targeted gates；最终全仓结论以 exact-SHA hosted CI 为准。

## 2. 任务分解

### T0 — current-source 调研与 RFC 三件套（Done）

- [x] fetch `origin/main`，确认 `main == origin/main == 5128efad5`；
- [x] 读取 `CLAUDE.md`、`STATE.md`、RFC-294 与 review / task-collab current source；
- [x] 追踪 task membership → review routes → review service → shared schema → single / multi-doc UI；
- [x] 对账 RFC-036 单人决策型 assignment 被 RFC-099 删除的历史；
- [x] 对账 RFC-324 observer、RFC-326 REST / MCP、RFC-333 decision transaction；
- [x] 与用户锁定 reviewer 只能看 assigned node、只能写 / 维护自己的意见、不能 selection / final decision；
- [x] 起草 proposal / design / plan 并登记 `design/plan.md` / `STATE.md`。

### T1 — 用户批准门（Done）

- [x] 用户明确批准 proposal D1～D14；
- [x] 用户批准 T2～T11 的 production 实施；
- [x] 确认“独立页面 `/tasks/:taskId/reviewers` + 完整替换”的交互范围；
- [x] 确认本轮不包含 quorum / 通知 / assignment MCP / task-wide reviewer visibility。

退出：收到明确批准；若产品裁决变化，先更新 RFC 再实施。

### T2 — source refresh、characterization 与 contracts（Done）

- [x] 开工前重新 fetch / sync 并记录 live source；
- [x] 复核并发 RFC-338 / RFC-339 对 review route、DB schema、server composition 与 task-execution public entrypoint 的影响；
- [x] 固定 owner / collaborator / observer / admin current capability matrix；
- [x] 固定 list / pending count / detail / versions / rounds 与 single / multi-doc current wire；
- [x] 固定 comment own-only、owner/admin manage-any、decision / selection member gate；
- [x] 增 reviewer capability matrix 与“reviewer 不进入 task collaborators / decision”durable tests。

退出：existing characterization 全绿；新增 reviewer contract 仅因 production 尚未实现而 red。

### T3 — migration 与 shared contracts（Done）

- [x] 按共享树当前 next available 编号新增 `review_node_reviewers` 与两条 indexes；
- [x] Drizzle schema / migration journal 同步，migration chain check 通过；
- [x] 新增 config request / response schemas、ReviewAccessScope / ReviewCapabilities；
- [x] 新增 ReviewAuthorRole，只扩 comment attribution；
- [x] shared schema tests 与 in-memory full migration chain 通过；
- [x] 确认无 backfill、无 `task_collaborators` role 变化。

退出：新旧 DB 均能启动；shared contract tests 全绿；current comment / decision wire 兼容。

### T4 — collaboration domain、ports 与 access query（Done）

- [x] 建 review relationship / capability pure domain policy；
- [x] 建 ReviewerStore / ReviewTaskAccess ports；
- [x] task-execution 增 narrow public review-node catalog 与 gate-subject read models；
- [x] sqlite reviewer store + bootstrap composition adapter；
- [x] `getReviewNodeReviewerConfig` / `replaceReviewNodeReviewers`；
- [x] `resolveReviewAccess` 单节点 query + actor-visible batch query；
- [x] public commands / queries / types exact exports；
- [x] no-relation / observer / reviewer / collaborator / owner / bypass 与历史 run identity tests；
- [x] architecture guard 确认 collaboration application 无 legacy service / task-execution internal import，route 不读 assignment table。

退出：assignment / access 只有 collaboration 一个 owner；pure + integration tests 全绿。

### T5 — reviewer 配置 HTTP 面（Done）

- [x] GET `/api/tasks/:taskId/reviewers`；
- [x] PUT `/api/tasks/:taskId/reviewers` full replace；
- [x] 复用 owner / resource-acl bypass 管理口径；
- [x] active user、unknown / disabled user、duplicate、non-review node、empty set 验证；
- [x] canonical response 顺序与错误映射；
- [x] assignment add / remove / re-add / task delete cascade tests。

退出：owner/admin 完整管理；collaborator/observer/reviewer 不可配置；无 assignment MCP。

### T6 — review reads、comments 与 MCP 接入（Done）

- [x] list / pending count 在分页前 union task-visible + assigned node；
- [x] detail / versions / version detail / rounds 接单一 access query；
- [x] detail 返回 actor capabilities；
- [x] comment POST 接 `requireReviewCommenter`，reviewer role snapshot 正确；
- [x] comment PATCH 接 reviewer own-only；DELETE 明确拒绝 reviewer，并保留 existing task-member rule；
- [x] selection / decision / decision-batch 保持 acting task member / admin gate；
- [x] RFC-326 MCP tools 继续 dispatch 同一 REST route，route/tool 双向映射架构测试通过；
- [x] RFC-326 全 MCP 执行回归：RFC-339 补齐 dispatcher bootstrap 注入后 15 tests / 145 expects 全绿；
- [x] assigned / sibling node、pending / historical run、removed / re-added assignment tests。

退出：assigned reviewer 只有节点级 read + comment；所有 decision mechanics 与旧角色能力不变。

### T7 — 独立 reviewer 配置页（Done：本地 DOM；hosted browser 待 T9）

- [x] 注册 `/tasks/:taskId/reviewers` route；
- [x] task detail 对 `canManage` actor 显示入口；
- [x] PageHeader / Field / UserPicker / chips / EmptyState 组合；
- [x] 常驻解释 reviewer 的节点级、意见型边界；
- [x] 已有 task member 显示关系 chip，并解释重叠角色能力取并集；
- [x] 完整 map load / edit / save / canonical rehydrate，并给出保存成功反馈；
- [x] pending、server error、retry、empty node 与共享 picker 交互；
- [x] i18n 中英；
- [x] responsive 390px CSS、DOM remove/save/click 与共享 picker keyboard/focus contracts；本地 Browser Use 被 URL policy 拒绝 localhost，
      不绕行，真实浏览器由 hosted UI gate 验证。

退出：owner/admin 能直觉地按节点维护集合；无权 actor 不出现入口；规则不是只藏在 disabled button 后。

### T8 — review UI capability cutover（Done）

- [x] single-doc / multi-doc 消费同一 capabilities；
- [x] comment edit 只对 author 或 manage-any actor 显示；reviewer 不显示 delete；
- [x] reviewer comment composer 可用，selection / decision controls 不渲染；
- [x] Q/W、decision hotkeys 与 dialogs 按能力不注册；
- [x] review-node scope 显示 plain task label，不链接 task detail；
- [x] review-node scope 不发 task queries、不连 task WS；
- [x] single / multi-doc 统一 8 秒 polling，local mutation 后即时 invalidate；
- [x] reviewer attribution chip 与既有 role chip 兼容；
- [x] historical / decided mode 继续全只读；节点权限被 403/404 撤销时丢弃 reviewer-only cached body。

退出：源码、DOM、键盘和真实点击四层都不存在 reviewer selection / decision 入口；owner/collaborator UI 不回退。

### T9 — 多用户 E2E 与功能回归（Pending hosted browser）

- [ ] owner 按两个 review nodes 配置不同 reviewer sets；
- [ ] reviewer inbox / pending count 仅含 assigned nodes；
- [ ] 看所有意见、加意见、改自己、不能删意见或改他人；
- [ ] 不能看 task detail / sibling review，不能 selection / decision；
- [ ] collaborator 读取全部意见并 iterate / approve；
- [ ] assignment removal 后入口 / 直链 / 写能力撤销，历史意见保留；
- [ ] future round 自动继承集合；
- [ ] 390px keyboard / focus / field error 与 1280px 主旅程；
- [ ] existing owner/collaborator/observer review journeys 全绿。

退出：AC-1～AC-14 都有 durable automated assertion，关键 UX 有真实浏览器证据。

### T10 — targeted gate 与功能实现门（In Progress）

- [x] shared / backend / frontend targeted tests；
- [x] targeted lint / format、migration check、shared/frontend/backend typecheck；
- [ ] migration upgrade + compiled binary smoke（若候选影响）；
- [ ] review / MCP / task-collab E2E；
- [x] 只审功能的实现门：能力矩阵、节点范围、历史、UI、无 decision bypass、existing behavior；
- [ ] RFC-338 / RFC-339 发布后重跑完整 architecture / backend typecheck（MCP 已在 RFC-339 候选上通过）；
- [ ] `git diff --check` 与 task-owned path / concurrent output 最终复核；
- [x] RFC AC → test traceability 表。

退出：candidate content 不再变化，targeted gate 全绿，0 个未解决功能 finding。

### T11 — 文档、发布与 exact-SHA CI（Pending；另需提交 / 推送授权）

- [ ] proposal / design / plan 更新实施事实和测试证据；
- [ ] `design/plan.md` / `STATE.md` 更新为 In Progress / Done；
- [ ] 进入共享 index publication critical section，确认 cached entries 只含明确交付集；
- [ ] exact-path commit，包含实际 AI co-author trailer 并复核 message / path list；
- [ ] 经用户授权后 fetch / sync / push；
- [ ] 验证 remote ancestry 与 `main == origin/main`；
- [ ] 等 exact-SHA main CI 及相关 scheduled workflow terminal success；
- [ ] CI 失败只修与本 RFC 有关的功能问题，候选变化后做成比例复验；
- [ ] 全部证据闭合后置 Done。

退出：AC-15 满足；若提交 / 推送未授权，明确保持本地 Draft / In Progress，不冒充交付完成。

## 3. AC → 测试追踪（实施时填写）

| AC           | 自动化证据                                                     | 状态    |
| ------------ | -------------------------------------------------------------- | ------- |
| AC-1～AC-2   | shared 4 + backend config HTTP / no-membership / cascade       | Passed  |
| AC-3～AC-4   | assigned-vs-sibling list/count + current/history access        | Passed  |
| AC-5～AC-7   | reviewer add/role/own-edit/delete/selection/decision HTTP      | Passed  |
| AC-8～AC-10  | frontend capability/config/revocation DOM；hosted browser 待跑 | Partial |
| AC-11～AC-13 | owner-only config + remove/re-add + exhaustive role union      | Passed  |
| AC-14        | RFC-317 本 RFC R2 边已清零；全门待并发候选收口                 | Partial |
| AC-15        | exact-SHA hosted CI                                            | Pending |

## 4. 当前停点

T2～T8 候选已完成且本 RFC 定向断言通过。RFC-339 已闭合 dispatcher bootstrap 漏接，backend typecheck 与 RFC-326 MCP suite
（15 tests / 145 expects）均已通过；共享 index 为空、`main == origin/main == 5128efad5`。工作树中的 RFC-338 / RFC-339 仍未发布，
并会更新本 RFC 也需要的 migration journal、schema、task-execution read models、server 与 i18n 等共享文件。按 shared-main 规则不暂存、
不代交、不回滚这些并发产物；待其发布后 fast-forward / revalidate，再执行 T9～T11 的 hosted browser、exact-path commit、push 与
exact-SHA CI。
