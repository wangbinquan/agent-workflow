# RFC-250 · 实施计划：前端交互完整性与一致性

- 状态：Implementation Complete / Publication In Progress（本地实现闭环；T46 远端发布门执行中）
- 日期：2026-08-03
- 交付方式：同一 RFC 分三批，每批测试先行、独立验收；用户已授权完成后精确提交并上库

## 0. 硬门与顺序

- [x] **RFC-250-T0**：完成全前端源码、共享组件、真实桌面/390px 关键流程审计，形成 P1/P2 清单。
- [x] **RFC-250-T1**：核对 RFC-169/198/199/211/235/246/247/249 所有权，写 proposal/design/plan。
- [x] **RFC-250-T2**：完成独立只读设计门，修订全部 P0/P1，记录
  [0 P0 / 0 P1 最终结论](./design-gate-2026-08-03.md)。
- [x] **RFC-250-T3**：取得用户在看到设计门结果后的明确批准（2026-08-03）；批准前未修改 production code。
- [x] **RFC-250-T4**：B1 开始前已复核 `STATE.md`、工作树和并行所有权；只改本批精确路径。

依赖规则：

1. `/repos` URL tab / dirty finding 原由 RFC-249 T31–T36 接收；用户在最终验收中明确报告
   `/repos?tab=repos` 无法切换到 Memory 后，本轮按该显式反馈补了 RFC-249 关闭增量：只修改
   `routes/repos.tsx` 的 canonicalizer 边界与关闭态 editor 挂载，不修改 `RepoGroupEditor.tsx` 或 visual
   baseline，也不把 RFC-249 整体冒充 Done。
2. RFC-249 若仍在修改 `routes/tasks.new.tsx`，B1 的 Task Wizard 子批后置到其最终 SHA 同步；其他 B1
   任务可以先做。
3. Intent answer projector、action gate、mutation ledger、unknown outcome、语义 timeline 与 source binding
   全部归 RFC-235；RFC-250 不修改 Intent production，只提交可追踪 finding。
4. Onboarding 三卡/四线、raw-click outcome 与完整路线归 RFC-211 follow-up；RFC-250 不新增 Skill 路线。
5. 任一批发现需要 DB/wire/ACL/lifecycle 变化，暂停该项并回到 RFC 设计门，不在前端猜状态。

## 1. B1 — 状态完整性与结果可信

### B1.0 公共红测与最小原语

- [x] **RFC-250-T5**：补 Dialog 高风险 dismiss 与 `UnsavedChangesGuard` save-and-proceed
  backward-compatible contract 红测；双向焦点、嵌套/portal 测试留在 B2 T33，与实现同批转绿。
- [x] **RFC-250-T6**：补版本化 draft envelope、dirty submitted-snapshot、Clarify generation、Inbox
  partial projection、Scheduled run-now eligibility 纯函数红测。
- [x] **RFC-250-T7**：如 OIDC/RepoGroup modal 需要，基于 `ConfirmDialog` 增加最薄的 discard-confirm 组合；
  禁止新增 overlay/CSS chrome 或全局 mutation store。

### B1.1 PAT

- [x] **RFC-250-T8**：把 PAT 创建收敛为 editing/creating/revealed/outcome-unknown/closed 状态机；creating
  锁 Esc/overlay/×/Cancel/重复 submit，并用 `classifyWriteOutcome` 区分 definitive/unknown。
- [x] **RFC-250-T9**：reveal 只允许显式 Done 关闭；复制反馈可读；token 创建成功后列表 refresh 失败不丢
  secret；POST unknown 刷新 inventory、引导检查/撤销且不重发 POST。
- [x] **RFC-250-T10**：reveal/pending 接入站内导航和 beforeunload 保护；显式放弃必须二次确认；补
  keyboard、overlay、Back/refresh、copy failure、5xx/body-read timeout/force-leave 后 marker 恢复测试。

### B1.2 草稿与长表单

