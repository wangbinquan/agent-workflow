# RFC-199 — 工作流编排器零指导 UX 与可靠草稿：技术设计

## 1. 设计边界与不变量

### 1.1 当前接缝

| 层              | 当前实现                                                                    | RFC-199 处理                                                          |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| route draft     | `routes/workflows.edit.tsx` 分散管理 draft/name/description/dirty/mutations | 收敛到 composite draft state machine、单写队列和精确保存回执          |
| workflow sync   | `useWorkflowSync` invalidates query，route refetch 无 dirty guard           | own echo / clean follow / dirty conflict 三分支                       |
| workflow PUT    | `UpdateWorkflowSchema` + `updateWorkflow` 先读后按 id 更新                  | 必填 `expectedVersion`，数据库原子 compare-and-swap                   |
| validation      | `POST /validate` 校验当前服务端行，结果无版本                               | 请求指定 version/hash，响应携带 `WorkflowRevision`                    |
| launch          | `/workflows/:id/launch` 重定向 `/tasks/new`                                 | 传递精确 workflow version，并复用 `StartTask.expectedWorkflowVersion` |
| canvas mutation | `WorkflowCanvas.commitChange` 收敛结构一致性                                | 演进为单一 pure transition reconciler；route history 统一编排         |
| add             | palette drag + RFC-198 click/keyboard centered insert                       | 不重复；新增空白态、toolbar、contextual `+` 共用 NodePicker           |
| connect         | port drag + `NEW / REUSE` drop preview                                      | 保留；抽纯 connection plan，新增非拖拽 Dialog                         |
| layout          | 已安装 dagre；`structureGraph` 有现成用法                                   | 新建 workflow-specific 纯布局 planner，尊重坐标空间与 wrapper         |
| responsive      | desktop 三栏，`<=720px` editor 纵向堆叠                                     | editor-scoped canvas-first rail/sheet，不改 RFC-198 全局 shell        |

### 1.2 必须保持的不变量

- 所有 definition 写入继续通过 shared schema、backend write validation 与既有 ACL/builtin guard。
- 当前 `WorkflowCanvas.commitChange` 演进为纯 `applyWorkflowTransition` + 单一 publish chokepoint；edge disconnect、review/output bind、clarify pair、fan-out input 与 workflow input 同步只在该 reconciler 按确定顺序执行一次，新增入口不得直接拼 definition 或预先同步后再过一遍。
- 现有拖拽连接的 missing/self/exact-duplicate 判定与 `NEW / REUSE` 可视预览逐行为保留；当前 generic drag 没有的 kind/cycle 阻断不得借重构偷偷加入。
- node id / edge id 仍是内部稳定身份；显示名不要求唯一，也不能替代引用。
- wrapper membership、boundary edge、fan-out aggregator、clarify cycle 的 validator 语义不变。
- task 启动继续冻结 workflow snapshot；本 RFC 只把 editor 交出的版本显式带到现有 `expectedWorkflowVersion` OCC 门。
- schemaVersion、workflow definition wire、ACL、builtin 只读规则与 YAML round-trip 不变。
- RFC-198 的 shell、主题 token、公共 Dialog/Form/PageHeader/TabBar/focus 合同继续为权威。

## 2. P0：可靠草稿与原子版本

### 2.1 现场并发失败

当前 `updateWorkflow` 执行“读 existing version → 计算 `+1` → 仅按 id UPDATE → 再读返回”。两个从 v1 并发的更新可以都宣称成功并最终只留下 v2；迟返回调用方甚至可能读到另一提交的内容。前端又把任意成功回执当成当前草稿已保存。

因此仅修 frontend debounce 不够。版本必须成为数据库写谓词，而不只是展示字段。

### 2.2 Update wire

PUT 改为保存完整 editable snapshot，并增加 mutation identity。partial patch 会让 rename、autosave 与 import 继续携带不同基线，不能保留：

```ts
const WorkflowMutationIdSchema = z
  .string()
  .length(26)
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) // canonical 128-bit ULID

const UpdateWorkflowSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    clientMutationId: WorkflowMutationIdSchema,
    snapshot: z.object({
      name: z.string().min(1).max(256),
      description: z.string(),
      definition: WorkflowDefinitionSchema,
    }),
  })
  .strict()

interface WorkflowRevision {
  workflowId: string
  version: number
  snapshotHash: string
  updatedAt: number
}

interface SaveWorkflowReceipt {
  clientMutationId: string
  requestedBaseVersion: number
  revision: WorkflowRevision
  snapshot: WorkflowDraftSnapshot
  outcome: 'committed' | 'already-current'
}

type WorkflowDetail = Workflow & { snapshotHash: string }
```

canonical bytes 定义为 UTF-8(`"workflow-editable-snapshot/v1\n" + canonicalJson(snapshot)`)：object key 递归字典序，array 顺序保留，输入先经 schema + definition migration 规范化。服务端以 canonical bytes 相等判断 no-op，再输出小写 hex SHA-256 作为 `snapshotHash`；不以 digest 相等替代服务端 byte comparison。DB `definition` 的 latest physical storage 则精确定义为 `canonicalJson(normalizedDefinition)`（无 domain prefix、无尾换行）；create/import/update/heal 以及 `agentLaunch`/`workgroupLaunch` fixed-id host seed 全部调用同一 `serializeWorkflowDefinitionStorageV1`。transaction 以 raw column string 与该结果比较是否需 heal，避免新建行或已 heal 行每次 no-op 都重复 bump。抽取并复用 `workflow-sync-diff.ts` 已有排序逻辑。

`GET /api/workflows/:id` 与 create 后的 detail payload 增加 derived `snapshotHash`（不落 DB、不要求 list row 计算），与 `version/updatedAt` 一起组成 route 初始 revision；reconciliation GET 因而能比较服务端 canonical hash。PUT/YAML overwrite 则以 `SaveWorkflowReceipt` 返回同一真值，不能让 frontend 自算 hash 代替服务端回执。

每个浏览器 tab 用现有 `ulid()` 为每个 submitted attempt 生成一次 mutation id，transport retry 复用该 id，queued 新 snapshot 生成新 id；YAML UI/CLI/internal command 同样“一次用户/命令意图一个 ULID”，禁止本地递增计数器。mutation id 只关联回执/WS，不作为长期持久化幂等表。

service 不接受隐式“无 actor 就跳过 ACL”：调用方必须传显式 `WorkflowWritePrincipal = {kind:'actor', actor} | {kind:'system', reason}`。所有 HTTP/YAML writer 传 actor；seed/framework system caller 使用可审计的 system reason。

服务端更新必须在同一个同步 DB transaction 内完成：

```sql
UPDATE workflows
SET name = ?, description = ?, definition = ?,
    version = version + 1, updated_at = ?
WHERE id = ? AND version = ?
RETURNING ...;
```

- transaction 先重读 id/version/owner/aclRevision/builtin/physical definition；在任何 hash/no-op/CAS 分支前，按 current owner 对 actor 重做 owner/admin 门（system principal 走显式 internal branch）。并发 owner transfer 后旧 owner 即使仍持有旧 version 也不能保存；route 的预鉴权只负责早失败/404 shape。
- 若 expectedVersion 匹配、logical canonical bytes 相同且物理 definition 已是 latest canonical storage：不 bump、不 broadcast，返回 `already-current`。
- 若 logical bytes 相同但 stored definition 仍是 GET 时内存升级前的旧 schema/非 canonical 形态：执行一次 fenced `committed` heal、bump version 并 broadcast，保持现有 heal-on-edit 契约；不能被 no-op 永久跳过。
- `RETURNING` 有一行：该行就是唯一 `committed` 回执，版本必为 `expectedVersion + 1`，snapshot 必须是本请求经服务端规范化后的内容，不能在提交后再做一个无 fence GET。
- version 已变化但 current/submitted canonical bytes 相同：作为响应丢失/同内容重试对账返回 `already-current`；仍须先通过 current owner/builtin 门，不 bump、不 broadcast。
- version 已变化且 bytes 不同：返回 `409 workflow-version-conflict`，details 带当前 `WorkflowRevision`；不存在/不可见继续既有 shape。
- schema parse 与 `assertNewRefsUsable` 保持 transaction 外 preflight；preflight 失败保证零写入，但引用资源在 preflight 后漂移不做多资源锁，由 exact Validate 与 `startTask` 最终 validator 拦截。transaction 内只重做依赖 current workflow row/principal 的 owner、builtin、name-change 与 CAS。
- 没有 `force: true` 绕过版本门。显式覆盖也必须先看见最新版本，再以该版本做下一次 CAS；再次竞争则再次冲突。
- 所有 HTTP/CLI/import writer 必须迁移；缺 `expectedVersion`、`clientMutationId` 或完整 snapshot 为 422，不保留默认“读最新再写”的后门。
- create 不需要 expectedVersion；workflow 表已有 version，无 migration。

只有 changed commit 才发送 `workflow.updated`；frame 增加 `clientMutationId`、version、snapshotHash、updatedAt。broadcast 可早于 HTTP 被浏览器收到，因此 frontend 用 mutation id 识别自身回声，HTTP receipt 仍是提交结算权威。

