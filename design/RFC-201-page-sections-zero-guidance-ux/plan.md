# RFC-201 — 实施计划

> **状态**：In Progress；B1–B6、T12.1–T12.3 与 T12.5 已完成，B7 待原生 Ubuntu visual、最终状态同步与 exact-SHA CI。

## 1. 依赖与顺序

```text
B0 audit + RFC                     [done, no production code]
 ├─> B1 draft/save truth           [P1, first]
 │    ├─> B2 shared nav primitives
 │    │    ├─> B3 Settings
 │    │    ├─> B4 Memory + Task
 │    │    └─> B5 resource forms
 │    └─> B5 resource forms
 ├─> R199 addendum                 [docs now; code stays in RFC-199 B8/B9]
 └─> B6 layout/a11y details        [after B2–B5]
      └─> B7 full gates/release
```

原则：先消除丢草稿/假保存，再做信息架构和视觉；不能用漂亮的新导航掩盖旧保存风险。

## 2. B0 — 盘点、真实浏览器与设计门

- [x] T0.1 读取当前 `CLAUDE.md`、`STATE.md`、RFC-198/199 与 live source；确认 RFC-199 真实进度为 B4，B5–B9 未完成。
- [x] T0.2 盘点 15 个真实 tab/switch surface，区分 page section、local form/mode、vertical selector、sibling route。
- [x] T0.3 用隔离临时 daemon + 真实 Chromium 走查 1280/390、中文/英文；记录 Settings/Task/Memory overflow、Runtime overlap、editor 250px canvas 等几何。
- [x] T0.4 源码对抗复核 Settings/Agent/Skill/Workgroup 草稿所有权，确认 4 个 P1；核实 MCP/Plugin/ZIP/Memory/Task/a11y P2。
- [x] T0.5 起草 proposal/design/plan，登记 `design/plan.md` 与 `STATE.md`；只修 RFC-199 文档漏项，不改 production。
- [x] T0.6 核实 production 与 source tests 已锁 ResourceSplit `<=1080px` list-or-detail；RFC-201 只补真实 resize/focus/dirty 几何，不重复实现 selector。
- [x] G0 用户明确批准 RFC-201（2026-07-16，明确回复「ok」）。

## 3. B1 — 草稿与保存真相（P1）

### T1 — edit-scope reducer 与 guard adapter

- [x] T1.1 新增 route-local `EditScopeRegistry` reducer/types/test helper；每 scope unique request id + single-flight，锁 late settle、clean remote follow、dirty remote===draft 安全收敛、dirty same-baseline、dirty foreign-remote、submitted revision race、partial success、definitive/ambiguous error、discard；remote read 带 issued epoch，write receipt 建 ignore floor，旧 GET 不得晚到回滚。
- [x] T1.2 提供 child adapter 上报 dirty/busy/valid/stale/firstInvalidTarget；不建全局 store，不让通用组件发 API。
- [x] T1.3 组合 `UnsavedChangesGuard`，新增窄幅 navigation predicate：只放行同一 resource identity 的已登记 section-key 变化，不能全局放行 query；mutating busy 期间不提供 discard-and-leave，离 route/resource 仍提示，route identity change 清 registry。
- [x] T1.4 dirty scope 的 validity 必须为 valid 才可提交；unknown 不当成功。source ratchet 禁 save success 无 matching request/submitted revision 清 dirty。

### T2 — Settings P1

