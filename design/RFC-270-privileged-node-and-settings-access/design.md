# RFC-270 · 技术设计

> 产品视角见 [`proposal.md`](./proposal.md)，任务分解见 [`plan.md`](./plan.md)。

## 0. 设计要旨

一句话：**把「谁能写」的既有边界，原样复制成「谁能看」，并让前台在越过边界之前就把路挡住。**

三条不可动摇的约束：

1. **不改后端 author gate 的判据**。`scriptAuthorGate.ts` / `codeHostAuthorGate.ts` 的敏感投影、字节比较、错误码全部原样。本 RFC 只在门**之前**插一步「按镜头回填」，让无权限用户的**合法编辑**不再产生越门尝试；**非法编辑仍然撞门**。
2. **脱敏必须保持定义结构合法**。所有枚举字段（`language` / `network` / `provider` / `request.method` / `readonly` / `allowDestructive` / `timeoutMs`）**一律不脱敏**——脱成 `'***'` 会让 `ScriptNodeSchema` / `CodeHostCallNodeSchema` 严格解析失败（`packages/shared/src/schemas/workflow.ts:873-949`），而后端校验器在 `workflow.validator.ts:1180` / `:1362` 正是拿这两个 schema 做严格再解析的。
3. **脱敏与回填共用同一份字段清单**。两者必须是同一个模块里的一对，否则「脱了没回填」= 静默丢数据，「回填了没脱」= 白脱。

## 1. 权限镜头（shared）

新文件 `packages/shared/src/privilegedNodeRedaction.ts`。

```ts
/** 每类特权节点是否需要对当前观察者遮蔽。true = 遮。 */
export interface PrivilegedNodeLens {
  scripts: boolean
  codeHost: boolean
}

/** 有全部权限（或平台自身搬运字节）时的镜头：什么都不遮、什么都不回填。 */
export const PRIVILEGED_LENS_TRANSPARENT: PrivilegedNodeLens = { scripts: false, codeHost: false }

export function lensIsTransparent(lens: PrivilegedNodeLens): boolean
```

### 1.1 字段清单（单一事实源）

```ts
/** 脚本节点里 `scripts:author` 治理的**内容**字段。
 *  刻意不含 language / network / readonly / outputs：它们是枚举与图结构，
 *  遮了会让 ScriptNodeSchema 解析失败、画布卡片与连线拓扑一起坏掉。 */
export const SCRIPT_REDACTED_FIELDS = ['script', 'env', 'dependencies'] as const

/** 代码平台调用节点里 `code-host-calls:author` 治理的**内容**字段。
 *  `request.method` 是枚举、`provider` / `action` 是注册表键、`allowDestructive`
 *  / `timeoutMs` 是判据输入，一律保留。 */
export const CODE_HOST_REDACTED_FIELDS = ['params', 'request'] as const
```

### 1.2 脱敏

```ts
export function redactPrivilegedNodes<T>(definition: T, lens: PrivilegedNodeLens, marker: string): T
```

- 镜头全透明 ⇒ **返回同一个引用**（与 `maskWorkflowScriptEnv` 的短路语义一致，`intentSecretSlots.ts:159-182`）。
- `script`：非空字符串 → `marker`；空字符串**保持空**（空正文本身是 `script-body-empty` 校验错误，遮蔽不得制造也不得掩盖它）。
- `env`：`Object.fromEntries(Object.keys(env).map(k => [k, marker]))`。**必须**用 `fromEntries` 而不是逐键赋值——`env` 名字文法允许 `__proto__`，直接赋值会命中原型 setter 让键消失（`intentSecretSlots.ts:172-177` 已踩过这个坑）。
- `dependencies`：`deps.map(() => marker)`。**保留长度**，因为画布卡片只显示依赖**个数**（`nodes/ScriptNode.tsx:32-71` 经 `WorkflowCanvas.tsx:3496` 的 `dependencyCount`）。
- `params`：值 → `marker`，键存活（`code-host-param-missing` 判的是 `.trim().length === 0`，`marker` 非空所以不会假报）。
- `request`：`path` → `marker`；`body` 非空 → `marker`（空 body 合法，保持空）；`query` 值 → `marker`；**`method` 原样**。

