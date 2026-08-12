# RFC-291 技术设计 — 意图会话提交入库后的自动挂载

> 产品视角见 [`proposal.md`](./proposal.md)，任务分解见 [`plan.md`](./plan.md)。

## 1. 问题定位

意图会话的上下文由**清单**（`intent_sessions.context_manifest_json`，`IntentContextManifest`）单点决定：

```
manifest 条目 (services/intent/manifest.ts:30-48)
  { handle, resourceType, resourceId, root, detail, fence?, dumpHash? }
                                       ↑      ↑
                                       |      └─ 本轮被完整 dump 进 mounted/（唯一可 update 的判据）
                                       └─ 显式挂载根（下一轮 dump 的输入）
```

一轮生成的装配链：

```
turnEngine.ts:489   roots = manifest.filter(root)          ← 只有 root 进 dump
        ↓
dumpBuilder.ts:222  每个 root → expandClosure → detailRefs（root + 闭包成员）
        ↓
dumpBuilder.ts:274  detailRefs 全部写 mounted/ 文档 + fence，manifest 标 detail: true
        ↓           其余可见资源写 inventory/ 摘要，manifest 标 detail: false
resolveChangeset.ts:474  update 目标必须 detail=true，否则 intent-target-not-mounted
```

**缺陷根因**：提交入库的大事务（`applyChangeset.ts:1070`）更新了 `commitSeq` / `contextRevision` / `currentDraftId`，唯独没有把本次创建的资源写进 manifest。于是这条链的第一步就把它们漏掉了——它们只能作为 inventory 摘要出现，`detail: false`，改不了。

注意 `detail` 的判据**不要求 `root`**（`resolveChangeset.ts:471-478` 只看 `entry.detail`），闭包成员同样带 fence（`dumpBuilder.ts:274-283` 的 `entryBase` 对 root 与非 root 一视同仁）。这是本 RFC 选型的关键背景：只挂「顶层产物」在闭包边完整时理论上够用，但会引入两个不可消除的弱点——用户取消挂载顶层根时闭包成员**连坐**失去详情；后续轮次改动引用关系时成员**掉出**闭包。且顶层方案省不到 token（闭包成员照样全文 dump）。**用户 2026-08-12 拍板：本次创建的资源全部设为挂载根。**

## 2. 变更总览

| 面                           | 文件                                                                                                                 | 性质                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A 自动挂载                   | `services/intent/applyChangeset.ts`                                                                                  | 行为变更                           |
| B copy 卸原件 + 只留最新副本 | `services/intent/resolveChangeset.ts` / `manifest.ts`（清单字段 + 承继）/ `dumpBuilder.ts`（承继接线，+ A 的写入点） | 行为变更                           |
| C 失效挂载跳过               | `services/intent/dumpBuilder.ts` / `turnEngine.ts` / `intentDoc.ts` / 前端                                           | 行为变更                           |
| D 闭包扩边 + 去重收口        | `services/intent/dumpBuilder.ts` / `services/execution/closure.ts`                                                   | 行为变更（D-1/D-2）+ 零行为（D-3） |

## 3. 面 A — 提交入库时自动挂载

### 3.1 写入点：提交大事务内，与 epoch 递增同语句

`applyChangeset.ts:1070` 现状：

```ts
tx.update(intentSessions)
  .set({
    commitSeq,
    contextRevision: claim.session.contextRevision + 1,
    currentDraftId: null,
    updatedAt: Date.now(),
  })
  .where(eq(intentSessions.id, input.sessionId))
```

改为在同一条 `set` 里追加 `contextManifestJson`。**必须在大事务内**：

