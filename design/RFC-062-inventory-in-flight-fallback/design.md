# RFC-062 — Technical Design

## 1. 总览

读端兜底：API GET `/api/tasks/:taskId/node-runs/:nodeRunId/inventory` 在 DB 列为 NULL 且 run 处于 `running` 状态时，尝试从 `~/.agent-workflow/runs/{taskId}/{nodeRunId}/inventory.json` 现场读盘并返回 captured 快照；文件不存在则返回新 reason `in-flight`。写端（dump plugin、runner 持久化）完全不动。

## 2. 模块改动

### 2.1 shared 层 — `packages/shared/src/inventory.ts`

`InventoryReasonCode` union 新增 literal `'in-flight'`：

```ts
// before
export const InventoryReasonCode = z.enum([
  'non-agent-kind', 'opencode-pure-mode', 'file-missing', 'parse-failed',
  'dump-plugin-internal-error', 'plugin-load-failed', 'schema-mismatch',
])

// after — append-only, no removals
export const InventoryReasonCode = z.enum([
  'non-agent-kind', 'opencode-pure-mode', 'file-missing', 'parse-failed',
  'dump-plugin-internal-error', 'plugin-load-failed', 'schema-mismatch',
  'in-flight',
])
```

`InventorySnapshotMissingSchema` / `InventorySnapshotSchema` discriminated union 自动跟随 union 扩展，无 schema 形状变化。

`inventoryReasonCode(err, ctx)` 分类器**不变**：它只在解析 / 读盘异常时调用，不知道也不需要知道"in-flight"（in-flight 由调用方根据 `run.status === 'running'` 显式 short-circuit 决定，不走 catch 分支）。这是有意的——in-flight 是**运行时状态**而不是**错误类型**，分类器仍只管错误。

### 2.2 backend service — `packages/backend/src/services/inventory.ts`

新增两块：

#### 2.2.1 `runRootFor(taskId, nodeRunId)` helper（纯函数）

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-run dir owned by the framework runtime, mirroring the layout
 * `services/runner.ts` writes to (~/.agent-workflow/runs/{taskId}/{nodeRunId}).
 * Exported so `getInventorySnapshot` can read in-flight inventory.json from
 * the same path the runner would post-exit. Kept a pure function so unit
 * tests can pass a stub HOME via env override and the runner stays the
 * source of truth for "where runRoot lives".
 */
export function runRootFor(taskId: string, nodeRunId: string): string {
  const home = process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), '.agent-workflow')
  return join(home, 'runs', taskId, nodeRunId)
}
```

> **为什么不复用 runner.ts 内部计算路径的代码？**
> Runner 内部用同样的常量但拼路径的逻辑散落在 `runNode` 入口；抽出一个 *exported* helper 让两侧共用，并把 runner 那里的 inline 拼接替换为这个 helper（**T2 内顺手做**，确保未来路径再改一处即可）。

> **为什么读 `AGENT_WORKFLOW_HOME` env？**
> 与 `services/config.ts` 现有约定保持一致（grep `AGENT_WORKFLOW_HOME` 可见 daemon / e2e fixture 都用这个 env override $HOME 走临时目录）。

#### 2.2.2 `getInventorySnapshot` 兜底分支

```ts
// services/inventory.ts — current (lines 177-179)
if (run.inventorySnapshotJson === null || run.inventorySnapshotJson === '') {
  return { captured: false, reason: 'file-missing', message: null }
}

// services/inventory.ts — after
if (run.inventorySnapshotJson === null || run.inventorySnapshotJson === '') {
  // RFC-062: runner only writes the DB column AFTER the opencode child exits.
  // For a still-running agent run, inventory.json may already be on disk —
  // read it directly so the UI sees real data instead of the misleading
  // "plugin may have failed" file-missing fallback.
  if (run.status === 'running') {
    const snap = await readSnapshotFromRunDir({
      runDir: runRootFor(taskId, nodeRunId),
      nodeKind: 'agent-single',  // PROMPT_CAPABLE_KINDS guard already passed
      pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
    })
    // The disk read can land on:
    //   - captured:true                  → return as-is (US-1)
    //   - reason:'file-missing'          → upgrade to 'in-flight' (US-2 瞬时空窗)
    //   - reason:'parse-failed' / other  → propagate as-is (AC-3 / AC-7)
    if (snap.captured) return snap
    if (snap.reason === 'file-missing') {
      return { captured: false, reason: 'in-flight', message: null }
    }
    return snap
  }
  return { captured: false, reason: 'file-missing', message: null }
}
```

**关键设计点**：

1. **门控信号是 `status === 'running'`**，不是"DB 列为 NULL 时不管三七二十一去读盘"。已结束 run 即便 runRoot 还没被 cleanup（runner step 12 是 best-effort），也不会绕过 DB 终态——保证 AC-5 / AC-6。
2. **`pureMode` 沿用 `readSnapshotFromRunDir` 的原有参数语义**，env override 与 RFC-029 一致；不引入新 env。
3. **`nodeKind` 硬编码 `'agent-single'`**，因为分支前的 `PROMPT_CAPABLE_KINDS.has(nodeKind)` 守门已经把非 agent-single 短路成 410。重新查 snapshotJson 解析 nodeKind 没意义。
4. **`file-missing` → `in-flight` upgrade 只发生在 status=running**，发生在 NULL 兜底分支内。其他所有路径（DB 命中 / 终态 / non-agent / pure-mode）零改动。
5. **不缓存读盘结果到 DB**。in-flight 兜底纯读、idempotent；让 runner step 11 仍是 DB 写入的唯一权威。否则会出现 "兜底写了一份 → runner 退出后又写一次"，竞争 + 字段值不一致风险。

### 2.3 backend route — `packages/backend/src/routes/tasks.ts`

零改动。`/api/tasks/:taskId/node-runs/:nodeRunId/inventory` 路由处理器只是把 `getInventorySnapshot` 返回值序列化；reason union 扩了 `'in-flight'` 后 zod schema 自动接纳。

### 2.4 frontend i18n — `packages/frontend/src/i18n/{zh-CN,en-US}.ts`

新增一组 key：

```ts
// zh-CN.ts — nodeDrawer.inventory.reason 节点新增
'in-flight': '正在运行，清单生成中…',

