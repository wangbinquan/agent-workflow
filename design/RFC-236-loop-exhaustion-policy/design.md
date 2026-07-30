# RFC-236 · 技术设计

## 1. 当前事实与影响链

### 1.1 配置与编辑器

- `WorkflowNodeSchema` 是最小公共字段加 `.passthrough()`；`maxIterations`、
  `exitCondition`、`outputBindings` 均由 kind-specific validator/runtime 读取。
- `WrapperGitLoopEdit.tsx` 在 Basics 区先渲染 `maxIterations`，Flow 区再渲染退出条件与
  outputs；公共 `<Switch>` 已提供一致的键盘、a11y 和视觉行为。
- `WorkflowCanvas`/palette 新建 loop 时只写当前默认字段。新策略为 opt-in，因此不需要给旧
  节点或新节点强制回填 `false`。

### 1.2 Validator

`workflow.validator.ts` 已对 loop 的 inner、`maxIterations` 与 `exitCondition` 做静态检查，
并用 `WorkflowValidationTarget` 把错误定位回 Inspector。runtime 在任何 wrapper row/iso
副作用前再次检查必填字段，保护损坏的 task snapshot 和绕过 validate 的调用方。

### 1.3 Scheduler

当前链路是：

```text
runTaskInner
  → runScope
    → deriveFrontier
      → runOneNode
        → runLoopWrapperNode
```

`runLoopWrapperNode` 每轮：

1. 在 loop-private canonical 中执行 `runScope(inner, iteration=i)`；
2. 处理 canceled / failed / awaiting；
3. 持久化 `phase='iter-done'`；
4. 读取退出端口并求值；
5. 条件为 true 时提升本轮 outputs、merge-back、wrapper=`done`；
6. 所有 N 轮条件都为 false 时 wrapper=`exhausted` 并返回 failed。

`deriveFrontier` 明确把 `exhausted` 放入 terminal-failure bucket。该全局语义不变。

## 2. 配置契约

### 2.1 字段

```ts
interface WrapperLoopPolicyFields {
  continueOnMaxIterations?: boolean
}
```

wire/persistence 规则：

| 原始值 | 解释 |
| --- | --- |
| 缺失 | `false`，兼容旧定义 |
| `false` | 达到上限后失败 |
| `true` | 达到上限后采用最后一轮并继续 |
| 其它任意值 | 非法配置，validator/runtime fail closed |

字段只对 `kind='wrapper-loop'` 有意义。其它 node 即使由旧/外部 producer 夹带该字段，也不改变
运行行为；现有 unknown-field round-trip 规则保持。

### 2.2 Shared 单一解析函数

新增 shared 纯函数，validator 与 scheduler 必须共用，避免“静态检查接受、运行时却按另一套
truthiness 执行”：

```ts
export function readContinueOnMaxIterations(
  node: WorkflowNode | Record<string, unknown>,
): boolean | null {
  const raw = (node as Record<string, unknown>).continueOnMaxIterations
  if (raw === undefined) return false
  return typeof raw === 'boolean' ? raw : null
}
```

`null` 只表示畸形。不得使用 `Boolean(raw)`、`raw === 'true'` 或 `?? false` 后跳过类型验证。

### 2.3 兼容性

- 不 bump `$schema_version`：字段可选，旧 reader 已 passthrough，旧 definition 不需重写。
- 不做 DB migration：workflow definition 与 task snapshot 都是 JSON。
- 任务启动后继续使用冻结 snapshot；编辑 canonical workflow 不改变正在运行或恢复中的任务。
- YAML import/export、resource copy、clipboard、intent changeset 均已对 node unknown fields
  passthrough；增加 round-trip/保留回归，防未来收窄 producer 时丢字段。

## 3. Validator 与定位

在 loop required-fields 规则中读取 shared helper：

```ts
const continueOnMax = readContinueOnMaxIterations(node)
if (continueOnMax === null) {
  issues.push({
    code: 'wrapper-loop-continue-on-max-iterations',
    message:
      `wrapper-loop '${node.id}' continueOnMaxIterations must be a boolean when present`,
    pointer: node.id,
    target: target.nodeField(node.id, 'loop-continue-on-max-iterations'),
  })
}
```

同时：

- `WORKFLOW_NODE_FIELD_KEYS` 新增 `loop-continue-on-max-iterations`；
- frontend target resolver 将该错误码映射到同一字段；
- RFC-203 validation exact copy 增加中英文文案；
- completeness/source-lock 测试继续保证 validator 新码不以 raw 英文漏到用户界面。

runtime 在校验 `maxIterations`、`exitCondition` 后、查找/铸造 wrapper row前调用同一 helper。
若返回 `null`，返回 `kind='failed'` +
`message='wrapper-loop-continue-on-max-iterations'`，不创建 wrapper iso 或执行 inner scope。

## 4. Scheduler 设计

### 4.1 单一成功收尾 helper