- 事务外补写会留下「资源已落库、挂载缺失」的中间态——正是本 RFC 要消灭的病；进程在两步之间崩溃就复现原缺陷，且没有任何补偿路径会修它（`convergeIntentApplyJournal` 对 `committed` 行只做文件系统面的 roll-forward，不重放大事务，`applyChangeset.ts:1216+`）。
- 大事务开头已重新校验会话身份（`applyChangeset.ts:872-886`：`contextRevision` / `currentDraftId` / `inFlightTurnId` 三项 CAS），所以 `sessionNow.contextManifestJson` 就是本次提交要修改的权威基线，无需再读一次。
- `contextRevision` 在本事务只 +1 一次；挂载变更搭同一次 epoch 递增，不额外 bump（额外 bump 会让并发 tab 的草稿多失效一次，语义上也不对——这是同一次提交的一部分）。

### 3.2 挂载哪些：`applied` 里的 create

大事务已在 `applyChangeset.ts:1045` 逐 op 累积 `applied`：

```ts
type AppliedEntry = {
  opId: string
  resourceType: AclResourceType
  resourceId: string
  action: 'create' | 'update'
  fromCopy: boolean
  name: string
}
```

其中 `action` 是**已归一的** action（`resolveChangeset.ts:465`：`op.action === 'create' || isCopy ? 'create' : 'update'`），即 copy 派生的副本天然计入 `action === 'create'`。因此挂载集合 = `applied.filter(a => a.action === 'create')`，无需第二处判据。

### 3.3 清单写入算法（纯函数，可单测）

新增纯函数（落在 `services/intent/manifest.ts`，与 handle 分配同模块）：

```ts
export interface AutoMountInput {
  /** 本次提交落库的创建物；copy 派生的副本额外带上其原件 resourceId。 */
  created: ReadonlyArray<{
    resourceType: AclResourceType
    resourceId: string
    copiedFromResourceId?: string
  }>
  /** copy 派生：被复制原件的 handle，提交后从挂载根退出。 */
  unmountHandles: readonly string[]
}

/** 提交入库后的清单迁移：同源旧副本退根 → copy 原件退根 → 创建物挂根。
 *  纯函数、幂等。 */
export function applyCommitMounts(
  manifest: IntentContextManifest,
  input: AutoMountInput,
): IntentContextManifest
```

语义（**顺序有语义，不可交换**）：

1. **同源旧副本退根**（AC-8b）：对 `created` 中带 `copiedFromResourceId` 的每一条，把清单里 `copiedFromResourceId` 等于同一原件、且 `root === true` 的既有条目置 `root = false`。
2. **原件退根**：对 `unmountHandles` 逐条命中置 `root = false`（条目与 handle 保留，与 `removeIntentMount` 的既有语义一致，`session.ts:884-889`）；未命中或本就 `root === false` → 无操作（AC-8）。
3. **创建物挂根**：对 `created` 逐条 `allocateHandle(createHandleAllocator(manifest), type, id)`（既有条目复用既有 handle，新条目取该类型计数器 +1）。已存在条目 → `root = true`（幂等）；不存在 → push `{ handle, resourceType, resourceId, root: true, detail: false, ...(copiedFromResourceId ? { copiedFromResourceId } : {}) }`。

为什么步骤 1 必须在步骤 3 之前：新副本自己也带 `copiedFromResourceId`（指向同一原件）。若先挂后退，退根规则会把**刚挂上的最新副本自己**一并退掉——正好与用户诉求相反。

`detail: false` 是正确的初值：本轮尚未 dump，没有 fence。下一轮 `buildIntentDump` 会把它升为 `detail: true` 并补 fence（`turnEngine.ts:499-518` 用新 manifest 覆写）。在那之前的中间态里，`resolveChangeset.ts:474` 仍会拒绝以它为 update 目标——**这是对的**：没 dump 过就没有 fence，改它等于盲写。

**不设上限**（用户拍板）：不裁剪、不排序截断。函数对 64 条创建物同样只是 64 次 push。

### 3.4 幂等与并发