**不加标记字段**：不往节点上写 `redacted: true`。理由——`WorkflowNodeSchema` 虽是 `.passthrough()`，但一个新字段会进 `serializeWorkflowEditableSnapshotV1` 的字节、进 YAML 导出、进任务快照，等于新开一条要长期维护的契约面；前台判权限直接用 `usePermission`，单一事实源，不需要服务端再告诉它一遍。

### 1.3 回填

```ts
export function rehydratePrivilegedNodes(
  next: WorkflowDefinition,
  previous: WorkflowDefinition,
  lens: PrivilegedNodeLens,
): WorkflowDefinition
```

对 `next` 里每个 kind 为 `script` / `code-host-call` 且**在 `previous` 里存在同 id 同 kind** 的节点，把 §1.1 清单里的字段**整体**换成 `previous` 的值（字段在 `previous` 里缺席就在 `next` 里删掉）。

**关键语义（AC-8）：回填由镜头决定，不由值决定。** 绝不检查「客户端发来的是不是 `***`」——那会让有权限的作者「把脚本正文改成 `***`」这个合法编辑被静默吞掉。镜头为遮 ⇒ 该字段客户端本来就看不见，它发什么都无意义，一律以库为准；镜头透明 ⇒ 一个字节都不碰。

在 `previous` 里**不存在**的节点不回填 —— 新增特权节点仍然原样撞门。`previous` 里有而 `next` 里没有（删除）也不做任何事 —— 删除仍然原样撞门。

## 2. 后端

### 2.1 镜头构造

新文件 `packages/backend/src/services/privilegedNodeLens.ts`：

```ts
export function privilegedNodeLensFor(actor: Actor): PrivilegedNodeLens {
  return {
    scripts: !actor.permissions.has('scripts:author'),
    codeHost: !actor.permissions.has('code-host-calls:author'),
  }
}
```

与 `scriptAuthorGate.ts:46` / `codeHostAuthorGate.ts:33` 读的是**同一个 `permissions` 集合**，所以「能写的一定能看」这条不变式由构造保证，不需要额外断言。

### 2.2 读出口

`tokenRedaction.ts` 现在只按 `ActorSource` 分流（`:41`）。本 RFC 引入第二根轴，做法是把三个 serializer 的第二参从 `ActorSource` 换成一个显式镜头值对象：

```ts
export interface WorkflowReadLens {
  source: ActorSource            // 既有 PAT 轴，原样
  privileged: PrivilegedNodeLens // RFC-270 新增权限轴
}
export function workflowReadLensFor(actor: Actor): WorkflowReadLens
```

`serializeWorkflowFor` / `serializeWorkflowReceiptFor` / `serializeTaskFor` 改签名收 `WorkflowReadLens`。**这是故意的编译期爆破**——与该文件 `:104-112` 已经写过的理由同款：让「我忘了这个出口也返回定义」变成编译错误，而不是一处漏网。

两轴**先后叠加**（都写 `'***'`，幂等）：先 PAT 的 `maskWorkflowScriptEnv`，再 `redactPrivilegedNodes`。

受影响出口（全部已在既有 serializer 后面，无需新找）：

| 文件 | 行 | 出口 |
|---|---|---|
| `routes/workflows.ts` | `:98` | `GET /api/workflows` 列表 |
| | `:114` | `GET /api/workflows/:id` |
| | `:141` | `POST /api/workflows` |
| | `:166` | `POST /api/workflows/:id/copy` |
| | `:196` | `PUT /api/workflows/:id` 回执 |
| | `:397` | `GET /api/workflows/:id/export`（YAML） |
| | `:438` / `:439` | `POST /api/workflows/import` 两个分支 |
| `routes/tasks.ts` | `:283 :305 :387 :447 :840 :926 :1052` | 七处 `serializeTaskFor`（`tasks.workflowSnapshot`） |

**`/ws/workflows` 不需要改**：`WorkflowsWsMessageSchema`（`packages/shared/src/schemas/ws.ts:261-287`）只带 id / name / version / snapshotHash / updatedAt，**不带定义**。这一点必须写进测试（源码层断言），否则将来有人往帧里加 `definition` 就会绕过整条镜头。

### 2.3 写路径回填

`prepareWorkflowSave`（`services/workflow.ts:341`）在两个 gate（`:383` / `:395`）**之前**插入：