- [x] T2.1 为九个 leaf 建字段投影/baseline/draft；一个 leaf 可多 scope。System Agents 拆 config + fusion Agent-row 两 baseline/remote/request；active panel 可卸载，route registry 保留草稿。
- [x] T2.2 新增并原子迁全 callsite 的 `ConfigReceiptCoordinator`：GET issued epoch、同 tab PUT 单写队列/write epoch、exact receipt + read floor、post-settle refetch；clean follow/dirty same baseline/dirty foreign remote 都只消费可接收 receipt。锁 `GET(A) issued→PUT(B) settle→A late→GET(C)` 与 Settings/LanguageSwitch 双 writer 响应乱序。
- [x] T2.3 `SectionForm` 只保存匹配 scope snapshot；System Agents config-first、config failure 零 fusion write、fusion-only 零 config PUT、fusion mutation 严格 `{runtime}` patch；clean disabled 有原因，success 不清其他/newer dirty。枚举全部 `/api/config` writer，强制最小 patch；LanguageSwitch 只发 `{language}`，禁 `{...query.data}`。
- [x] T2.4 Network effective port 仅 suggestion，显式“固定当前端口”才 dirty；route tests 锁 Limits→Network→Limits、Back/Forward、query refetch、save/discard、stale、旧 GET 晚到、stale language cache 与零 hydration 假 dirty。

PR-A / T1–T2 收口记录（2026-07-16）：聚焦 19 files / 166 tests 全绿，workspace typecheck 与 frontend lint 全绿；隔离 Chromium 实测跨 Tab 草稿保留、离页 guard 与 390px 零 body overflow。独立对抗复审覆盖 Config/Fusion 的 daemon A→B、credential rotation、旧 GET/PUT、5xx outcome-unknown 与 guard discard TOCTOU，结论 `CLEAN`（0 P0/P1/P2）。

### T3 — Agent / Skill / Workgroup P1

- [x] T3.1 `JsonField` 上报 raw/parsed/error；Agent Advanced 非法 JSON 算 dirty+invalid，Save/Create 不提交旧合法对象，guard/field focus/badge 全锁。
- [x] T3.2 Skill metadata/body + per-path file op/newPath 接组合 registry；create/delete 改 staged；每个成功 receipt 的 fresh composite token 串给下一步，partial failure/retry 不重复成功 op；ambiguous response 用 token-before→metadata/tree/content→token-after 稳定快照，matching intent 已应用则 clean、不同则 fresh token + dirty/stale、token 变化最多自动重试 2 次后保持 outcome-unknown；锁 B-content→foreign-C→C-token 不误 clean；History gate。
- [x] T3.3 Workgroup config/member editor 接组合 registry；Save All 合成单个 full-replace payload/一次 PUT，响应重映射 member id；panel handoff、切成员、关闭、Escape、route leave 不丢。
- [x] T3.4 运行各自 focused tests；B1 不改 Tab IA，仅把现状变可信。

T3.2/T3.3 收口记录（2026-07-16）：Skill 11 files / 83 tests 与 Workgroup 14 files / 253 tests 全绿，workspace typecheck、相关 lint、Prettier/diff-check 全绿；split 页 mutating-busy 的共享 guard 接线作为 G1 最后一项继续收口。

### G1 — 工作安全门

- [x] Settings、Agent invalid JSON、Skill files、Workgroup member 四条红→绿回归全部通过。
- [x] 无 panel switch/Back/refetch 可静默覆盖 dirty；无 pre-write GET/旧 request receipt 清 newer edit/回滚 clean baseline；无 config writer 用 stale full snapshot 覆盖他人字段；mutating busy 不可伪 discard。
- [x] Workgroup 双 dirty 单 PUT 零回滚；Skill metadata+两 file op 三个 fresh token，PUT/DELETE 200 丢失后双 token 稳定 authoritative reconcile、零混合快照/盲重试；Settings System Agents 双 endpoint 语义不变。
- [x] 独立实现复审无 P0/P1 后再进入 B2/B3。

## 4. B2 — 公共导航原语

### T4 — `PageSectionNav`