- **replay**：重复 `clientMutationId` 在 claim 阶段就返回存储回执（`applyChangeset.ts` 头注 §claim），大事务根本不重跑 → 清单不会被二次修改（AC-4）。
- **函数级幂等**：即便同一输入被重放到 `applyCommitMounts`，步骤 1 的「已存在则置 root」保证结果收敛，不会出现重复条目或 handle 漂移（AC-5）。
- **与 turnEngine 覆写的关系**：生成轮次结束时会用 dump 产物覆写整份 manifest（`turnEngine.ts:508-513`），但它带三重条件（会话存在 / `inFlightTurnId === turnId` / `contextRevision === launchRevision`）。提交发生时 `inFlightTurnId` 必须为 null（大事务 CAS 已验），且提交把 `contextRevision` +1，所以任何跨越提交的旧轮次覆写都会被条件挡掉。**无需额外加锁。**

## 4. 面 B — copy 场景卸原件

### 4.1 为什么需要新字段

「哪个原件被复制成了哪个副本」这条信息目前在 apply 侧**拿不到**：

- `applied[].fromCopy` 只是 `boolean`（`resolveChangeset.ts:309`、shared `intentSession.ts:328`）。
- `ResolvedIntentOp.manifestEntry` 在 copy 时被**刻意丢弃**（`resolveChangeset.ts:646`：`...(entry === undefined || isCopy ? {} : { manifestEntry: entry })`）——它的语义是「in-place update 的 fence 来源」，copy 不是 in-place，带上会让 fence 校验误判。这个丢弃是对的，不要动它。
- `ResolvedIntentBundle.finalIdByRef` 的 key 混了 tempRef 与被复制的 handle，反解需要再判一次词法——等于第二处判据。

因此给 `ResolvedIntentOp` 加一个语义独立的可选字段：

```ts
export type ResolvedIntentOp = {
  ...
  /** RFC-291 — copy 派生时的原件 handle；提交成功后原件退出挂载根。
   *  与 manifestEntry 语义不同：那是 in-place update 的 fence 来源，copy 刻意不带。 */
  copiedFromHandle?: string
}
```

在 `resolveChangeset.ts:643` 的 `resolved.push` 处，`isCopy` 时置 `copiedFromHandle: op.target`。

### 4.2 apply 侧消费

大事务里遍历 `preparedOps`：

- `item.op.copiedFromHandle` 的非空值 → `applyCommitMounts` 的 `unmountHandles`。
- 同一条 op 若 `fromCopy`，其 `created` 条目带上 `copiedFromResourceId` = 该 handle 在**提交前清单**里对应的 `resourceId`（清单是 handle→资源 id 的唯一映射，`manifest.ts:5-7`）。handle 解析不到时不带该字段（退化为「只挂副本、不追同源」，不报错）。

**不进 receipt**：回执 schema（shared）保持不变，避免为一个内部编排细节改动前端解析面。可断言面用 manifest 本身（比回执更贴近被测行为）。

### 4.3 派生关系必须跨轮次持久

清单条目新增可选字段：

```ts
export interface IntentManifestEntry {
  ...
  /** RFC-291 — 本条目是从哪个资源 copy 派生来的（原件 resourceId）。
   *  用于「同一原件再派生新副本时，同源旧副本退根」（AC-8b）。 */
  copiedFromResourceId?: string
}
```

**关键约束**：`buildIntentDump` 每轮**重建整份清单**（`turnEngine.ts:508-513` 整体覆写），重建时条目由 detailRefs / inventory / 不可用根三条路径分别构造——若不显式承继，`copiedFromResourceId` 会在下一轮生成后**静默丢失**，AC-8b 只在「同一轮内连续提交」时成立，跨轮就失效。

因此 `buildIntentDump` 在返回前统一承继一次：按 `(resourceType, resourceId)` 从 `priorManifest` 取 `copiedFromResourceId` 补进新条目（新条目自己没有该字段时）。**一处**逻辑覆盖三条构造路径，避免在每条路径各写一遍。

