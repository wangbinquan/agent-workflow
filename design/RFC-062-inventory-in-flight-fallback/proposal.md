# RFC-062 — Inventory In-Flight Fallback

状态：Done（2026-05-25 单 PR 全部 T1-T4 落地）

## 背景

RFC-029 把 opencode 子进程的 runtime inventory（loaded agents / skills / mcps / plugins）以快照形式持久化到 `node_runs.inventory_snapshot_json`，再由 `RuntimeInventorySection`（task detail 抽屉 → Session 标签内的 `<details>` 折叠区）展示出来。落地至今工作正常，**对已结束的 run** 准确无误。

但对**正在运行的 agent run**，section body 一直显示 `未生成清单文件（插件可能加载失败）。` —— 文案上把责任甩给"插件加载失败"，事实却并非如此。

定位现场（2026-05-25 task `01KSESDVXQVRQX1FXG6N432C52`，picker 选中 `反问#3 13:34:20` = node_run `01KSET103XKDECB04R19AKFQ4R`，status=`running`）：

- `~/.agent-workflow/runs/01KSESDVXQVRQX1FXG6N432C52/01KSET103XKDECB04R19AKFQ4R/inventory.json` 文件**存在**（3251 bytes，`{"captured":true,"agents":9,"skills":2,"mcps":0,"plugins":2,"capturedAt": ...}`），写盘时间比 run.startedAt 晚约 4 秒
- 同时 DB `node_runs.inventory_snapshot_json` 列**为 NULL**
- API `/api/tasks/:taskId/node-runs/:nodeRunId/inventory` 走 `services/inventory.ts:177-179` 命中 NULL 分支 → 返回 `{captured:false, reason:'file-missing'}`
- 前端 `RuntimeInventorySection.tsx:98-104` 把 `file-missing` 渲染成 i18n key `nodeDrawer.inventory.reason.file-missing` → 中文文案"未生成清单文件（插件可能加载失败）。"

**根因**：写盘（dump 插件，opencode 启动后立即触发）与"持久化到 DB"（runner.ts:1083-1097 step 10b → :1124-1137 step 11）之间有秒~分钟级 gap —— runner 只在 opencode 进程**退出之后**才读 `inventory.json` 并写 DB。这段窗口期 API 看到的是 NULL，前端被迫渲染 file-missing 文案。文案本身又把插件错钉为"加载失败"，对用户和后续排障都误导。

## 目标 (Goals)

1. **正在运行的 agent run 也能看到运行时清单**：当 DB 列还没回填、但磁盘 inventory.json 已经写好且可解析时，API 返回 captured 快照，UI 渲染 chips + tables，与"已结束 run"的体验对齐。
2. **区分"in-flight 等待写盘"和"真的没生成"两种状态**：新增 `in-flight` reason code 给"running 但磁盘文件不存在"的瞬时窗口（plugin 启动 / queueMicrotask 还没跑完）；文案明确不指责插件。
3. **零产品行为回归**：已结束 run（done / failed / canceled / exhausted / interrupted）走原有 DB 命中 / NULL → file-missing 路径，字节级守恒；测试与守门强制锁住这一点。

## 非目标 (Non-Goals)

- **不动 dump 插件**（`aw-inventory-dump.mjs`）。插件本来就工作正常。
- **不动 runner 写 DB 的时序**。中间过程同步、周期回写、chat.message 事件同步等方案，都额外引入并发风险（多次写、覆盖、journal 风暴）和复杂度，不是修这个 UX 问题的最短路径。
- **不引入新表 / migration / drizzle schema 变更**。in-flight 兜底是纯读端逻辑。
- **不动 inventory 持久化字段（`node_runs.inventory_snapshot_json`）的最终值**。终态写盘仍由 runner step 11 负责。
- **不为非 agent kind 的 run 提供 in-flight 兜底**。`agent-single` 之外的 kind 不会有 inventory.json，不进入兜底分支。

## 用户故事

**US-1（主线）**：用户在 task 进行中查看某个 agent_xxx 节点的右抽屉 Session 标签，展开"运行时清单"折叠区 → 立即看到 `智·N 技·M M·X 插·Y` 4 个 chip 与下方 agents / skills / mcps / plugins 表格。不再看到"未生成清单文件（插件可能加载失败）"。