```ts
const lens = principal.kind === 'actor'
  ? privilegedNodeLensFor(principal.actor)
  : PRIVILEGED_LENS_TRANSPARENT      // verbatim-copy / system 搬的是库里的字节，不遮不填
const definitionForSave = rehydratePrivilegedNodes(
  normalizedSnapshot.definition,
  preflightWorkflow.definition,
  lens,
)
```

之后**所有**下游（两个 gate 的 `next`、实际落库的定义、版本比较与 `snapshotHash` 计算）一律用 `definitionForSave`，不得再引用 `normalizedSnapshot.definition`。这一条用一个源码层断言锁住（同 §7 T-A6）。

`insertWorkflowInTx`（`:784`）**不加回填**：创建路径没有 `previous`，无从回填，且新增特权节点本来就该撞门。

### 2.4 `snapshotHash` 的已知不对称（显式承认，不修）

后端 `workflowSnapshotHashOf`（`workflow.ts:902-907`）与前端 `hashWorkflowDraftSnapshot`（`lib/workflow-editor-draft.ts:214-220`）是**同一个算法**（`sha256(serializeWorkflowEditableSnapshotV1(...))`）。脱敏后，被遮用户本地算出的 hash 与服务端返回的 hash 不再相等。

影响面已逐处核过，只有**一处**：

- `lib/workflow-editor-draft.ts:715-720` 的快路径 `observation.revision.snapshotHash === attempt.snapshotHash` —— 用于「refetch 抢在 PUT 回执之前到达」时提前结算。被遮用户这条快路径不再命中，落回常规路径。
- **CAS 不受影响**：客户端回传的 `expectedSnapshotHash` 取自 `state.serverRevision.snapshotHash`，那是**服务端给的值**（`workflowRemoteSnapshotFromDetail` → `detail.snapshotHash`），与 `workflow.ts:265` 的比较两端同源。
- **脏检测不受影响**：`snapshotsEqual`（`lib/workflow-editor-history.ts:315-318`）比的是本地 local 与本地 server 两份**都被遮过**的快照。
- `:728` / `:928` / `:1040` / `useWorkflowEditorDraft.ts:887` 全是 server-vs-server 比较。

结论：仅在「PUT 回执丢失 + refetch 先到」这一罕见时序下，被遮用户可能多走一次常规冲突判定。写进 `docs/audit-backlog.md`，不在本 RFC 修——修它要把 hash 也过镜头，那会让同一 revision 对不同观察者有不同 hash，进而污染 WS 帧与 CAS 语义，代价远大于收益。

## 3. 前端 · 权限钩子

新文件 `packages/frontend/src/hooks/usePrivilegedNodes.ts`：

```ts
export interface PrivilegedNodeAccess {
  canAuthorScripts: boolean
  canAuthorCodeHost: boolean
  /** 该 NodeKind 对当前用户是否为「特权且无权」。 */
  isProtectedKind: (kind: NodeKind) => boolean
  /** 定义里全部受保护节点 id。画布用它做 draggable / deletable / 连线判定。 */
  protectedNodeIds: (definition: WorkflowDefinition) => Set<string>
  /** palette 条目的置灰理由，null = 可用。 */
  paletteDisabledReason: (item: PaletteItem) => string | null
}
```

内部就是两次 `usePermission`（`hooks/useActor.ts:60-64`，加载中 / 失败一律 `false` = 失败关闭）。**纯判定逻辑抽成同文件的纯函数**（`privilegedNodeAccessOf({canAuthorScripts, canAuthorCodeHost}, t)`），这样测试不用挂 QueryClient 就能覆盖全部分支。

## 4. 前端 · 五处收口

### 4.1 palette 置灰（AC-9 / AC-10）

`WorkflowNodePicker.tsx` **已经有** `disabledReason?: (item: PaletteItem) => string | null`（`:54`），并且已经接进了 `choose`（`:247`）与 `aria-disabled`（`:345-357`）。今天**没有任何调用方传它**。要做的是：

1. `EditorPaletteContent` / `EditorSidebar`（`canvas/EditorSidebar.tsx`）加一个 `disabledReason` 透传形参；
2. 两个挂载点 `WorkflowCanvas.tsx:3109` 与 `routes/workflows.edit.tsx:1062` 传 `paletteDisabledReason`；
3. **补上拖拽分支**——`WorkflowNodePicker.tsx:280` 的 `onDragStart` 与 `:389-390` 的 `draggable` 目前是无条件的，`aria-disabled` 挡了点击但没挡拖。改为 `draggable={reason === null}` 且 `onDragStart` 在 `reason !== null` 时 `event.preventDefault()`。**这条必须有独立测试**：只测点击不测拖拽，等于漏掉真正的创建路径。
4. 置灰理由文案带上所需权限点名字（`editor.nodePicker.requiresPermission`，中英双语）。