向后兼容：既有会话的清单条目没有该字段，读取为 `undefined`，退化为「只卸原件、不追同源」，与本 RFC 之前的行为一致，不需要迁移。

## 5. 面 C — 失效挂载跳过而非硬失败

### 5.1 dumpBuilder 契约变更

`dumpBuilder.ts:241` 现状对不可见的挂载根 `throw new Error(...)` → 整轮生成失败。改为跳过并记录：

```ts
export interface IntentDumpResult {
  ...
  /** RFC-291 — 本轮被跳过的挂载根：资源已删除或对该 actor 不可见。
   *  只记 handle + 类型，绝不回显名字（不可见资源的名字不属于该 actor 的可见面）。 */
  unavailableMounts: Array<{ handle: string; resourceType: AclResourceType }>
}
```

处理细节：

1. 不可见 root **不进** `detailRefs`（不 dump、不展开闭包）。
2. **仍要分配 handle 并保留清单条目**：`{ handle: allocateHandle(alloc, type, id), resourceType, resourceId, root: true, detail: false }`。若省掉这一步，重建的 manifest 会把该条目整个丢掉——后果是前端「已挂载元素」里它凭空消失（而不是显示「资源不可用」）、handle 从会话历史断链、用户再也无法对它点「取消挂载」。`allocateHandle` 会从 `priorManifest` seed 里复用既有编号，handle 恒定（AC-10）。
3. 条目位置：与既有 detail/inventory 条目并列 push，顺序不影响语义（消费端一律按 handle / (type,id) 查表）。

### 5.2 提示面

- **给构建 Agent**：`buildIntentDoc` 已有 `hiddenDependencyNote` → `## Access notes` 段（`intentDoc.ts:90`、`:452-453`）。新增同段落的一条注记（沿用既有 id-only 风格）：

  ```
  Mounted resources unavailable this epoch (deleted or no longer visible to you):
  res#agent#3 (agent). They are absent from mounted/; do not guess their contents.
  ```

  实现上给 `buildIntentDoc` 加一个 `unavailableMountNote: string | null` 入参，与 `hiddenDependencyNote` 同段渲染（两者都非空时各占一行）。**不合并成一个参数**：两者语义不同（一个是「闭包成员你看不到」，一个是「你挂的根没了」），合并会让 note 文案二选一失真。

- **给用户**：路由投影已把不可见挂载的 `displayName` 置 null（`routes/intentSessions.ts:455-465` 用 `listVisibleIntentResources` 反查），前端据此显示「资源不可用」（`intent.detail.tsx:468`）。补一条小字说明「生成时将跳过」，新增 1 条 i18n key（双语）。不新增组件、不改列表结构。

### 5.3 语义边界

跳过 ≠ 自动清理。用户拍板的是「跳过并提示」，条目保留为挂载根。理由：资源可能只是**临时**不可见（授权被回收后又恢复），自动清理会让挂载一去不返。

## 6. 面 D — 依赖闭包扩边与去重收口

### 6.1 现状

`expandClosure`（`dumpBuilder.ts:139-206`）的边：

| 源                   | 边                                                  | 状态                                               |
| -------------------- | --------------------------------------------------- | -------------------------------------------------- |
| agent                | `dependsOn` / `mcp` / `plugins` / `skills(managed)` | 已有                                               |
| workflow             | `agent-single` 节点的 `agentId`                     | 已有，但**手写第三份读取**（`dumpBuilder.ts:191`） |
| workflow             | `call-workflow` 节点 → 子工作流                     | **缺**                                             |
| workflow             | `call-workgroup` 节点 → 工作组                      | **缺**                                             |
| workgroup            | agent 成员                                          | 已有                                               |
| skill / mcp / plugin | —                                                   | 叶子                                               |

### 6.2 D-1：收口 agent 引用读取（零行为）