把当前 exit=true 分支的收尾抽为 loop 专用 helper（签名可按实现调整）：

```ts
type LoopCompletionReason = 'exit-condition' | 'max-iterations-continued'

async function completeLoopIteration(args: {
  state: SchedulerState
  node: WorkflowNode
  wrapperRunId: string
  wrapperIso: IsoHandle
  bindings: OutputBinding[]
  iteration: number
  reason: LoopCompletionReason
  log: Logger
}): Promise<OneNodeResult>
```

唯一顺序：

1. 对每个 `outputBinding` 调 `readPortRowAtIteration(..., iteration)`；
2. `upsertWrapperOutput` 同时复制 `content / kind / archiveJson`；
3. 非 passthrough 时调用现有 `mergeBackWrapperIso`；
4. `conflict-human` 返回 `awaiting_human`，不得写 `done`；
5. `merge-failed` 写 wrapper=`failed` 并返回 failed；
6. `markWrapperTerminal(..., 'done')`，DB-first 后广播 `done`；
7. 只有第 6 步成功且 `reason='max-iterations-continued'` 时才写结构化 warning log；
8. 返回 `kind='ok'`。

输出提升仍先于 merge，保持现有 crash/resume/upsert 行为；wrapper 非 `done` 时下游不会消费这些
预写 outputs。不得在新分支另写一套简化 merge 或只把状态翻成 done。

### 4.2 主循环

伪代码：

```ts
const continueOnMax = readContinueOnMaxIterations(node)
if (continueOnMax === null) return invalidPolicy()

for (let i = startIter; i < maxIter; i++) {
  const subRes = await runScope(...)
  // canceled / failed / awaiting_* 原样返回

  persist({ kind: 'loop', iteration: i, phase: 'iter-done' })
  const matched = evaluateExitCondition(...)
  if (matched) {
    return completeLoopIteration({ iteration: i, reason: 'exit-condition', ... })
  }
}

if (!continueOnMax) {
  mark exhausted
  return wrapper-loop-exhausted
}

return completeLoopIteration({
  iteration: maxIter - 1,
  reason: 'max-iterations-continued',
  ...,
})
```

`maxIter` 已保证 integer ≥1，因此 `maxIter - 1` 有效。resume 从 `startIter` 继续，只有真正完成
最后一轮且退出条件仍为 false 才进入 continue 分支；停泊/取消不会绕过去。

### 4.3 结构化日志

只有 `markWrapperTerminal(..., 'done')` 和 DB-first `done` 广播都完成后，continue 分支才通过
当前 loop logger 写 warning，字段至少含：

```text
code=wrapper-loop-max-iterations-continued
taskId
nodeId
wrapperRunId
maxIterations
iteration
```

不写 `errorMessage`、`wrapper_progress_json` 完成标记或 `node_run_events` 模型文本，不新增
`NodeRunStatus`。状态/输出仍是业务事实，warning 只是运维诊断；普通提前退出不写该 code。
若外部 cancel/interrupted 抢先使 `markWrapperTerminal` 收敛到其它结果，helper 在日志前退出，
不会留下“已继续”的误导记录。

### 4.4 Scope 与恢复不变量

- continue 分支最终写 `done`，因此 generic `deriveFrontier`、`decideScopeOutcome` 和 downstream
  projection 无需策略感知。
- `exhausted` 仍永远代表 loop 上限导致的失败；已有 exhausted resume 防线不改。
- wrapper output 仍由 wrapper 自身 done row暴露；下游不直接读取 inner row。
- loop-private canonical 仍只在成功收尾 helper 中 merge 回 parent；开启策略不绕过
  `workflowScope.ts` 的 dependency projection。
- 下游后来失败并 resume 时，已 done/fresh 的 loop 不重跑。

## 5. 前端

在 `WrapperGitLoopEdit` Basics 区：

```tsx
<InspectorFieldAnchor
  nodeId={node.id}
  field="loop-continue-on-max-iterations"
>
  <Switch
    checked={readContinueOnMaxIterations(node) === true}
    onChange={(checked) =>
      update(
        { continueOnMaxIterations: checked },
        atomicNodeInspectorChange(
          node.id,
          'continueOnMaxIterations',
          t('inspector.fieldContinueOnMaxIterations'),
        ),
      )
    }
    label={t('inspector.fieldContinueOnMaxIterations')}
    hint={t('inspector.fieldContinueOnMaxIterationsHint')}
  />
</InspectorFieldAnchor>
```

约束：

- DOM 顺序必须是 maxIterations input → switch → Flow/exit condition。
- 复用公共 `Switch`，不新增 CSS 或自写 checkbox。
- 缺字段显示 unchecked；用户切换后显式写 boolean。
- `onChange` 是一次 atomic history step，undo/redo 恢复整节点字段。
- 新增中英文 label/hint；hint 明确“只有退出条件未满足时采用最后一轮输出，内部错误仍失败”。
- 畸形字段由 ValidationPanel 定位到开关；UI 不把畸形值猜成 true。