**US-2（瞬时空窗）**：用户在 opencode 子进程刚启动、`queueMicrotask(dump)` 还没把文件写到磁盘的瞬间打开抽屉 → 看到"正在运行，清单生成中…"占位文案，3 秒内 refetchInterval 触发后刷新成 US-1 的真实数据。文案不暗示插件失败。

**US-3（已结束 run，回归保险）**：用户回看一个已 done / canceled / failed 的旧 run → 行为与 RFC-029 落地后完全一致，不会因 in-flight 兜底误读残留 runRoot（即使 cleanup 失败遗留了 inventory.json，也不会绕过 DB 终态）。

## 验收标准 (Acceptance Criteria)

**API 层（`getInventorySnapshot` 行为矩阵）**：

| run.status                                | DB 列      | runRoot 文件        | 期望返回                                                                                                 |
| ----------------------------------------- | ---------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `running`                                 | NULL       | 存在 + 合法 JSON    | **`{captured:true, ...}`**（从文件解析） ← AC-1                                                          |
| `running`                                 | NULL       | 不存在              | **`{captured:false, reason:'in-flight'}`** ← AC-2（新增 reason）                                         |
| `running`                                 | NULL       | 存在但 JSON 损坏    | `{captured:false, reason:'parse-failed', message: <truncated>}` ← AC-3（复用现有 reason）                |
| `running`                                 | 非 NULL    | 任意                | DB 命中路径不变，仍解析 DB 内容 ← AC-4（回归锁）                                                         |
| `done` / `failed` / `canceled` / `exhausted` / `interrupted` | NULL       | 任意                | `{captured:false, reason:'file-missing'}` ← AC-5（不进入 in-flight 兜底；与现有契约字节级守恒）          |
| `done` 等终态                              | 非 NULL    | 任意                | DB 命中路径不变 ← AC-6（回归锁）                                                                          |
| 非 `agent-single` kind                     | —          | —                   | 现有 410 `node-kind-not-supported` 行为不变 ← AC-7                                                       |
| `pending`                                  | NULL       | 不存在              | `{captured:false, reason:'file-missing'}` ← AC-8（pending 还没启动 opencode，不进入 in-flight）          |

**前端**：

- AC-9：i18n key `nodeDrawer.inventory.reason.in-flight` 在 zh-CN / en-US 两语言文件都存在；文案明确表达"运行中、生成中"，不指责插件
- AC-10：`RuntimeInventorySection` 在 `snap.reason === 'in-flight'` 时渲染新文案；现有 `file-missing` / `parse-failed` / `dump-plugin-internal-error` / `non-agent-kind` / `opencode-pure-mode` 等所有其他 reason 渲染路径字节级守恒
- AC-11：data-testid `inventory-missing` 仍挂在 "captured:false" 容器上（i18n 文本变了不影响 DOM 锚点）

**回归保险**：

- AC-12：RFC-029 既有套件零退化（backend `inventory-service*.test.ts` / `inventory-route*.test.ts` / `runner-inventory*.test.ts` + frontend `runtime-inventory-section.test.tsx` 全部继续绿）
- AC-13：grep 守门——`services/inventory.ts` 必须包含 `'in-flight'` 字面量与 runRoot 读盘 helper 调用；`shared/inventory.ts` 的 `InventoryReasonCode` union 必须包含 `'in-flight'`

## 与既有 RFC 的关系

- **RFC-029（runtime inventory）**：本 RFC 是它的读端补丁。RFC-029 的写盘契约（dump plugin → runRoot/inventory.json → runner step 10b 读 + step 11 落 DB）一行不动。
- **RFC-053（node-run lifecycle）**：兜底分支依赖 `node_runs.status === 'running'` 作为门控信号；RFC-053 的 CAS 状态机保证这个字段是权威的。
- **RFC-057（diagnose repair）**：lifecycle alert / repair 不依赖 inventory；本 RFC 不引入新 alert rule。
- **RFC-060（fanout as wrapper）**：`isAgentRunKind` 已经在 RFC-060 PR-E 收口成 `nodeKind === 'agent-single'`，本 RFC 复用同一守门；wrapper-fanout 容器节点本身不是 agent-single，自然落到 410 分支，无新增逻辑。