`services/resourceRefs.ts:39-50` 的 `extractWorkflowAgentRefs(def): Set<string>` 是权威提取器（RFC-223 PR-8：只认 canonical `agentId`，name-only 的遗留节点 fail-closed）。`dumpBuilder` 改为调用它，删除手写分支。行为等价（同一判据、同一 fail-closed 立场），并满足 AC-16 的源码层断言。

### 6.3 D-2：新增两条 call 边

引用收集复用 shared 的权威收集器（`packages/shared/src/workflowCalls.ts:25-38` / `:46-56`）：`collectWorkflowCallRefs` / `collectWorkgroupCallRefs`，二者返回 `{ nodeId, <type>Name, <type>Id? }`。

**不使用** `resourceRefs.ts:64-71` 的 `extractWorkflowWorkflowRefs` / `extractWorkflowWorkgroupRefs`——它们把结果压成 `string[]` 名字集合，丢掉了 `idHint`，而 id 缓存是解析判据的第一优先级（见 6.4）。这两个提取器服务于「保存时校验新增引用」的名字域场景，与此处需求不同。

### 6.4 D-3：解析判据与启动期冻结同源

`freezeCallClosure`（`services/execution/closure.ts:238+`）已经确立了权威判据，且带血的教训写在注释里（实现门 P0-1：跨可见性泄漏）：

> id 缓存优先——节点的 `workflowId` **只在该行名字仍等于选择器名字、且对该 actor 可见时**采纳；否则回落到名字，且**限于该 actor 可见的行，最老 ULID 胜**（`workflows.name` 不唯一，YAML 导入碰撞是合法状态）。

dumpBuilder 必须用**同一条**判据（AC-14），否则会出现「启动时执行的是 W1、意图会话里改的是 W2」这类最难查的错位。抽取最终裁决为纯函数，两处共用：

```ts
// services/execution/callRefTarget.ts（新文件，或落在 closure.ts 内导出）
export function pickCallTarget<T extends { id: string; name: string }>(
  ref: { authoritativeName: string; idHint?: string },
  candidates: {
    /** idHint 命中的行（调用方已做可见性过滤）。 */
    hinted?: T
    /** 该名字下可见行中最老的一条（ULID 升序第一条）。 */
    oldestVisibleByName?: T
  },
): T | undefined
```

- `freezeCallClosure` 侧：已分别构造 `hintById` 与 `byName`（可见过滤 + `orderBy asc(id)` 取首条），改为把二者喂给 `pickCallTarget`，**行为零变化**。
- `dumpBuilder` 侧：`VisibleCatalog` 已是「该 actor 可见的全量资源 Map」（`dumpBuilder.ts:118-137`），在内存里按 name 建索引（同名取 id 最小）即可，无需额外 DB 查询。

### 6.5 递归与规模

- 子工作流会被 push 进既有 BFS 队列，其 call 边继续展开；`seen` 集合（`dumpBuilder.ts:145`）天然防环。
- **不设深度 / 数量上限**，与既有 `expandClosure`、`freezeCallClosure` 保持一致（两者都只靠去重收敛）。风险登记在 §9。
- 解析不到的 call 目标（不存在 / 不可见）走既有 `hiddenCount` 计数（AC-15），与 agent 侧不可见依赖同路径，不抛错、不泄漏名字。

### 6.6 dump 文档不变

工作流 dump 只把 `agent-single` 的 `agentId` 替换成 handle（`dumpBuilder.ts:393+`），call 节点保持 `workflowName` / `workgroupName` **原样**——这是权威字段，且变更集里创建 call 节点也是按 exact name（`intentDoc.ts:390`）。扩边只影响「哪些资源进 `mounted/`」，不改任何文档格式。

## 7. 失败模式

