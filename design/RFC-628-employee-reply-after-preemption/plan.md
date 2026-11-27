# RFC-628 实施计划

状态：In Progress——实现、集中验证与实现门均已完成，待 CI（用户 2026-11-27 指示立项并完整交付，RFC 写完即进入实现，不再另行请批；设计里由起草方代为裁决的各项见 design §7，用户可随时改判），2026-11-27。

路径约定同 design：源码相对 `packages/backend/src/`，测试相对 `packages/backend/`，其余从仓库根写起。仓库规则：先完成下面 T1～T7 的全部实现与全部用例，再进入 T8 集中验证；开发期间只做必要的读码与语法、格式静态自查。

设计门结论不通过，处置见 design §8；本计划已随之调整：删去跨轮携带旧回复的任务，加上 `observe-mr` 的重排、`observe-approval` 的第二种续办、回复时检查 MR 状态、图研发内置岗位换名，以及对应的新用例。

## 任务

| 编号 | 内容 | 依赖 | 完成标志 |
| --- | --- | --- | --- |
| RFC-628-T1 | `domain/mergeRequestLifecycle.ts` 新增 `usesPreemptionSafeReviewReplies`；新文件 `domain/reviewResolutionFollowUp.ts`（只有 `pendingReviewFollowUp`）；用例 A1、A2 | — | design §3.1 的续办函数与判断函数齐全，用例写齐 |
| RFC-628-T2 | `application/employeeTypePackage.ts`：修订号 12；`observe-mr` 后继加 `reply-feedback`、`prepare-change`，`observe-approval` 后继加 `reply-feedback`、`prepare-change`；`observe-mr` 按 design §3.3 第 1 条的六步重排（第 2 步重新冻结提交、第 4 步回复、第 5 步在新清单下不看触发事件类型）；`observe-approval` 进行中时两种续办与「通过 → `observe-mr`」显式分支；`publish-mr` 结算在新修订号下要求已标记发布；`repair-feedback` 输出校验只改 `publishedHeadSha` 的写入与期望值（保留规则不变）；用例 B1～B8、C1、D1、D2、H1 | T1 | design §3.2～§3.4 全部落地，新旧清单各有用例 |
| RFC-628-T3 | `application/employeePlatformWorkItems.ts`：条件函数；发布成功、候选基线等于台账源头提交且 `publishedHeadSha` 为空时补写；回复先看 MR 是否仍开着、改用发布提交作正文与标记、移除线程已删除的行（对所有尚未回复的行）、全部移除时写空台账（`terminal`）、摘要写明；汇总与清理过期检视不改；用例 E2～E6 | T1 | design §3.5 全部落地，修订号 11 与空修订号的旧行为有用例 |
| RFC-628-T4 | 图研发 `@3`：`deliveryLifecycle.ts` 常量与两处比较；`builtinCatalog.ts` 的 `type-v3:` 记录、修订号 3 列表与后继解析；`bootstrap/daemonModules/digitalEmployee.ts` 组合目录的后继委托；`deliveryJobs.ts` 新岗位标识、新岗位名称与配置链接；`composition/graphDeliveryLifecycle.ts` 注释；前端 `GraphDesignDelivery.tsx:49` 链接；用例 J1～J3 | T2 | design §3.6 的表逐行落地；`@2` 员工能自动升到 `@3`，启动不报岗位名称冲突 |
| RFC-628-T5 | 修订号同步：design §4 列出的后端用例、前端用例与 e2e（含 `tests/rfc330-case-list-membership-scope.test.ts:59-60`、`tests/rfc396-case-intake.test.ts:30`、`tests/rfc509-development-automation-composition-remainder-boundary.test.ts` 的声明清单与名字总数）；e2e 改用 `DEVELOPMENT_TYPE_PATH` 并新建 `e2e/graph-development-type-ref.ts`；扫描只补认 `/digital-employees/development%40<数字>`，既有反例不变（K1） | T2、T4 | §4 的「必改」清单逐条完成，「不用改」清单未被误改 |
| RFC-628-T6 | 运行时与系统级用例：新文件 `tests/rfc628-reply-after-preemption-runtime.test.ts`（F1～F6，双库）；`tests/rfc310-digital-employee-system-mock-e2e.test.ts` 检视闭环里加回复前与提交前两种抢占（G1）；按 design §6 的夹具提示让假平台工作项写回台账 | T2、T3 | 用例写齐，文件顶端写明锁的缺陷 |
| RFC-628-T7 | 仓库账本：`design/plan.md` RFC 索引登记 RFC-628；`STATE.md` 顶部加进行中条目，并把 2026-11-27 那一节「后一半没有修」改为指向本 RFC；`design/RFC-616-process-metrics/plan.md:311-312` 同样指向本 RFC | — | 三处登记完成，不删改他人条目 |
| RFC-628-T8 | 集中验证：改动文件的类型检查、lint、格式；T1～T6 涉及的用例按双库定向执行，前端用例；独立功能实现门（本会话派生的 subagent，只审功能）；修本人问题后复验相关范围；按精确路径提交、推送，跟踪精确 SHA 的 CI，失败先归因 | T1～T7 | CI 全绿或失败已按责任归因并如实记录 |