content writer 定义为任何会修改 workflow `name`、`description`、`definition` 或 `version` 的路径，全部必须调用同一 fenced save service。Create/fixed-id seed 可保留独立 insert ownership，但所有 production `INSERT workflows.definition` 必须先走 canonical storage helper；`agentLaunch`/`workgroupLaunch` 是显式 source-lock 点。允许保留的 metadata-only `db.update(workflows)` 必须进入 allowlist（例如 fusion owner/builtin repair），且不能触碰 editable columns/version；不能因调用方名为 seed/internal 就豁免。destructive writer 只有 fenced delete service 可调用 `db.delete(workflows)`，ratchet 禁止恢复 `deleteWorkflow(db,id)` 或 route/direct 按 id delete 旁路。

YAML import wire 从 raw body + query 收敛为 shared schema：

```ts
type ImportWorkflowRequest = {
  yamlText: string
  mode: 'fail' | 'new' | 'overwrite'
  overwrite?: {
    workflowId: string
    expectedVersion: number
    clientMutationId: WorkflowMutationId
  }
}

type ImportWorkflowResult =
  | { outcome: 'created'; workflow: WorkflowDetail }
  | { outcome: 'overwritten'; receipt: SaveWorkflowReceipt }
```

- `mode='fail'` 的 collision 409 details 必带 incoming/existing name 与 current `WorkflowRevision`；Dialog 保存该 revision。
- 用户确认 overwrite 时，浏览器生成并持有一个 ULID，发送 conflict workflowId/expectedVersion；服务端重解析 YAML，要求 YAML id 与 workflowId 相同，再构造完整 snapshot 调同一 save service。
- overwrite 缺任一 fence 为 422；冲突后刷新 preview 才能取得新 revision。transport retry 复用 mutation id；CLI/internal caller 自己生成一次 ULID。
- `new`/无冲突 create 用 INSERT `RETURNING` 的同一规范化行直接构造带 hash 的 `WorkflowDetail`，不做 post-create GET；overwrite 只返回 save receipt，不再附一份可能跨 revision 的 Workflow。Onboarding 与 Dialog 同时迁移，不能保留 raw-body unfenced 后门。

### 2.3 Delete fence

Delete 同样是版本敏感的破坏性写，不能留在 PUT fence 之外：

```ts
const DeleteWorkflowSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    clientMutationId: WorkflowMutationIdSchema,
  })
  .strict()
```

Delete Dialog 显示服务端 version 与本地是否仍有未保存编辑；确认表示丢弃该本地草稿，不先把待删内容多保存一次。service 接收显式 principal，并在单一 `dbTxSync` 中重读 current row，先做 current owner/admin + builtin gate、version match，再在同一 transaction 检查全部 task references，最后 `DELETE ... WHERE id=? AND version=? RETURNING id,version`。任一漂移返回 409/403/404/in-use 且零删除；没有按 id force-delete。只有 commit 后发送带 `clientMutationId/deletedVersion` 的 `workflow.deleted`，HTTP 成功才导航列表；409 要求刷新摘要并重新确认。

与 `startTask` 的交错按 DB FK/transaction 明确线性化：task row insert 先赢，Delete 必须看到 reference 并 `workflow-in-use`；Delete 先赢，startTask 的最终 insert 将 FK/zero-row 翻译成结构化 `workflow-version-mismatch`，不得冒泡 500。startTask 对所有在 task row 成功前新建的 normal repo/worktree/scratch side effects 维护 cleanup ledger；此 race 失败后必须清到零残留（共享 cache 只撤本次引用，不删他人资产）。普通 version mismatch 若在 materialize 前发现仍保持零创建。测试用可控 hook 覆盖两种顺序、最终零 dangling task/残留目录。

### 2.4 Composite draft

新增 `lib/workflowEditorDraft.ts` 纯状态机。一个 draft 同时拥有 name、description、definition，删除 route 内 rename/autosave 两条竞争写通道：

```ts
type WorkflowDraftSnapshot = Pick<Workflow, 'name' | 'description' | 'definition'>

interface WorkflowEditorDraftState {
  local: WorkflowDraftSnapshot
  server: WorkflowDraftSnapshot
  serverVersion: number
  revision: number
  savedRevision: number
  inFlight: SaveAttempt | null
  queuedRevision: number | null
  phase:
    | 'clean'
    | 'dirty'
    | 'saving'
    | 'reconciling'
    | 'error'
    | 'conflict'
    | 'inaccessible'
    | 'deleted'
  error: ApiError | null
  conflict: RemoteConflict | null
  transport: 'online' | 'degraded' | 'offline'
  reconcileRetry: { attempt: number; nextAt: number | null }
  history: HistoryState
}

interface SaveAttempt {
  revision: number
  expectedVersion: number
  clientMutationId: string
  snapshot: WorkflowDraftSnapshot
  snapshotHash: string
}
```

规则：

1. 每个本地事务产生新的单调 `revision`；Undo/Redo 也是新 revision，绝不把计数器倒退。
2. debounce 只决定“何时要求保存”，不决定保存内容。请求变量必须携带创建时的完整 snapshot/revision/expectedVersion，mutation function 不读取 render closure。
3. 同一 workflow 最多一个 PUT 在途；编辑发生时只更新 `queuedRevision` 为最新值，不并发发第二个请求。
4. 成功回执只确认 `attempt.revision`。若 `state.revision === attempt.revision`，进入 clean；否则保持 dirty，并立即/按短 idle 窗口提交最新 queued snapshot。
5. transport/5xx 不能直接判定未提交：进入 `reconciling` 并 GET 当前 revision。GET 也不可达时保持原 in-flight attempt、local 与最新 queued intent，transport=`offline`，绝不清 dirty/改成 definitive error；WS 断开但 HTTP 仍成功为 `degraded`。成功 HTTP/WS open 才恢复 online，`navigator.onLine` 只作唤醒提示，不单独作为真值。
6. 409 进入 conflict，暂停 autosave；local、remote metadata、history 都保留，禁止自动覆盖。
7. 明确 `workflow.deleted` frame 进入 `deleted`；save/reconcile/detail 的 403/404 因 ACL 不暴露存在性而进入 `inaccessible`，文案为“已删除或权限已变化”，不能猜成 deleted。两者都保留 local/history、停止 autosave，提供本地 YAML 导出；仍有 create 权限且 refs 可用时可另存副本，另可重试访问/返回列表，绝不能显示已保存。
8. 卸载/路由跳转时 dirty/saving/reconciling/error/conflict/inaccessible/deleted 继续接入 `UnsavedChangesGuard`；“正在保存”不能被当成安全离页。

前端可复用 shared stable hash 做相等判断，但服务端返回的 revision/hash 与 CAS 才是并发真值。

offline reconciliation 使用可测试 scheduler：1s/2s/4s/8s/15s capped backoff（测试注入 clock/jitter），并提供手动“立即重试”；browser `online`、WS open、visibility/focus 都会取消等待并立即 reconcile。恢复后必须先 GET：hash 等于 submitted 合成成功；server 仍为 expectedVersion 且 hash 不同则复用原 mutation id 重发同 attempt；version 已前进且 hash 不同进入 conflict；403/404 进入 inaccessible。完成这一步前不能先发送 queued 新 snapshot，避免把“旧请求其实已提交”误当新基线。没有 in-flight 的离线编辑只 coalesce queued revision，online 后再按 single-flight 保存。

### 2.5 Query / WebSocket 调和

query 返回 workflow R 时按以下顺序处理：

0. **active reconciliation 优先**：若 phase=`reconciling` 且存在 in-flight attempt，任何 HTTP GET 或 WS/visibility/focus 唤醒后的 observation 都先走 §2.4 的 attempt-aware 分类：hash 等于 submitted 合成成功；`R.version === attempt.expectedVersion` 且 hash 不同表示仍是原 base，复用原 mutation id 重发；version 已前进且 hash 不同才进入 conflict。generic dirty-remote 规则不得抢先消费 active reconciliation observation。
1. **旧数据**：`R.version < serverVersion`，忽略。
2. **完全相同**：version + snapshotHash 与已知 server/attempt 相同，视为重复通知。
3. **自身回声**：WS `clientMutationId` 命中 in-flight；不 invalidate detail，不动 local revision，仍由 PUT receipt 结算。query refetch 先到时以 version/hash 做防御性等价判断。
4. **clean follow**：本地 clean 且无 in-flight，采用 R 为 local/server，清空 history 与旧 validation。
5. **dirty remote**：本地 dirty/saving/error 且 R 不是自身回声，冻结 local 并进入 conflict；绝不 `setDraft(R.definition)`。active reconciliation 已由规则 0 消费，其中只有 version advanced + different hash 进入同一 conflict；same expectedVersion 必须重发原 attempt，不能假冲突或 clean-adopt。
6. **conflict 中的新远端**：更新 conflict 的 current version/摘要，但不覆盖本地内容，也不自动退出冲突。
7. **明确远端删除**：进入 deleted，保留 local/history，允许另存副本或导出本地 YAML；403/404 observation 进入 inaccessible，不暴露也不猜测资源存在性。