| #   | 场景                                           | 行为                                                                                                                                                                                                                 |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 大事务在写 manifest 后回滚                     | 整个提交回滚，资源未落库、清单未变 —— 全有或全无（AC-3）                                                                                                                                                             |
| F2  | 提交成功、进程随即崩溃                         | 清单已随事务落盘；重启后 `convergeIntentApplyJournal` 只 roll-forward 文件系统面，清单无需参与                                                                                                                       |
| F3  | 提交成功后资源被别处删除                       | 下一轮走面 C：跳过 + 提示，不炸（AC-9）                                                                                                                                                                              |
| F4  | 自动挂载后 dump 过大                           | 用户拍板不设上限；缓解是手动取消挂载（B1 逃生舱）。登记为已知成本                                                                                                                                                    |
| F5  | copy 原件 handle 在清单中不存在                | `applyCommitMounts` 无操作（AC-8）；`copiedFromResourceId` 也不写入，退化为「只挂副本、不追同源」。不抛错——原件条目理论上必在（copy 的前提是它 detail=true），缺失只可能来自并发 rebase，此时提交已被大事务 CAS 挡下 |
| F5b | 旧清单（本 RFC 之前）无 `copiedFromResourceId` | 同源旧副本识别不到 → 只卸原件，与本 RFC 之前行为一致；不迁移、不报错（design §4.3）                                                                                                                                  |
| F6  | call 目标同名多行且都可见                      | 最老 ULID 胜，与启动期冻结完全一致（AC-14）；不同名多行不会互相干扰                                                                                                                                                  |
| F7  | 扩边后闭包异常大（工作流互调深链）             | 无上限，靠 `seen` 收敛；单轮 dump 变大表现为 token 上升，不影响正确性。登记在 §9                                                                                                                                     |

## 8. 测试策略

> 依 `CLAUDE.md §Test-with-every-change`：下列 case 必写，PR 全绿才算交付。首选纯函数可断言面 + 少量集成断言。

### 8.1 纯函数（`packages/backend/tests/rfc291-auto-mount-manifest.test.ts`）

- `applyCommitMounts`：六类资源逐类挂根（AC-1）；已存在条目复用 handle 并置 root（AC-5）；重复调用结果收敛（AC-4 的函数级面）；`unmountHandles` 命中置 false、未命中无操作、原本非 root 无操作（AC-7 / AC-8）。
- `applyCommitMounts` 的同源退根（AC-8b）：清单里已有一个 `copiedFromResourceId === R` 的根，新提交又从 R 派生副本 → 旧副本 `root: false`、新副本 `root: true`，两者 handle 均保留。**顺序回归锁**：断言新副本自己没有被同源规则误退（先退后挂，design §3.3）——这条测试若变红即说明顺序被交换。
- 旧清单无 `copiedFromResourceId`（F5b）：只卸原件，不误伤任何条目。
- `pickCallTarget`：id 缓存命中 / 名字不匹配则回落 / 回落取最老 ULID / 都不命中返回 undefined（AC-14）。

### 8.2 apply 集成（`packages/backend/tests/rfc291-commit-auto-mount.test.ts`）

- 提交一个含六类 create 的变更集 → 读 `context_manifest_json` 断言全部 `root: true`（AC-1）；`contextRevision` 只 +1（AC-3）。
- 同 `clientMutationId` 重复提交 → 清单逐字节不变（AC-4）。
- copy 决策提交 → 副本挂根、原件 `root: false` 且 handle 保留（AC-6 / AC-7）。
- **跨轮承继**（AC-8b 的持久面）：copy 提交 → 跑一轮 `buildIntentDump` 重建清单 → 断言副本条目上的 `copiedFromResourceId` 仍在 → 再从同一原件 copy 一次 → 上一个副本退根、最新副本是唯一同源根。**这条是 §4.3 的守卫**：若承继逻辑漏接，测试在第二步就红。

### 8.3 端到端「提交后可改」（`packages/backend/tests/rfc291-commit-then-update.test.ts`）

> 这是锁死用户报告缺陷的**回归防护主锚**，文件顶注明「locks the RFC-291 defect: resources committed from an intent session were not mounted, so the next turn's update hit intent-target-not-mounted」。