## 6. 失败模式矩阵

| 场景 | 开关关闭/缺失 | 开关开启 |
| --- | --- | --- |
| 第 k≤N 轮退出条件满足 | done，输出第 k 轮 | 完全相同 |
| N 轮成功但条件仍 false | exhausted，task failed | 输出第 N 轮、merge、done、下游继续 |
| inner failed | failed | failed |
| inner canceled | canceled | canceled |
| inner awaiting human/review | park | park |
| 最终 merge conflict | awaiting_human | awaiting_human |
| 最终 merge failure | failed | failed |
| 字段为 `"true"` / `1` / object | validation/runtime failed | 不适用 |
| 字段缺失 | exhausted 默认 | 不会隐式开启 |

## 7. 测试策略

### Shared / validator

- shared helper：missing/false/true/invalid 全矩阵。
- validator：missing、false、true 均合法；string/number/null/object 均发独立 code 和严格 target。
- WorkflowValidationTarget schema 与 frontend resolver 覆盖新 field key。
- YAML export/import 与 node reference/copy round-trip 保留 `true`；sync diff 能识别策略变化。
- RFC-203 exact validation copy/completeness 增加新码。

### Scheduler

- 保留现有 “field missing → exhausted” 测试，证明默认行为未漂移。
- `true` + 条件永远 false：精确执行 N 轮，wrapper done、task done/下游执行、无 exhausted。
- 输出 binding 使用最后一轮值；kind/archiveJson 同步投影。
- 条件在第 k<N 轮满足：提前退出，不写 continued warning。
- `true` + inner failure/cancel/awaiting：原语义不变。
- passthrough 与真实 git loop-private canonical 各一例；真实 git 断言所有轮次改动 merge 回 task
  canonical。
- merge conflict 与 merge failure 走共享 helper 的既有失败出口；至少一条定向回归证明开关不把
  merge failure 变 done。
- resume/下游重试：完成后的 loop 不重跑。
- 损坏 snapshot 的非 boolean 字段在 inner dispatch/iso 副作用前 fail closed。

### Frontend / browser

- 旧节点开关未选中；DOM 顺序紧跟 maxIterations。
- 点击 on/off 更新精确 boolean；一次 undo/redo 恢复。
- 中英文 label/hint；role=checkbox/accessible name 锁公共 Switch 契约。
- validator issue 可聚焦到该开关。
- desktop light/dark 与 390px：不溢出、不挤压 exit condition；点击、reload 持久化和
  undo/redo 实跑。检查公共 Switch 仍渲染 enabled、可聚焦的原生 checkbox 与完整 label/hint。
- 本轮应用内浏览器的 Space 注入未作为原生键盘行为证据，且未运行 axe；实现不新增自定义
  键盘处理或控件语义，继续复用公共 Switch。

### 门禁

- 定向 shared/backend/frontend tests。
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run format:check`
- `bun run depcheck`
- 相关 scheduler regression、frontend Vitest、真实浏览器验证与实现门。

## 8. 预计改动面

- `packages/shared/src/`：loop policy helper、export、validation field key 与测试。
- `packages/backend/src/services/workflow.validator.ts`
- `packages/backend/src/services/scheduler.ts`
- backend validator/scheduler/YAML 回归。
- `packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx`
- `packages/frontend/src/lib/workflow-validation-target.ts`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts`
- frontend inspector/validation/i18n 测试。
- 完工时同步 `design/{proposal,design,plan}.md`、本 RFC、RFC 索引与 `STATE.md`。

## 9. 不变量

- `exhausted` 的全局含义不变，仍是 terminal failure。
- generic scope scheduler 不读取 `continueOnMaxIterations`；只有 loop runner 在成功完成最后一轮
  后消费。
- old/missing 永远 false。
- 最多只执行 `maxIterations` 轮。
- 继续模式只改变“退出条件 false”的收尾，不改变任何真实错误出口。
- 最后一轮 outputs 与 loop-private canonical 必须一起走正常成功收尾，不允许只放行控制流而
  丢数据/文件。

## 10. 实现终态

实现与设计一致，未新增 migration、schema version 或状态：

- shared `readContinueOnMaxIterations` 是 validator、runtime 与 Inspector 的共同解释源；
- `completeLoopWrapperIteration` 统一提前退出与达到上限继续的 output/merge/done 收尾；
- 默认 exhausted、畸形 snapshot pre-side-effect failure、末轮 N 次边界、inner failure /
  awaiting、真实 Git canonical 与 artifact 投影均有回归；
- Inspector Switch 位于 maxIterations 后，并接入 atomic history 与 semantic field target。

实现门与完整验证明细见
[`implementation-gate-2026-07-30.md`](./implementation-gate-2026-07-30.md)。