`useWorkflowSync` 继续负责 invalidation；route 改为把 query data 作为 `REMOTE_OBSERVED` event 送进状态机，不再用裸 effect 直接 setDraft。

WS frame 不是完整同步日志，断线期间可能漏帧。`useWorkflowSync` 必须暴露单调 `connectionEpoch`：每次 WebSocket `open` 都无条件 invalidate workflow detail + list，并把返回行送入同一 `REMOTE_OBSERVED` 分支；页面从 hidden 回到 visible、窗口重新 focus 时也做节流 reconciliation。mutation id 只允许忽略“这一帧自身回声”的 detail invalidation，绝不能跳过 reconnect/visibility reconciliation。于是断线期间的远端提交在 clean tab 上会 adopt，在 dirty tab 上会进入 conflict，而不是永久保持假 clean。

### 2.6 冲突恢复

保存状态区变为持久 Notice，不用会消失的 toast。提供三个显式动作：

- **另存为副本（推荐）**：以 local snapshot 调 CreateWorkflow，名称预填 `<原名>-copy` 并允许修改；成功后打开新 workflow。原资源不被覆盖。
- **加载远端**：共享 ConfirmDialog 明示本地改动会丢失；确认后采用最新 query snapshot、重置 history/validation。
- **覆盖远端**：danger ConfirmDialog 展示本地版本和当前远端版本；确认时先 refetch，再用该 latest version 做 CAS。期间又变化则继续 409，不循环强写。

冲突 UI 不尝试按 node id 自动合图；可提供本地/远端节点数、更新时间等摘要，不把整份 JSON diff 作为主路径。

### 2.7 权限或可见性丢失

`inaccessible` 使用持久 Notice：“无法继续访问此工作流；它可能已删除，或你的权限已变化。”因为 403/404 合同刻意不泄露存在性，UI 不显示未经证实的 owner/delete 结论。动作固定为：本地导出 `unsaved` YAML、重试访问、返回工作流列表；若 CreateWorkflow 与所有引用资源门仍可通过，再提供“另存为副本”。任何动作都不清 local/history，只有副本创建成功并切到新资源后才结束旧草稿 guard。

## 3. 保存、校验、导出与启动的精确交接

### 3.1 `ensureSaved()`

route 暴露：

```ts
type SavedReceipt = {
  revision: number
  server: WorkflowRevision
  snapshot: WorkflowDraftSnapshot
}

ensureSaved(): Promise<SavedReceipt>
```

它立即取消 debounce、刷新 queued snapshot，并串行等待直到某一时刻 `revision === savedRevision` 且无 in-flight。Validate/Export 等普通调用若等待期间继续编辑，则保存最新 revision；连续输入期间显示“完成编辑后继续…”，300ms idle 后再推进。error/conflict/inaccessible/deleted 抛结构化结果并把焦点送到保存状态 Notice。

每个 action 拿到 receipt 后都必须再次检查 local revision/hash；如果在后续 API 返回前发生编辑，则结果标记 stale，不继续危险动作。Launch 是例外：点击后建立可取消的短暂 `preparing-launch` interaction lock，冻结本次点击 revision 直至保存/校验/导航完成，失败即解锁；界面明确显示“正在保存并校验…”，不让系统猜用户想启动哪个版本。

### 3.2 Validate

`POST /api/workflows/:id/validate` body 改为：

```ts
{
  expectedVersion: number
  expectedSnapshotHash: string
}
```

响应改为：

```ts
interface WorkflowValidationReceipt {
  revision: WorkflowRevision
  validationContextHash: string
  validatedAt: number
  ok: boolean
  issues: WorkflowValidationIssue[]
}
```

backend 只调用一次 `loadVisibleWorkflow` 捕获 immutable row/snapshot，以该行同时做 ACL、version/hash guard，再调用 `validateWorkflowDefinition(captured.definition, freshlyLoadedContext)`；guard 后不得再按 id 读取 workflow。并发 writer 插在 guard/validate 之间时，只能校验已捕获的请求版本，或在捕获时已看到新版本而 409，不能检查 vN 后校验 vN+1。frontend 流程为 `ensureSaved → validate(receipt.server)`，并把结果绑定到 `{localRevision, workflowVersion, snapshotHash, validationContextHash}`。

validation 还依赖实时 agents/skills/plugins，workflow revision 不能代表完整校验上下文。backend 通过单一 `projectWorkflowValidationContext` 投影 validator 实际读取的全部语义字段：至少含资源 identity/version/enabled/可见性、agent role/inputs/outputs/outputKinds/outputWrapperPortNames/dependsOn/skills/mcp/plugins/runtime，以及 skill/plugin 的 enabled/version/capability；不含 secret/prompt 正文。投影字段由 source/AST coverage 与 validator 读取点同增，不能靠手写子集静默漏项。稳定排序后计算 UTF-8(`"workflow-validation-context/v1\n" + canonicalJson(projection)`) 的小写 hex SHA-256 `validationContextHash`。agent/skill/plugin inventory query 或 WS 变化时，editor 立即把旧结果标为“校验环境可能已变化”；Launch 永远重新执行 fresh exact Validate，不复用页面上旧的绿色结果。`startTask` 仍是最终 fresh validator，防 Validate 后到创建 task 前的资源漂移。

任意本地编辑后，原结果显示为“上次校验（草稿已变化）”，不再贡献绿色通过状态；只有当前 revision 的 blocking issue 才控制 Launch。

### 3.3 Export

Export 改为先 `ensureSaved`，再用 authenticated fetch 请求 `GET /api/workflows/:id/export?expectedVersion=N&expectedSnapshotHash=H` 并生成下载。route 只调用一次 `loadVisibleWorkflow` 捕获 immutable row/snapshot，以该行同时做 ACL、version/hash guard 与 pure YAML stringify；guard 后不得二次读取“最新行”。因此并发 writer 恰好插在 guard/stringify 之间时，要么导出已捕获的请求版本，要么在捕获时已看到新版本并返回 409，绝不会检查 vN 却序列化 vN+1。不能继续用脱离状态机的裸 URL 打开可能过期的 YAML。deleted 状态可单独导出仍在内存的 local draft，并在文件名明确标记 `unsaved`。

### 3.4 Launch

Editor 的 Launch：

1. 设置 `preparing-launch` lock，捕获点击 revision；
2. `receipt = await ensureSaved()`；
3. 无条件 fresh validate exact version/hash，并取得新的 `WorkflowValidationReceipt`；页面旧结果只作编辑反馈，不作为本次 Launch 的授权缓存；
4. 若有 blocking issue，解锁并留在 editor，定位第一项；warning 不阻塞；
5. 检查 receipt 与冻结 revision 一致；
6. 导航 `/workflows/:id/launch?version=<receipt.server.version>`。

legacy redirect 将 version 传到 `/tasks/new` 的 validated search：

```ts
{ kind: 'workflow', workflow: id, workflowVersion: number }
```

Task wizard：

- 首次加载即校验当前 workflow version 等于 deep-link version；不等则显示“流程已在打开启动页前变化”，不静默换定义；
- 对所有带 `workflowVersion` 的 editor launch（不只 relaunch）捕获 `normalizedWorkflowVersion`；
- immediate POST 沿用现有 `expectedWorkflowVersion`，保证填写启动参数期间又发生修改时 backend 409；
- JSON 与 multipart 两条 immediate submit 都必须携带 guard；
- startTask 在最终 task-row transaction 仍消费 guard/FK；若 workflow 在前置读取后被删除，返回结构化 mismatch 并按 cleanup ledger 清除全部本次 materialized side effects，不留下 orphan worktree/repo；
- schedule 继续按既有语义在触发时快照最新版本，不把 immediate guard 持久化；界面必须明确“计划执行时使用最新工作流”，不能伪装为固定当前版本。

这条链不要求新增 task snapshot 机制；复用 RFC-175 已存在的启动 OCC。

## 4. 单一交互规划层

### 4.1 Change intent

所有本地编辑通过 route 的 `dispatchDraftChange`：

```ts
interface DraftChangeMeta {
  source: 'canvas' | 'inspector' | 'metadata' | 'starter'
  label: string
  mergeKey?: string
  transaction?: 'single' | 'begin' | 'update' | 'commit'
  selectionAfter?: CanvasSelection
}
```

Canvas、Inspector 与 Dialog 都先构造 typed transition，再由唯一 `applyWorkflowTransition` 生成 canonical next definition；route 只接收 before/next + intent 并记录 history，不再让 planner、事件 handler 与旧 `commitChange` 各执行一遍同步。rename、description 等非图字段也走同一 composite draft 入口，避免一个旧 canvas history 跨过较新的 inspector edit。

### 4.2 Undo / Redo

history 位于 composite draft 层，保存回执不影响 history：