- 提交创建 agent → 跑 `buildIntentDump` → 该 agent 出现在 `mounted/`、清单 `detail: true` 且带 fence → 以其 handle 构造 update 变更集 → `validateDraftChangeset` 与 `resolveIntentBundle` **均通过**（AC-2）。
- 负向锁：一个**未**挂载的 inventory-only 资源作为 update 目标 → 仍报 `intent-target-not-mounted`（AC-17，防止把守卫改松）。

### 8.4 失效挂载（`packages/backend/tests/rfc291-unavailable-mount.test.ts`）

- 挂载后删除资源 → `buildIntentDump` 不抛错、`unavailableMounts` 含该 handle、清单保留 `root:true/detail:false` 且 handle 不变（AC-9 / AC-10）。
- 失去可见性（他人 private）同上。
- `buildIntentDoc` 渲染出 `## Access notes` 且**不含资源名字**（AC-11，文本断言）。

### 8.5 闭包扩边（`packages/backend/tests/rfc291-closure-call-edges.test.ts`）

- 父工作流 `call-workflow` → 子工作流进 `mounted/`、可作 update 目标（AC-12）；子工作流再 call 孙工作流 → 递归进入。
- `call-workgroup` → 工作组进详情，其 agent 成员继续展开（AC-13）。
- call 目标不可见 → 进 `hiddenDependencies` 计数，不抛错、无名字（AC-15）。
- 环（A call B call A）→ 收敛不死循环。
- 源码层断言：`dumpBuilder.ts` 不再出现 `'agent-single'` 字面量（AC-16）。

### 8.6 前端（`packages/frontend/tests/rfc291-mount-unavailable-hint.test.tsx`）

- 挂载项 `displayName === null` → 渲染「资源不可用」+「生成时将跳过」小字；有名字时不渲染该小字。用 `findByRole` / 既有 testid，不新增 wrapper testid。

### 8.7 既有测试影响面

`rfc234-intent-routes.test.ts:348`（create with mounts）只断言初始清单，不受影响。跑 `bun run gate:local` 全绿前提交。

## 9. 已知成本与风险登记

- **R1（token）**：全挂无上限 → 一次造 20 个资源后每轮 dump 都带它们全文（skill 连文件树）。用户拍板接受；逃生舱是手动取消挂载。若后续实测炸上下文，可另开 RFC 引入「按最近提交批次保留」策略。
- **R2（闭包规模）**：扩边后工作流互调深链会把整条链拉进详情。与既有实现一致地不设上限，靠去重收敛。
- **R3（判据漂移）**：`pickCallTarget` 若将来被某一侧绕过，就会重现跨可见性错位。测试里对两处调用点各留一条断言，源码层文本断言兜底。

## 10. 与其它 RFC / 并发工作的关系

- **RFC-234 / RFC-235**（intent builder 本体）：本 RFC 是其 apply 管线与 dump 装配的增量，不改 §9 的 claim/preflight/prestage/big-tx/forward/converge 相位划分。
- **RFC-271**（资源配置包）：决策 26 明确 intent 不并入包导入的提交表。本 RFC 遵守该边界——包导入路径不做自动挂载（§3 非目标）。
- **RFC-243**（call 节点 / 启动期闭包冻结）：面 D 复用其判据并抽出共享纯函数；`freezeCallClosure` 侧零行为变更。
- **RFC-282 / RFC-284**（抽象去重与防护制度化）：面 D 的收口方向与之一致（消灭第三份 agent 引用读取、判据单点化）。若 RFC-284 批次同期改到 `dumpBuilder.ts` / `closure.ts`，按 `CLAUDE.md §Multi-person collaboration` 先调和再落。
- **RFC-290**（NumberInput 范围提示）：同期在改 `intent.detail.tsx` 与 i18n 双语文件。本 RFC 在这两个文件只做**追加**（一条挂载小字 + 对应 key），提交按路径精确 `git add`，不回改对方内容。