- [x] **RFC-250-T11**：在 RFC-249 对 `tasks.new.tsx` 的所有权释放后，实现 Task Wizard strict
  session draft、seed barrier、恢复/放弃、File metadata/reselect、成功/登出清理、guard，以及非幂等
  create/save 的 `classifyWriteOutcome` + unknown reconciliation。
- [x] **RFC-250-T12**：覆盖 new/deep-link/relaunch/editScheduled/tour、异步 refetch 不 rebase、写 storage
  失败、credentialed URL/secret input 不落盘、pending 全 material controls 冻结、失败保留与成功导航同步
  clear；另覆盖 POST 5xx/transport/body-read timeout 后 frozen draft 保留、inventory reconcile、零盲重试。
- [x] **RFC-250-T13**：OIDC provider 表单接 dirty baseline + discard confirm；save/test 互斥 pending，
  pending 锁 dismiss；edit 空 secret 保持原 secret，连接测试不清 dirty。
- [x] **RFC-250-T14**：把 RepoGroupEditor residual dirty（含瞬时目录名/批量 URL）作为 exact finding
  写入 RFC-249 T31–T36；RFC-250 不改该组件，以接收证据关闭。

### B1.3 Clarify

- [x] **RFC-250-T15**：提取 Clarify local/server generation reducer、串行 IDB writer 与 per-question
  single-flight server queue；最后一次本地编辑不再被 debounce cleanup 丢弃，server ack 只在最新 fulfilled
  后推进。
- [x] **RFC-250-T16**：实现“保存中 / 已保存 / 已保存在本机尚未同步 / 保存失败”投影、retry 与
  Save-and-leave；后者只等待/承诺 IDB，reject 留页，beforeunload 不承诺异步 flush。
- [x] **RFC-250-T17**：让 detail 与 `CentralizedAnswerDialog` 复用同一 durability 定义；补 rapid type→
  navigate/unmount、server 403/409、瞬时网络错、late ack、新编辑、submit success 清理测试。

### B1.4 Mutation 与聚合状态

- [x] **RFC-250-T18**：Memory archive/delete 改用 fulfilled 才关闭的公共确认合同；unarchive/全部失败
  显示 ErrorBanner，target-scoped pending/error/retry 与 selection 更新正确。
- [x] **RFC-250-T19**：首页 Inbox 复用现有 inbox view-model 或抽其公共纯投影，锁两源 success/loading/
  partial/all-failed 真值表；partial 不显示假空态或完整 count。
- [x] **RFC-250-T20**：Scheduled 列表/详情复用 eligibility + confirm action；三类 degraded reason、
  disabled schedule 可手动运行、历史失败可运行、pending/error/success 两处一致。
- [x] **RFC-250-T21**：把 Intent 裸 JSON、archived action 和未渲染 mutation error 的源码/负向场景记录
  到 RFC-235 T5/T7；RFC-250 不补临时 production/test projector。

### B1 验证

- [x] **RFC-250-T22**：运行本批 focused frontend tests、frontend typecheck/lint、`git diff --check`；
  Chromium + WebKit 跑 PAT、Task Wizard、Clarify、Memory、Inbox、Scheduled 真实流程。
- [x] **RFC-250-T23**：人工查看 1280/390 的 pending/error/recovery 截图，确认输入与一次性 secret 无静默
  丢失后，记录 B1 交付证据；不得提前勾 B2/B3。

## 2. B2 — 共享交互、键盘与复杂画布

### B2.1 Dialog / Select / controls

- [x] **RFC-250-T24**：实现 Dialog 默认初始焦点 resolver 与 Tab direction-aware focus trap；显式 safe
  initial focus 接入 Confirm/Unsaved 场景，保留 topmost stack、portal ownership、restore fallback。
- [x] **RFC-250-T25**：Select 的 open/Arrow/Home/End/typeahead 全部跳过 disabled；过滤后校正 active，
  无 enabled option 时移除 `aria-activedescendant`、Enter/Space no-op 并显示准确空态。
