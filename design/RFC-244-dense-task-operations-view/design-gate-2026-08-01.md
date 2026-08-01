# RFC-244 · Codex 设计门记录（2026-08-01）

## 范围与方法

- 审核对象：`proposal.md`、`design.md`、`plan.md` Draft v1。
- 审核方式：在隔离的本地 clone 中以 Codex read-only gate 对照当前 task route/service/schema、
  RFC-192/RFC-232/RFC-243、Owner/WS/公共前端原语逐项做 source-backed 对抗审查。
- 首轮原始结论：**P0=0 / P1=5 / P2=3**；不是批准，全部 finding 必须折回 Draft v2 后复审。
- 生产代码：本门禁及修订均未修改生产代码。

## 首轮 findings 与处置

| 等级 | Finding                                                                                                      | Draft v2 处置                                                                                                                                                                                       | 状态   |
| ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1   | ownership `scope` 被当成 ACL set，会把实际 authorized parent 错标 unavailable                                | 拆 `taskAuthorizationCondition` 与 `taskOwnershipScopeCondition`；root/child ancestry、edge、`childCount` 只基于 ACL-only `authorized_tasks`，scope 仅筛 self-match；增加 admin + shared-scope 反例 | 已折入 |
| P1   | 每个 child cursor 请求重复全局递归和 facets，展开次数放大全表查询                                            | 拆 root global plan 与 child bounded-subtree plan；child 先按 authorized parent/index 限域且 response 无 facets；benchmark 改为 1 root + 20 expansions                                              | 已折入 |
| P1   | 裸 `json_extract` 遇历史损坏 workgroup config 会令整页 5xx                                                   | projection/search 共用 `json_valid + json_type + CASE` 的 frozen-name expression；corrupt/missing/wrong-type 与 legacy parity tests                                                                 | 已折入 |
| P1   | “deleted parent 留下 orphan”违背 RFC-243 cascade，现有 delete frame 又可能在删除后 gate 丢失                 | unavailable 只表示 unauthorized/dangling；正常 delete 继续 cascade；事务内冻结 cascade set audience，提交后逐 task 广播既有 deleted frame + 非序列化 context                                        | 已折入 |
| P1   | attention 依赖 alert，但 alert resolve 无事件；legacy `useTasksSync` 又会立即 refetch，无法实现稳定 dirty UX | additive `lifecycle.alert.resolved`；独立 `['task-operations']` key 与 `useTaskOperationsSync`，事件只标 dirty，用户/15s/reconnect/disconnected fallback 后整棵重建；legacy hook 不改               | 已折入 |
| P2   | `runningMs/runningSince` 在 projection 却不在 strict wire，且 legacy wall-clock helper 会算入人工等待        | 新 endpoint `executionClock` strict 字段 + RFC-207 累计运行 helper；legacy `TaskSummary/taskDurationCell` 不改                                                                                      | 已折入 |
| P2   | native table sibling rows + `aria-level` 没有完整 tree semantics / keyboard model                            | 明确改用原生 nested `<ol>/<li>`；稳定 branch id、原生 link/button、sr-only cell labels；不声明半套 tree/treegrid；加 VoiceOver/键盘验证                                                             | 已折入 |
| P2   | 状态多选未绑定现有公共原语，容易自写 checkbox/popover 平行控件                                               | filter 固定用公共 `Dialog` + `MultiSelect(searchable=false, allowCustom=false)` + `TASK_STATUS` options                                                                                             | 已折入 |

## Draft v2 的额外收敛

- cursor fingerprint 绑定 actor id、`tasks:read:all` capability、effective scope 与 parent/filter，跨 actor
  复用直接 422。
- root/child 使用 discriminated response：root 必有 facets，child schema 不允许 facets。
- `childCount` 保留 ACL-only direct child 旧语义；`qualifyingChildCount` 才受当前 query 影响。
- 事件不做 row status/delete 的局部乐观 patch，避免 row、tree stats 与 facets 出现多个真值。
- ownership/membership 会直接改变 authorized set 与 Owner；Draft v2 额外补
  `task.members.changed` + before/after audience union，覆盖新增/移除成员与 owner transfer。
- normal delete 与异常 dangling 明确分开，避免验收 fixture 建立在不可能的持久状态上。

## Focused 复审 findings 与 Draft v3 处置

- 复审对象：Draft v2 + 八项首轮 finding 的最小现有源码锚点。
- 复审方式：隔离 clone、Codex read-only、只检查首轮闭合度与 Draft v2 新矛盾。
- 原始结论：**P0=0 / P1=1 / P2=1**；两项均折回 Draft v3，尚不是批准。

| 等级 | Finding                                                                                             | Draft v3 处置                                                                                                                                                                                                  | 状态   |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1   | `task.members.changed` 紧随 revalidation trigger 广播，会命中 `revalidating=true` 的 frame 丢弃窗口 | revalidation hook 增 additive awaited adapter；`updateTaskMembers` 提交后 await 全部冻结连接刷新/关闭，再广播 before/after audience frame；既有 caller 仍 fire-and-forget；覆盖 pending/order/fail-closed 回归 | 已折入 |
| P2   | `MultiSelect(searchable=false)` 仍渲染可编辑 combobox，但输入不筛选，Enter 行为与可访问名称产生矛盾 | 删除 `searchable=false`，复用组件默认 searchable 模式，仅固定 `allowCustom=false`；增加本地化 label / wire value 输入与 Enter 切换测试                                                                         | 已折入 |

## Closing 复审

- 复审对象：Draft v3 中 awaited revalidation 时序与默认 searchable `MultiSelect` 两项修订。
- 复审方式：隔离 clone、Codex read-only，仅对照 revalidation hook/connections/registry/taskCollab、
  `MultiSelect` 与对应测试锚点。
- 复审结论：**APPROVED — P0=0/P1=0/P2=0**。

## 最终门禁结论

**APPROVED — P0=0/P1=0/P2=0**。RFC-244-T4 完成；当前仅等待用户对 RFC-244 的正式批准，批准前
不进入生产实现。