- [x] T4.1 实现 group+leaf 数据模型、rail/inline 两 presentation、container `>=56rem`/compact grouped Select；复用 `SelectOption.group` 并让辅助技术读到 group+leaf，group 不进 URL。
- [x] T4.2 desktop 由 owner render 真 TanStack Link，保留 href/Cmd-click/复制链接；compact 走 functional search update；只有 exact leaf `aria-current`，group 不重复 current；push/replace、badge 与 disabled reason 正确。
- [x] T4.3 focus/resize/200% zoom handoff；hidden desktop/mobile duplicate 不进入 DOM/tab order。
- [x] T4.4 component tests：flatten/key uniqueness、active、capability filter、compact、Back/Forward owner integration。
- [x] T4.5 inline single-row density contract：group 与 active leaves 同一横排、active group label 仅辅助技术可读、compact 行为不变。

### T5 — `TabBar` / `PeerNav` / selector contracts

- [x] T5.1 `badgeTone` default neutral；attention/danger semantic token 与 accessible label。
- [x] T5.2 `ResizeObserver` 派生 start/end overflow；edge fade + 44px accessible scroll buttons；reduced-motion、1px tolerance。
- [x] T5.3 `ariaLabel|ariaLabelledBy` 类型必填并原子迁全部 callsite；RFC-201 只为 NodeInspector 接最小 name，文案/sections 留 RFC-199；保留 roving/manual activation/panel ids。
- [x] T5.4 新增 `PeerNav`，Clarify shard 使用 Link + `aria-current`，source ratchet 禁 tab class 伪装 route link。
- [x] T5.5 Task Outputs 改完整 vertical tablist 或普通按钮列表；v1 选择 vertical tabs，与 Worktree/Structural 同合同。

### G2 — 公共原语门

- [x] 横向溢出、resize、active scroll、scroll button、keyboard、RTL 如项目支持、axe component tests 全绿。
- [x] 所有 tablist 有 name；无半套 listbox；所有 sibling route 保留原生 link 行为。
- [x] visual diff 仅真实 overflow/semantic badge 发生，不扩大 threshold。

## 5. B3 — Settings 分组与内部布局

- [x] T6.1 以 container-aware rail/compact Select 分四组；保留 9 个 query leaf、默认 Runtime、旧 `#runtime` 规范化；901px panel 不得因 desktop sidebar + rail 低于 640px。
- [x] T6.2 字段 panel 使用 760–840px semantic measure，Runtime/list 最多约 960px；`.page/.content` 保持全宽。
- [x] T6.3 Runtime row 窄屏 main/meta/actions 不重叠；actions wrap/grid；Delete 共享 ConfirmDialog + focus restore。
- [x] T6.4 每个 panel 补短目的说明、清晰 save/stale/success；Network/Appearance 等 field/hint 扫描顺序。
- [x] T6.5 1280、901/900、721/720、390、640×400、中文/英文、light/dark、200% zoom 几何/axe。

### G3 — Settings 门

- [x] 九个 legacy deep-link/Back/Forward 全绿；390 所有 leaf 一次可发现、零 body overflow/row overlap。
- [x] dirty/stale/save/guard 的 B1 oracle 在新 nav 下不回退。

## 6. B4 — Memory 与 Task 页面 IA

### T7 — Memory

- [x] T7.1 按待处理/记忆库/自动化分组；普通 `/memory` 默认 All，显式旧 `?tab=` 全保留。
- [x] T7.2 candidate 仅统计 server `canManage===true`，fusion 使用 owner/admin endpoint；NavItem 主 Link 进入 All，pending accessory 作为非嵌套 sibling action 深链，desktop/mobile close/focus 正确；零 count 不等于无 leaf capability。
- [x] T7.3 Distill/approval/fusion 按真实权限过滤；直接不可用 deep-link replace + 一次说明。
- [x] T7.4 row 与 Compare Dialog 原样传递 server-returned `memory.canManage`；不在前端按 actor/owner 重算，owner 不退化只读。
- [x] T7.5 edit fetch 有 loading/error/retry shell；empty state 说明来源与下一步；All view mode 返回保留。

### T8 — Task detail

