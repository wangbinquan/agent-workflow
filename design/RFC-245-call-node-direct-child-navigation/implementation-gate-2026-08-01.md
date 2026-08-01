# RFC-245 实现门记录（2026-08-01）

## 门的执行方式（如实登记：Codex 两轮均 wedge，改为自评审替代）

- **第一轮**：`codex exec --sandbox read-only`，全量范围（10 个改动面 + 8 个评审问题）。
  跑到 ~16 分钟时进入 wedge：进程存活但 **0% CPU**、stdout 与 `~/.codex/sessions` 的 rollout
  **同时冻结 10+ 分钟**，无任何 findings 输出。这与个人 memory 记录的
  「2026-07-31 起 `codex exec` 成批卡死」特征完全一致。按记录的止损姿势 `pkill` 终止。
- **第二轮**：缩小到 4 个文件 / 3 个问题的紧凑 prompt + watchdog。产出 1.5MB 探查日志后
  **再次冻结**（mtime 停在 15:15，7 分钟无增长），同样零 findings。
- 按 `docs/dev-gotchas.md` 的「勿三连重试」，**停止重试**，由我按同一份问题清单完成对抗自评审，
  并在下面逐条记录结论与证据。**这不等同于一次独立 Codex 复核，这里明确标注为替代方案。**

> 设计门（`design-gate-2026-08-01.md`）是同一天早些时候跑成功的，2 P0 / 3 P1 / 4 P2 已全部处置。
> 本轮实现门的替代自评审基于那一轮的结论继续收口。

## 自评审结论（逐条，附证据）

| #   | 问题                                                                          | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 处置                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `deriveCallNodeNav` 会不会跳到已被取代 / 已取消的子任务，或漏掉活着的子任务？ | **无缺陷，但语义此前没被测试锁住**。两条关键路径：①`scheduler.ts:2851-2876` 的 `ADOPTABLE_CALL_ROW_STATUSES = {pending,running,interrupted,canceled}` —— daemon 关停把调用行落成 `canceled` 后仍**原地领养**，该行继续持有活着的子任务，所以 oracle **只能看 `childTaskId`、绝不能看行状态**；②cascade retry 给下游调用行铸空占位行而**不取消**其存活子任务（RFC-243 后端缺口），此时 freshest-wins 让画布**变惰性**而不是跳到已被父任务取代的那一代 —— 安全。 | 补两条测试锁住这两条语义（`call-node-click-nav.test.tsx` 的 adoption / cascade 用例）。                                                                                                                  |
| b   | 可点提示与点击行为会不会在某条重建路径上失步？                                | **设计门 P1-3 已抓到并修**（effect 依赖数组）。本轮复查四条重建路径全部传 `callNavs`：`WorkflowCanvas.tsx:501/781/1402` + 测试导出 `:3452`；ref-guard、rebuild 判据、effect deps、undo/restore `useCallback` deps 均已加。                                                                                                                                                                                                                                     | 已有行为测试（`undefined → present → absent`）+ 源码锁双覆盖。**并且实测该行为测试一开始是假绿**（内联 `agents={[]}` 每渲染换身份，触发 `agentsChanged` 重建），改成稳定引用后：摘依赖 → 红，恢复 → 绿。 |
| c   | `remountDeps` 会不会破坏依赖「param 变化不重挂」的东西？                      | **无**。同仓 `workgroups.detail.tsx:64` / `skills.detail.tsx:60` 是同样写法；`useTaskSync(id)` 本就按 id 建连，重挂等价于换 id 重连；查询缓存按 key 存活不受组件重挂影响；`search`（页签）不在依赖里。前端全量 675 文件 / 5620 条通过，含 `task-detail-route-history` / `task-detail-page-tabs`。                                                                                                                                                              | 保留，附源码锁 + 空抽屉栏症状断言。                                                                                                                                                                      |
| d   | children 再验证是否真的堵住了「首响应 `[]` 后轮询自关」的洞？                 | **堵住**，且证明方式从文本锁升级为**真断言**：`buildTaskSyncRules` 是纯函数，直接断言 `node.status` 与任务终态两组键都含 `taskChildrenQueryKey`，并额外断言该键**不是** `['tasks', taskId]` 的前缀（防止后人「简化」掉）。实测摘规则 → 红。残余：父任务已终态后子任务在别处被删 → 缓存旧行会指向 404 面，与 `ChildTaskLink` 现状等价，已在 design F3c 登记。                                                                                                   | 已加 3 条断言进 `task-sync-rules.test.ts`。                                                                                                                                                              |
| e   | `ParentTaskLink` 的 ACL / 死链 / 缓存键？                                     | **发现并修掉一个真缺陷**：react-query 在 refetch 失败后**保留上一次成功的 `data`**（实测 `status:'error'` 与 `data` 并存），原来的「先看 data」写法会在**会话中途权限被撤销**后继续显示父任务名 + 活链接。改为 error 优先。缓存键 `['tasks', parentId]` 与详情路由共用是**有意**的（顺带预热跳转目标），不同 observer 各自的 staleTime/retry 不冲突。                                                                                                          | 修 + 补 200→403 转换测试；实测摘修复 → 3 条红。                                                                                                                                                          |
| f   | 表格入口的门控对吗？                                                          | **对**。抽屉只在 `workflow-status` pane 内渲染，故入口按 `canOfferFailedJump(displayedTabs)`（= `tabs.includes('workflow-status')`）门控，与失败横幅同一判据；只挂在 call 行上，其它 kind 行为零变化。                                                                                                                                                                                                                                                         | 补两条锁（门控表达式 + 仅 call 行）。                                                                                                                                                                    |
| g   | 新测试是否真的 load-bearing？                                                 | **逐条实测过三处**：effect 依赖（红 2）、`ParentTaskLink` error 优先（红 3）、`useTaskSync` children 键（红 1）。其余 `tasks.detail` 相关断言是**源码文本锁**——这是本仓对这个「挂载代价极高的路由」的既有约定（见 `task-detail-child-task-link.test.tsx` 头注释显式说明该 idiom），不是本次新引入的弱化。                                                                                                                                                      | 保留；已把其中最有价值的一条（WS 失效）升级成纯函数真断言。                                                                                                                                              |
| h   | 注释里有没有对仓库不实的断言？                                                | 设计门 P2-1 / P2-2 / P2-3 / P2-4 抓到的四处（selection 楔子归因、坏抽屉症状、参数个数、403/404）已全部改正并写进代码注释与文档。                                                                                                                                                                                                                                                                                                                               | 已闭合。                                                                                                                                                                                                 |