- 结构操作、Dialog submit、starter apply、edge insert 各为一个原子 entry；
- node drag 的多帧 change 在 drag start/stop 间合并为一个 entry；
- 同一字段连续输入按 `mergeKey` 合并，blur、焦点切换或 750ms idle 结束 transaction；
- Undo/Redo 恢复完整 composite snapshot 和 selection/focus hint，并生成新 revision；
- 新 local change 发生在 undo 后清 redo；
- clean remote follow、加载远端、切换 workflow 清 history；保存成功、validation、own echo 不清；
- 最多保存 50 个结构共享 snapshot reference。所有 reducer 输入保持 immutable；开发测试用 deep-freeze 反证原地修改。

快捷键只在非文本输入/非 Dialog capture 时接管；文本框内浏览器原生 undo 优先。工具栏按钮始终可见并带下一项 label，例如“撤销：删除 审计节点”。

### 4.3 Connection plan

抽取纯函数 `planWorkflowConnection(definition, request, semanticContext)`，让 drag 与显式 Dialog 共用，但 planner 只产生 preview + graph delta，不直接调用 review/output disconnect/connect sync：

```ts
interface WorkflowSemanticContext {
  agentsByName: Readonly<Record<string, AgentPortCapability>>
  inventoryRevision: string
}

type ConnectionRequest =
  | {
      kind: 'generic'
      source: PortRef
      targetNodeId: string
      target: { mode: 'reuse'; portName: string } | { mode: 'new'; portName: string }
    }
  | { kind: 'clarify-questioner' /* typed source/target */ }
  | { kind: 'cross-questioner' /* typed source/target */ }
  | { kind: 'cross-designer' /* typed source/target */ }
  | {
      kind: 'fanout-boundary-input'
      wrapperNodeId: string
      outerEndpoint: PortRef
      innerEndpoint: PortRef
      port: { portName: string; kind: AgentOutputKind; role: 'shard' | 'broadcast' }
    }
  | {
      kind: 'fanout-boundary-output'
      wrapperNodeId: string
      innerEndpoint: PortRef
      outerEndpoint: PortRef
      port: { portName: string; kind: AgentOutputKind }
    }

type ConnectionNodePatch = {
  kind: 'set-fanout-inputs'
  wrapperNodeId: string
  inputs: ReadonlyArray<WrapperFanoutPort>
}

type ConnectionPlan =
  | {
      ok: true
      removeEdgeIds: string[]
      addEdges: WorkflowEdge[]
      nodePatches: ConnectionNodePatch[]
      connectionMeta: ConnectionMeta[]
      compatibility: 'compatible' | 'incompatible' | 'unknown'
      preview: ConnectionPreview
      warnings: ConnectionAdvisory[]
    }
  | { ok: false; reason: ConnectionBlockReason }
```

它统一规划 kind compatibility、input name、已有引用、wrapper boundary、clarify 成对语义与 `NEW / REUSE`。`REUSE` 的定义就是选择现存 input；若该单入端口已占用，沿用当前 drag 语义，在 preview 中明确“替换原连接”并把旧 edge 放入 `removeEdgeIds`，不另造一个含义重叠的 `REPLACE` 选项。target port 不能机械依赖 `declaredPorts(node).inputs`：agent-single/output 是可扩展动态输入，必须由现有 `existingInputPorts` + node kind policy 接受 new/reuse；review/clarify/wrapper 等 fixed target 才以 shared `declaredPorts` 为主。agent output/outputKinds、aggregator promotion 与 control-flow classification 只从 immutable `WorkflowSemanticContext` 读取；inventory revision 变化时重新计算候选和 preview，旧 Dialog plan 立即失效并禁用提交，不能缓存打开瞬间的资源结论。

review 是 fixed target 的显式特例，不能因 `declaredPorts(review).dataInputs` 当前为空就消失：将 `REVIEW_INPUT_PORT_NAME = '__review_input__'` 提升为 shared semantic constant，并在 `connectionTargetPolicy` 注册“单入、只允许 fixed-port REUSE（占用即 replace）、同步 `inputSource`”描述。source 必须是 agent-single 的已声明 output；kind 复用 shared `tryParseKind` + `isReviewableBodyKind` / `isMultiDocReviewInput`，只接受 markdown/markdown_file/path<md|markdown> 或其合法 list，非 agent/已知非 markdown为 incompatible，inventory 未加载才是 unknown。planner、drag adapter、Dialog、validator 与 review output-port derivation共用该 policy/predicate，不在 frontend 再硬编码一份 markdownish 集合。

review input 从 single↔multi 变化会让 derived business output 在 `approved_doc ↔ accepted` 间切换。planner 必须给出该 semantic rename preview；reconciler 在同一 transaction 原子重写所有以旧 review port 为 source 的 edges，以及 output bind、loop exit/output binding 等 PortRef，`approval_meta` 不动。不能只改 `inputSource` 留下 stale downstream port；single→multi→single golden 同时锁 kind、edge 与 mirrors。

`ok` 只表示现有 structural contract 可提交；compatibility 单独三态返回。guided Dialog 对已知 `incompatible` 禁用并解释、对 inventory 未加载的 `unknown` 等待重算；drag adapter 继续按旧合同提交并把 compatibility 只作为 advisory，避免重构改变既有 definition。dynamic agent input 不因 capability-card `Agent.inputs` 为空就误判 incompatible；generic cycle 同理只 advisory。

fan-out crossing 不能伪装成普通 output→input：input boundary 同时有 outer target / inner source，output boundary 同时有 inner target / outer source。上述两个领域 intent 明确编码两侧角色；新 fan-out input 必须携带或从 source 权威派生 `kind`，并显式选择唯一 `shard` 或 `broadcast` role。kind 未知时 UI 要求选择/等待资源上下文，不沿用当前首口 `list<string>`、后续 `string` 的猜值。选择 shard 时 kind 必须 parse 为 `list<T>`；沿用现有 inspector 语义，planner 纯返回 immutable `set-fanout-inputs` node patch，把旧 shard 原子 demote 为 broadcast、把新口设为唯一 shard，preview 明示该变化，planner 本身不 mutate definition。wrapper 尚无 shard 时不能只新增 broadcast 并宣称完成，guided UI 要求先选一个合法 shard；0/1/2-shard 输入分别锁 blocking/valid/validator-rejected-heal oracle。已经存在的 external→wrapper input 与 wrapper output→external 普通连接仍走 generic intent。

为保持现有 drag 合同，generic cycle 不是 planner blocking reason：当前画布只阻止 missing/self/exact duplicate，合法 loop cycle 又必须可建。planner 可返回 topology advisory，最终由当前 scope-aware backend validator 判定；clarify 的设计性成对 cycle 也不报警。RFC 不一边承诺 drag 等价、一边偷偷新增通用 cycle gate。

`applyWorkflowTransition(prev, transition, semanticContext)` 是唯一写语义：先从 prev 计算并应用 disconnect/clarify cascade，再写 node/edge/node-declaration delta，随后对新增 edge 执行 review/output bind、fan-out input/boundary 与 workflow input sync；最后以同一 context 比较 prev/final `declaredPorts`，应用已知 semantic rename（review approved port）并处理 disappeared derived ports。占用端口 REUSE 与 edge insert 因此不会出现双同步。它返回 `{next, warnings}`；route 只接收 canonical next 并记录一个 history entry，同时显示 warnings。

node deletion 也属于 semantic transition，而不是只删 visible node/incident edges：`collectNodeDeletionClosure` 对 wrapper 递归包含所有 descendant；随后 `pruneDeletedNodeReferences` 依据 shared node-reference descriptor inventory，过滤 surviving wrapper `nodeIds` 与 review rerunnable arrays，并把指向已删节点的 review `inputSource`、output `ports[].bind`、loop `exitCondition` / `outputBindings[].bind` 清成显式 incomplete 值，由 Validation 定位修复。wrapper membership 被过滤时复用 `applyMembershipPatch` 规则：非 `sizeLocked` 清 persisted size 触发 refit，locked 保持尺寸。clarify pair 与 boundary/mirror 仍由同一 cascade 处理。

删除/更换 fanout aggregator 等操作还可能让 wrapper derived output 消失，却没有直接 dangling nodeId。final port-diff 必须删除引用 disappeared port 的普通/boundary edges，并清对应 output/loop/review PortRef，warning 列出受影响连接；不得靠 edge fallback 继续画 ghost port。若 shared oracle给出明确 semantic rename 才原子改写，否则 fail-visible prune。copy rewrite、delete prune 与 port-ref prune 共用 descriptor inventory/source ratchet，新增引用字段不能只修一边。

EdgeInspector 的 target-port rename 也必须变成 semantic transition，不能继续直接改 `edge.target.portName`：system/clarify/boundary/review fixed port 禁止任意 rename；agent-single 动态 input 可改；output/fan-out 声明端口 rename 必须原子更新声明、所有相关 edge 与 mirror/boundary metadata。remove 同样走 reconciler。

drag handle、body-drop、EdgeInspector rename/remove 与 node-delete path 先迁到 transition reconciler，并用现有回归证明交互/合法图语义等价，之后才接非拖拽 UI。字节差异只允许来自本 RFC 明列的 dangling-ref、derived-port、fanout kind/shard 修复，并逐项用 before/after fixture 解释；不能拿“修复”掩盖其他 drift。Dialog 只消费 plan/preview，提交时调用一次 reconciler，不复制同步规则。

