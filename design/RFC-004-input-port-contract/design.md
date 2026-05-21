# RFC-004 Design — Input 节点端口契约统一 + `definition.inputs[]` 同步

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 改动地图

| 文件 | 改动类型 | 摘要 |
| --- | --- | --- |
| `packages/backend/src/services/scheduler.ts` | edit | `runOneNode` input 分支：`portName: 'out'` → `portName: inputKey` |
| `packages/backend/src/services/workflow.validator.ts` | edit | 新增 rule `input-key-not-declared`（input.inputKey ∈ definition.inputs[].key 必须）；既有 `outs.add(inputKey)` 已对齐，不动 |
| `packages/backend/tests/scheduler.test.ts` | edit | 3 处 `portName: 'out'` 改 `portName: inputKey`；新增 `input-port-contract.test.ts`（独立文件）锁线上复盘 case |
| `packages/backend/tests/workflow-validator.test.ts` | edit | 新增 3 case：`input-key-not-declared` 触发 / declared 时通过 / `input-orphan-declared` warning（非阻塞） |
| `packages/frontend/src/components/canvas/syncInputDefs.ts` | new | 纯函数 `syncInputDefs(prevDef, nextNodes): WorkflowInput[]` —— 协调 inputs 数组与 input 节点集合 |
| `packages/frontend/src/components/canvas/NodeInspector.tsx` | edit | input 分支：在 `inputKey` 之外渲染 `kind / label / required / description` 四字段；改 inputKey 时触发级联重命名 |
| `packages/frontend/src/components/canvas/WorkflowCanvas.tsx` | edit | `applyNodeChange` / `applyEdgeChange` 落点后调用 `syncInputDefs` 更新 `definition.inputs[]` |
| `packages/frontend/src/components/canvas/nodePalette.ts` | edit | 新建 input 节点时不再只给 `inputKey`，新增工厂返回与 syncInputDefs 一致的 default entry shape（避免双写） |
| `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` | edit | 新增 5 条 `inspector.fieldInput*` key（kind / label / required / description / labelHint） |
| `design/design.md` | edit | §5 YAML 样例 `source.portName: out` 改 `source.portName: requirement`；§7.3 输入端口章节顶部加一段"端口名 = inputKey" |
| `STATE.md` | edit | 顶部追加 `"进行中 RFC：[RFC-004](...)"` 一行；完工时挪到"已完成 RFC"表 |
| `design/plan.md` | edit | RFC 索引表追加 `RFC-004` 行 |

不动文件清单（明示）：

- `packages/backend/src/routes/tasks.ts`、`packages/backend/src/services/runner.ts`、`packages/shared/src/schemas/workflow.ts`、`packages/shared/src/prompt.ts`、`packages/backend/src/db/schema.ts`、`packages/backend/db/migrations/*`、`packages/frontend/src/routes/workflows.launch.tsx`、`packages/frontend/src/components/canvas/nodes/InputNode.tsx`、RFC-003 的 `canvas-connect.ts` / `EdgeInspector.tsx` / `PortHandles.tsx`。

## 2. 契约（运行时 + 校验 + 画布三对齐）

```
input 节点 in_X (inputKey: K)
  ├─ 运行时（scheduler.ts）        → 写 nodeRunOutputs (portName=K, content=task.inputs[K])
  ├─ 静态校验（validator.ts）       → outputPorts.set(in_X, {K})；edges 必须用 portName=K
  ├─ 画布渲染（WorkflowCanvas.ts）  → 右侧具名 handle id=K，label=K
  └─ Launcher 表单（launch.tsx）   → 从 definition.inputs[] 找 key=K 那条 → 渲染对应 picker
```

**唯一身份**：`inputKey`（也即端口名）。`definition.inputs[].key` 与 `input` 节点 `inputKey` 一一对应（即 `inputs[]` 不可以有 input 节点不引用的 key —— warning；input 节点不可以引用 inputs[] 没有的 key —— error）。

## 3. `syncInputDefs` 纯函数（编辑器侧的协调器）