- [x] T8.1 现有 `TaskDetailTab` leaf 增概览/执行/产物/协作 group metadata，不新增 URL key。
- [x] T8.2 抽 `deriveTaskDetailCapabilities` 并与 backend consumer 对齐；扫描 `repos[]`，锁 top-level baseCommit=null 但多仓 diff/structure 可用；按 capability/permission 过滤，异步稳定前不规范化。
- [x] T8.3 container >=56rem 使用单横排 inline group + active leaves，更窄用单 grouped Select；Questions 等待办提升到 group/leaf badge。
- [x] T8.4 保留 plain/dynamic/workgroup 默认与所有程序化跳转；task panel/canvas/table 宽度不被 nav rail 压缩。
- [x] T8.5 Task Outputs vertical keyboard/ARIA、无 output/无 worktree 形状、late config/phase tests。
- [x] T8.6 用户反馈收口：loaded-task 顶部所有异常/恢复提示可独立关闭，按 task+signal signature 重现新信号；stack 有界滚动，不再无限压缩正文。

### G4 — Page section 门

- [x] Memory admin/owner/viewer、candidate/fusion counts、旧深链、empty/error 全绿。
- [x] Task 9/10/4 leaf key 全枚举；plain/dynamic/workgroup/multi-repo/late-config/phase 组合全绿。
- [x] 1280/390 截图与 bounding box 证明无屏外不可发现入口，Task workspace 宽度不回退。

## 7. B5 — 资源表单与操作 Tab

### T9 — Agent / Skill

- [x] T9.1 Agent 保留五分区；Resources 改“能力与协作”，技术细节 Disclosure；Ports/Resources count neutral，validation danger。
- [x] T9.2 Skill detail 合并 Overview+Content 为 Edit，保留 Files/Versions；managed path 进技术信息；旧 local active 不需 URL 迁移。
- [x] T9.3 Skill new 改“手动创建/导入 ZIP”；ZIP select/review dirty、result clean；review→select、file replacement 与 commit-busy route guard。
- [x] T9.4 390 overflow affordance、最后 tab 可触达、active/dirty/error badge 与 focus。

### T10 — MCP / Plugin / Auth / drawers

- [x] T10.1 shared exact operation-revision projector/hash + keyed resource coordinator；MCP 全可变行/updatedAt 投影，semantic no-op PUT 不 bump timestamp，PUT/rename/delete/ACL owner-transfer 与 Probe start/finalize 按 stable id 协调，generic ACL endpoint 锁内重载鉴权；`{id,hash}` 对完整 operation 去重，不保留 name-only raw Promise；不同 hash 分配单调 generation 与 persisted/active causal timestamp，I/O 后仅 current hash + latest generation 可 upsert，stale/superseded 409。锁 Save→Probe/Probe→Save 同毫秒 immediate/GET freshness；frontend requestId+hash settle CAS；dirty banner + 保存并探测、i18n field error/ARIA 与完整状态。
- [x] T10.2 Plugin 全可变行 + immutable cachedPath/install generation 投影；npm/git create/PUT/Upgrade 安装到唯一 generation，写原子 manifest/sourceIdentity（npm resolved+integrity、git final commit），校验后单 DB publish；Check 按 identity 而非 package version，锁 same-version/new-commit 与 legacy unknown。失败/崩溃保持 current cache，orphan/old generation 安全 GC；file source 不提供不可原子化的 Check/Upgrade。PUT/rename/delete/upgrade/ACL owner-transfer 同 id fence，generic ACL endpoint 锁内重载鉴权；publish 在同步 DB transaction 内重载 owner/hash + captured exact projection 全持久化列 null-safe conditional WHERE；Check 使用 mkdtemp/ULID 并返回前锁内重验；frontend requestId+hash query CAS；expected/used/new hash、409、dirty banner、no-change/update-ready/upgrade-success/error/retry 全锁。
- [x] T10.3 Auth OIDC discovery loading/error/empty 分开；late providers 与输入保留回归。
- [x] T10.4 Node drawer neutral counts/能力隐藏。Node Inspector 改名/sections 属 RFC-199 external seam；本批只验证 B2 的最小 accessible name 未回退。
- [x] T10.5 Worktree/Structural 手写纵向 tablist 补 name，不改 Up/Down/Home/End。

