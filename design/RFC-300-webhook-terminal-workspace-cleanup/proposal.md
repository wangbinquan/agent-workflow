# RFC-300 Webhook 终态工作区即时清理

状态：**Done（2026-08-14；实现 `835e5bda` 已进入 `main`，exact-SHA 主 CI 36/36 全绿）**

## 1. 背景

Webhook 事件仓库任务会从缓存仓创建每任务 linked worktree；Webhook scratch 任务则创建一座
独立的空 Git 仓库。两者在任务结束后都由任务行继续持有，只有管理员启用通用
`worktreeAutoGc` 后，后台小时级扫描才会按年龄/合并条件回收。

这不适合高频 Webhook：大量已经成功完成或明确取消的任务仍长期占用磁盘。用户要求在设置页
提供一个专用开关，让 Webhook 任务运行结束后立即释放自己拥有的工作区，并进一步明确：

- 事件仓库 worktree 与 scratch 独立仓库都要覆盖；
- 只在 `done` / `canceled` 时清理；
- `failed` / `interrupted` 继续保留，以支持恢复和排障；
- 借用父任务目录的 `inherited` 子任务不能删除父任务拥有的空间。

## 2. 用户已拍板的产品规则

### D1. 一个默认关闭的全局开关

新增 `webhookTaskWorkspaceAutoCleanup: boolean`，默认 `false`，放在“设置 → GC”。默认关闭时
行为逐字保持现状；开启无需重启。

### D2. 只覆盖两个不可恢复终态

开关只在 Webhook 根任务进入以下状态时请求清理：

- `done`
- `canceled`

`failed` 与 `interrupted` 不清理；`pending`、`running`、`awaiting_review`、
`awaiting_human` 当然也不清理。

### D3. 事件仓库与 scratch 都清理，借用空间者排除

候选必须同时满足：

1. `tasks.webhook_trigger_id IS NOT NULL`，即由 Webhook fire 直接创建；
2. `space_kind IN ('remote', 'scratch')`，即任务拥有自己的空间；
3. 状态为 `done` 或 `canceled`；
4. 尚未进入/完成 workspace prune。

专用 claim 另带 `workspace_prune_cause='webhook-terminal'`。历史 RFC-165 GC 与 iso-container GC
共用同一 timestamp，但 cause 为 NULL；启动恢复不得把这些旧/临时 claim 解释为本开关的删除授权。

明确排除：

- `inherited` 调用子任务：它借用父任务 call-node iso，不拥有目录；
- 仅继承 `trigger_context_json` 的子任务：不能因“看起来有 webhook context”被误判为根任务；
- `internal`、历史 `local`、普通手动/定时任务；
- Webhook `failed` / `interrupted` 任务。

### D4. 在终态转换时生效，不追溯历史

策略在线性化的 `done` / `canceled` 状态转换时读取：

- 开关打开后进入终态的合格任务会被清理，包括开关打开前已启动、之后才结束的任务；
- 开关打开前已经终态的历史任务不会被本策略追溯扫描；
- 一旦某任务已写入 durable prune claim，随后关闭开关不会撤销该次清理；关闭只影响未来终态转换。

通用 `worktreeAutoGc` 仍保持自己的既有历史扫描语义，两套策略互不改写。

### D5. “立即”指终态原子认领，执行所有权释放后删除

终态状态写与 workspace prune claim 必须在同一 DB CAS 中完成，避免 daemon 在“任务已经终态、
清理意图还没落库”的窗口崩溃而永久漏清。

文件系统删除不在状态事务内执行：它在 scheduler/runner 完全结算、活动任务所有权释放后立即
开始，避免取消兜底与仍在退出的子进程/iso merge/discard 竞争目录。删除失败不把已完成任务
改成失败；claim 保留，由启动恢复和后台 ticker 重试。

### D6. 保留任务历史，删除依赖 live workspace 的能力

清理只删除磁盘工作区与对应 snapshot refs，不删除任务行、node runs、事件、会话、持久化输出、
归档产物或 Webhook delivery/fire 记录。

清理后：

- worktree 文件浏览、live 文本 diff、仍需工作区计算的结构化视图按既有契约不可用；
- `done` / `canceled` 任务不能再从旧工作区做单节点 retry 或 sync-workflow；如需继续，重新启动
  一项新任务；
- scratch 中未进入持久化输出/归档的临时文件会随整座空仓删除；
- linked worktree 中未提交的修改会丢失；已提交到任务分支的 Git 对象/分支按既有 GC 原语处理。

任务详情必须停止显示“worktree 已保留”的误导横幅，并在工作区已清理时隐藏会必然失败的 retry
入口；任务历史本身继续可读。

## 3. 目标