```ts
// packages/frontend/src/components/canvas/syncInputDefs.ts

import type { WorkflowDefinition, WorkflowInput, WorkflowNode } from '@agent-workflow/shared'

/**
 * Reconcile `definition.inputs[]` with the set of input nodes by inputKey.
 *
 * Rules (order matters):
 *   1. Keep every existing inputs[] entry whose key is referenced by some
 *      input node — preserves user-customized label / kind / required /
 *      description across edits.
 *   2. For every input node whose inputKey has no matching entry, append a
 *      default entry `{ kind: 'text', key, label: key, required: true }`.
 *   3. Drop inputs[] entries whose key is no longer referenced — orphans
 *      are surfaced by the validator as a warning before this fires,
 *      but if reconciler runs on a no-orphans-remaining state we just
 *      clean up. (Editor calls reconciler post-node-delete so cleanup is
 *      always the right move at that point.)
 *
 * Pure: returns a new array; never mutates inputs in place. Equality check
 * (shallow) lets the caller skip a state update when nothing changed.
 */
export function syncInputDefs(
  prevInputs: WorkflowInput[],
  nodes: WorkflowNode[],
): WorkflowInput[] {
  const keysInNodes = new Set<string>()
  for (const n of nodes) {
    if (n.kind !== 'input') continue
    const k = (n as Record<string, unknown>).inputKey
    if (typeof k === 'string' && k.length > 0) keysInNodes.add(k)
  }
  const kept = prevInputs.filter((i) => keysInNodes.has(i.key))
  const keptKeys = new Set(kept.map((i) => i.key))
  const added: WorkflowInput[] = []
  for (const k of keysInNodes) {
    if (keptKeys.has(k)) continue
    added.push({ kind: 'text', key: k, label: k, required: true })
  }
  return [...kept, ...added]
}
```

**为什么用纯函数 + 等值短路**：避免触发 RFC-003 那条"1s 自动保存"的连环更新；也方便单测。

**调用点**（在 `WorkflowCanvas.tsx`）：

```ts
function applyDefinitionPatch(prev: WorkflowDefinition, patch: Partial<WorkflowDefinition>): WorkflowDefinition {
  const merged = { ...prev, ...patch }
  const nextInputs = syncInputDefs(merged.inputs ?? [], merged.nodes ?? [])
  if (nextInputs === merged.inputs) return merged
  return { ...merged, inputs: nextInputs }
}
```

所有节点 add / patch / delete 路径走 `applyDefinitionPatch`。

## 4. InputKey 重命名（inputKey → inputKey'）级联

NodeInspector input 抽屉的 inputKey TextInput `onChange` 路径：

```ts
function renameInputKey(prevDef: WorkflowDefinition, nodeId: string, nextKey: string): WorkflowDefinition {
  const node = prevDef.nodes.find((n) => n.id === nodeId)
  if (!node || node.kind !== 'input') return prevDef
  const prevKey = (node as { inputKey: string }).inputKey
  if (prevKey === nextKey) return prevDef
  const nodes = prevDef.nodes.map((n) =>
    n.id === nodeId ? ({ ...n, inputKey: nextKey } as typeof n) : n,
  )
  // Rename the inputs[] entry by key (preserves label/kind/required/description).
  const inputs = (prevDef.inputs ?? []).map((i) =>
    i.key === prevKey ? { ...i, key: nextKey } : i,
  )
  // Rename outbound edges' source.portName.
  const edges = prevDef.edges.map((e) =>
    e.source.nodeId === nodeId && e.source.portName === prevKey
      ? { ...e, source: { ...e.source, portName: nextKey } }
      : e,
  )
  return { ...prevDef, nodes, inputs, edges }
}
```

**为什么不重新跑 syncInputDefs**：syncInputDefs 不知道"老 key 哪条 entry 要保留 user-defined label"——它只会把那条 entry 丢掉再补一条 default。这里手工 by-key rewrite 才能保住 label。

**单测三条**：renameInputKey(prev, nodeId, sameKey) 是 no-op；rename 同时改节点 + entry + 出边三件套；rename 时 target.portName **不变**（agent 侧用户原本怎么 wiring 就保留）。

## 5. Validator 新规则

```ts
// 在 workflow.validator.ts 的 inputs-uniqueness 之后追加：

// 5a. input-key-not-declared --------------------------------------------------
const declaredKeys = new Set(inputs.map((i) => i.key))
for (const node of nodes) {
  if (node.kind !== 'input') continue
  const key = readString(node, 'inputKey')
  if (key === undefined) continue // 由 input-key-missing（既有）兜底
  if (!declaredKeys.has(key)) {
    issues.push({
      code: 'input-key-not-declared',
      message: `input node '${node.id}' inputKey '${key}' not declared in workflow.inputs[]`,
      pointer: node.id,
    })
  }
}

// 5b. input-orphan-declared --------------------------------------------------
const inputNodeKeys = new Set(
  nodes
    .filter((n) => n.kind === 'input')
    .map((n) => readString(n, 'inputKey'))
    .filter((k): k is string => typeof k === 'string'),
)
for (const inp of inputs) {
  if (!inputNodeKeys.has(inp.key)) {
    issues.push({
      code: 'input-orphan-declared',
      message: `workflow.inputs[] declares key '${inp.key}' but no input node references it`,
      pointer: inp.key,
      severity: 'warning', // 新字段，详见 §6
    })
  }
}
```