`packages/frontend/tests/palette.test.ts:168-169` 现在把「两个分区无条件存在」锁成期望——**分区仍然存在**（用户选了「显示但置灰」），该断言不变；新增的是条目级 disabled 断言。

### 4.2 Inspector 占位（AC-11）

`inspector/ScriptEdit.tsx` 与 `inspector/CodeHostCallEdit.tsx`：`!canAuthor` 时**提前返回**

```tsx
<div className="inspector-sections">
  <EmptyState
    title={t('scriptInspector.noViewPermission.title')}
    description={t('scriptInspector.noViewPermission.body')}
    size="compact"
    data-testid="script-inspector-no-view-permission"
  />
</div>
```

即**不再渲染任何**表单控件（现状是全套控件 `disabled` 渲染，`ScriptEdit.tsx:131-330` / `CodeHostCallEdit.tsx:245-475`）。原来的只读横幅文案 `scriptInspector.noAuthorPermission` / `codeHostInspector.readonlyBanner` 随之退役。

RFC-253 AC-30 与 `ScriptEdit.tsx:11-15` 的注释是这次改判的**直接对象**，两处都要改写并注明「RFC-270 按用户判定改判」，否则下一个接手的人会以为这是回归。

**Preview 页签无需处理**：`NodeInspector.tsx:159` 的 `hasPreview = node.kind === 'agent-single'`，这两类节点根本没有 Preview 页签。用一条测试把这个前提钉住。

### 4.3 「管理连接 ↗」（AC-12）

`inspector/CodeHostCallEdit.tsx:262-273` 的 `<a href="/settings?tab=codeHosts">` 包一层 `usePermission('settings:read')`。因为 §4.2 已经让无 `code-host-calls:author` 者看不到整个面板，这一条实际针对的是「有 `code-host-calls:author` 但无 `settings:read`」的 **manager**（`MANAGER_DENIED_PERMISSIONS` 显式拒了 `settings:read`，`permission.ts:445-454`）——正是今天点了就吃 403 的那批人。

### 4.4 `/settings` 路由守卫（AC-13）

用户选定 **`beforeLoad` 重定向**。仓内今天**没有**任何基于角色的 `beforeLoad`（只有 `__root.tsx:31,44` 的 token 守卫与两处 legacy URL 重定向），所以这是新开一种模式，要做对三件事：

1. **router 需要 `queryClient`**。`lib/query-client.ts` 现在只导出工厂 `createQueryClient()`，`main.tsx:11` 调它。改为在 `lib/query-client.ts` 里再导出一个应用级单例 `appQueryClient`，`main.tsx` 与 `router.tsx` 共用；`createRouter` 加 `context: { queryClient: appQueryClient }`。
2. **`/api/auth/me` 的 query options 抽成共享常量**，让 `useActor`（`hooks/useActor.ts:32-58`）与守卫用**同一个 queryKey 与 staleTime**，否则守卫会打一次独立请求、并且和组件里的缓存对不上。
3. **守卫失败要放行而不是误伤**：

```ts
beforeLoad: async ({ context }) => {
  let me: MeResponse
  try {
    me = await context.queryClient.ensureQueryData(meQueryOptions(getToken()))
  } catch {
    return   // /me 本身挂了（断网 / daemon 重启）不能把 admin 弹走；
             // 后端所有 settings 路由仍是 settings:read 强制，安全边界不依赖这里
  }
  if (!me.permissions.includes('settings:read')) throw redirect({ to: '/', replace: true })
}
```

`replace: true` 让浏览器后退键不会在配置页和首页之间弹跳。

### 4.5 画布上的特权节点（AC-14 / AC-15）

`WorkflowCanvas.tsx`：

1. `toFlowNodes`（`:3368`）给受保护节点加 `draggable: false` + `deletable: false`；
2. `toFlowEdges`（`:3609`）给「端点之一是受保护节点」的边加 `deletable: false`；`isValidConnection` 拒绝触及受保护节点的新连线；
3. **wrapper 归属守卫** —— `onNodeDragStop`（`:2712-2790`）在 `applyMembershipPatch`（`:2760`）之后、`commitChange`（`:2789`）之前，用一个 shared 纯函数复核：

