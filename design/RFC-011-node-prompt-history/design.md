# RFC-011 — 节点 Prompt 历史可见性 · 技术设计

---

## 1. 概览

两端协同：

- **Backend**：去掉 `review.ts:1064` 的"就地 reset 上游 row"，改成 mint
  一条新的 `node_run` 行（`retry_index = prev.retry_index + 1`，状态 pending，
  继承 `preSnapshot`）。旧行落到一个明确的「被新版本替代」终态。
  scheduler / runner 不动 —— 它们本就支持多条同 nodeId 行的存在
  （retry 路径就是这么走的）。
- **Frontend**：`NodeDetailDrawer` 接收已有的 `runs[]` 之外再多接收一个
  `nodeId` 上下文，Prompt tab 在内部按 `nodeId` 过滤所有 attempts，
  渲染切换器（`<select>`）+ 选中项的 promptText。non-agent 节点 NULL 全
  attempt 显示 N/A 文案。canvas 选中 / Stats / Events / Output tab 行为不变。

不引入新表、不引入新 REST endpoint —— 复用 `/api/tasks/:id/node-runs`
已经返回的全量 `runs[]`（Task 详情页已经在轮询）。

---

## 2. 数据模型 / DB

### 2.1 不需 migration

`node_runs` 现有列已经够用：

- `id` / `nodeId` / `taskId` / `iteration` / `retryIndex` / `parentNodeRunId`
  / `shardKey` —— 用于 attempts 切换器排序、分组、标签。
- `promptText` —— 单次 attempt 真实发给 opencode 的 prompt（runner 写入）。
- `status` / `startedAt` / `finishedAt` / `reviewIteration` —— 切换器条目
  显示用。

历史行不删 / 不改语义 —— 唯一变化在 §3.1 review 重跑路径的"是否新插行"上。

### 2.2 旧行的终态

review iterate / reject 触发上游重跑时，旧 `node_run` 行不再"复活到 pending"，
而是被显式标记为已被新行取代。复用已有的终态枚举不引入新值：

- `status: 'canceled'`
- `errorMessage: 'superseded-by-review-{decision}: Replaced by retry_index N due to review {decision} of <reviewNodeId>'`

（node_runs schema 没有 `error_summary` 列；机器可读的标识用 errorMessage
的稳定前缀 `superseded-by-review-{decision}:` 表达，便于 test / 未来 GC 用
正则匹配。）

这样：

- 既有 `noderunTone(s)` 函数对 canceled 已映射为 gray，不需要新增 CSS。
- 既有"是否可 retry"判定 `canRetryNodeRun`（NodeDetailDrawer.tsx:414）：
  canceled + 非 running task → 返回 true。但我们 mint 的新 pending 行
  会让用户看到的"最新一次"指向新行，所以再点 retry 按钮的语义是
  "在已有重跑基础上再叠加一次"——这与现有 retry 行为一致，零冲突。

### 2.3 排序契约

attempts 切换器按 **以下排序键**（升序，先=旧）：

1. `iteration`
2. `retryIndex`
3. `parentNodeRunId` NULL 优先（父行先于其 shard 子行）
4. `shardKey` 字典序
5. `startedAt` 升序（兜底）

排序在前端 pure helper `sortNodeRunsForPromptHistory(runs)` 中实现，
便于单测。

---

## 3. Backend 改动

### 3.1 `services/review.ts` — submitReviewDecision iterate / reject 重跑路径

#### 改动前（review.ts:1038-1065）

```ts
for (const nodeId of rerunSet) {
  const upRuns = await args.db
    .select()
    .from(nodeRuns)
    .where(/* taskId & nodeId & iteration */)
    .orderBy(desc(nodeRuns.retryIndex))
  const latest = upRuns.find((r) => r.parentNodeRunId === null) ?? upRuns[0]
  if (latest === undefined) continue
  if (rollbackFlag && latest.preSnapshot !== null /* … */) {
    await rollbackToSnapshot(taskRow.worktreePath, latest.preSnapshot)
  }
  await args.db.update(nodeRuns).set({ status: 'pending' }).where(eq(nodeRuns.id, latest.id))
}
```

#### 改动后