## 未由本轮覆盖的部分（诚实边界）

- **没有真机浏览器视觉自查**。三处新 UI 全部复用既有 class / 组件（`.canvas-node__*-nav` 同评审
  与反问、`chip chip--tight`、`.btn .btn--sm`），DOM 结构由单测断言；但要在浏览器里看，需要起
  daemon + 建带调用节点并真跑出子任务的工作流，成本远超改动本身。视觉基线预计不受影响
  （编辑器/预览 surface 不传 `callNavs`；`mobile-task-detail` 场景的种子任务不是子任务），
  以 CI 的 visual job 为准。
- **没有新增 e2e**。与 RFC-158 / RFC-161 两个同构先例一致（二者也只有单测 + 源码锁）。
- **一次独立的第三方模型复核缺席**（Codex 两轮 wedge）。如需补，建议在 Codex 恢复后按
  `rfc245-impl-gate-prompt.txt`（保存在本次 session 的 scratchpad）重跑一次。

## 门禁结果

- 前端全量：**675 文件 / 5626 条通过**（补完 adoption / cascade / WS 断言后的最终重跑）。
- shared：**1536 条通过**。
- typecheck 通过；本 RFC 涉及文件 `eslint --max-warnings 0` 干净；prettier 已格式化。
- 后端：首轮 `bun run test` 报 4 fail，隔离重跑收敛为 **7901 pass / 28 skip / 2 fail**
  （另 2 条在两次跑之间消失——并发 session 仍在改后端，属于共享树噪声）。剩下 2 条**全部属于
  并发在飞的 RFC-244 后端改动**，与本 RFC（零后端 / 零迁移 / 零端点）无关：
  - `RFC-054 W1-6 … HEAD journal has 127 entries` —— 新增迁移未更新 journal 条目数棘轮
    （`docs/dev-gotchas.md` 的 ratchet 清单里就有这一条）；
  - `API contract registry coverage … missing 1 endpoint(s)` —— 新增端点未登记进契约表。
    本 RFC 未改任何 `packages/backend/**`、未加迁移、未加端点，无法触发这两条。

## 上库前完整性审计补充（2026-08-01）

用户授权提交前，OpenAI Codex 又按 proposal A1–A12 对当前实现做了一轮源码与行为交叉审计，补出
此前自评审仍漏掉的 3 个实现缺口和 1 个测试缺口，现已闭合：

1. **retained-data error 违背 D5**：TanStack Query 的 refetch error 可与上一次成功的 `data`
   并存；`callNavByNode` 与 `ChildTaskLink` 原先都只看 `data`，旧 `[]` 会在新错误下继续把 live
   child 判成不可达。现改为 `isError` 优先，错误态恢复乐观可点，并用 200 `[]` → 503 的真实
   QueryClient 行为测试锁住。
2. **A3 的颜色与跳转不在同一代**：跳转按 id freshness，但画布状态仍按 `startedAt`；新 retry
   placeholder 常为 `startedAt=null`，会继续显示旧代颜色。现抽 `deriveCurrentCallNodeRun`，两个
   call kind 的状态投影与导航共用它；「旧 done + 新 pending/null-startedAt」回归用例已锁。
3. **T9 对旧 snapshot 缺少 wire 兜底**：计划明定 call row = snapshot kind 或
   `childTaskId != null`，实现却只认 snapshot kind，旧/损坏 snapshot 会丢掉唯一 Retry/历代入口。
   现按计划补 `childTaskId` 兜底，并在真实任务路由测试中覆盖。
4. **A1/A9/T9 只有源码正则，没有真实路由行为锁**：现扩现有
   `task-detail-route-history.test.tsx`，验证画布单跳到 child、表格按钮切到 drawer pane，以及 drawer
   打开后 A→B 详情跳转会因 `remountDeps` 清空旧任务布局状态。

补充审计后的定向门：相关 4 文件 **68/68**，真实路由 + 核心回归组合 **69/69**，最终 RFC-245
组合 **84/84**，均通过。完整前端 **675 文件 / 5631 tests**、shared **1536 tests**、typecheck、lint、
format 全绿。

本地 `bun run test` 的 backend 长时轮在宿主临时端口耗尽后，由
`Bun.serve({ port: 0 })` `EADDRINUSE` 触发 47 条 WS / daemon 级联失败；既有
`rfc098-process-governance.test.ts` 的 2 条 PID 回收等待也在隔离复跑中稳定超时。RFC-245 零 backend
改动，且上述失败均不经过本 RFC 调用链，因此不把它们伪写成 RFC-245 绿灯，也不在本 RFC 越界修；
上库闭环以干净 hosted runner 的 exact-SHA CI 为最终权威。