```ts
// packages/shared/src/workflowNodeAncestry.ts 追加
export function ancestryUnchanged(
  previous: WorkflowDefinition,
  next: WorkflowDefinition,
  nodeIds: Iterable<string>,
): boolean
```

任一受保护节点的 `wrapperAncestryOf` 变了 ⇒ **丢弃归属补丁，只提交位置变化**。这修的是 §1.2 里那条最刺眼的自相矛盾：受保护节点自己已经拖不动了，但拖动**包着它的 wrapper** 仍可能改变它的传递归属。

补丁被丢弃时用既有的画布提示告诉用户原因（不静默）。

### 4.6 403 不再等于「工作流没了」（AC-16）

三步，缺一不可：

1. `WorkflowDraftFailure`（`lib/workflow-editor-draft.ts:73-77`）加 `code?: string`；
2. `failureFromError`（`hooks/useWorkflowEditorDraft.ts:1017-1031`）把 `ApiError.code` 填进去（今天整个丢弃）；
3. `saveFailed`（`:590-601`）与 `reconcileFailed`（`:668`）的 `403 || 404 → terminalState('inaccessible')` 前面加一条前置分支：

```ts
const AUTHOR_FORBIDDEN_CODES = new Set(['script-author-forbidden', 'code-host-author-forbidden'])
if (status === 403 && event.failure.code !== undefined && AUTHOR_FORBIDDEN_CODES.has(event.failure.code)) {
  return authorForbidden(state, event.failure)   // → phase 'error'，不是终态
}
```

落到既有的 `error` 相位（`:645-653`，`commands: cancelTimerCommand` —— **不自动重试**，不会打 403 循环），本地草稿保留，后续任一编辑按 `applyLocalRevision` 的 `mayResumeAutosave`（`lib/workflow-editor-draft.ts:408-410`）恢复自动保存。

`WorkflowDraftStatus.tsx:152-166` 的 error 横幅按 `error.code` 分流出专属文案：标题「此改动需要额外权限」，正文说明缺哪个权限点、草稿仍在、撤销该步即可继续。**不复用** `inaccessible` 的四个出口（重试访问 / 另存为副本都必然再失败）。

`routes/workflows.edit.tsx:1400-1402` 的 `isWorkflowAccessLoss` 是 **GET** 侧判定，GET 的 403 确实是真访问丢失，**不改**。

## 5. 数据与迁移

**零迁移、零 schema 变更、不 bump `$schema_version`**。不新增数据库列、不新增权限点、不改任何 zod schema。跟随 RFC-243 / RFC-253 / RFC-269 的近例。

## 6. 失败模式与取舍

| 失败模式 | 处置 |
|---|---|
| `/api/auth/me` 加载中或失败 | `usePermission` 返回 `false` ⇒ **失败关闭**：palette 置灰、Inspector 占位。路由守卫相反——**失败放行**（§4.4），因为守卫只是 UX，真边界在后端。两者方向不同是刻意的，注释写明。 |
| 无权限用户导出 YAML 再导入 | 拿到 `***` 的 YAML；自己导入必 403（`insertWorkflowInTx` 无 `previous`）。admin 导入会造出 `***` 正文的坏脚本——与 PAT 通道既有风险同形，落 `docs/dev-gotchas.md`，不在本 RFC 修。 |
| 无权限用户删除特权节点 | 前台 `deletable:false` 挡住；绕过前台则后端 403 + §4.6 的准确文案。**刻意不放行**：删除会改变工作流的执行语义。 |
| 有权限的作者把脚本正文真的写成 `***` | 镜头透明 ⇒ 不回填 ⇒ 原样落库（AC-8）。 |
| 并发：A（有权限）改脚本，B（无权限）同时改布局 | B 的保存回填后投影与库一致 ⇒ 不撞门；版本 CAS 仍照常检测并发冲突，走既有 409 冲突流程。 |
| 未来有人往 `/ws/workflows` 帧里加 `definition` | §7 的源码层断言会红。 |

## 7. 测试策略

**每条禁用 / 拒绝分支都必须有测试**（CLAUDE.md 规则 7）。下表即验收清单。