## 依赖与提交

- T1 先行；T2、T3 可并行；T4、T5 依赖 T2（图研发描述符由研发描述符派生）；T6 依赖 T2、T3；T7 与实现同批提交。
- 单个提交，前缀 `feat(digital-employee): RFC-628 被抢占后补发检视回复`。提交前核对共享暂存区，按路径 `git add` 与 `git commit -- <路径…>`；工作树里其他会话的迁移相关在制品不纳入。
- 修订号升级会让存量员工与岗位在下次启动时各生成一份新修订号下的后继；本 RFC 不改工作契约，按 `modules/digital-employee/application/authoringService.ts:754-771` 应自动完成，集中验证时以 J2 与发布升级矩阵的 CI 结果为准。

## 验收清单

证据里的用例文件都在 `packages/backend/tests/` 下；集中验证只在 SQLite 上执行（本机没有 PostgreSQL 测试库），双库以 CI 为准。

- [x] proposal §6 第 1 条：回复待执行时四种抢占事件之后都执行了「回复修复结果」，台账为「已回复」；有新意见时先回复再汇总，有冲突时先修冲突再回复 —— `rfc628-reply-after-preemption-settlement`（新旧清单各给预期）、`rfc628-reply-after-preemption-runtime`（含实现门后补的「回复待执行 × 有新意见的检视更新」）、`rfc628-system-mock-e2e`（G1）
- [x] proposal §6 第 2 条：提交待执行、头提交未变时，四种抢占事件之后修复都被提交、推送并回复；新意见随后被汇总，冲突由推送后的冲突更新触发修复 —— 同上三个文件（含补的「提交待执行 × 生命周期更新」）与 `rfc628-platform-work-items`
- [x] proposal §6 第 3 条：已合入 / 已关闭时交办结束，没有新增回复；回复步骤执行时已合入 / 已关闭也不发 —— `rfc628-reply-after-preemption-settlement`、`rfc628-platform-work-items`（E6）
- [x] proposal §6 第 4 条：阻塞后恢复再被抢占，每条线程恰好一条修复结果回复 —— `rfc628-reply-after-preemption-runtime`、`rfc628-platform-work-items`
- [x] proposal §6 第 5 条：提交前被抢占、头提交已变时不重新提交，之后的发布不误称已处理 —— `rfc628-reply-after-preemption-settlement`、`rfc628-platform-work-items`（E2、E3）
- [x] proposal §6 第 6 条：回复时线程已删除不阻塞，摘要写明 —— `rfc628-platform-work-items`（E4，含已回复与已删除并存；线程列表没有读全时不当作已删除，见 design §9 P2-1）
- [x] proposal §6 第 7 条：续办之后的「关注 MR 状态」汇总没记过的线程，且不对同一批线程重复汇总 —— `rfc628-reply-after-preemption-settlement`、`rfc628-reply-after-preemption-runtime`（F6）
- [x] proposal §6 第 8 条：旧修订号交办（含 `graph-development@2`）的结算、校验与平台工作项行为不变 —— 结算用例对 `development@11`、`graph-development@2` 的清单逐例给出与改动前相同的预期；运行时用例固定在 `@11` 的一例断言回复仍会丢失；`rfc628-mr-lifecycle-revision`
- [x] proposal §6 第 9 条：`graph-development@2` 员工与岗位自动升到 `@3`，启动不报岗位名称冲突，内置 MR 岗位可用 —— `rfc628-graph-catalog`（J1、J2）、`rfc396-registration`、`rfc396-mr-job`
- [x] design §4 同步清单全部完成 —— 同步改过的 13 个既有用例文件与前端 `rfc396-graph-workspace`、`rfc396-delivery-terminal` 全部通过
- [x] design §6 必写用例全部写齐并通过 —— 7 个新用例文件（含实现门后补的用例）全部通过
- [x] 独立功能实现门通过 —— 无 P0 / P1，2 项 P2 已处置（design §9）
- [ ] 精确 SHA 的 CI 结果：
- [x] 仓库账本（T7）已登记 —— `design/plan.md`、`STATE.md`、`design/RFC-616-process-metrics/plan.md` §4.7