## 6. ValidationIssue 加 severity（最小化扩展）

当前 `WorkflowValidationIssue` 只有 `code / message / pointer`，task 启动只判 `result.ok`（`issues.length === 0`）。本 RFC 给 issue 加 `severity?: 'error' | 'warning'`（默认 `error`），并把 `result.ok` 改为"无 error 即 ok"：

```ts
export interface WorkflowValidationIssue {
  code: string
  message: string
  pointer?: string
  severity?: 'error' | 'warning' // new — default 'error'
}

export function validateWorkflow(...): WorkflowValidationResult {
  ...
  const hasError = issues.some((i) => (i.severity ?? 'error') === 'error')
  return { ok: !hasError, issues }
}
```

只有 `input-orphan-declared` 走 warning；其它既有 issue 全是 error（不指定 severity 字段，靠默认值），行为不变。前端 `ValidationPanel` 渲染分两块（已经分了 ok / not-ok 两态，本次扩展成 errors / warnings / ok 三态）。

## 7. 数据流（task launch happy path，对齐后）

```
[Editor] 用户拖 input 节点 (inputKey='requirement')
   ↓ syncInputDefs → definition.inputs = [{kind:'text', key:'requirement', label:'requirement', required:true}]
   ↓ auto-save (1s debounce, RFC-003 既有) → PUT /api/workflows/:id
[DB] workflows.definition.inputs[] 落盘
[Launcher] GET /api/workflows/:id → definition.inputs[] 非空 → 渲染 'requirement' 文本框
[User] 填值 "实现一个登录页" → POST /api/tasks { inputs: { requirement: '实现一个登录页' } }
[Scheduler] runOneNode(in_xx):
   inputKey = 'requirement'
   value = task.inputs['requirement'] = '实现一个登录页'
   INSERT nodeRunOutputs (portName='requirement', content=value)  ← 旧硬编码 'out' 改这里
[Scheduler] runOneNode(agent_xx):
   resolveUpstreamInputs() → 找 edge.source.portName='requirement' 的 outputs row → 命中
   → renderUserPrompt 把 'requirement' 章节填好
   → spawn opencode with rendered prompt
[Runner] agent 输出 envelope → status=done
```

## 8. 迁移路径（既有 DB workflows）

**核心策略**：编辑器一打开就修。具体路径：

1. 用户在 workflow 列表点击某个老 workflow → 进 `workflows.edit.tsx`。
2. 路由首屏从 `useQuery(['workflow', id])` 拿到 definition。
3. `useEffect` 在 query resolve 后跑一次 `syncInputDefs`：
   - 若 `nextInputs.length !== prevInputs.length` 或任一 entry shape 不等，触发一次显式 `setDefinition(applyDefinitionPatch(...))`。
4. 既有 1s 自动保存把修复结果写回 DB。

**不在 daemon startup / GET 路径上自动改 DB**：保持 GET 幂等、避免"读着读着 DB 被改"的副作用。

**用户的失败 task**：本 RFC 不能让 task `01KRNJXKNSXR8C1DHSCCCWHDD4` 起死回生（它已经 status=failed 终态、worktree 已存盘但数据已固化）。修完后用户在 launcher 重新起一个新 task 就行。

## 9. YAML 路径

`workflow.yaml.ts` 的 `previewWorkflowYaml` / `importWorkflowYaml` 走 `validateWorkflow`。新规则 `input-key-not-declared` 会让旧手写 YAML（"`inputs: []`"加 input 节点）的导入失败，错误信息直接含 nodeId + inputKey。导出路径不动（不需要"补齐"导出物，因为本 RFC 后编辑器保证导出物已经是对齐的）。

`design.md:510` 样例 YAML 同步改：

```diff
-  - { source: { nodeId: in_1, portName: out },          target: { nodeId: worker_1, portName: requirement } }
+  - { source: { nodeId: in_1, portName: requirement },  target: { nodeId: worker_1, portName: requirement } }
```

并在 §7.3 顶部加一段（约 5 行）：

> input 节点的输出端口名等于其 `inputKey`。launcher 表单字段也由 `definition.inputs[].key` 与 `inputKey` 一一对应。

## 10. 失败模式

| 触发 | 结果 |
| --- | --- |
| User 改 inputKey 时撞到另一个 input 节点的 inputKey | validator 既有 `input-key-duplicate` 触发；编辑器同步前段 NodeInspector 在 onBlur 时也加同名预检（红字提示，不写回 onChange） |
| User 删除 input 节点时它的出边 target 节点 prompt 模板还引用 `{{key}}` | validator 既有 `prompt-template-unresolved` 触发 |
| YAML 导入老仓样例（`portName: out`） | validator 新规则报 `edge-source-port-missing` |
| 编辑器 open 老 workflow 时 query 失败 | useEffect 不跑 syncInputDefs，definition 保持原状，无破坏 |
| User 在 NodeInspector 把 inputKey 改空字符串 | TextInput 验空 onBlur 拒绝写回，保留原值 |
| 一个老 workflow 有 input 节点但 inputKey 也是空字符串 | syncInputDefs 跳过该节点（`k.length > 0` 守卫）→ inputs 数组不变；validator 既有 `input-key-missing` 触发提示 |