### shared

- `privileged-node-redaction.test.ts`
  - 透明镜头返回同一引用；
  - 脚本：`script` / `env` 值 / `dependencies` 被遮，长度与键保留；空正文保持空；`__proto__` 键存活；
  - 脚本：`language` / `network` / `readonly` / `outputs` **未被遮**；
  - 代码平台：`params` 值 / `request.path` / `request.body` / `request.query` 值被遮；`method` / `provider` / `action` / `allowDestructive` / `timeoutMs` **未被遮**；
  - **脱敏后的定义仍能通过 `ScriptNodeSchema` / `CodeHostCallNodeSchema` 严格解析**（AC-3，锁住「不遮枚举」这条约束）；
  - 回填：镜头为遮 ⇒ 客户端任意值都被库值覆盖；镜头透明 ⇒ 一个字节不碰（含「作者真把正文写成 `***`」这条，AC-8）；`previous` 里没有的节点不回填；
  - **不变式测试**：`rehydratePrivilegedNodes(redactPrivilegedNodes(d, lens), d, lens)` 的敏感投影 === `d` 的敏感投影（把 §1.1 的「脱敏/回填成对」钉死）。
- `workflowNodeAncestry.test.ts` 追加 `ancestryUnchanged` 的正反例。

### backend

- `rfc270-privileged-node-read-lens.test.ts`
  - AC-1 / AC-2：无权限会话用户 `GET /api/workflows/:id` 拿到 `***`；admin 拿到明文；
  - AC-4：列表 / create / copy / PUT 回执 / import 两分支 / YAML 导出 / `serializeTaskFor` 逐个出口；
  - AC-5：PAT + 无权限双轴叠加，`env` 仍是 `***`，既有 RFC-247 / RFC-253 T28 断言不回退；
  - **源码层断言**：`WorkflowsWsMessageSchema` 不含 `definition`（§2.2）。
- `rfc270-privileged-node-rehydrate.test.ts`
  - AC-6：无权限用户 PUT 脱敏定义 + 改别的节点 → 200，库里脚本字节不变；
  - AC-7：新增 / 删除特权节点、改入边、改 wrapper 归属 → 403，错误码不变；
  - `verbatim-copy` / `system` principal 走透明镜头（copy 路径不被回填干扰）；
  - **源码层断言**：`prepareWorkflowSave` 在回填之后不再引用 `normalizedSnapshot.definition`（§2.3）。

### frontend

- `rfc270-palette-permission.test.tsx`：AC-9 / AC-10，**点击**与**拖拽**两条分支各一例；有权限时不置灰。
- `rfc270-privileged-inspector.test.tsx`：AC-11，无权限时占位出现且**查不到**任何敏感字段的 DOM 文本；有权限时表单照常（现有 `rfc269-code-host-inspector.test.tsx` / `rfc253-script-snippet-inspector.test.tsx` 只覆盖了有权限分支，本次补齐无权限分支）；AC-12 链接可见性两分支；`hasPreview` 前提断言。
- `rfc270-settings-route-guard.test.tsx`：AC-13，非 admin 被重定向、admin 正常进入、`/me` 失败时放行。
- `rfc270-canvas-privileged-nodes.test.tsx`：AC-14，受保护节点 `draggable/deletable` 为 false、受保护边不可删；wrapper 归属守卫的正反例（AC-15）。
- `rfc270-draft-author-forbidden.test.ts`：AC-16，`saveFailed` / `reconcileFailed` 收到带 code 的 403 → `error` 相位而非 `inaccessible`；收到不带 code 的 403（真访问丢失）→ 仍是 `inaccessible`；`failureFromError` 保留 `code`。
- 既有 `palette.test.ts:168-169`：分区断言不变，新增条目 disabled 断言。

### 显式改判的既有断言

- RFC-253 `ScriptEdit.tsx:11-15` 的「read-only 是诚实呈现」注释与 AC-30 → 改写为 RFC-270 改判。
- RFC-269 `CodeHostCallEdit.tsx:14-17` 同款注释 → 同上。
- `tokenRedaction.ts:33-41` 的「会话通道不脱敏」推理 → 改写：PAT 轴仍按 source，新增权限轴按 permissions。
- `docs/code-host-calls.md` 与（若有）脚本节点文档中关于「无权限可查看」的描述。
