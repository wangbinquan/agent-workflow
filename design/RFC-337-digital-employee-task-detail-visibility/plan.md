# RFC-337 实施计划 — 数字员工任务详情的信息架构与交付可见性

状态：Implemented / Publication In Progress；用户已于 2026-08-28 批准 `proposal.md §5 D1–D7` 并授权完成后推送。

## 1. 任务分解

| 任务        | 内容                                                                                                            | 依赖  | 状态        |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| RFC-337-T1  | 用户确认 proposal D1–D7；实现前重新 fetch/sync shared `main` 并对账并发 owner/index                             | —     | Done        |
| RFC-337-T2  | 定义 strict `EmployeeCaseDetailProjectionV1`、required presenter SPI、registry/fallback 与 artifact 来源合并    | T1    | Done        |
| RFC-337-T3  | 实现 development 只读 presenter：issue input、workspace、change candidate、MR 和相关 region/work item refs      | T2    | Done        |
| RFC-337-T4  | 扩 `RuntimeService.project()` 与 HTTP projection，加入 `launchOrigin/detail`，锁定 additive/partial/legacy 合同 | T2–T3 | Done        |
| RFC-337-T5  | 扩共享 panorama/flow display 的 runtime ingress 与 sibling external action props；authoring 行为保持            | T4    | Done        |
| RFC-337-T6  | Case route 接入 URL tabs 与 Overview：关键事实、唯一绿色输入、输入 inspector、页头/职责图 MR 链接               | T4–T5 | Done        |
| RFC-337-T7  | 完成 Details/Artifacts/Execution/Activity panes，搬移既有 section 并补 repo/branch/candidate/artifact 展示      | T6    | Done        |
| RFC-337-T8  | 补 i18n/CSS：completed ingress、事实网格、bounded content、sibling link、390px 与 focus/keyboard                | T5–T7 | Done        |
| RFC-337-T9  | 补 backend/frontend/component/E2E/真实浏览器视觉与 authoring/Session 导航回归                                   | T2–T8 | Done        |
| RFC-337-T10 | 精确提交/推送，验证 path/trailer/remote ancestry，跟踪 exact-SHA GitHub CI 到终态                               | T9    | In Progress |
| RFC-337-T11 | 回填 proposal/design/plan、`design/plan.md` 与 `STATE.md` 的实现/CI 证据并置 Done                               | T10   | Pending     |

## 2. 预计 owned paths

最终以批准后的 live diff 为准，预计涉及：

- `design/RFC-337-digital-employee-task-detail-visibility/**`
- `design/plan.md`、`STATE.md`
- `packages/backend/src/modules/digital-employee/{public,application,composition}/**` 的详情 projection slice
- `packages/backend/src/modules/development-automation/composition/**` 的只读 Case presenter
- `packages/backend/src/routes/**` 中 employee-case detail adapter 的必要合同更新
- `packages/backend/tests/**` 中 RFC-337 直接回归
- `packages/frontend/src/routes/employee-cases.$caseId.tsx`
- `packages/frontend/src/components/digital-employees/{EmployeeCapabilityPanorama,ResponsibilityFlowDisplay}.tsx`
- `packages/frontend/src/components/PageSectionNav.tsx`（只在现有原语确有缺口时；优先零修改复用）
- `packages/frontend/src/styles/**` 中 employee case/panorama 的 scoped 样式
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- `packages/frontend/tests/**`
- `e2e/rfc310-digital-employee-journey.spec.ts` 与稳定 visual fixture/snapshot

不涉及 migration、Type Package descriptor revision 或工作流 TaskEngine 数据模型。并发 session 若修改同一 task-related
文件，提交前逐 hunk 对账并完整保留其输出；非本 RFC 路径不暂存。

## 3. 验收清单

- [x] 用户明确批准 D1–D7。
- [x] Case runtime 只有一张绿色 completed input card，点击不离页并显示完整冻结输入。
- [x] authoring/job template 仍显示和配置全部入口。
- [x] 概览显示 repo、frozen/planned/pending target branch、source branch、baseline 与 MR 空态/实态。
- [x] 详细信息覆盖全部冻结参数和 Context 技术记录。
- [x] 产物覆盖 change candidate、changedPaths、MR、artifact refs/source/Session。
- [x] PageHeader、概览、产物、职责 2、三个 MR 工作项和 selected detail 使用同一 exact MR href。
- [x] 共享 route/panorama 不硬编码 development/MR work item IDs。
- [x] 五个 URL tabs 的 direct/back/forward/keyboard/active-pane 行为已锁。
- [x] 390px、长正文、长路径和长 JSON 不制造页面横向溢出或无限纵向展开。
- [x] backend/frontend/component/E2E/真实浏览器视觉与 authoring/Session 回归已通过。
- [ ] commit 只含精确 allowlist，包含真实 Codex co-author trailer。
- [ ] 实现 commit 已进入 `origin/main`，remote ancestry 已确认。
- [ ] 包含实现的 exact-SHA GitHub CI/相关 visual/E2E 终态已记录。

## 4. 发布策略

优先单批纵向提交。若共享 `main` 并发要求拆批，每一批都必须保持 API/consumer 可编译且现有行为完整，不能把
projection schema、participant、route consumer 拆成让主干短暂失配的半截。发布时使用共享 index 的短临界区，
每次 staging/commit/push 前重新 fetch 并核对 `origin/main...main`；只精确暂存 RFC-337 allowlist。
