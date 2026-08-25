# RFC-323 数字员工按员工绑定的 Adapter 配置卡 —— plan

## 1. 状态

- 当前：**Done（本地收尾；待发布后复验/回填最终 run）**
- 研究基线：`main@8ed77bbfb57ebc0e56e35eb8b8d1c3d434dbab0e`；候选持续在共享
  `main` 上同步并按 RFC-323 自有内容重验证；已发布祖先、本地收口提交和已知 hosted run 在
  T28/T29 与 §4 记录。`e423065c45ae336683af8e14482f7b4b52448286` 尚未 push，因此最终发布
  exact SHA 与对应 hosted run 仍须发布后复验并回填。
- 实现许可：**已取得**。2026-08-25 用户明确要求“完整实现 RFC 并提交上库”，批准 proposal C1～C12
  与能力影响 I1～I5。
- 共享树：并发输出持续推进 `main`；本 RFC 保留 `architecture/guard-manifest.json` 中他人更新的
  `rfc270-canvas-central-guard.lines=364`，发布时继续精确排除 clarify 等无关路径。

## 2. 任务分解

### Phase A：合同与兼容投影

- [x] **RFC-323-T1** 增加 `LaneAdapterSlot` 与 `LaneAdapterBinding` domain schema、类型包校验和 pure merge。
- [x] **RFC-323-T2** 扩展岗位模板 `defaultAdapterBindings`、员工 draft `adapterOverrides`、员工 revision
      `exactAdapterBindings`，并把 Adapter digest 纳入 compiled closure。
- [x] **RFC-323-T3** 扩展 Job/Employee create/update/read wire；旧客户端省略字段保持 `[]`。
- [x] **RFC-323-T4** 实现 legacy tool connectionRef 的 0/1/N 候选投影，不改 immutable JSON/digest；错误提供可操作定位。
- [x] **RFC-323-T5** 新工具 authoring 删除 connectionRef，旧 body 显式拒绝；历史 ToolRegistration revision 只读兼容。

### Phase B：Integration 运行接线

- [x] **RFC-323-T6** 扩充 Integration public connection projection，返回 secret-free purpose/availability/content digest。
- [x] **RFC-323-T7** Adapter runner 消费 `connectionRef + secretProjection`；收紧 env key、缺失 fail closed、未声明 env 不泄漏。
- [x] **RFC-323-T8** runtime plan 按员工 exact lane binding 组装 `connectionRef`，并纳入 nonce/digest；删除新路径的 tool connection read。
- [x] **RFC-323-T9** pipeline collect 切为平台 `PipelineEvidenceParticipant`，保持 exact-head、sink、budget、pending wake 合同。
- [x] **RFC-323-T10** approval prepare/submit/lookup/observe 对拍员工 exact lane binding，保持幂等、correlation、deadline 与恢复。
- [x] **RFC-323-T11** 发布下一版 development type package，完成唯一可推导员工的自动升级；歧义保持旧 revision并给人工原因。

### Phase C：泳道配置卡与最小 Dialog

- [x] **RFC-323-T12** `EmployeeCapabilityPanorama` 增加非 WorkItem 的 `LaneAdapterCard` 投影与布局/a11y 合同。
- [x] **RFC-323-T13** 岗位模板职责图支持 default Adapter binding；missing 状态进入发布定位。
- [x] **RFC-323-T14** 员工卡新增“配置职责”入口，支持 inherit/override/restore 并显示 exact revision。
- [x] **RFC-323-T15** 分类工具箱的工具定义只读显示“由岗位/员工配置”，AddToolDialog 删除 connection 字段；
      独立 Adapter 卡的配置直达由 T30 承接。
- [x] **RFC-323-T16** 最小绑定 Dialog：purpose-filtered Select、来源/状态、保存/恢复、权限与 overlay 行为。
- [x] **RFC-323-T17** 次级 Adapter 资源 Dialog：guided create/edit/publish/archive/ACL；全字段可达、默认只露名称/程序。
- [x] **RFC-323-T18** runtime Case 职责图只读显示实际冻结 Adapter，不产生虚假 round/timeline。

### Phase D：旧界面退役

- [x] **RFC-323-T19** 删除 `/code/executors` 页面实现，保留无 UI redirect。
- [x] **RFC-323-T20** 删除 generic code config 的 Adapter list/detail/summary/editor/raw JSON 分支，保留另外三类资源。
- [x] **RFC-323-T21** 删除旧 CSS/i18n/fixtures/tests/visual scenario，更新 route/e2e capability ledger。
- [x] **RFC-323-T22** 增加退役棘轮：旧 DOM/testid/route component/AddTool connection 字段不得复活。