### 4.4 “连接到…” Dialog

入口：节点选中工具条、output port 可见 action、节点更多菜单。Dialog 使用共享 `Dialog + Field + Select`：

1. source output（入口若来自端口则已选）；
2. 可搜索 target node，按兼容性排序，不隐藏 disabled 选项的原因；
3. target input 选择 `reuse` 或 `new`，new 使用受控端口名输入；占用端口的 reuse 明示将替换哪条连接；fan-out boundary 改用领域文案并显式展示 shard/broadcast、kind 与内外侧角色；
4. 摘要展示 `来源.输出 → 目标.输入`、数据 kind 与 NEW/REUSE；
5. planner ok 才允许提交。

键盘 focus 首落 source/target 的第一个未完成字段；提交后选中目标节点并把焦点还给画布节点。Escape/Cancel 零 mutation。

### 4.5 Node Picker 与 contextual add

新增一个共享业务组件 `WorkflowNodePicker`，不是新的全局 primitive。数据源包含现有 palette node kinds 与可选 agent/resource 信息；结果统一返回 `NodePickerIntent`：

```ts
type NodePickerIntent =
  | {
      kind: 'free'
      viewportPoint: XY
      scope: { kind: 'top-level' } | { kind: 'wrapper'; wrapperNodeId: string }
    }
  | {
      kind: 'after-node'
      nodeId: string
      scope: { kind: 'top-level' } | { kind: 'wrapper'; wrapperNodeId: string }
    }
  | { kind: 'inside-wrapper'; wrapperNodeId: string }
  | { kind: 'insert-edge'; edgeId: string }
```

- free：复用现有 `insertPaletteItem`，默认 viewport center 或触发点；
- after-node：创建节点并尝试 planner 生成连接，提交前预览；
- inside-wrapper：每个 editable git/loop/fanout wrapper（包括空 wrapper）提供可见“添加内部步骤”，picker 候选遵守现有 membership/嵌套 policy；placement 可在 wrapper-local space 计算，但提交前必须经现有 `coordProjection` 转回 canonical **absolute** position 写入 WorkflowDefinition，只有 xyflow render adapter 再投影 relative。创建节点、append wrapper `nodeIds` 与可选连接是同一 transition/history entry。after-node 若源节点位于 wrapper，scope 也必须显式携带该 wrapper；不能只凭视觉落点猜 membership；
- insert-edge：v1 只支持 top-level、两端都不属于 wrapper 的普通 data edge；boundary/clarify/control/任意 wrapper-inner/cross-wrapper edge 不显示 `+`。这同时避开 fan-out inner-chain 等现有结构禁令。只有能构造 `A → new → B` 且两段均兼容的候选可提交，必须保留原 target port；原边删除、节点创建与两条新边是同一 transition/history transaction；
- 取消时零定义变化，焦点回原 trigger；
- recent items 只存 node/resource identity，不存 workflow 内容。

节点/边 `+` 在 selection/focus 后可见；纯 hover 只作视觉加速，不是唯一入口。empty state 与 toolbar 使用同一 picker。

连续 click/keyboard add 不能全部落在 viewport center。新增纯 `findOpenPlacement`，使用节点实测/默认 rect 做稳定网格或螺旋避让；若中心落在 wrapper 视觉 rect 内但 intent 不是加入 wrapper，必须移出该 rect，避免“看起来在容器内、实际不在 nodeIds”的假包含。`scope/inside-wrapper` 是唯一非拖拽 membership authority，并在 wrapper coordinate space 内避让；空 wrapper 不再要求先拖一个 child 才能继续。

### 4.6 邻接不变量修复

Undo、插边与连接 planner 会放大现有 clipboard 缺口，必须在同一前置批修复：

- copy/duplicate 选中 wrapper 时递归扩展其完整 child closure（嵌套 wrapper 同样展开），只复制 closure 内两端都被包含的 edge；wrapper 与 child 同组偏移，不能复制引用原 child id 的空壳；
- paste 通过 shared node-reference descriptor inventory 驱动的 `rewriteCopiedNodeReferences(node, idMap)` 重写所有内部引用：wrapper `nodeIds`、review `inputSource/rerunnableOnReject/rerunnableOnIterate`、output `ports[].bind`、wrapper-loop `exitCondition.nodeId/outputBindings[].bind`，以及实现盘点发现的其他 nodeId/PortRef 字段；同一 inventory 也驱动 node-delete prune；
- slice 外引用统一清空/过滤并给可见 warning，不保留指向原图的隐形依赖；legacy missing child 同样只能从新 closure 过滤，绝不能 fallback 原 id；
- paste 重建 edge 时保留 `boundary`，不能把 fan-out runtime edge 静默降成普通 edge；
- clipboard payload 记录 `sourceWorkflowId`，并为所有复制的 input node 携带完整匹配 `definition.inputs[]` declaration。paste 按 **distinct source inputKey** 建 `inputKeyMap`，每个源 key 只生成一个 target workflow 内 collision-safe 新 key；共享该 key 的所有复制节点、outbound edge source port 与唯一 declaration 一起重写，不能把一个 launcher field 拆成多个。完整保留 upload kind/label/required/description/targetDir/accept/count/size 等字段。源 declaration 缺失则整次 paste fail closed + warning，禁止 `syncInputDefs` 静默补成默认 text。跨 workflow 与同 workflow duplicate 使用同一规则；resource refs 仍由下一次 save gate。
- review/output/loop/nested-wrapper/boundary clipboard fixture 在实现新 history 前先红后绿，并对 node reference field 做 source ratchet，新增字段不能漏进 copy。

这些是既有语义的守恒修复，不扩 runtime 或 definition wire；不得顺手重做 clipboard UX。

## 5. Starter 构造

### 5.1 Catalog

starter catalog 是 frontend 纯数据 + builder，不持久化新 schema：

```ts
interface WorkflowStarter {
  id: 'code-audit-fix' | 'audit-only'
  titleKey: I18nKey
  slots: StarterRoleSlot[]
  build(mapping: StarterRoleMapping): WorkflowDefinition
}
```

role slot 是 starter 内的语义标签（Code/Audit/Fix），声明 inputs、outputs 与 output kind；普通 slot 由用户显式映射任一兼容 normal agent，只有聚合 slot 强制 `agent.role === 'aggregator'`。候选来自当前可见 agent 清单，不按名称猜用途；ACL 仍由服务端 update 的 resource reference gate 兜底。

### 5.2 标准闭环

标准闭环表示现有运行语义，而不是首页图形的装饰复制：

- 输入 → `wrapper-git` 内编码 agent；
- wrapper 的 `git_diff` list/path 产物进入 fan-out audit 子图；
- fan-out 内审计实例与 aggregator 按现有 wrapper-fanout 规则连接；
- aggregator 输出进入 fix agent → 输出。

runtime 没有可直接复用的 shared workflow validator（当前最终 oracle 在 backend），不能在 frontend 复制完整规则。因此 backend 先把现有 `validateWorkflow(db,id)` 内核收敛为 `loadWorkflowValidationContext(db)` + 纯 `validateWorkflowDefinition(definition, context)`；saved-row validate 与 candidate validate 都调用这一份，不建临时 DB row，也不把 core 搬到 frontend/shared。

builder 先用专用纯 `validateStarterMapping` 做即时 slot/role/port/kind preflight，再调用 authenticated `POST /api/workflows/:id/validate-draft`：body 携 candidate definition + claimed candidate hash。backend 捕获 current workflow/actor 权限，parse+migrate candidate 后自行计算 UTF-8(`"workflow-definition-candidate/v1\n" + canonicalJson(candidate)`) 的 SHA-256；claimed hash 不等为 422，response 只回 server hash。随后以 captured stored definition→candidate 做与 PUT 同源的 `assertNewRefsUsable`，再调用正式 core/context loader；endpoint 不持久化，返回 `{candidateHash, validationContextHash, validatedAt, ok, issues}`。mapping/candidate/context 变化立即取消或作废旧结果；Apply 点击时重跑一次，只有 server hash 匹配当前 candidate 且无 blocking issue 才把 starter 写入本地 draft。PUT 仍再次执行资源 gate/CAS，不能把 preview 当写授权。catalog 的每个 golden mapping 仍在 backend test 中跑同一 validator，防 builder 漂移。随后 normal draft queue 走 fenced PUT，Launch 前 exact Validate；资源在极短窗口继续漂移仍由 inventory invalidation 与 Launch/startTask fresh validator 拦截。缺失合法 Code/Audit/Aggregator/Fix candidate、端口 kind 不兼容或 wrapper 输出不能合法提升时，Apply disabled，并给具体 slot 原因。不得用 agent 名称字符串猜角色。

标准闭环还依赖当前只在 scheduler 注释中以非规范写法存在的 git diff path-list 语义。shared 真值必须注册为 grammar 合法的 `wrapper-git.git_diff = list<path<*>>`，不能写会被解析成未注册 base path 的 `list<path>`；同时更新 stale runtime 注释，并枚举/测试 `sourcePortKind`、shardingRegistry（path 自身作 shard key，不能退化 index）、control-flow classification、validator、canvas 与 scheduler consumers，证明只是把既有 runtime 事实上移为共享真值，没有改变 edge/runtime 语义；starter 不允许私有硬编码第二份 kind。