1. 高频 Webhook 的成功/取消任务在结束后不再长期堆积独立工作区。
2. remote linked worktree 与 scratch Git 仓库共用同一可靠的两阶段 prune 原语。
3. 终态认领原子、实际删除不与仍活跃的执行所有者竞争，并能在失败/重启后续做。
4. 精确区分 Webhook 根任务与只继承 context 的调用子任务。
5. 默认行为、普通任务、失败/中断恢复能力和通用 GC 策略保持不变。
6. 设置文案与任务详情明确告知工作区删除带来的能力变化。

## 4. 非目标

- 不删除 cached repo/mirror、Webhook trigger、endpoint、delivery 或 fire 记录。
- 不清理 `failed` / `interrupted` 工作区。
- 不让 `inherited` 子任务取得或删除磁盘所有权。
- 不改变 Webhook supersede、熔断、匹配、启动空间选择或权限模型。
- 不为已结束历史任务做专用 backfill/bulk cleanup。
- 不保证所有输出都能在无工作区时重算；本 RFC 只保留已经持久化/归档的结果。
- 不把实际 Git 删除放进任务状态事务，也不因清理失败回滚终态。

## 5. 用户故事

1. **成功事件仓任务**：任务显示完成后，其 linked worktree 很快消失，任务记录与输出仍在。
2. **取消中的事件仓任务**：子进程和 iso 先完成退出/回收，随后删除 canonical worktree，不发生
   “目录先删、退出流程再访问”的竞态。
3. **成功/取消 scratch**：整座临时 Git 仓库直接删除，不尝试 `git worktree remove`。
4. **失败/daemon 中断**：工作区继续存在，用户仍可 Resume、看文件和排障。
5. **调用子任务**：子任务终态不会删除父任务 call-node iso；由父任务既有 iso 生命周期负责。
6. **删除失败/daemon 重启**：任务状态保持终态，durable claim 在重启或后续 ticker 中继续完成。
7. **开关时序**：只处理开启后新发生的终态，不突然扫掉管理员未预期的历史任务。

## 6. 验收标准

- [x] 配置 schema/default/PATCH/CLI/设置 draft 均包含 `webhookTaskWorkspaceAutoCleanup`，默认 false。
- [x] 设置 → GC 使用公共 `Switch`，双语 hint 明确 done/canceled、remote/scratch、失败/中断保留与能力影响。
- [x] Webhook remote + `done`、remote + `canceled` 均原子写 claim，并在执行所有权释放后删除 worktree。
- [x] Webhook scratch + `done`、scratch + `canceled` 均原子写 claim，并递归删除整座 scratch repo。
- [x] `failed` / `interrupted`、普通任务、历史 `local`、`internal`、`inherited` 均不被专用策略认领。
- [x] 判定使用 `webhook_trigger_id`，只继承 trigger context 的子任务不会误清。
- [x] 开启前已终态任务不追溯；开启后进入终态的在途任务会清；关闭不撤销已落 claim。
- [x] 状态 CAS 丢失时不能留下孤立 claim；状态写与 claim 要么一起成功，要么一起不成功。
- [x] claim 持久化 `webhook-terminal` 来源；升级前/普通/iso GC 的 NULL-cause claim 绝不被专用恢复接管。
- [x] 活跃 task driver 存在时只认领不删；driver settle 后立即删除。
- [x] 删除失败保留 claim/终态，启动恢复与 ticker 可幂等重试；重复 finalizer 不报错、不重复破坏。
- [x] 成功后 `workspace_pruned_at` 落库；任务行、node runs、事件、持久化输出与归档产物仍可读。
- [x] 任务详情不再为已清理的 canceled 任务显示“worktree 已保留”，且不提供必然失败的 node retry。
- [x] 通用 `worktreeAutoGc` 的年龄、onlyMerged、四终态和默认关闭行为回归不变。
- [x] 定向 shared/backend/frontend/E2E、typecheck/lint/format 与 `bun run gate:local` 全绿。

## 7. 能力影响清单（需随 RFC 显式批准）

这是管理员主动开启的能力收缩：

| #   | 开关开启后的变化                                                                  | 未受影响范围                                                               |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| C1  | Webhook `done` / `canceled` 的 live 工作区、未提交修改和 scratch 临时文件会被删除 | 默认关闭；普通任务与历史终态不受专用策略影响                               |
| C2  | 这些任务不能再从旧工作区做单节点 retry 或 sync-workflow                           | 重新 launch 新任务仍可；`failed` / `interrupted` 的 Resume/retry/sync 保留 |
| C3  | worktree 文件、live diff 和依赖 live workspace 的视图不可用                       | DB 历史、日志、会话、持久化输出与归档产物保留                              |
| C4  | `onlyMerged` 不保护本即时策略；取消/完成即按管理员选择删除                        | 通用 `worktreeAutoGc.onlyMerged` 语义不变                                  |
| C5  | 已落 durable claim 的清理在随后关闭开关后仍会完成                                 | 关闭后不会为未来终态新增 claim                                             |
| C6  | `inherited`/internal/local、普通任务、失败/中断任务绝不进入本策略                 | 它们继续走各自原有生命周期                                                 |