### G5 — Resource form 门

- [x] dirty operation 明确 saved-vs-draft；“保存并执行”只有 exact `operationConfigHash` 才继续；invalid/save failure 零 operation request；start-before-foreign、hash-match-during-operation、owner-transfer/permission-loss-during-paused-operation、MCP A-slow/B-fast/H1→H2/rename/same-ms clock、Plugin install/DB failure/same-version generation/same-package-version-new-commit/concurrent Check/frozen-clock full-row CAS、operation-200→PUT-200→old-frontend-settle 全部 fail closed/线性化，零 stale result/query/current-cache/ACL corruption。
- [x] Skill ZIP/Files、Agent raw invalid 与 B1 guard 全绿；表单局部 Tab 不误写 URL。

## 8. B6 — 全局布局遗漏与 RFC-199 接缝

- [x] T11.1 1081/1080、901/900、短视口真实 resize：焦点在将隐藏 list 时转 detail Back/heading，detail focus 保持，selection/dirty guard 不丢；split 内容内部滚动可达。
- [x] T11.2 建 semantic width allowlist/ratchet：field reading measure 与 workspace full width 分开，禁止 blanket `.page/.content` max-width。
- [x] T11.3 external seam verification-only：确认 RFC-201 shared CSS/TabBar 未让当前 editor 基线回退；RFC-199 的 Validation/selector/geometry 目标另报状态，不阻断 RFC-201 Done、不在本 RFC 实现。
- [x] T11.4 same-subsystem missed-issues pass：新导航/registry 的所有 callsite、i18n key、visual scene、source ratchet 无漏接。

### G6 — 接缝门

- [x] `page-fills-content-width` 不回退；Task/canvas/diff/table consumer rendered oracle 全绿。
- [x] RFC-199 editor surface CSS 不被 SectionNav/TabBar 共享规则污染；RFC-199 未完成的目标几何不作为 RFC-201 gate。
- [x] ResourceSplit 真实几何、焦点、dirty、Back 全绿。

## 9. B7 — 收口与发布验证

- [x] T12.1 focused tests 红→绿后跑 frontend/backend/shared 受影响 tests、三端全量与现有 e2e。
- [x] T12.2 正式仓库门：
  - `bun run typecheck`
  - `bun run test`
  - `bun run format:check`
  - `bun run lint`
  - `bun run build:binary` 与单二进制 smoke
- [x] T12.3 Playwright/axe：1280×800、1081/1080、901/900、721/720、390×844、640×400；中文/英文、light/dark、200% zoom、reduced-motion。
- [ ] T12.4 visual baseline 只更新有意场景；同步 scene count/README/双平台基线，不放宽 threshold。
- [x] T12.5 独立对抗实现门：草稿/receipt race、URL resolver、权限/能力、responsive/focus 四风险桶，以及任务导航密度、横幅 dismiss signature/focus/有界 stack；0 P0/P1/P2 后才 Done。
- [ ] T12.6 更新 RFC 状态、`STATE.md`、`design/plan.md`；精确路径提交，不覆盖并行 RFC-199/200 hunks。
- [ ] T12.7 若用户授权 push：按 AGENTS.md 使用实际贡献者 `Co-Authored-By` trailer，`git show -s --format=%B HEAD` 核实后 push，并按 exact SHA 检查 CI。