### 5.3 应用语义

- 只对空 workflow 提供 starter 主入口；非空 workflow 若从更多菜单进入，必须二次确认“替换全部草稿”，并可 Undo。
- Apply 是一个 history transaction，随后选中第一个需配置节点。
- starter 输出固定 id seed 只用于测试；生产用现有 id factory，显示名不依赖 id。
- builder 不保存；由 normal draft queue 负责 CAS。

## 6. 自动布局

新增纯函数 `planWorkflowLayout(definition, { semanticContext, measuredSizes, selection })`，复用 `@dagrejs/dagre`；React adapter 在调用前捕获 immutable `measuredSizes`，planner 不从 DOM 读尺寸：

1. 从 definition + 节点显式尺寸 + `measuredSizes` 建立 coordinate spaces：top-level 与每个 wrapper 分开；实测尺寸优先于默认尺寸，多端口节点不能按固定卡片高度估算。
2. 对每条 data 或 control/signal 执行依赖（包括 fan-out `__done__`→downstream），找到两端所属 coordinate space 的最低公共祖先，在该空间把两端投影为 direct-child representative；代表不同才建立 virtual rank constraint。这样 external→wrapper-inner 的普通边也会在父层约束 external 与 wrapper 顺序。
3. actual boundary/mirror plumbing 不重复增加约束；clarify/system feedback/channel 排除。其余 projected constraints 中若形成 cycle，按稳定 node/edge id 确定性选择 back edge 排除 rank，实际 edge 不删除。data/control 分类依赖同一个 `WorkflowSemanticContext`，不能只按 port 名硬猜。
4. 先递归布局最深 wrapper 内容，再用现有 `wrapperFit` 计算容器尺寸，最后布局父空间。
5. 父空间布局移动 wrapper 时，将同一 delta 平移该 wrapper 的完整 descendant closure 的 canonical absolute positions；不能只移动 wrapper 本身，否则 renderer 的 child-relative geometry 会改变。再通过现有 `coordProjection` 做相对/绝对转换；不改变 parent/wrapper membership、port、edge 或业务字段。
6. `sizeLocked` 容器保持显式尺寸；内容放不下则给 warning 并不缩到重叠。当前 schema 没有 position pin，RFC 不私造持久字段。
7. 有 >=2 个选中节点时允许“整理所选”，但只移动同一 coordinate space 的 selection；保持原 selection bbox 锚点并避让未选节点。跨 wrapper selection 不静默重排整图，而是返回明确 advisory，由用户另点“整理全图”。
8. 返回 `{ next, warnings }`；结果作为一个 draft transaction，可 Undo。layout planner 不直接 setNodes，`sizeLocked` 放不下等 warning 必须进入可见结果。

测试 fixture 覆盖普通 DAG、分支/汇合、合法 clarify cycle、git/loop/fanout nested wrapper、父 wrapper 移动时 descendant absolute 同 delta 且 child-relative geometry 不变、boundary edge、sizeLocked、孤立节点与重复运行稳定性。

## 7. Validation 定位与检查器信息架构

### 7.1 Pointer resolver

shared validation issue 增加可选 strict typed target，保留 `pointer` 向后兼容。`field` 不是 DOM id，而是 shared finite semantic token；frontend 再映射到 stable field id：

```ts
const WorkflowValidationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), nodeId: z.string() }).strict(),
  z
    .object({
      kind: z.literal('node-field'),
      nodeId: z.string(),
      field: WorkflowNodeFieldKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('node-port'),
      nodeId: z.string(),
      direction: z.enum(['input', 'output']),
      portName: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('edge'), edgeId: z.string() }).strict(),
  z.object({ kind: z.literal('workflow-input'), inputKey: z.string() }).strict(),
  z.object({ kind: z.literal('workflow-output'), outputName: z.string() }).strict(),
  z.object({ kind: z.literal('workflow') }).strict(),
])
```

`WorkflowNodeFieldKeySchema` 由 shared `WORKFLOW_NODE_FIELD_KEYS` 的封闭 enum 生成，键表示 `agent`、`prompt`、review source、loop exit 等语义字段；新增可聚焦字段必须先扩 shared enum + frontend resolver。output node 的 binding row 是该 output node 的 data input，因此 `binding-node-missing` / `binding-port-missing` 通过 `{kind:'node-port', nodeId:outputNode.id, direction:'input', portName:binding.name}` 唯一定位，不能错误指向 upstream output；loop `outputBinding` / `exitCondition` 则使用对应 `node-field` semantic row target。重复 workflow input/output 等无法唯一定位的错误只发 workflow target，不能挑第一个冒充命中。

能唯一定位的现有 validator issue 必须发 target；frontend 同时新增纯 `resolveWorkflowIssueTarget(issue, definition)`，为旧 pointer/code 提供兼容解析：

```ts
type IssueTarget =
  | { kind: 'node'; nodeId: string; section?: InspectorSection; field?: WorkflowNodeFieldKey }
  | { kind: 'node-port'; nodeId: string; direction: 'input' | 'output'; portName: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'workflow-input'; inputKey: string }
  | { kind: 'workflow-output'; outputName: string }
  | { kind: 'workflow'; section?: 'inputs' | 'outputs' }
  | { kind: 'unknown' }
```

它优先读取 target，再解析现有 pointer/code，不改变 backend validator 文案。点击问题后 dispatch selection、fit view、打开 inspector section，并在元素 mount 后通过 stable field id 聚焦。pointer/target 指向已删除对象时显示“对象已变化，请重新校验”，不猜最近节点。

画布节点显示 error/warning 计数 badge；颜色不是唯一线索。边问题使用加粗/虚线与 accessible label。只展示绑定当前 revision 的 issue。

Validation summary 是 toolbar 中固定高度的 action，不再让详情 panel 成为 editor grid 的自增行。viewport `>720px` 且 block-size `>520px` 时，详情作为 workspace 内 anchored overlay，固定 `max-block-size`、own scroll，不参与 canvas layout；`<=720px` 或 block-size `<=520px` 时改用共享 top-level `modalSurface='validation'` full-screen/sheet。issue 数量从 1 增到 N 时 panel allocation 与 canvas bounding box 不变；compact validation modal 打开时不要求背后 canvas 可见，但关闭/summary-only 的 640×400 canvas 仍 >=240px。点击 issue 后若目标移出当前可视区，Validation surface 先 handoff 关闭并抑制 trigger restore，再完成 selection/fit/inspector mount 与字段 focus；普通 Cancel/Escape 回 toolbar summary。列表自身 scroll position 不应被 canvas fit 重置。

### 7.2 Inspector

- 标题：用户命名 / agent 名；raw kind 与 node id 移到 collapsed “技术详情”，保留复制 ID。
- `OutputEdit`/`ReviewEdit` 的 editable upstream/rerun node/port 裸输入改为从 definition 派生的可搜索对象/端口 Select。`EdgeInspector` 的 source/target node 改为业务名只读显示，raw id 收进技术信息；可编辑 target-port 使用同一 selector，但提交必须消费 B5 唯一 connection transition/`applyWorkflowTransition`，端点重连走 ConnectionDialog，B8 不新增直写旁路。wire 不变。
- Inspector 顶层只保留“编辑 / 提示词预览”；Preview 不再使用过宽的泛称。常用字段置顶，Review/Loop 等复杂表单在编辑 panel 内按 Basics / Flow / Advanced / Technical sections 渐进披露；高级端口、wrapper/runtime 配置不继续增加同级 Tab。
- 字段错误同时提供 inline message 与 Validation list 反向链接；全页只有一个受控 live announcement。
- 不把尚未保存的字段错误交给 server validate 才发现：可同步判断的 required/name/kind compatibility 就地显示，server 仍为最终 oracle。

## 8. 编辑器视觉与响应式

### 8.1 桌面视觉

- `WorkflowCanvas` 新增必填 `surface: 'editor' | 'task' | 'workgroup-preview'`，root 输出 `data-canvas-surface`；`readOnly` 继续控制行为，但不能被当作视觉 mode 推断。raw id 隐藏、普通节点 220–240px、明确列出的复杂 wrapper/review 节点最多 260px、config health 与 editor 状态 CSS 全部 scope 到 `surface='editor'`，并显式传给 node renderer。
- canvas 用中性 surface/grid；accent 只用于 selection、连接预览、primary action 与语义状态。
- 普通 node 基准宽 220–240px，只有多端口 wrapper/review 等列入 visual fixture 的复杂节点可到 260px；标题一行、摘要最多两行，显示 agent/业务名、类型 label、端口/配置状态，不在主卡展示 raw id。
- wrapper 保持现有虚线容器语言，fan-out/review/clarify 使用语义 badge，不制造每种 kind 一套高饱和背景。
- page header 保留 Validate 与唯一 primary Launch；canvas toolbar 只放 Add、Undo/Redo、Layout/Fit 与 validation summary，不复制第二个 page-primary。disabled 必须有可读原因。
- 保存状态紧邻名称；validation 是独立状态，不能混进 save chip。
- context menu 收敛为加速入口。继续保留时必须补 open focus、Arrow Up/Down、Home/End、Escape 与 focus restore；高频能力同时有 visible entry。