```ts
for (const nodeId of rerunSet) {
  const upRuns = await args.db
    .select()
    .from(nodeRuns)
    .where(/* taskId & nodeId & iteration */)
    .orderBy(desc(nodeRuns.retryIndex))
  const latest = upRuns.find((r) => r.parentNodeRunId === null) ?? upRuns[0]
  if (latest === undefined) continue

  if (rollbackFlag && latest.preSnapshot !== null && latest.preSnapshot !== '') {
    try {
      await rollbackToSnapshot(taskRow.worktreePath, latest.preSnapshot)
    } catch (err) {
      log.warn('review rollback failed', { nodeRunId: latest.id, error: msg(err) })
    }
  }

  // Mark the old run as superseded — preserves its promptText/outputs.
  await args.db
    .update(nodeRuns)
    .set({
      status: 'canceled',
      finishedAt: latest.finishedAt ?? Date.now(),
      errorSummary: `superseded-by-review-${args.decision}`,
      errorMessage: `Replaced by retry_index ${latest.retryIndex + 1} due to review ${args.decision} of ${dv.reviewNodeId}`,
    })
    .where(eq(nodeRuns.id, latest.id))

  // Mint a fresh pending node_run at retry_index + 1, inheriting preSnapshot.
  await args.db.insert(nodeRuns).values({
    id: ulid(),
    taskId: dv.taskId,
    nodeId,
    status: 'pending',
    retryIndex: latest.retryIndex + 1,
    iteration: latest.iteration,
    parentNodeRunId: null,
    preSnapshot: latest.preSnapshot,
    // startedAt left null — scheduler will set it when the run actually starts.
  })
}
```

接触面 / 不变式：

- scheduler 的 `pickPending` 谓词 `status === 'pending' && parentNodeRunId === null`
  （`scheduler.ts:416`）正常拾起新行。
- `resolveUpstreamInputs` 等"取该 nodeId 最新一次成功 run"的 helper
  按 `retryIndex DESC` 排序后取 done 行，与之前等价。
- 没有 multi-process review iterate 场景 —— RFC-005 留作后续 issue
  (B-T14)，本 RFC 不触碰；如未来支持，本路径需对 children 行做同样
  "mark superseded + 新插 parent"处理。

### 3.2 broadcast & resume

iterate / reject 末尾仍调用 `broadcastReviewDecision` + 返回
`resumeRequired: true`，REST 层 `resumeTask` 接 awaiting_review 不变 ——
被 mint 的新 pending 行自然被 scheduler 接走。

### 3.3 接口 / schema

`/api/tasks/:id/node-runs` 已经返回全表行（`task.ts:560-595`）。无需新接口。
shared types 不变 —— `NodeRun` 已有所有需要字段。

---

## 4. Frontend 改动

### 4.1 `routes/tasks.detail.tsx`

`onSelect` 回调维持 `setSelectedNodeRunId(latestRunByNode.get(sel.id))`
不变。**但**给 `NodeDetailDrawer` 多传一个 `nodeId` prop：

```tsx
<NodeDetailDrawer
  taskId={id}
  taskStatus={tk.status}
  nodeRunId={selectedNodeRunId}
  nodeId={runs.find((r) => r.id === selectedNodeRunId)?.nodeId ?? null}
  runs={nodeRuns.data.runs}
  outputs={nodeRuns.data.outputs}
  onClose={closeNodeDrawer}
  onSelectRun={setSelectedNodeRunId}
/>
```

—— 为什么传 `nodeId`：drawer 内 Prompt tab 需要按 nodeId 过滤所有
attempts；从单条 `runs.find(r.id === nodeRunId).nodeId` 派生也行，但
显式传更便于单测。

### 4.2 `components/NodeDetailDrawer.tsx`

```ts
interface Props {
  taskId: string
  taskStatus?: Task['status']
  nodeRunId: string | null
  nodeId: string | null // NEW
  runs: NodeRun[]
  outputs: NodeRunOutput[]
  onClose: () => void
  onSelectRun?: (id: string) => void
}
```

PromptTab 重写：

