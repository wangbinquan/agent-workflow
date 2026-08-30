# RFC-340 实施计划 — 节点级意见型评审人授权与配置

状态：Done（2026-08-30）；D1～D14、T0～T11、AC-1～AC-15 与 published exact-SHA hosted closeout 已完成。

开工 source pin：`5128efad55ba55fc95205c6dfd9b148916a181d1`

Implementation commits：`0bde4f3e64ace65db4293d516916288164641ab3`、
`ec73490a92a62390d816c2d8526184f41556dc2a`、`761598e9877af7fa7ccf67c4b64d5f9e87f12012`。

Published containing exact SHA / Main CI：`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` / `33298828254`
（terminal success）。

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

### T7 — 独立 reviewer 配置页（Done）

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

### T9 — 多用户 E2E 与功能回归（Done）

- [x] owner 按多个 review nodes 完整替换不同 reviewer sets；
- [x] reviewer inbox / pending count 仅含 assigned nodes；
- [x] 看所有意见、加意见、改自己、不能删意见或改他人；
- [x] 不能看 task detail / sibling review，不能 selection / decision；
- [x] collaborator 读取全部意见并 iterate / approve；
- [x] assignment removal 后入口 / 直链 / 写能力撤销，历史意见保留；
- [x] future round 自动继承集合；
- [x] 390px keyboard / focus / save / overflow 与 canonical 1280px 浏览器矩阵；
- [x] existing owner/collaborator/observer review journeys 全绿。

证据按真实边界拆分：backend HTTP / domain matrix 承担多 actor、节点隔离、意见作者、撤权、历史 / future round 与 decision refusal；
frontend DOM/source locks 承担 capability controls、keyboard、task link / query / WS 与 cache；`review-multidoc-round-history.spec.ts` 以真实
owner 会话命中配置 GET/PUT，`ux-consistency.spec.ts` 以 390px 真实浏览器完成深链、UserPicker、保存与 overflow。全量 hosted E2E
承担既有旅程回归；不把这些组合证据写成一条不存在的单体多用户 spec。

退出：AC-1～AC-14 都有 durable automated assertion，关键 UX 有真实浏览器证据。

### T10 — targeted gate 与功能实现门（Done）

- [x] shared / backend / frontend targeted tests；
- [x] targeted lint / format、migration check、shared/frontend/backend typecheck；
- [x] migration upgrade + compiled binary smoke；
- [x] review / MCP / task-collab E2E；
- [x] 只审功能的实现门：能力矩阵、节点范围、历史、UI、无 decision bypass、existing behavior；
- [x] RFC-338 / RFC-339 发布后完整 architecture / backend typecheck 与 hosted backend 8/8；
- [x] `git diff --check` 与 task-owned path / concurrent output 最终复核；
- [x] RFC AC → test traceability 表。

退出：candidate content 不再变化，targeted gate 全绿，0 个未解决功能 finding。

### T11 — 文档、发布与 exact-SHA CI（Done；共享索引回填另走协调临界区）

- [x] proposal / design / plan 更新实施事实和测试证据；
- [x] `design/plan.md` / `STATE.md` 在 implementation publication 期间保持 RFC-340 In Progress，最终 Done 翻转登记为共享 closeout；
- [x] 每次进入共享 index publication critical section前确认 cached entries 只含明确交付集；
- [x] implementation exact-path commits 包含实际 AI co-author trailer并复核 message / path list；
- [x] 经用户授权后 fetch / sync / push；
- [x] 验证三条 implementation commits 是 published exact SHA 的祖先；
- [x] 等 containing exact-SHA Main CI 与 8 条 scheduled workflow terminal success；
- [x] 逐个 successor 只修精确 hosted failure，候选变化后重新执行同 SHA 全门；
- [x] AC-1～AC-15 全部证据闭合后置 Done。

退出：AC-15 已满足。RFC 自有三件套在独立 docs critical section收口；共享 `design/plan.md` / `STATE.md` 因 RFC-347/348
并发 WIP 不整文件代交，由各 owner 稳定交接后的短共享 closeout 临界区翻转，不改变本 RFC 已发布的功能与 hosted verdict。

## 3. AC → 测试追踪（实施时填写）

| AC    | 自动化证据                                                           | 状态    |
| ----- | -------------------------------------------------------------------- | ------- |
| AC-1  | shared reviewer config schema + backend full-replace HTTP            | Passed  |
| AC-2  | no-membership + task-delete cascade                                  | Passed  |
| AC-3  | assigned-vs-sibling list / pending-count                             | Passed  |
| AC-4  | current + historical node access                                     | Passed  |
| AC-5  | reviewer add-comment + author-role HTTP                              | Passed  |
| AC-6  | own-edit / other-edit / delete refusal HTTP                          | Passed  |
| AC-7  | selection / decision refusal HTTP                                    | Passed  |
| AC-8  | frontend capability-driven single/multi-doc DOM + hosted E2E          | Passed  |
| AC-9  | no task link/query/WS + polling/cache source/DOM locks                 | Passed  |
| AC-10 | 390px hosted deep-link/UserPicker/save/overflow + 1280px matrix       | Passed  |
| AC-11 | owner/admin-only config + invalid relationship cases                 | Passed  |
| AC-12 | remove / re-add access lifecycle                                     | Passed  |
| AC-13 | exhaustive owner/collaborator/observer/reviewer/admin union          | Passed  |
| AC-14 | RFC-317/canonical architecture locks；collaboration owner 边归零       | Passed  |
| AC-15 | `c5c4faaf...` Main CI + 8 scheduled workflows                        | Passed  |

## 4. 实际 publication 与 hosted closeout

| stage                          | commit / run                                                                                          | 结果                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| core implementation            | `0bde4f3e64ace65db4293d516916288164641ab3`                                                            | assignment、collaboration policy、REST/MCP、review UI、migration/contracts/tests      |
| reviewer page styles           | `ec73490a92a62390d816c2d8526184f41556dc2a`                                                            | dedicated config layout、status chips、sticky actions、390px controls                 |
| MCP/bootstrap joint seam       | `761598e9877af7fa7ccf67c4b64d5f9e87f12012`                                                            | REST/MCP 共享 composed deps 与 bootstrap-owned collaboration context                 |
| containing exact SHA           | `c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68`                                                            | 三条 implementation commits 均为其祖先                                                |
| Main CI                        | `33298828254`                                                                                         | static/build/frontend/backend 8/8、三平台 Playwright、required aggregator 全部 success |
| e2e full / WebKit              | `33298851279` / `33298852761`                                                                         | 两条完整矩阵 terminal success                                                         |
| evidence / git / runtime       | `33298851076` / `33298851691` / `33298851086`                                                         | terminal success                                                                      |
| maintenance / visual / Windows | `33298851934` / `33298851050` / `33298851033`                                                         | terminal success                                                                      |

定向证据为 shared 4、backend reviewer/comment 20（77 expects）、frontend review/config 52、RFC-326 MCP 15（145 expects），并包含
rolling migration、三端 typecheck、lint/format、architecture 与 `git diff --check`。hosted browser 以真实 owner 配置 API 命中、390px
配置 UI 和全量现有评审旅程组合闭合；actor/节点/意见/撤权/禁止 decision 的穷尽矩阵由 durable backend/frontend tests 负责。

RFC-340 据此 Done。共享 RFC 索引与 `STATE.md` 的最终状态翻转仍遵守共享文件 owner 交接，不回滚或代交 RFC-347/348 并发 WIP。