- [x] **RFC-250-T26**：Checkbox/Switch 在 coarse pointer/≤720px 扩大 wrapper 到 44×44；disabled button/
  switch 清除 hover 位移、强调和阴影；不制造邻项 hit-area overlap 或页面 overflow。

### B2.2 复合导航与反馈

- [x] **RFC-250-T27**：重构 ChangeReview sidebar 语义边界；group header、file selector、viewed checkbox
  各自接收原生/规定按键，Arrow/Home/End 不截获异类 descendants。
- [x] **RFC-250-T28**：AgentForm、Workgroup detail 等审计命中点改用 ErrorBanner/NoticeBanner +
  FeedbackStack；新增 source ratchet 禁止裸 `.error-banner` 回归。
- [x] **RFC-250-T29**：PAT permission matrix 390px 改成无无提示裁切的分组布局或显式 TableViewport；全部
  scope 可发现、可聚焦、可点击。

### B2.3 Workflow

- [x] **RFC-250-T30**：实现 pure camera planner 与 readable-focus/overview 模式；只在初次 identity 或
  显式命令控制相机，不因 refetch/resize 抢夺用户视口；只对 editable editor 启用，不改变 task/workgroup
  read-only preview。
- [x] **RFC-250-T31**：低于 action threshold 隐藏随画布缩成微点的 inline controls，保留 screen-space
  Add/搜索/定位/放大；可见 edge/wrapper action 满足 desktop 24px、coarse 44px 实测命中区。
- [x] **RFC-250-T32**：恢复 PageHeader Validate secondary，复用现有 exact-save/validate handler，结果
  focus ValidationPanel；Launch 保持唯一 primary 与 fresh validation。

### B2 验证

- [x] **RFC-250-T33**：组件测试覆盖 Dialog 正反向循环、内部 Tab 后程序化外逃、嵌套/portal、Select
  all-disabled、Changes keyboard、mobile controls hit rect 与 blocker roles。
- [x] **RFC-250-T34**：构建 ≥14 nodes 的确定性 Workflow fixture；Chromium + WebKit 在 desktop/390 测
  初始 camera、screen-pixel label、overview/readable handoff、minimap、node/issue focus、inline action rect、
  hidden 0×0 mount 后 reveal、用户 pan 后 refetch 不抢相机与 zoom band 阈值。
- [x] **RFC-250-T35**：运行 axe critical/serious=0 和 B2 visual；人工确认 overview 不会成为不可退出的
  缩略图、readable focus 仍可探索完整图。

## 3. B3 — 集成验证与所有权移交

- [x] **RFC-250-T36**：组合跑 PAT、Task Wizard、Clarify、Memory、Inbox、Scheduled、Dialog/Select/Changes
  与 complex Workflow 的 Chromium + WebKit 真实流程，锁跨组件 feedback/focus/guard 不互相回归。
- [x] **RFC-250-T37**：跑 1280/1024/736/390×844/390×568、coarse pointer、light/dark visual/geometry，
  人工检查长中文、长 Owner、pending/error/partial/overview populated 状态。
- [x] **RFC-250-T38**：为 RFC-235 记录 Intent exact finding；为 RFC-211 follow-up 记录 step-scoped
  `{tourId,stepId,attemptId,kind,resourceId/taskId}` outcome 要求，且明确第四路线需另获批准。
- [x] **RFC-250-T39**：为 RFC-249 T31–T36 记录 `/repos?tab=` 与 RepoGroupEditor dirty finding并验证其 plan
  已接收；最终验收中用户明确报告跨页跳转回归后，按 RFC-249 所有权补最小 production 关闭增量并新增
  Chromium/WebKit 390px 回归，不修改 RepoGroupEditor 内部或 visual baseline。
- [x] **RFC-250-T40**：只在本轮触及文案保持 zh-CN/en-US key parity 和“代理 / 远端仓库 / 所有者”基线；
  全站 glossary 另列 backlog，不做大规模替换。