### Phase E：验证与交付

- [x] **RFC-323-T23** domain/application/backend 定向测试与 legacy projection 变异检验。
- [x] **RFC-323-T24** Integration/system-mock：两员工同工具不同 Adapter、secret allowlist、pipeline pending→passed、approval terminal。
- [x] **RFC-323-T25** frontend component/route/a11y/响应式测试；更新并人工检查受影响视觉基线。
- [x] **RFC-323-T26** 设计门：限定 RFC-323 文档路径审查并处置 findings；取得用户实施批准。
- [x] **RFC-323-T27** 实现门：限定 RFC-323 自有路径审查，逐条处置 findings。
- [x] **RFC-323-T28** 已完成本次用户授权的本地 publication candidate 收口：RFC-323 已发布祖先为
      `686c4270732440457ba1da2c8d27628a24432296`、`089015b1a53071b151f2e6b73268517390eb4b55`，
      hosted 覆盖账本收敛提交为 `ac960adabfea626b58e2aee6c1b03ca56312f7d3`；WebKit 红项修复
      `e423065c45ae336683af8e14482f7b4b52448286` 仅在本地。此勾选只表示本地精确提交阶段完成，
      不表示 `e423065c4` 已 push，也不表示最终 exact-SHA hosted CI/visual 已发生。
- [x] **RFC-323-T29** 按用户 2026-08-25 的明确授权，把 RFC 索引与 `STATE.md` 在本地标记为
      Done，并记录当前可验证的远端 ancestry/run 与失败归因。最终发布 SHA、全套 workflow run IDs
      和终态须在 `e423065c4` 发布后复验并回填；本地 Done 不宣称 hosted 全绿。
- [x] **RFC-323-T30** 用户回归：分类工具箱 Adapter 卡不得 disabled；点击像工具卡一样直接管理 purpose-scoped
      Adapter 资源，不选择或绑定员工/岗位；岗位与员工职责图利用当前上下文直接打开既有绑定 Dialog。
- [x] **RFC-323-T31** Issue 来源边界纠偏：删除 `delivery-main/requirement-source` 槽、员工绑定与 workspace
      acquisition 接线；系统级回归改走 Integration 标准 Issue envelope → Event Center → WorkStart。

## 3. 验收矩阵

| Proposal AC | 任务            | 必须证据                                      |
| ----------- | --------------- | --------------------------------------------- |
| AC-1        | T1/T11          | 类型包 schema + negative fixture              |
| AC-2        | T2/T13/T14      | 两员工同岗位不同 exact Adapter 测试           |
| AC-3        | T1/T2/T6        | missing/purpose/ACL/archive publish failures  |
| AC-4        | T2/T8           | closure digest + old revision stability       |
| AC-5        | T12/T18         | DOM geometry + runtime round count            |
| AC-6        | T16/T17         | permission matrix + minimal-field snapshot    |
| AC-7        | T8/T9/T24       | pipeline system mock exact-head evidence      |
| AC-8        | T8/T10/T24      | approval full saga ref equality               |
| AC-9        | T7/T24          | env capture + missing key + no-leak mutation  |
| AC-10       | T4/T5/T11       | new write reject + historical replay          |
| AC-11       | T19-T22         | redirects + extinction guard                  |
| AC-12       | T16/T17         | complete resource lifecycle from lane Dialog  |
| AC-13       | T14-T17/T25/T30 | 工具箱资源管理 + 上下文绑定 + 双浏览器/响应式 |
| AC-14       | T6-T10/T27      | RFC-294 boundary guard                        |
| AC-15       | T11/T24/T31     | standard Issue ingress + no source Adapter    |

所有 AC 必须至少映射一条判别性测试；删除类 AC 必须有“旧实现复活即红”的负 fixture。

## 4. 本地候选证据（2026-08-25）

- 后端定向：15 文件，97 tests / 1278 assertions 全绿；架构/覆盖账本 7 文件 118 tests 全绿，另有 4 条
  仅在全量 journal 中启用的条件跳过。
- Integration runner：只投影声明 secret、缺 secret spawn 前失败、保留 exit-code typed failure，且 provider stderr
  不进入 failure receipt。
- 真实 system-mock 改为标准 Issue webhook/Event Center/WorkStart 输入，不创建来源 Adapter；继续覆盖流水线
  pending→passed/retry、审批 terminal 与合并闭环。语义纠偏后的最终结果以 exact-SHA hosted CI 为准。