## 11. 测试策略

按 CLAUDE.md "test-with-every-change"：

**Backend**

- `tests/input-port-contract.test.ts`（新文件）：1 case 锁线上复盘——seed agent `coder`（outputs `[answer]`）+ workflow input(requirement) → agent，task launch inputs={requirement:'X'}，跑完后 agent 的 promptText 包含 "X"；nodeRunOutputs 表里 input 节点产出 row 的 portName === 'requirement'。**顶部注释**：`Locks in port-name = inputKey contract. If this goes red, check scheduler.ts:319 and workflow.validator.ts:134 in lock-step. Originated RFC-004 / failed task 01KRNJXKNSXR8C1DHSCCCWHDD4 on 2026-05-15.`
- `tests/scheduler.test.ts`：3 处 `portName: 'out'` → `portName: <inputKey>`；其它断言不变。
- `tests/workflow-validator.test.ts`：+3 case
  1. input 节点 inputKey 'foo'，definition.inputs[] 空 → 触发 `input-key-not-declared`，result.ok === false
  2. input 节点 inputKey 'foo'，definition.inputs[{key:'foo',...}] → 不触发，result.ok === true
  3. definition.inputs[{key:'foo',...}] 但无 input 节点 → 触发 `input-orphan-declared` severity=warning，result.ok === true（warning 不阻塞）

**Frontend**

- `tests/sync-input-defs.test.ts`（新文件）：5 case
  1. 空 prev + 1 input 节点 → 追加默认 entry
  2. prev=[{key:foo,label:'Custom'}] + 1 input 节点(inputKey=foo) → 保留 label
  3. prev=[{key:foo,...}] + 0 input 节点 → 移除 entry
  4. prev=[{key:foo,...}] + 1 input 节点(inputKey=bar) → 移除 foo + 追加 bar
  5. prev=[{key:foo,...}] + 2 input 节点(inputKey=foo,foo) → 不创建重复（保留单条；duplicate 由 validator 报）
- `tests/input-inspector.test.tsx`（新文件）：4 case
  1. 渲染 5 字段（inputKey / kind / label / required / description）
  2. 改 inputKey → 触发 onPatch；onPatch 落点后 definition.inputs[].key 同步、出边 source.portName 同步
  3. 改 label → 仅 definition.inputs[that entry].label 变化，节点不变、边不变
  4. 改 kind=files → definition.inputs[that entry].kind === 'files'
- `tests/launcher-renders-from-input-node.test.tsx`（新文件）：1 case，用 `setQueryData` 注入一个 workflow（input 节点 + 对齐 inputs entry），断言 launcher 渲染 text input field（label 显示 entry.label）。
- `tests/canvas-edit-old-workflow.test.tsx`（新文件）：1 case 锁迁移路径——`useQuery` 喂一个老 shape（inputs:[] + 一个 input 节点），断言 useEffect 后 setDefinition 被调一次且 next.definition.inputs 长度 === 1。

**典型 e2e（不在本 RFC 强制范围；Playwright harness 已有）**

- 留个 TODO：把 `e2e/main.spec.ts` 的 fixture 工作流从"input → agent → output"扩展成"input(requirement) → agent + 必填 launcher field"，保护 S1 用户故事免再次回归。这条**不**作为 RFC-004 验收必做项（避免和 P-5-07 e2e 范围耦合），但 plan.md 里列为 follow-up。

## 12. 与既有 RFC 的关系

- **RFC-003**：本 RFC 把 RFC-003 提供的 catch-all + 默认 `target.portName = source.portName` **真正激活** —— 在 RFC-003 之前用户根本拉不出第一条边，所以"input 节点出端口名 = inputKey"的契约对外不可见；RFC-003 打通连边后立刻暴露契约不一致。本 RFC 不动 RFC-003 任何代码。
- **RFC-002**：input 节点抽屉的 `kind/label/required/description` 字段编辑沿用 RFC-002 的 `Field + TextInput / Switch / Select` 一组组件（包括字段 label 走 i18n），没有新组件。

## 13. 一句话契约

> **`input` 节点的 `inputKey` 同时是它的输出端口名、它对应 launcher 字段的 key、它在 `definition.inputs[]` 里 entry 的 key。三处任一处不一致都是 bug。**
