# RFC-243 实现门记录 · 2026-08-01（一轮）

- 评审方式：**独立 Claude 子代理**（Codex companion 当日仍不可用，沿 RFC-240/241 先例）。
  范围 `git diff aa32b90c..HEAD` 全六个 commit，基准为 design v2 / proposal（含 D7 偏差）
  与设计门 22 条 findings 的承诺处置。
- 首轮结论：**NEEDS_FIXES — 1 P0 + 5 P1 + 8 P2**。
- 处置：**P0/P1 全部修复；P2 修 5 条、登记 3 条**（见下表）。修复过程中补的恢复矩阵测试
  当场抓出一条**未被评审列出的更深缺陷**（daemon 关停误判，见 P1-5 附记），一并修复。

## P0

| #    | Finding                                                                                                                                                          | 处置                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | 闭包按 name 全表 oldest-ULID 解析，**跨可见性绑定并执行他人私有资源**（自建同名行即可通过保存门，launch 却绑更老的私有行；且编辑器预览与执行绑定可能不是同一行） | `freezeCallClosure` 改为 **id 缓存优先（且该行仍须持有同名选择器）+ name 兜底限定在发起者可见域内取最老行**；新增必填 `actor` 参数，四个启动面（JSON/multipart/agent/workgroup/scheduled）线程化 `launchActor`；无 actor 的 call 启动 fail-closed。workgroup 叶同规。 |

## P1

| #    | Finding                                                                                                                                                      | 处置                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | `GET /api/tasks?parent_id=X` 恒空（与 top-level 默认 AND 成假）→ 列表展开与子任务直链**全链路死**                                                            | 路由：`parent_id` 出现时不再强制 `topLevelOnly`（children 查询本身就是子列表）。                                                                                                                                                                                      |
| P1-2 | validator 4f/4g 的 resolver 依赖检查**生产零接线**（`/validate`、`/validate-draft`、launch 门、startTaskImpl 都没传 candidate）→ 编辑器不显示、launch 不强拦 | 四个调用点全部传入 `{definition, currentWorkflow}`。                                                                                                                                                                                                                  |
| P1-3 | dw 模式工作组子任务的 `result` 折叠缺失 → 下游端口静默拿空；`dwCallNodeRejections` 只拒 call-workflow                                                        | F 步对 call-workgroup 折叠为单一 `result`（字典序 `## name` 分节，已有 `result` 原样保留）；dw 拒绝改双 kind。                                                                                                                                                        |
| P1-4 | §7.2 `.git/worktrees` 注册表互斥整体未实现且未登记                                                                                                           | 落地 `withWorktreeRegistryLock`（键 = 归一化 `--git-common-dir`，linked worktree/iso-of-iso 收敛同键），`createWorktree` / `removeWorktree` / `createIsolatedWorktree` 三个注册表写点接入；新增 `rfc242-registry-mutex.test.ts`（互斥时序 + 8 路并发 add + 源码锁）。 |
| P1-5 | adoption / merge_state 分段 replay **零测试**                                                                                                                | 补恢复矩阵：daemon 重启领养同一子任务、R-merged 分段只补 F 与终态、child-deleted 映射，另加 loop 逐轮子任务与 git wrapper diff 窗口两条叠加形态。                                                                                                                     |

**P1-5 附记（补测试当场抓出的真缺陷，评审未列）**：daemon 关停时子任务的 abort 常先于父
controller 落地，父的 W 阶段把子任务的 `interrupted` 当作「不可恢复」→ 调用行 `failed`、
**父任务 failed（而非可恢复的 interrupted）**，且该行离开领养集 → resume **重复发起第二个
子任务、旧子任务成孤儿**。修复：判据改为「子任务 errorSummary=`daemon-restart`」+ 有界
（2s）等待父 abort 确认，确认则不写终态、让既有 `cancelTaskRow` 落 interrupted；另加固
「子任务仍被本进程驱动（`isTaskActive`）时回落 re-attach」。领养判据同时放宽到
`{pending,running,interrupted,canceled}`（关停收尾会把调用行落 canceled）。

## P2

| #    | Finding                                                                  | 处置                                                                                                   |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| P2-1 | humanWaitMs 换代双记                                                     | 新代台账归零，仅领养同一行才继承（+ 源码锁测试）。                                                     |
| P2-2 | retryNode 未前置取消旧子任务（文档却已声称）                             | 落地前置级联取消；dev-gotchas 表述同步。                                                               |
| P2-4 | 「不持 globalSem」「adoption 禁 mint」两条源码锁缺失                     | 以哨兵注释划定 adoption 区，facade 测试新增两条源锁。                                                  |
| P2-7 | executor / importRef 注释过期（称 workgroup 待 PR-4）                    | 注释更正。                                                                                             |
| P2-8 | STATE.md、design/plan.md 未收口                                          | 本轮一并收口。                                                                                         |
| P2-3 | R-isolating 段以「F 先行、行 done 在 merge 前」（agent runner 先例）替代 | **登记为残余**：崩在 done→pending-merge 窗口会让子任务全量重跑；与 agent 行为同族，无 wedge/数据损坏。 |
| P2-5 | 其余测试缺口（S5 委派、call-workgroup 失败矩阵、childBudget 告警）       | **登记为残余**（happy path + 关键失败路径已锁）。                                                      |
| P2-6 | 前端 resolver 无独立 `'forbidden'` 态；子任务详情页无父任务链接          | **登记为残余**：不可见与不存在在列表 ACL 下同形（不泄露存在性），父链接列表侧已有降级呈现。            |

## 已反驳（评审自列，未上报）

childBudget 懒 childness 读乱序（自愈且在接受的 burst 内）、launch 半失败遗留 pending 子行
（boot reap 覆盖）、done-before-merge 下游早派（merge_state 门覆盖）、被引资源删除后发起失败
（设计 §9 明列时点）、renderCallGoal 自写正则（与 `TEMPLATE_RE` 同域）、取消双路径皆级联
（幂等）、iso GC 孙代深度（逐容器递归成立）、cancelTask 直写 errorMessage（非状态列，s14 已登记）。