### 8.2 Layout modes

```text
>=1536       [palette 240] [canvas min 520] [inspector 360..420 when selected]
1180..1535   [canvas min 520] [inspector 360..420 when selected] + palette modal
721..1179    [canvas only] + palette / inspector side modal
<=720        [compact toolbar + stable canvas] + full-screen workflow-editor modal
```

- grid contract 固定：wide selection 用 `240px minmax(520px, 1fr) clamp(360px, 27vw, 420px)`；mid selection 用 `minmax(520px, 1fr) clamp(360px, 30vw, 420px)`；无 selection 时对应 inspector track 不存在，canvas 扩展。gap/padding 必须计入可用宽，不能靠挤破 520px track 过断点。
- 1536/1180 阈值来自实际可用宽度：当前 AppShell/content chrome 下，1280 若仍放 240+480 两 rail，canvas 只剩约 252px；1536 三栏仍可保住约 588px，1180 去 palette 后以 360px inspector 保住至少 520px canvas。editor breakpoint 不改变 RFC-198 shell 900 与全局 content 720。
- breakpoint 通过 CSS media query 决定呈现；JS 只用于当前挂载哪一种交互 surface，沿用 AppShell 的 `useSyncExternalStore(matchMedia)` 形状，避免 hidden duplicate 进入 tab order。
- sheet 使用共享 Dialog 的 `panelClassName` 皮肤，参考 Inbox/mobile nav；不创建私有 focus trap。
- 抽无 chrome 的 `WorkflowPaletteContent`、`NodeInspectorContent`、`EdgeInspectorContent`；rail 与 Dialog 复用 content，避免双标题/双关闭。persistent rail 完全由 viewport mode + selection 派生，不进入 modal state：wide 可同时有 palette rail 与 inspector rail，mid 可同时有 inspector rail 与 palette modal。
- 单一顶层 `modalSurface` 控制器取值 `none | palette | inspector | connection | starter | validation | actions | rename | acl | save-copy | confirm`。`<=1179` 的 palette/inspector 与 compact/short-height validation 都是互斥 workspace modal；`1180–1535` 的 palette 是 modal、inspector 仍可在 rail；`>=1536` 的 Add 直接 focus palette search，不另开 palette modal。任何 mode 同时最多一个 **top-level editor Dialog**；validation issue→inspector、actions→rename/ACL/delete-confirm、conflict→save-copy 都先 handoff，不把旧 Dialog 留在底下。
- 现有 ACL owner-transfer 合同是唯一已知需要 parent ACL Dialog 上再开确认层的业务路径，继续复用 shared Dialog stack：允许最多一层 `nestedDialogSurface = none | acl-owner-transfer`。nested 打开时 parent panel inert/不可聚焦但保留 DOM；Escape/Cancel 只关 topmost 并把焦点还给 parent 内触发按钮，再次 Escape 才关闭 ACL 回页面稳定 trigger。不得把 NodePicker/Connection/Starter/普通 confirm 任意叠成第二层；新增 nested case 必须回 RFC/公共 Dialog 合同评审。
- transactional surface 从 palette/inspector 发起时直接做状态 handoff：关闭 outgoing 时抑制其 trigger restore，再打开 incoming 并设置 initial focus；Cancel 可回 origin surface/field，成功按结果去目标 inspector/canvas；最终关闭才回稳定 Add/node trigger。palette→inspector、More→Rename、More→ACL、More→Delete confirm、conflict→save-copy 等切换不得出现瞬时双 top-level Dialog，也不得被 outgoing restore 抢焦点。Rename/ACL Cancel 回 More trigger，成功回页面名称/ACL 状态；Delete Cancel 回 More trigger，成功后按既有列表导航。Escape 每次只关闭当前 topmost surface。
- side modal 固定 `inline-size: min(88vw, 420px)`；phone 为 `100vw × 100dvh` 并计 safe-area。palette 初始焦点落共享 `TextInput type="search"`（补 accessible label）；inspector 初始焦点落 active tab/首字段。
- `<=720px` supersede RFC-198 workflow editor 的 palette/canvas/inspector vertical stack。canvas 高度使用 viewport/safe-area 计算并有合理最小值，不因浏览器 chrome 抖动无限重排。
- inspector/picker 打开时桌面 selection 保留；关闭 sheet 后焦点回对应 canvas node/toolbar trigger。
- 200% zoom 触发 compact layout 后，若当前 focus 所在 rail 被卸载，焦点交给等价 sheet trigger，不落 body。
- port 视觉点可保持紧凑，但 pointer hit area 尽量达到 24×24；移动端核心连接通过 Dialog 完成，满足非精密替代。
- browser geometry 直接断言 bounding box：1536/1535、1180/1179、1280×521/520、901/900、721/720 成对；wide/mid inspector open 时 canvas `>=520px`，390×844 canvas visible block `>=560px`，640×400 landscape `>=240px`，side modal `<=420px` 且 phone modal 等于 visual viewport。1280×521/520 独立锁 block-size threshold：521 为 anchored overlay，520 为 validation modal，不能只靠 640×400 同时命中宽/高 compact。不得只断言 class 或 body 无 overflow。
- 同一几何门增加 1/N validation issue fixture：normal-height overlay 与 compact/short-height modal 都独立滚动、最后一项可达；1→N 不改变 canvas 尺寸。640×400 在 validation modal 关闭/summary-only 时量 canvas >=240px，modal 打开时改量 full-screen surface、最后 issue 与焦点交接，不要求背后 canvas 可见。

状态视觉按六个正交轴映射，不能用一个 border 同时表达全部含义：

- save：saved / dirty / saving / reconciling / error / conflict / inaccessible / deleted；
- transport：online / degraded / offline；offline Notice 明示“改动保留在本地，恢复后先核对”，不能伪装成 definitive save failure；
- validation：unknown / valid / warnings / errors / stale；
- config health：ready / incomplete / warning；
- selection/focus：纯交互状态，border/ring 优先级 `focus-visible > selected > config health > kind accent`；validation 永远使用独立文字/图标/计数 badge，不抢 selection/focus border；
- runtime：只属于 task/read-only canvas，继续复用现有 `NODE_RUN_STATUS_KIND`，editor 不另造运行态。

组合 oracle 至少覆盖 editor `focused + selected + validation-error`、`selected + incomplete`，以及 task `runtime + kind`；后者证明 editor CSS 没有越过 surface scope。

### 8.3 动作菜单

更多动作拍板为共享 Dialog action list，不在本 RFC 临时扩一个通用 Menu：Page actions 包含 Export、Rename、ACL、Delete，node actions 复用同一 action-list 形状；Rename/ACL/Delete 分别 handoff 到顶层 rename/acl/confirm surface，ACL 内 owner-transfer 可使用上一节唯一受控 nested layer。右键 ContextMenu 只保留专家鼠标捷径，Shift+F10/ContextMenu key 打开可键盘的 action Dialog；现有 popover 若继续保留则补首项 focus、Arrow/Home/End、Escape 与 focus restore。Launch 是页面唯一主按钮。

## 9. 组件与文件形状

建议新增：

```text
packages/frontend/src/lib/workflowEditorDraft.ts
packages/frontend/src/lib/workflowConnectionPlan.ts
packages/frontend/src/lib/workflowLayout.ts
packages/frontend/src/lib/workflowIssueTarget.ts
packages/frontend/src/lib/workflowStarters.ts
packages/frontend/src/components/editor/WorkflowNodePicker.tsx
packages/frontend/src/components/editor/ConnectionDialog.tsx
packages/frontend/src/components/editor/WorkflowStarterDialog.tsx
packages/frontend/src/components/editor/WorkflowEditorToolbar.tsx
packages/frontend/src/components/editor/WorkflowSaveNotice.tsx
packages/frontend/src/components/editor/WorkflowEditorPanelDialog.tsx
```

准确目录以当前 editor 组件所在位置为准，不为满足本表迁移整棵目录。`workflows.edit.tsx` 保持 orchestration route，复杂 reducer/effect 不留在 route 内。

backend/shared 改动集中：

```text
packages/shared/src/schemas/workflow.ts
packages/shared/src/schemas/ws.ts
packages/backend/src/routes/workflows.ts
packages/backend/src/services/workflow.ts
```

另更新 broadcaster/import overwrite 调用点、export version guard、launch redirect/tasks.new search。无 DB migration、无新生产依赖。

## 10. Error 与可观测性合同

稳定错误码：