B7 收口记录（2026-07-16，原生 Ubuntu visual 前）：B1–B6 与独立对抗门已完成，产品实现复审 `CLEAN`（0 P0/P1/P2）。frontend 全量 582 files / 4718 tests；shared 全量 1325 tests；正式根门 734 files / 5787 tests，`5764 pass / 23 skip / 0 fail`；非 visual E2E `123 pass / 22 skip / 0 fail`；workspace typecheck、lint、format、diff-check、binary build/smoke、Chromium UX 20/20、axe 14/14 与 Darwin visual 17/17 均通过。真实浏览器测得 Task 单横排导航 46.5px；四条横幅在有界 stack 内均可关闭，逐条关闭后的焦点顺移与正文高度恢复符合合同。packages 与 E2E/Darwin 基线已分别提交为 `e9e998a6`、`d29a5638`，尚未 push。Linux/amd64 模拟容器 build/smoke 与 visual 17/17 通过，但 22 张场景均出现跨架构字体栅格漂移，故明确拒绝把 QEMU 结果当基线；T12.4 仍须用原生 Ubuntu 24.04 workflow artifact 刷新六个有意场景并复跑。T12.6/T12.7 等最终状态、push 与 exact-SHA CI 后完成，RFC 暂保持 In Progress。

## 10. 回滚与停线条件

- B1 是工作安全基础；后续 IA 可按页面回滚，但不得恢复 Settings 丢草稿、Agent 假保存或 Skill 双 save 假象。
- PageSectionNav 单页失败可回旧 TabBar，同时保留旧 URL key 与 B1 registry。
- MCP/Plugin exact hash wire、Plugin immutable generation/orphan GC 与 MCP in-memory operation generation 是本 RFC 的拟议范围；批准后若需要 DB migration、无法证明 filesystem atomic publish/current-reader 安全或必须扩大到 distributed lock，停线回 RFC，不以原地安装、延时或盲 refetch 冒充准确。
- 发现任何 D5 之外 backend API、DB migration、ACL 或 task state-machine 变化时停线重新审批。
- 与 RFC-199/200 同文件出现并行 hunk 时暂停该 hunk，先协调 owner；不得覆盖、amend、rebase 或 reset shared `main`。

## 11. PR / 精确提交拆分

| PR   | 范围                                                                                                | 依赖                 | 独立门与回滚                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| PR-A | B1 T1–T2：registry/guard + Settings                                                                 | G0                   | Settings P1 全绿；可独立回旧 UI，但不能回退 registry 安全合同                            |
| PR-B | B1 T3：Agent/Skill/Workgroup 草稿与组合保存                                                         | PR-A helper          | 四条 P1、fresh token、single PUT；按 route 独立提交，失败不夹带 IA                       |
| PR-C | B2：PageSectionNav/TabBar/PeerNav/vertical selector                                                 | PR-A guard predicate | component/source/axe；不改页面业务 wire                                                  |
| PR-D | B3：Settings IA/layout                                                                              | PR-A + PR-C          | Settings URL/geometry/dirty 全门；可回旧 presentation 保留 registry                      |
| PR-E | B4：Memory + Task                                                                                   | PR-C                 | 分 Memory、Task 两个精确提交；权限/多仓/旧 key 门                                        |
| PR-F | B5 T9：Agent/Skill microcopy 与 ZIP                                                                 | PR-B + PR-C          | local Tab/guard/390 门                                                                   |
| PR-G | B5 T10：MCP/Plugin exact revision + coordinator + immutable generation + operation UX；Auth/drawers | PR-A + PR-C          | shared→backend→frontend 原子兼容批；失败注入、操作中/响应乱序、双客户端 409 与三端 tests |
| PR-H | B6/B7：语义宽度、真实几何、visual/全门/状态                                                         | PR-D–G               | 无新业务行为；独立实现 gate 0 P0/P1                                                      |

每个 PR 使用精确路径提交并在进入下一依赖批前通过本批 focused tests；PR-G 的 shared/backend/frontend wire 不能拆成让 trunk 中间不兼容的独立 push。RFC-199/200 并行 hunk 先协调，不以 rebase/amend 改写 shared `main`。