- 架构守卫锁定 `delivery-main` 无 `requirement-source` slot，员工 workspace 无来源 acquisition port；旧
  Development Mission 的兼容 runner 不在本 RFC 中删除。
- pipeline evidence：目标 SHA 或 MR fence 暂不可证、stale-input 均保持 pending；脱敏失败与零 required gate 在导入前
  fail closed；每轮文件按 bundle namespace 隔离，同名 provider 日志不能覆盖历史 round 证据。
- approval ordering：仅当 pipeline 泳道启用时等待 terminal current evidence；审批独立启用不形成永久等待；GitLab CE
  无显式 reviewer 的聚合 `approved=false` 不被臆断为审批 hold。
- 前端纠偏定向：5 文件，37 tests 全绿；锁定工具箱只管理 Adapter 资源且不出现员工/岗位选择，岗位与员工上下文
  继续直接绑定；前后端 typecheck 与本 RFC 触及文件 ESLint 全绿。
- 浏览器：Chromium 2/2、WebKit 2/2；覆盖员工 override/恢复继承、旧 URL redirect、职责图与 runtime 冻结引用。
- 视觉：`fixed responsibility toolbox` Darwin 场景以 no-update 模式 1/1 全绿；responsibility map 与 node toolbox
  两张受影响基线均已人工检查。
- 构建：`bun run build:binary:e2e` 成功并完成四个产物 smoke。
- 本轮按共享树规则未启动第二份 full local gate；最终全仓结论以发布后的 exact-SHA hosted CI/visual 为准。
- 已发布 ancestry：`686c4270732440457ba1da2c8d27628a24432296` →
  `089015b1a53071b151f2e6b73268517390eb4b55` →
  `ac960adabfea626b58e2aee6c1b03ca56312f7d3`，三者均为已发布包含 SHA
  `15139df7edaac8e1f3a696ae2ef690371ff185fe` 的祖先。
- 已知 hosted 证据：包含 SHA `72e648327ddebb9b7f8a9e444af0a1ee36db46e2` 上 visual
  `32807636272`、e2e-full `32807888356`、evidence-soak `32807885394`、git-protocols
  `32807887371`、integration-opencode `32807891339`、windows-platform `32807886748`
  均 success；其主 CI `32807636233` 被后续 push 取消。后继 `15139df7e` 的主 CI
  `32807941954` success。
- 已知 WebKit 红项：`72e648327` 的 e2e-webkit run `32807888131` failure，稳定失败归因为
  ReactFlow 控件挂载探测早于渲染、searchable Select 的 WebKit 指针命中，以及 macOS retry
  账本多一个无进程 bookkeeping row。三项已由本地 `e423065c4` 修复；该提交尚未 push，因而
  **不存在**可填写的最终 exact-SHA WebKit/八类 workflow 全绿 run。

## 5. 实施顺序与共享树边界

1. 用户批准后先做 Phase A 的纯合同与测试，避免 UI 先行造出不可运行配置。
2. Phase B 闭合真实运行后才接 Phase C；卡片出现时不得仍是 validation-only。
3. 新卡片完整承接 lifecycle 后再做 Phase D，禁止先删唯一管理入口。
4. 当前共享 dirty 文件至少包括 Digital Employee runtime/type package 与相关测试；动这些文件前重读完整 diff，保留所有并发 hunks。
5. 不创建 branch/worktree，不 stash/reset/rebase/amend；不运行本地 full gate。按仓规用定向测试迭代，最终以 exact-SHA hosted CI 为权威。
6. `design/plan.md`、`STATE.md`、architecture ledgers 与视觉账本均为并发交汇文件；提交前逐行确认只包含 RFC-323 与已明确交接内容。

## 6. 发布拆分

跨层 schema、runtime、UI 退役与覆盖账本必须同一候选闭合，因此采用两步发布：

1. 一笔 RFC-323 实现提交：生产代码、测试、Darwin 视觉与“publication pending”文档；
2. hosted visual 如产出新的 Linux 权威图，经人工检查后以第二笔 closeout 提交更新 Linux 图和 T28/T29/CI 记录。

任一步共享文件冲突都停止 publication；不通过 alternate index、commit-tree、临时删除或其他旁路绕开。

## 7. 实现前退出门（已满足）

- [x] 用户批准 proposal C1～C12；
- [x] 用户接受能力影响 I1～I5；
- [x] 设计门没有未处置 P1/P2；
- [x] `main == origin/main` 或已说明无法安全同步的具体 blocking paths；
- [x] RFC-323 自有路径与其他会话 owner 边界已重核。