```tsx
function PromptTab({
  runs,
  nodeId,
  selectedRunId,
  workflowNodeKind, // from definition.nodes[nodeId].kind — see §4.3
}: {
  runs: NodeRun[]
  nodeId: string | null
  selectedRunId: string
  workflowNodeKind: string | null
}) {
  const { t } = useTranslation()
  const attempts = useMemo(
    () =>
      nodeId === null ? [] : sortNodeRunsForPromptHistory(runs.filter((r) => r.nodeId === nodeId)),
    [runs, nodeId],
  )
  const [pickedId, setPickedId] = useState<string>(selectedRunId)

  useEffect(() => {
    // when canvas selection changes, re-anchor to the new latest attempt
    setPickedId(selectedRunId)
  }, [selectedRunId])

  if (!isPromptCapableKind(workflowNodeKind)) {
    return <div className="muted">{t('nodeDrawer.promptNotApplicable')}</div>
  }
  if (attempts.length === 0) {
    return <div className="muted">{t('nodeDrawer.promptPending')}</div>
  }

  const picked = attempts.find((a) => a.id === pickedId) ?? attempts[attempts.length - 1]
  const isFanoutParent =
    picked.parentNodeRunId === null && attempts.some((a) => a.parentNodeRunId === picked.id)

  return (
    <div className="prompt-history">
      <label className="prompt-history__picker">
        <span className="muted">{t('nodeDrawer.promptAttemptLabel')}</span>
        <select
          value={picked.id}
          onChange={(e) => setPickedId(e.target.value)}
          className="prompt-history__select"
        >
          {attempts.map((a) => (
            <option key={a.id} value={a.id}>
              {formatAttemptLabel(a, t)}
            </option>
          ))}
        </select>
      </label>
      {isFanoutParent ? (
        <div className="muted">{t('nodeDrawer.promptFanoutParent')}</div>
      ) : picked.promptText === null || picked.promptText === '' ? (
        <div className="muted">{t('nodeDrawer.promptEmpty')}</div>
      ) : (
        <pre className="readonly-pre">{picked.promptText}</pre>
      )}
    </div>
  )
}
```

#### 4.2.1 attempt label 格式

`formatAttemptLabel(run, t)` 返回形如：

- single agent / retry：`iter=0 retry=2 · done · 14:08:30`
- multi-process 父行：`iter=0 retry=0 · fan-out parent · done · 14:00:01`
- multi-process shard：`iter=0 retry=0 · shard=src/foo.ts · done · 14:00:31`
- review 触发的新 attempt：和普通 retry 一样按 retry_index 区分；
  额外在 startedAt === null 时把时间替换为 `pending`。

i18n keys：

- `nodeDrawer.promptAttemptLabel` —— picker 前缀
- `nodeDrawer.promptAttemptEntry` —— 用 interpolation 拼 4-5 段
- `nodeDrawer.promptFanoutParent` —— "fan-out parent (no prompt — pick a shard)"
- `nodeDrawer.promptNotApplicable` —— "this node kind has no prompt"
- `nodeDrawer.promptEmpty` —— "no prompt recorded for this attempt"
- `nodeDrawer.promptPending` —— 既有 key，复用

### 4.3 `isPromptCapableKind` & workflow definition

drawer 怎么知道节点种类？两个来源：

- 直接看 `runs` 里这个 nodeId 是否有过 `promptText !== null` 的 attempt
  —— 若有则 capable。问题：第一次跑的 agent 节点在还没启动时也是 NULL，
  会误判为 N/A。
- 从 `task.workflowSnapshot` 里查 nodeId.kind —— 权威，但需要 drawer
  访问 workflow definition。

**选第二个**：tasks.detail.tsx 在调用 drawer 时，从 `definition.nodes`
找出当前 nodeId 的 kind 一并传入：

```tsx
const definition = useMemo<WorkflowDefinition | null>(/* … existing in TaskStatusCanvas */, [task.workflowSnapshot])
// hoist to TaskDetailPage level so drawer can read it too
```

`isPromptCapableKind(kind: string | null): boolean` 在
`lib/node-prompt.ts` 内：返回 true 当 `kind === 'agent-single' || kind === 'agent-multi'`。
其它 input / output / wrapper-git / wrapper-loop / review / null → false。

### 4.4 样式

新 `.prompt-history` / `.prompt-history__picker` / `.prompt-history__select`
三 class 加到 `styles.css`：

```css
.prompt-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prompt-history__picker {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prompt-history__select {
  flex: 1;
  min-width: 0;
}
```

`.readonly-pre` 沿用现有规则不动。

---

## 5. 失败模式

| 场景                                                               | 处理                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| review iterate 时 mint 新行后 daemon 崩溃                          | 老行已经标 canceled，新行 pending 仍然存在；下次 daemon 启动走 `resume`，pending 新行被 scheduler 接走。`resumeTask` 不改。 |
| review iterate 时 rollback 成功但 mint 新行写库失败                | 老行还在 awaiting_review 上游状态（review 行未改）；REST 抛 500；用户重试即可。                                             |
| Prompt tab attempts 列表很长（>50）                                | `<select>` 原生滚动；不分页。如果 task 经历过 >50 attempts 已经是病态情况，UI 不优化。                                      |
| 用户在 picker 切到旧 attempt 后 retry 按钮的语义                   | retry 按钮独立挂在 drawer 顶部，依据 selectedRunId 不动 —— 切 picker 只换 prompt 显示不换 selectedRunId，避免误操作。       |
| Workflow snapshot 中找不到当前 nodeId（极罕见，snapshot 解析失败） | `definition === null` → drawer 退化为既有行为（show promptText if any 否则 muted）。不抛错。                                |