- [x] **RFC-250-T41**：汇总三项 handoff 的可追踪链接和 B1/B2 证据；handoff production 未完成不冒充
  已修复，也不阻塞 RFC-250 自有 scope 的 Done。

## 4. 总门、实现门与交付

- [x] **RFC-250-T42**：运行 workspace `bun run typecheck`、`bun run lint`、`bun run test`、
  `bun run format:check`、`bun run depcheck` 与 `git diff --check`；不对 `design/**`/`STATE.md` 执行会产生
  全文件噪音的格式化。
  冻结快照的 static、shared full、frontend full 全绿；backend full 的 9 项失败由冻结 HEAD
  `40535c0e` 的 RFC-252 G1 基线回归导致，与 RFC-250 staged paths 无交集，且后继 `9f296872` 已修。
  本地不因移动 `main` 重跑全量，最终发布 SHA 由 T46 exact-SHA CI 复核。
- [x] **RFC-250-T43**：以 `bun run build:binary:e2e` 构建包含 E2E fixture 的真实二进制，完成目标
  Chromium/WebKit、Darwin visual 与人工截图检查。
- [x] **RFC-250-T44**：执行至少一次独立只读实现门；修复所有 P0/P1，并复跑受影响 focused/full gates。
- [x] **RFC-250-T45**：更新 RFC 状态、`STATE.md`、`design/plan.md` 和 AC 证据；逐项标明 pass、dependency
  pending 或明确移交，禁止把未做项写成 Done。
- [x] **RFC-250-T47**：Agent Runtime 字段稳定显示；注册表 loading/error 有 disabled/loading/retry，单一
  enabled runtime 仍可 inherit↔explicit pin，已固定 disabled runtime 可见且可解除；组件测试与 390px
  Chromium/WebKit 保存/重载流程纳入最终二进制门禁。
- [x] **RFC-250-T48**：移动导航抽屉把 focus/pending destination 的 capture 准备与抽屉关闭的 bubble
  完成拆开，确保 TanStack Link 先接管 transition、`UnsavedChangesGuard` 可阻断；桌面与 390px 的
  Stay/Discard/reload 恢复流程均由真实浏览器回归锁定。
- [ ] **RFC-250-T46**：仅在用户另行要求提交/上库后，精确路径 staging，使用真实 AI co-author trailer，
  提交前验证 `git show -s --format=%B HEAD`；push 后验证远端 ancestry、exact-SHA CI 与 hosted visual。
  用户已于 2026-08-03 要求完整实现后提交上库；未完成 T46 不得宣称发布闭环。

## 5. 测试文件建议

复用/扩展既有测试目录，不以本 RFC 名义复制大套 harness：

- `packages/frontend/tests/dialog*.test.tsx`
- `packages/frontend/tests/token-create-dialog.test.tsx`
- `packages/frontend/tests/unsaved-guard.test.tsx`
- `packages/frontend/tests/task-wizard*.test.tsx`
- `packages/frontend/tests/clarify*.test.tsx`
- `packages/frontend/tests/memory*.test.tsx`
- `packages/frontend/tests/inbox*.test.tsx`
- `packages/frontend/tests/scheduled*.test.tsx`
- `packages/frontend/tests/change-review*.test.tsx`
- `packages/frontend/tests/workflow*.test.tsx`
- `e2e/keyboard-flows.spec.ts` 与 RFC-250 专用 flow/visual spec（如既有 spec 过重再新增）

## 6. 完成定义

RFC-250 只有在 T23、T35、T37、T42–T45、T47–T48 全部完成、AC1–AC19 各有证据且独立实现门无 P0/P1 时，
才可标 Done。Intent、
Onboarding、Repos 的 handoff 必须有接收证据，但其 production closure 由 RFC-235/211/249 自己定义；也
不能用“测试数量很多”替代本 RFC 的高风险负向流程和真实浏览器证据。