// en-US.ts — 对应位置
'in-flight': 'Run in progress, inventory generating…',
```

文案设计原则：

- 不含"插件" / "plugin" 字样（与 file-missing 文案"插件可能加载失败"区分，不指责）
- 含"运行中" / "in progress" 表达瞬态性
- 末尾省略号暗示"再等等就有了"

### 2.5 frontend component — `packages/frontend/src/components/inventory/RuntimeInventorySection.tsx`

零代码改动。`InventoryBody` 现有的：

```ts
if (!snap.captured) {
  const reasonKey = `nodeDrawer.inventory.reason.${snap.reason}` as const
  return (
    <div className="inventory-section__missing" data-testid="inventory-missing">
      {t(reasonKey, { defaultValue: snap.reason })}
    </div>
  )
}
```

天然按 `snap.reason` 拼 i18n key，新 reason 自动渲染。data-testid `inventory-missing` 保留（AC-11）。

### 2.6 runner 一处可选清理

`services/runner.ts` 当前两处拼 runRoot 的代码：

```ts
const runRoot = join(homedir(), '.agent-workflow', 'runs', opts.taskId, opts.nodeRunId)
```

在 T2 内改成调 `runRootFor(opts.taskId, opts.nodeRunId)`。**纯重构**，不改语义；好处是路径常量未来只剩一处。把这事顺手做完，避免 RFC-062 落地后 inventory 读端和 runner 写端的"runRoot 拼法"漂移。

## 3. 失败模式与边界

| 场景                                                                                  | 行为                                                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| dump 插件挂掉（runRoot/inventory.json 永远不出现，run 仍在 running）                  | API 在每次轮询时都尝试读盘 → 返回 `in-flight` → 用户看到"运行中、生成中…"；run 结束后 runner step 10b 也读不到 → DB 落 `plugin-load-failed`   |
| dump 插件先写 `{captured:false, reason:'dump-plugin-internal-error'}` 后再无更新       | 读到 missing stub → `parsed.success` 命中 `InventorySnapshotMissingSchema` → 返回该 stub 不动；UI 显示插件内部错（与 RFC-029 既有 stub 路径一致） |
| Run 已 canceled 但 runRoot 还在 + inventory.json 残留                                  | `run.status !== 'running'` → 不进入兜底 → DB NULL → `file-missing`（AC-5 守门）                                                              |
| Run 进入 `awaiting_review` / `awaiting_human`                                          | status 既不是 running 也不是 done → DB NULL → file-missing。这两个状态下 opencode 子进程已经退出，inventory.json 应已被 runner 持久化或 runRoot 已清理；命中此分支即说明 runner 异常退出（属于 RFC-053 lifecycle 异常），不是 RFC-062 兜底场景 |
| Run 状态从 running 切到 done 的瞬间（race）                                           | 任一时刻只命中一条分支。最坏情况：兜底分支读完文件返回 captured，与几毫秒后的另一次请求走 DB 命中路径，两次返回内容一致（dump 插件写的 = runner step 11 读的） |
| inventory.json 文件存在但权限 denied / fs 错误                                         | `readSnapshotFromRunDir` 内 `inventoryReasonCode(err, ...)` 现有路径已分类为 `file-missing` / `parse-failed` 等；兜底分支统一升格成 `in-flight` 仅当原 reason 是 file-missing |
| `AGENT_WORKFLOW_HOME` env 与 runner 启动时不一致（极端场景：daemon 重启换 env）         | 读端按当前 env 找 runRoot；runner 写盘按当时 env 找。两者本来就该相等；不等的话现有 RFC-029 写端也会找错位置，已不是本 RFC 引入的新问题。Test 用 env override 验证默认 vs 自定义两条路径 |

## 4. 测试策略

**新增测试** —— 全部在 `packages/backend/tests/inventory-in-flight-fallback.test.ts` + `packages/shared/tests/inventory-reason-code.test.ts` + `packages/frontend/tests/runtime-inventory-section-in-flight.test.tsx`。

### 4.1 shared（≥ 3 case）

- C-S1：`InventoryReasonCode` union 包含 `'in-flight'`（zod parse 测试）
- C-S2：`InventorySnapshotMissingSchema.safeParse({captured:false, reason:'in-flight', message:null})` 成功
- C-S3：`InventorySnapshotSchema` discriminated union 接受 `in-flight` reason

### 4.2 backend（≥ 8 case）

按 §AC 矩阵行覆盖：

- C-B1（AC-1 主线）：`status='running'` + DB NULL + 文件存在合法 → 返回 `{captured:true, agents:[...], ...}`
- C-B2（AC-2 in-flight）：`status='running'` + DB NULL + 文件**不存在** → `{captured:false, reason:'in-flight', message:null}`
- C-B3（AC-3 parse-failed propagation）：`status='running'` + DB NULL + 文件**损坏** → `{captured:false, reason:'parse-failed', message:<truncated>}`
- C-B4（AC-4 DB 命中回归）：`status='running'` + DB 非 NULL → 直接解析 DB，不读盘（用 `existsSync` spy / 间接断言不调 `readSnapshotFromRunDir`）
- C-B5（AC-5 终态守门 a）：`status='done'` + DB NULL + 文件存在（模拟 cleanup 失败）→ `{captured:false, reason:'file-missing'}`，不读取磁盘
- C-B6（AC-5 终态守门 b）：`status='canceled'` + DB NULL + 文件存在 → `file-missing`
- C-B7（AC-5 终态守门 c）：`status='failed'` + DB NULL + 文件存在 → `file-missing`
- C-B8（AC-7 非 agent kind）：`workflowSnapshot` 标 review / clarify / input / output / wrapper-* kind → 仍走原 410 分支
- C-B9（AC-8 pending）：`status='pending'` + DB NULL + 文件不存在 → `file-missing`（不进入 in-flight）
- C-B10（dump-internal-error stub 透传）：`status='running'` + 文件内容 `{captured:false, reason:'dump-plugin-internal-error', message:'X'}` → 原样返回，不升格成 in-flight
- C-B11（`runRootFor` 单测）：默认 home / `AGENT_WORKFLOW_HOME` env override / 各组件正确转义

### 4.3 backend grep 守门（≥ 2 case）

- C-B12：`grep "'in-flight'" packages/backend/src/services/inventory.ts` ≥ 1 行（防止 in-flight 兜底被 silent 移除）
- C-B13：`grep "runRootFor(" packages/backend/src/services/runner.ts` ≥ 1 行（runner 也用 helper，路径单源）

### 4.4 frontend（≥ 4 case）

`packages/frontend/tests/runtime-inventory-section-in-flight.test.tsx`：

- C-F1：mock API 返回 `{captured:false, reason:'in-flight'}` → 渲染 zh 文案"正在运行，清单生成中…"
- C-F2：同上 + en locale → "Run in progress, inventory generating…"
- C-F3：data-testid `inventory-missing` 仍在（DOM 锚点回归锁）
- C-F4：i18n key `nodeDrawer.inventory.reason.in-flight` 在 zh-CN + en-US 两文件都存在（直接 import 断言）+ 文案**不含**"插件" / "plugin" 字符串（强化"不指责插件"的产品意图，防止文案漂移）

### 4.5 既有套件零退化

- RFC-029 全部 inventory 相关测试 `bun test inventory` 应当一次绿（不修改任何 expected 值）
- runner 走完已结束 run 的 inventory 持久化路径不变（C-B5/B6/B7 守门）

## 5. 性能 / 资源

- 兜底分支多一次 `readFile` 系统调用 + JSON parse。inventory.json 典型 < 10KB；GET 路由本来就是 ad-hoc 查询（前端 useQuery 没设 refetchInterval，仅在 attempt 切换或抽屉重开时触发）。性能影响可忽略。
- 无新连接 / 锁 / cron / 后台任务。

## 6. 兼容 / 迁移

- 老前端（不知道 `in-flight` reason）：i18n fallback 由 `t(reasonKey, { defaultValue: snap.reason })` 兜底 → 渲染"in-flight"裸字符串。视觉不优雅但不报错；用户升级前端即修复。
- 老后端 + 新前端：DB NULL → 老逻辑返回 `file-missing` → 前端 i18n 渲染原文案；in-flight 改进只在前后端都升级后生效。
- 无 DB schema 变更 → 无 migration。

## 7. 安全 / 隐私

- 兜底读盘路径都在 `~/.agent-workflow/runs/{taskId}/{nodeRunId}` 受控目录内，路径由 ULID 构成、无路径穿越风险。
- inventory.json 内容是 opencode 已注册的 agent / skill / mcp / plugin 元数据，原本就要展示给同 taskAccessible 用户，无新暴露面。