| code                        | HTTP             | 场景                            | UI                               |
| --------------------------- | ---------------- | ------------------------------- | -------------------------------- |
| `workflow-version-conflict` | 409              | PUT expectedVersion 失配        | 持久冲突 Notice + 三个恢复动作   |
| `workflow-validation-stale` | 409              | validate version/hash 失配      | 保留草稿，提示重新保存/校验      |
| `workflow-version-mismatch` | 409              | export/start exact version 失配 | 保留草稿或启动参数，提示重新确认 |
| 现有 validation codes       | 200 result       | definition 语义问题             | 可定位问题列表，不作为网络错误   |
| 现有 ACL/not-found          | 403/404 contract | 权限变化/删除（不可区分）       | inaccessible Notice；保留本地稿  |

开发态 structured log 对 PUT 记录 workflow id、expected/current/result version、actor id、request id；不记录完整 definition/prompt。frontend 测试可观察 reducer state，不引入 production analytics SDK。

## 11. 测试设计

### 11.1 Backend / shared

- 两个 vN 并发 PUT：恰一成功到 vN+1，另一 409；不得两个 success 或复用版本。
- 成功回执内容等于本请求 snapshot，不会读到后续 writer 内容。
- no-op 与“stale expectedVersion + 相同 hash”返回 already-current，不 bump、不 broadcast；changed commit frame 的 mutationId/version/hash 与 receipt 一致。
- name/schema/reference preflight 在 transaction 外；失败保证零 partial write/version bump，但不宣称锁住外部资源。transaction 内只重做 current row owner/admin、builtin/name-change 与 CAS。
- missing expectedVersion/clientMutationId/full snapshot 422；builtin/ACL/not-found 同形不回退。
- canonical ULID 正反例、domain-separated canonical bytes/hash、logical no-op 与 physical heal-on-edit；owner transfer 后旧 owner 即使持有旧 version 也不能写。
- YAML structured request、preview/apply version guard、collision revision 与 transport retry mutation id；create 不受影响。
- validate/export exact revision success + mismatch；两者 guard 后 writer 插入仍只消费一次 captured workflow row。validation response 包含 WorkflowRevision/context hash；资源 inventory 在旧绿色结果后变化时 Launch 必须 fresh validate，不能复用。
- validation context projection source/AST coverage 锁 validator-read fields，特别是 dependsOn/skills/mcp/plugins/outputWrapperPortNames；secret/prompt 不入 hash。
- export guard/stringify 只消费一次捕获 row；writer 插在两者之间仍只会导出请求版本或 409。
- content writer source/AST ratchet 与 metadata-only allowlist，禁止 editable columns/version 从旁路更新；delete ratchet 禁止无 principal/expectedVersion 的 service/direct DB 旁路。
- existing StartTask expectedWorkflowVersion 路径加 editor deep-link fresh launch case。

### 11.2 Pure frontend

- edit during save、连续三次 edit、queued save、failure/retry、stale success 不清 dirty；请求前断网、response 丢失后 GET 也断网均保留 attempt/local/queued；online/WS-open 恢复后 same hash 成功、same version 重发、advanced different hash 冲突。
- own WS before HTTP、HTTP before WS、clean remote follow、dirty remote conflict、conflict 中再更新；断线漏远端 commit 后 reconnect/visible reconciliation 分别锁 clean adopt 与 dirty conflict；response-loss → offline → foreign commit → WS-open/GET 必须从 reconciling 进入 conflict；owner transfer 后旧 tab 进入 inaccessible 并保留 local/export/copy。
- ensureSaved flush、typing supersede、error/conflict/deleted、精确 receipt；remote delete 保留 local。
- history transaction/coalescing/redo invalidation/remote reset/50-entry cap/immutable input。
- connection plan drag/new/reuse/wrapper/incompatible；review shared fixed input/markdownish policy；semantic context refresh；fan-out boundary input/output 的 side/role/kind；generic cycle advisory、合法 loop/clarify cycle 可建，drag adapter golden 等价。
- edge insert pure golden：`A → B(existing target port)` 变为 `A → N → B`，原 edge 消失，B port 与所有 mirror 恰好同步一次，整个变更一个 history transaction 且 Undo 精确还原；boundary/clarify/control/inner/cross-wrapper/fanout inner-chain fail closed，Cancel 零 mutation。
- placement 连续添加不重叠、viewport center 被占与 wrapper 假包含规避。
- clipboard wrapper nodeIds 重写/boundary 保留、跨 workflow upload input declaration/key/edge 守恒；node delete recursive closure 与 surviving wrapper/review/output/loop ref prune。
- starter candidate/role/port/aggregator fail-closed、validate-draft stale cancellation 与 backend validator golden oracle。
- layout determinism、data+control dependency、LCA direct-child projection、cycle、nested wrapper、boundary、measured size、sizeLocked warning、selection bbox/avoidance、Undo round-trip。
- issue pointer node/edge/field/global/stale target。

### 11.3 Rendered components

- empty state、toolbar、palette 与空/非空 wrapper 内部 Add 都打开同一 picker；top-level/wrapper membership 明确，Cancel 零 change，submit 一个 transaction。
- Connection Dialog 全键盘路径、disabled reason、focus restore、NEW/REUSE preview。
- ordinary-data edge 中点 Add 的 rendered oracle：仅合法 top-level edge 显示可聚焦入口；选择/Cancel/focus restore 正确，禁止类型不显示或 fail closed。
- Undo/Redo disabled/label/shortcut；输入框内不劫持 browser undo。
- validation stale/current、点击定位/打开 inspector/聚焦字段。
- context menu 或 action Dialog 的 menu/focus contract。
- conflict 三动作各自确认与本地草稿保留；deleted 另存/导出。
- inaccessible Notice 的本地导出/重试/返回列表/有权限另存路径，且视觉不冒充 deleted。
- offline/degraded Notice 与 save phase 正交；手动 retry、online 恢复、backoff timer 的 focus/live 文案不抖动。
- responsive mode 单实例 panel、互斥、resize selection/draft/focus 守恒；palette 搜索使用共享 TextInput。

### 11.4 Playwright / visual / a11y

- 零 drag 主旅程：空白 → 两节点 → 显式连接 → 修错 → validate → launch。
- 零 drag wrapper 旅程：添加空 git/loop/fanout wrapper → 内部 Add → stored absolute / xyflow relative / nested wrapper projection、membership 与 Undo 正确，不靠 drop hit-test。
- 专家回归：真实 drag connect 显示并执行 NEW 与 REUSE。
- edge insert 旅程：`A → B(existing target port)` 插入 N 后锁 `A → N → B`、原 edge 消失、B target 与 mirrors 单次同步、一个 Undo 还原；boundary/clarify/control/inner/cross-wrapper/fanout inner-chain 不显示入口或 fail closed，Cancel 零 mutation。
- 双 page/context 并发编辑冲突，另存副本/加载远端/覆盖远端各一 oracle。
- 人为延迟 PUT，保存中继续编辑后 reload，最终内容必须是最新 revision。
- editor→wizard 后远端升版，JSON/multipart submit 都 409 且零 task/物化；schedule 仍使用既有 latest-at-fire 语义。
- 1536/1535、1280、1180/1179、901/900、721/720、390×844、640×400；直接断言 canvas/panel bounding box，覆盖 light/dark、200% zoom、reduced-motion。
- axe 明确场景：1536 与 1280 inspector rail open、1179 palette side modal、390 full-screen NodePicker/Inspector/Connection Dialog，至少一组 light/dark；另跑 More→Rename/ACL/Delete 与 ACL→owner-transfer。单层时断言 document 唯一 top-level Dialog；nested 时按 topmost panel scope 断言唯一 accessible name/heading/close、parent inert/无可聚焦命中、initial/return focus，不能把合法 parent DOM 误判为重复。
- ReactFlow renderer 继续由 rendered component + keyboard gate 覆盖 node/port/action，不把 axe exclusion 当合规证明；另锁 task-detail 与 dynamic-workflow preview 的 DOM/视觉零回归。
- deterministic workflow visual fixture 锁 1536 三栏、1280 inspector light/dark、1179 side modal、390 empty+picker/full-screen inspector，以及 toolbar、node、selection、issue；不扩大全局 threshold。

## 12. 设计门与 supersede 声明

- RFC-199 窄幅 supersede RFC-198 的“本轮不重做 workflow canvas”限制、editor desktop 固定 rail 与 `<=720px` 三块纵向堆叠；RFC-198 全局 shell/token/primitive 与其他 specialized workspace 全部保持。
- task-detail read-only canvas 与 workgroup dynamic preview 共享现有 node DOM/CSS，因此 editor 视觉必须通过显式 `surface` scope；两类 consumer 的 runtime badges、raw metadata、question/review/clarify 提示与 geometry 不得随 RFC-199 改变。
- RFC-198 最终实现基线为 `e48ba3e7` 且 Done 状态已收口；RFC-199 不改写其历史归属，每批仍核对 foundation live source 与工作树归属。
- RFC-199 补完根 `design/proposal.md` 已承诺但当前未实现的 autosave/undo/auto-layout 体验，并以本 RFC 的版本与响应式合同为最新权威。
- 设计批准后仍按 `plan.md` 分批；P0 保存门未绿，不得并行落 Node Picker/Starter 等 production UI。
- 任何需要改变 runtime、definition schemaVersion 或自动合图的新发现必须停下回 RFC，不在实现中顺手扩 scope。