---

## 6. 测试策略

### 6.1 Backend（`packages/backend/tests/`）

- **`reviews-iterate-mints-new-run.test.ts`** （+3 case）
  - case "iterate 后老行变 canceled + errorSummary='superseded-by-review-iterated' + promptText 保留"
  - case "iterate 后新行 retryIndex = old+1, status='pending', preSnapshot 继承"
  - case "reject 同上 + sibling cascade 不被新行影响（其它 review 节点照常回到 awaiting_review）"
- 既有 `e2e/review.spec.ts` 的 reject → iterate → approve 状态机循环
  锁仍需通过 —— 调整 fixture 期望（rejectedThenIterated case 现在有
  2 条 retry_index=0 canceled 行 + 1 条 retry_index=1 行 + 最终 done）。

### 6.2 Frontend（`packages/frontend/tests/`）

- **`prompt-history-sort.test.ts`** （+5 case，pure helper）
  - sortNodeRunsForPromptHistory：单条 / 多 retry / 父-子 shards / iteration
    跨层 / startedAt 缺失
- **`node-drawer-prompt-history.test.tsx`** （+6 case）
  - 单 attempt：select 仅 1 项 + 显示 promptText
  - 多 attempts：select 出现，切换更新 `<pre>` 内容
  - multi-process 父行：父项标 fan-out parent + 切到 shard 看见 prompt
  - input node kind：显示 promptNotApplicable，不渲染 select / pre
  - canvas 切节点：useEffect 重锚 selectedRunId 到新 attempts.last
  - retry 按钮不被 picker 切换影响（selectedRunId 不动）
- 源代码层兜底（按 [feedback_post_commit_ci_check]）：
  **`node-drawer-prompt-source.test.ts`** （+3 case）正则锁
  - `NodeDetailDrawer.tsx` 不再含 `run.promptText === null`（被新分支取代）
  - 含 `prompt-history__select`
  - 含 `isPromptCapableKind(`

### 6.3 集成

- 既有 `e2e/main.spec.ts` 跑一遍确保 happy path 单 attempt 不回归。

---

## 7. 性能 / 影响

- Prompt 渲染：仅过滤 `runs[]`（task 详情页已经 hold 全量），无新网络
  请求。`<select>` 数量 = 该节点 attempts 数（≤ retry_index 上限，典型 1-5）。
- DB 写：iterate / reject 每个 rerunSet 节点一行 UPDATE + 一行 INSERT
  （此前是一行 UPDATE）。绝对量低（典型 1-3 节点 × 1-3 次 iterate），无关。
- Storage：每次 review iterate 多一行 `node_runs` —— 长期看在 P-4-08
  events 归档 GC 窗口内累积可接受；不引入新 GC 策略。

---

## 8. 兼容性

- Old tasks（pre-deploy）：之前被 in-place reset 过的上游行已经丢了原
  prompt 文本，无法回填。drawer 上这些节点只能看到当下的 promptText —— 与
  既有行为一致。
- Workflow YAML / DB schema / shared types：零改动。
- `/api/tasks/:id/node-runs` 响应字段：零改动。前端老版本如果连接新后端，
  最多看到 canceled 状态的"superseded"行 —— 不会崩。

---

## 9. 实现顺序与回滚

按 plan.md T1 → T2 → T3 串行，单 PR：

1. backend 改 review.ts + 测试加锁 —— 局部可单独 typecheck/test 通过。
2. frontend drawer + helper + 测试。
3. i18n + design.md §7 callout + STATE.md。

回滚：单 commit revert 即可。DB schema 无 migration 需要逆向。

---

## 10. 未来扩展（不在本 RFC 内）

- attempt 对比视图：两 attempts side-by-side diff 或 word-level diff
  （可以复用 RFC-005 DiffView 已有的能力）。
- attempts 切换器可滚动 + 检索（如果用户日常 attempts > 20）。
- multi-process review iterate（B-T14）：父行 + children 行的"superseded"处理。
- Events / Output tab 也加 attempts 切换器 —— 本 RFC 只动 Prompt tab。
