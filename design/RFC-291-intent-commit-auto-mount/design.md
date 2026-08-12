# RFC-291 技术设计 — 意图会话提交入库后的自动挂载

> 产品视角见 [`proposal.md`](./proposal.md)，任务分解见 [`plan.md`](./plan.md)，
> 设计门记录见 [`design-gate-2026-08-12.md`](./design-gate-2026-08-12.md)。
>
> **v2（2026-08-12）**：经双路设计门（路 1 锚点核实 + 路 2 Codex 对抗）判 FAIL 后重写。
> 新增面 E / 面 F（用户拍板纳入），修正 copy 谱系、`pickCallTarget` 契约、面 C 覆盖范围、
> AC-16 断言口径、测试矩阵与全部 stale 锚点。

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
dumpBuilder.ts:225  每个 root → expandClosure → detailRefs（root + 闭包成员）
        ↓
dumpBuilder.ts:277  detailRefs 全部写 mounted/ 文档 + fence（六类 fence 分别在
        ↓           :325 / :359-366 / :379 / :392 / :434 / :466），manifest 标 detail: true
        ↓
dumpBuilder.ts:481  其余可见资源写 inventory/ 摘要条目，manifest 标 detail: false
        ↓
resolveChangeset.ts:471-478  update 目标必须 detail=true，否则 intent-target-not-mounted
```

**缺陷根因**：提交入库的大事务（`applyChangeset.ts:1070`）更新了 `commitSeq` / `contextRevision` /
`currentDraftId`，唯独没有把本次创建的资源写进清单。于是这条链的第一步就把它们漏掉了。

精确表述（设计门 P3 纠正了初版的过度概括）：本次 create 的资源**未作为根、且不可从任何现有根到达、
且落在 inventory cap 内**时，才只拿到 `detail: false` 的摘要条目；落在 cap 之外则连摘要都没有。两种
情况都改不了。

注意 `detail` 的判据**不要求 `root`**（`resolveChangeset.ts:471-478` 只看 `entry.detail`），闭包成员
同样进 `detailRefs`（`dumpBuilder.ts:245-247`）并在 `:277` 起的同一循环里拿 fence。这一点在本设计里
出现三次：它是「只挂顶层也够用」的依据，是面 B 承诺被推翻的原因（§4.4），也是面 D 生效的机制。

**用户 2026-08-12 拍板：本次创建的资源全部设为挂载根。** 只挂「顶层产物」虽在闭包边完整时理论可行，
但有两个不可消除的弱点——用户取消挂载顶层根时闭包成员**连坐**失去详情；后续轮次改动引用关系时成员
**掉出**闭包。且顶层方案省不到 token（闭包成员照样全文 dump）。

## 2. 变更总览

| 面                        | 文件                                                                                      | 性质                    |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| A 自动挂载                | `services/intent/applyChangeset.ts` / `manifest.ts`                                       | 行为变更                |
| B copy 挂副本卸原件       | `services/intent/resolveChangeset.ts` / `manifest.ts` / `dumpBuilder.ts`（承继接线）      | 行为变更                |
| C 失效挂载跳过            | `services/intent/dumpBuilder.ts` / `turnEngine.ts` / `intentDoc.ts` / 前端                | 行为变更                |
| D 闭包扩边 + 去重收口     | `services/intent/dumpBuilder.ts` / `services/execution/closure.ts`                        | 行为变更 + 零行为收口   |
| **E call 边 handle 绑定** | `services/intent/dumpBuilder.ts` / `resolveChangeset.ts` / `intentDoc.ts` / shared schema | 行为变更（设计门 P1-a） |
| **F handle 高水位**       | `services/intent/manifest.ts` / `dumpBuilder.ts` / DB migration                           | 缺陷修复（设计门 P1-d） |

面 E / F 是设计门查出的**既有缺陷**，用户拍板纳入本 RFC 一并修（它们都被面 A/D 显著放大）。

## 3. 面 A — 提交入库时自动挂载

### 3.1 写入点：提交大事务内，与 epoch 递增同语句

`applyChangeset.ts:1070` 现状的 `set` 只有 `commitSeq` / `contextRevision` / `currentDraftId` /
`updatedAt`。改为在**同一条 `set`** 里追加 `contextManifestJson`。必须在大事务内：

- 事务外补写会留下「资源已落库、挂载缺失」的中间态——正是本 RFC 要消灭的病；进程在两步之间崩溃就
  复现原缺陷，且**没有任何补偿路径会修它**：`convergeIntentApplyJournal` 对 `committed` 行只调
  `rollForwardCommitted`（skill stages），不重放大事务（`applyChangeset.ts:1257-1266`，设计门路 1 取证）。
- 大事务开头已重新校验会话身份（`applyChangeset.ts:872-886`：`contextRevision` / `currentDraftId` /
  `inFlightTurnId` 三项 CAS），`sessionNow.contextManifestJson` 就是权威基线，无需再读一次。
- `contextRevision` 在本事务只 +1 一次；挂载变更搭同一次 epoch 递增，不额外 bump。

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

`action` 是**已归一的**（`resolveChangeset.ts:465`：`op.action === 'create' || isCopy ? 'create' : 'update'`），
copy 派生的副本天然计入 `create`。挂载集合 = `applied.filter(a => a.action === 'create')`，无需第二处判据。

### 3.3 清单写入算法（纯函数，可单测）

落在 `services/intent/manifest.ts`（与 handle 分配同模块）：

```ts
export interface AutoMountInput {
  /** 本次提交落库的创建物；copy 派生的副本额外带上**谱系根** resourceId（见 §4.3）。 */
  created: ReadonlyArray<{
    resourceType: AclResourceType
    resourceId: string
    copiedFromResourceId?: string
  }>
  /** copy 派生：被复制原件的 handle，提交后从挂载根退出。 */
  unmountHandles: readonly string[]
}

/** 提交入库后的清单迁移：同源旧副本退根 → copy 原件退根 → 创建物挂根。纯函数、幂等。 */
export function applyCommitMounts(
  manifest: IntentContextManifest,
  input: AutoMountInput,
): IntentContextManifest
```

语义（**顺序有语义，不可交换**）：

1. **同源旧副本退根**：对 `created` 中带 `copiedFromResourceId` 的每一条，把清单里 `copiedFromResourceId`
   等于**同一谱系根**、且 `root === true` 的既有条目置 `root = false`。比较键是
   `(resourceType, originResourceId)`，不是裸 id。
2. **原件退根**：对 `unmountHandles` 逐条命中置 `root = false`（条目与 handle 保留，与 `removeIntentMount`
   既有语义一致，`session.ts:884-889`）；未命中或本就 `root === false` → 无操作。
3. **创建物挂根**：逐条 `allocateHandle(...)`（既有条目复用既有 handle）。已存在条目 → `root = true`
   （幂等）；不存在 → push `{ handle, resourceType, resourceId, root: true, detail: false,
...(copiedFromResourceId ? { copiedFromResourceId } : {}) }`。

**步骤 1 必须在步骤 3 之前**：新副本自己也带 `copiedFromResourceId`（指向同一谱系根）。若先挂后退，
退根规则会把**刚挂上的最新副本自己**退掉——与用户诉求正好相反。这条有专门的顺序回归锁（§10.1）。

`detail: false` 是正确初值：本轮尚未 dump、没有 fence。下一轮 `buildIntentDump` 会升为 `detail: true`
并补 fence（`turnEngine.ts:514` 用新清单整体覆写）。在那之前 `resolveChangeset.ts:474` 仍拒绝以它为
update 目标——**这是对的**：没 dump 过就没有 fence，改它等于盲写。

**不设上限**（用户拍板）：不裁剪、不排序截断。

### 3.4 幂等与并发

- **replay**：重复 `clientMutationId` 在 claim 阶段返回存储回执，大事务不重跑 → 清单不被二次修改。
- **函数级幂等**：同一输入重放到 `applyCommitMounts`，步骤 3 的「已存在则置 root」保证收敛。
- **与 turnEngine 覆写的关系**：生成轮次结束时用 dump 产物整体覆写清单（`turnEngine.ts:514`），带三重
  条件（会话存在 / `inFlightTurnId === turnId` / `contextRevision === launchRevision`）。提交时
  `inFlightTurnId` 必须为 null（大事务 CAS 已验）且 `contextRevision` +1，所以跨越提交的旧轮次覆写
  必被条件挡掉。**无需额外加锁。**

### 3.5 可见性前提（设计门路 1 取证，作为不变量入档）

`assertWritable`（`session.ts:439-443`）把会话写权限制为 **owner-only**（admin 读旁路显式不延伸到写，
返回同形 404）。因此 apply 的 actor 恒等于会话 owner；而创建落库时 `ownerUserId: actor.user.id`。两者
相乘 ⇒ **自动挂载的资源不可能对下一轮的 actor 不可见**。

⚠️ 若将来放开会话协作写权，这条前提立即失效，自动挂载会开始批量产出不可用根（面 C 会兜住不炸，但
体验退化）。改动会话写权的人必须回来重新评估这一条。

## 4. 面 B — copy 挂副本、卸原件、只留最新副本

### 4.1 为什么需要新字段

「哪个原件被复制成了哪个副本」在 apply 侧拿不到：

- `applied[].fromCopy` 只是 `boolean`（`resolveChangeset.ts:309`、shared `intentSession.ts:328`）。
- `ResolvedIntentOp.manifestEntry` 在 copy 时被**刻意丢弃**（`resolveChangeset.ts:647`）——它的语义是
  「in-place update 的 fence 来源」，copy 不是 in-place，带上会让 fence 校验误判。这个丢弃是对的。
- `ResolvedIntentBundle.finalIdByRef` 的 key 混了 tempRef 与被复制 handle，反解等于第二处判据。

因此给 `ResolvedIntentOp` 加语义独立的可选字段，在 `resolveChangeset.ts:643` 的 `resolved.push` 处于
`isCopy` 时置为 `op.target`：

```ts
/** RFC-291 — copy 派生时的原件 handle；提交成功后原件退出挂载根。
 *  与 manifestEntry 语义不同：那是 in-place update 的 fence 来源，copy 刻意不带。 */
copiedFromHandle?: string
```

### 4.2 apply 侧消费

大事务里遍历 `preparedOps`：

- `item.op.copiedFromHandle` 非空值 → `unmountHandles`。
- 同一条 op 的 `created` 条目带上 `copiedFromResourceId` = **谱系根**（§4.3），由该 handle 在**提交前
  清单**里的条目推出（清单是 handle→资源 id 的唯一映射，`manifest.ts:5-7`）。handle 解析不到时不带该
  字段（退化为「只挂副本、不追同源」，不报错）。

**不进 receipt**：回执 schema（shared）保持不变，避免为内部编排细节改动前端解析面。可断言面用清单本身。

### 4.3 谱系根，而不是直接来源（设计门 P1-c）

copy 由用户 decision 驱动（`resolveChangeset.ts:424`：`decisionByOp.get(op.opId)?.applyMode === 'copy'`），
**不限于**他人/内置资源的强制 copy——用户可以对自己的资源、包括对自己上一个副本，再次选择 copy。

若只记直接来源就会漏：O→C1（C1 溯源 O）；再对 C1 选 copy → C2（溯源 C1）；随后重新挂载 O 并 O→C3 时，
退根只命中溯源 O 的 C1，**命不中 C2** ⇒ C2 与 C3 同时为根，违反「只留最新副本」。全程合法输入。

因此写入的是**谱系根**：

```ts
originOf(sourceEntry) = sourceEntry.copiedFromResourceId ?? sourceEntry.resourceId
```

比较与写入都用 `(resourceType, originResourceId)`。C2 因此溯源到 O 而非 C1，O→C3 时 C1 与 C2 一起退根。

### 4.4 承诺弱化：卸原件 ≠ 原件不可达（设计门 P1-b，用户拍板 (a) 案）

初版 G2/B2/US-3 承诺「原件全文退出上下文、无法再直接提 update」。**这不成立**：若另一个挂载根（例如
引用该 agent 的工作流）仍在，其闭包会把原件重新纳入 `detailRefs` 并给 fence，针对原件 handle 的原地
update 照样通过两道守卫。

用户拍板：**弱化承诺，不引入抑制态**。理由——改父资源时本就应该看得到它引用的子资源正文；为兑现
「不可达」而把被引用件降级为 reference-only，会损害正常场景。

因此本 RFC 的 copy 语义精确表述为：**原件与同源旧副本不再是显式挂载根**；它们是否仍出现在上下文里，
取决于是否可从其它根到达。文档三处（G2 / B2 / US-3）按此改写，不承诺不可达。

### 4.5 派生关系必须跨轮次持久

清单条目新增可选字段：

```ts
/** RFC-291 — 本条目的 copy 谱系根 resourceId（不是直接来源，见 §4.3）。 */
copiedFromResourceId?: string
```

**关键约束**：`buildIntentDump` 每轮**重建整份清单**（`turnEngine.ts:514` 整体覆写），条目由 detailRefs /
inventory / 不可用根三条路径分别构造——不显式承继就会在下一轮**静默丢失**，「只留最新副本」只在同一轮
内成立、跨轮失效。

因此 `buildIntentDump` 返回前统一承继一次：按 `(resourceType, resourceId)` 从 `priorManifest` 取
`copiedFromResourceId` 补进新条目。**一处**逻辑覆盖三条构造路径。

向后兼容：既有清单没有该字段 → `undefined` → 退化为「只卸原件、不追同源」，不迁移、不报错。

## 5. 面 C — 失效挂载跳过而非硬失败

### 5.1 跳过的判据是「拿不到可 dump 的内容」，不是「catalog 里没有」

初版只把 `dumpBuilder.ts:241` 的 throw 改成 skip。设计门两路独立指出这不够：catalog 只是
`loadVisibleCatalog`（`dumpBuilder.ts:213`）的内存快照，**真正 materialize 一个 skill 在 `:326` 起**，
`readSkillContent` 会重新查库并在行消失时抛 `skill-not-found`（`skill.ts:501-515`）/ 后续
`skill-changed`（`:538-540`）——完全绕过 skip 路径，整轮照样炸。自动挂载让挂着的资源变多，等比放大窗口。

修正后的契约：

```ts
export interface IntentDumpResult {
  ...
  /** RFC-291 — 本轮被跳过的挂载根：删除或对该 actor 不可见。
   *  只记 handle + 类型，绝不回显名字。 */
  unavailableMounts: Array<{ handle: string; resourceType: AclResourceType }>
}
```

处理细节：

1. 根检查（catalog 缺失）与**逐资源 materialize 失败**走同一条路径。materialize 外层捕获**明确的
   deleted / not-visible 结果**（`skill-not-found` / `skill-changed` / 行消失）→ 转 unavailable 条目。
2. **其它错误照常抛**（文件 I/O 损坏、YAML 序列化失败等）。不吞真错——把所有异常一律降级会让真实故障
   变成静默的「资源不可用」，那是比原缺陷更糟的失真。
3. 闭包成员 materialize 失败 → 计入既有 `hiddenDependencies`，不进 `unavailableMounts`（它不是根）。
4. **仍要分配 handle 并保留清单条目**：`{ handle, resourceType, resourceId, root: true, detail: false }`。
   省掉这步会让重建后的清单整个丢掉该条目——前端「已挂载元素」里它凭空消失（而不是显示「资源不可用」）、
   handle 断链、用户再也点不到「取消挂载」，并且会触发面 F 的高水位回退。

### 5.2 提示面

- **给构建 Agent**：`buildIntentDoc` 已有 `hiddenDependencyNote` → `## Access notes` 段
  （`intentDoc.ts:90`、`:452-453`）。新增 `unavailableMountNote: string | null` 入参，同段渲染：

  ```
  Mounted resources unavailable this epoch (deleted or no longer visible to you):
  res#agent#3 (agent). They are absent from mounted/; do not guess their contents.
  ```

  **不合并成一个参数**：两者语义不同（「闭包成员你看不到」vs「你挂的根没了」），合并会让文案二选一失真。

- **给用户**：路由投影已把不可见挂载的 `displayName` 置 null（`routes/intentSessions.ts:456-464`），前端
  据此显示「资源不可用」（`intent.detail.tsx:466`；⚠️ 该文件是三方并发热点——RFC-290、`5e95ac58` 与本
  RFC，实现时**以符号而非行号定位**）。补一条小字「生成时将跳过」，新增 1 条 i18n key（双语）。不新增
  组件、不改列表结构。

### 5.3 语义边界

跳过 ≠ 自动清理。条目保留为挂载根，因为资源可能只是**临时**不可见（授权回收后又恢复），自动清理会让
挂载一去不返。

## 6. 面 D — 依赖闭包扩边与去重收口

### 6.1 现状

| 源                   | 边                                                  | 状态                                               |
| -------------------- | --------------------------------------------------- | -------------------------------------------------- |
| agent                | `dependsOn` / `mcp` / `plugins` / `skills(managed)` | 已有                                               |
| workflow             | `agent-single` 节点的 `agentId`                     | 已有，但**手写第三份读取**（`dumpBuilder.ts:191`） |
| workflow             | `call-workflow` → 子工作流                          | **缺**                                             |
| workflow             | `call-workgroup` → 工作组                           | **缺**                                             |
| workgroup            | agent 成员                                          | 已有                                               |
| skill / mcp / plugin | —                                                   | 叶子                                               |

### 6.2 D-1：收口 agent 引用读取（零行为）

`resourceRefs.ts:39-50` 的 `extractWorkflowAgentRefs` 是权威提取器（RFC-223 PR-8：只认 canonical
`agentId`，name-only 遗留节点 fail-closed）。**闭包展开**改调它，删除手写 walker。

⚠️ 范围限定（设计门 P2-d）：dump **renderer**（`dumpBuilder.ts:399-403`）仍必须识别 `'agent-single'`
才能把 `agentId` 转成 `agentRef`——那是面 E 的载体，不能删。因此 AC-16 的断言口径收窄为「闭包展开不再
手写 agent 节点 walker」，而不是「文件里不出现该字面量」。

### 6.3 D-2：新增两条 call 边

引用收集复用 shared 权威收集器（`workflowCalls.ts:25-38` / `:46-56`）：`collectWorkflowCallRefs` /
`collectWorkgroupCallRefs`，返回 `{ nodeId, <type>Name, <type>Id? }`。

**不使用** `resourceRefs.ts:64-71` 的名字版提取器——它们压成 `string[]` 丢掉了 `idHint`，而 id 缓存是
解析判据的第一优先级。

### 6.4 D-3：解析判据真正单点化（设计门 P2-b 修正）

`freezeCallClosure`（`closure.ts:238+`）确立了权威判据，教训写在注释里（实现门 P0-1：跨可见性泄漏）：

> id 缓存优先——节点的 `workflowId` **只在该行名字仍等于选择器名字、且对该 actor 可见时**采纳；否则
> 回落到名字，且**限于该 actor 可见的行，最老 ULID 胜**（`workflows.name` 不唯一，YAML 导入碰撞合法）。

初版把 helper 设计成接收「已经挑好的 `hinted` / `oldestVisibleByName`」——那等于把真正的裁决（名字相等、
可见性、ULID 排序）留在调用侧（`closure.ts:281-324`，workgroup 分支 `:395-442` 另有一份）。dumpBuilder
只要按 Map 顺序取到同名的另一行，helper 单测全绿而两侧选出不同工作流，AC-14 形同虚设。

**修正契约**——helper 接收 id hint 与**完整候选集**，自行完成全部裁决：

```ts
// services/execution/callRefTarget.ts
export function pickCallTarget<T extends { id: string; name: string }>(
  ref: { authoritativeName: string; idHint?: string },
  /** 该 actor 可见的候选行（调用方只负责「可见」，不负责挑选）。顺序无关。 */
  visibleCandidates: readonly T[],
): T | undefined
```

裁决顺序（helper 内部，唯一实现）：① `idHint` 命中且该行 `name === authoritativeName` → 用它；
② 否则在 `name === authoritativeName` 的候选里取 `id` 最小（ULID 单调 ⇒ 最老）；③ 否则 `undefined`。

- `freezeCallClosure` 侧：把已过滤的可见行数组喂进去，删掉本地的 `byName` 挑选与 hint 判定，**行为零变化**
  （由 freeze/dump 同夹具对拍测试保证）。
- `dumpBuilder` 侧：`VisibleCatalog`（`dumpBuilder.ts:118-137`）就是该 actor 可见的全量 Map，直接把
  同名候选喂进去，无需额外 DB 查询。

### 6.5 递归与规模（设计门 P2-c 修正）

初版称「不设上限、靠 seen 收敛，只增加 token、不影响正确性」。这不成立：`expandClosure` 每个 mount
**新建 `seen` 并独立重跑**（`dumpBuilder.ts:141-148`、`:225-227`），队列用 `queue.shift()`
（`dumpBuilder.ts:175-176`）是 O(n²) 搬移；而本 RFC 让「一次提交 64 个根」（`INTENT_LIMITS.maxOps`）
成为常态输入。大扇出工作流 × 64 根会在启动模型前占满事件循环。

修正：

- `queue.shift()` → 游标索引推进。
- 邻接展开跨 roots **共享 memo**（同一资源的出边只算一次），`seen` 仍按根隔离以保证每个根的
  `hiddenCount` 正确。
- 复杂度回到 ~`O(V + E + roots)`。
- 仍不设深度/数量上限（与 `freezeCallClosure` 一致），但补大扇出 + 共享子图 + 64 根的复杂度回归测试。

解析不到的 call 目标（不存在/不可见）走既有 `hiddenCount`，不抛错、不泄漏名字。

## 7. 面 E — call 边的 handle 绑定与去 ULID（设计门 P1-a，用户拍板纳入）

### 7.1 问题

`dumpBuilder.ts:399` 的 `if (node.kind !== 'agent-single') return node` 让 call 节点**原样**进 dump，
连同 `workflowId` / `workgroupId` 两个 canonical ULID。后果有二：

1. **违反 handle 隔离**——`manifest.ts:5-7` 明定「the model never sees a ULID」。
2. **边无法映射到 handle**——两个可见同名工作流 W1（较老）/ W2，父节点 `{workflowName:"build",
workflowId:W2}`：启动期 `freezeCallClosure` 绑定 W2，面 D 也把 W2 拉进详情，但模型看到的是「名字 +
   一个裸 ULID」，无法判定该边对应 `mounted/` 里的哪个 handle。若实现者为满足隔离而抹掉 id，模型回写
   父工作流时缓存丢失，**下次启动按名字回落到较老的 W1**——用户以为在改被调用的工作流，运行的却是另一个。

### 7.2 方案：沿用既有 `agentRef` 模式，不发明新机制

关键发现：`agentRef`（dump 面 handle）↔ `agentId`（DB 面 canonical id）的双向转换**已经存在**——
dump 侧 `dumpBuilder.ts:399-403`，resolve 侧 `resolveChangeset.ts:566-584`（`delete node.agentRef;
node.agentId = resolveRef(ref)`）。面 E 只是把同一模式同构扩展到两类 call 节点：

| 位置         | `call-workflow`                                                                                      | `call-workgroup`     |
| ------------ | ---------------------------------------------------------------------------------------------------- | -------------------- |
| dump 输出    | 删 `workflowId`，加 `workflowRef: <handle>`；解析不到则 `workflowRefHidden: true`                    | 同构，`workgroupRef` |
| 保留字段     | `workflowName`（权威选择器，authored 数据，人类与模型都需要）                                        | `workgroupName`      |
| resolve 回写 | `delete workflowRef; workflowId = resolveRef(ref)`，并用目标行真实 name 覆盖 `workflowName` 保证自洽 | 同构                 |

- **目标解析**用 §6.4 的 `pickCallTarget`，与闭包展开、启动期冻结**同一实现**——三处一致，这正是
  P1-a 场景要的「dump 里那个 handle 就是将来会执行的那一行」。
- **新建 call 节点**：模型仍可按 `workflowName` 创建（`intentDoc.ts:390` 的既有指引不变）；若目标是
  同一变更集内新建的工作流，用既有 tempRef（`$new:slug`）走 `resolveRef`，与 `agentRef` 完全同路。
- **ACL 校验**：call 目标的 ref 与 `agentRef` 一样进 `resolveChangeset.ts:62-64` 的引用收集，确保模型
  不能引用它无权访问的资源。
- **shared schema**：`IntentWorkflowPayloadSchema` 的 call 节点加可选 `workflowRef` / `workgroupRef`
  （与既有 `agentRef` 并列）；`workflowId` / `workgroupId` 在 intent 域**不接受**模型输入（与 `agentId`
  同待遇）。
- **INTENT.md 契约**：`intentDoc.ts` 里 call 节点的说明同步改写为 ref 形式。⚠️ prompt 是模型唯一读到的
  规格，措辞错误等价于 API 契约写错（`docs/dev-gotchas.md`：两条 P1 曾都出在 doc 里），因此本面必须有
  **驱动真实 `applyIntentChangeset` 的行为测试**，而不是只断言 doc 里有某句话。

### 7.3 名字仍然出现在 dump 里——这不违反 AC-15

`workflowName` 是父工作流 authored 的正文内容，作者本人可见；AC-15 的「不回显名字」只约束
**hidden/unavailable 报告与 `## Access notes`**（那里的名字属于 actor 看不见的资源）。两者不冲突，
文档需写明边界，避免实现者过度删名。

## 8. 面 F — handle 高水位（设计门 P1-d，用户拍板纳入）

### 8.1 问题：注释与实现相反

`manifest.ts:51-52` 写着「Counters only ever grow — … so conversation history stays coherent across
epochs」。实现做不到：`createHandleAllocator`（`manifest.ts:59-70`）只从传入清单恢复高水位，而
`buildIntentDump` 每轮从空数组重建，inventory 只保留 `.slice(0, cap)`（`dumpBuilder.ts:474`）——被 cap
淘汰、或已删除且非 detail 的条目**不进新清单**，高水位随之回退。

后果：下一个新建资源拿到历史 ordinal，**旧对话里的 `res#agent#3` 指向另一个资源**。测试缝
`inventoryCap` 可确定性复现；生产 cap=500 需要 500 个名字靠前的同类资源。本 RFC 的退根条目（copy 原件、
同源旧副本）增多，进一步放大。

### 8.2 方案：持久化 per-type 高水位

- `intent_sessions` 新增列 `handle_watermark_json TEXT NOT NULL DEFAULT '{}'`，存
  `Partial<Record<AclResourceType, number>>`（DB migration，遵循本仓既有编号约定）。
- `createHandleAllocator(seed, watermark?)`：计数器取 `max(清单推导值, watermark[type])`。
- 每次 dump / 提交写清单时，把该会话见过的最大 ordinal 一并写回该列（单调，只增不减）。
- 同步修正 `manifest.ts:51-52` 的注释，使其与实现相符。

### 8.3 明确不做：全量 `(type,id) → handle` 映射

只持久化高水位可保证 **ordinal 永不复用**（消灭「指向另一个资源」这一危害）；但一个资源的条目若被
淘汰后又回来，它可能拿到**新的** handle。这属于「历史 handle 悬空」，严格弱于「历史 handle 错指」。

持久化全映射需要无界增长的结构（一个长会话可接触数千资源），成本与收益不匹配。因此：

- AC-5 的措辞改为「**ordinal 永不复用**；同一资源在其清单条目存续期间 handle 恒定」。
- 「条目淘汰后重新出现可能换 handle」登记为已知限制（§11 R4）。

## 9. 失败模式

| #   | 场景                                          | 行为                                                                                                 |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1  | 大事务在写清单后回滚                          | 整个提交回滚，资源未落库、清单未变 —— 全有或全无                                                     |
| F2  | 提交成功、进程随即崩溃                        | 清单已随事务落盘；converge 只 roll-forward 文件系统面，清单无需参与（`applyChangeset.ts:1257-1266`） |
| F3  | 提交成功后资源被别处删除                      | 下一轮走面 C：跳过 + 提示，不炸                                                                      |
| F4  | catalog 加载后、materialize 前资源被删        | 面 C §5.1 第 1 条捕获（明确的 deleted/not-visible）→ 转 unavailable，不炸                            |
| F4b | materialize 期间真实 I/O 故障                 | **照常抛出**，不降级为「资源不可用」——不吞真错（§5.1 第 2 条）                                       |
| F5  | copy 原件 handle 在清单中不存在               | 无操作；`copiedFromResourceId` 不写入，退化为「只挂副本、不追同源」。不抛错                          |
| F5b | 旧清单无 `copiedFromResourceId`               | 只卸原件，与本 RFC 之前行为一致；不迁移、不报错                                                      |
| F6  | call 目标同名多行且都可见                     | `pickCallTarget` 单点裁决，dump / 闭包 / 启动期冻结三处必然一致                                      |
| F7  | 大扇出闭包 × 64 根                            | 游标队列 + 跨 roots memo 后 ~O(V+E+roots)；不再占满事件循环（§6.5）                                  |
| F8  | 模型回传的 `workflowRef` 指向它无权访问的资源 | 走既有引用 ACL 收集（`resolveChangeset.ts:62-64`）拒绝，与 `agentRef` 同待遇                         |
| F9  | 模型删掉了 call 节点的 `workflowRef`          | 按 `workflowName` 解析（既有语义）；同名歧义时取最老 ULID，与启动期一致                              |
| F10 | 高水位列缺失（旧行 / 迁移前）                 | `DEFAULT '{}'` ⇒ 退化为「按清单推导」，即本 RFC 之前的行为；不报错                                   |

## 10. 测试策略

> 依 `CLAUDE.md §Test-with-every-change`。设计门 P2-e 指出初版矩阵多处可 false-green，以下为修正版：
> 每条都要求「实现写错时测试必红」。

### 10.1 纯函数（`rfc291-auto-mount-manifest.test.ts`）

- `applyCommitMounts`：六类逐类挂根；既有条目复用 handle 并置 root；重复调用收敛；`unmountHandles`
  命中/未命中/本就非 root 三态。
- **谱系根**（AC-8b 核心）：O→C1→C2 后再从 O copy 出 C3 ⇒ C1 与 C2 **都**退根、只有 C3 是根；再从旧
  C1 分叉 copy ⇒ 仍收敛到单一最新根。若实现只比直接来源，此用例必红。
- **顺序回归锁**：断言新副本没有被同源规则自我误退（步骤 1 在 3 之前）。
- 旧清单无 `copiedFromResourceId`：只卸原件，不误伤。
- `pickCallTarget`：hint 命中 / hint 名字不符则回落 / 回落取最老 ULID / hint 不可见 / 全不命中。

### 10.2 apply 集成（`rfc291-commit-auto-mount.test.ts`）

- 六类 create 全覆盖 → 清单全部 `root: true`；`contextRevision` 恰好 +1。
- **AC-3 不能只测终值**（P2-e）：加一个「session 已更新、大事务尚未提交」的故障缝，断言故障后清单与
  资源**双双回滚**——只测成功态无法区分「写在同一事务」与「写在第二个事务但恰好成功」。
- **AC-4 不能只比字节**（P2-e）：replay 除断言清单不变外，还要断言 journal 未新增行、receipt 为**同一**
  `journalId`——否则「重复执行但返回新回执」的实现也会绿。
- copy 提交 → 副本挂根、原件 `root:false` 且 handle 保留。
- **跨轮承继**：copy 提交 → 跑一轮 `buildIntentDump` → 断言 `copiedFromResourceId` 仍在 → 再 copy →
  旧副本退根。承继漏接则第二步即红。**从已退根的 O 再 copy 时，测试必须先走合法的 remount + dump**，
  否则会绕过真实守卫（P2-e）。

### 10.3 端到端「提交后可改」（`rfc291-commit-then-update.test.ts`）

> 回归防护主锚，文件顶注明锁的是本次用户报告的缺陷。

- **六类各一条** commit → dump → update 链路（P2-e：初版只测 agent，其余五类 dump/fence/接线坏掉仍绿）：
  提交创建 → `buildIntentDump` → 该资源在 `mounted/`、清单 `detail: true` 且带**该类型正确的 fence** →
  以其 handle 提 update → `validateDraftChangeset` 与 `resolveIntentBundle` 均通过。
- 负向锁（AC-17）：未挂载的 inventory-only 目标 → **分别**断言 `validateDraftChangeset` 与
  `resolveIntentBundle` 两处守卫各自拒绝（两处都要断，不能只测一处）。

### 10.4 失效挂载（`rfc291-unavailable-mount.test.ts`）

- 删除 / 失去可见性 → 不抛错、`unavailableMounts` 含该 handle、条目保留 `root:true/detail:false` 且
  handle 不变。
- **materialize 期竞态**：catalog 加载后、dump 前删除 skill（确定性 seam）→ 仍不炸（F4）。
- **真错不吞**：注入非 not-found 的 I/O 失败 → 照常抛（F4b）。
- **整轮收尾**（P2-e）：不止调 `buildIntentDump`，要驱动完整 turn，断言其余 roots 与 inventory 正常、
  轮次以正常状态结束。
- `## Access notes` 文本不含资源名字；并断言 **turnEngine 确实传了该参数**（初版直接喂 renderer，抓不到
  上游忘记接线）。

### 10.5 闭包扩边与 call 绑定（`rfc291-closure-call-edges.test.ts`）

- `call-workflow` → 子工作流进详情、可作 update 目标；递归到孙工作流；`call-workgroup` 同构。
- 环（A call B call A）收敛；大扇出 + 共享子图 + 64 根的复杂度回归（§6.5）。
- **freeze / dump 同夹具对拍**（AC-14）：同名两行、hint 指向改名行、hint 不可见、cap 边界四种输入下，
  `freezeCallClosure` 与 dump 选出**同一行**。
- **面 E 行为测试**：dump 产物里 call 节点**不含** `workflowId`/`workgroupId`、含正确 `workflowRef`；
  把该 dump 原样回传成 update changeset → 落库后 `workflowId` 与原目标**一致**（锁住「回写丢缓存导致
  下次启动回落到 W1」这条 P1-a 失败路径）。
- 源码层断言收窄（AC-16）：**闭包展开**路径不再手写 agent 节点 walker（renderer 保留）。

### 10.6 handle 高水位（`rfc291-handle-watermark.test.ts`）

- 用 `inventoryCap` 测试缝确定性复现：退根 → cap 淘汰 → 新建 ⇒ 断言新资源**不复用**历史 ordinal。
- 迁移前旧行（列为默认 `{}`）→ 行为退化为旧逻辑，不报错（F10）。

### 10.7 前端（`rfc291-mount-unavailable-hint.test.tsx`）

- `displayName === null` → 渲染「资源不可用」+「生成时将跳过」；有名字时不渲染该小字。用 role 选择器。

### 10.8 既有测试影响面（P3 纠正）

`rfc234-intent-routes.test.ts` 的「create with mounts」用例**不是**只断言初始清单——它会等首轮结束并
断言 `detail: true`（`:370-394`）。本 RFC 改 dump 装配后**它就是受影响面**，必须复跑并确认语义未变。
初版称「不受影响」是误判。

## 11. 已知成本与风险登记

- **R1（token）**：全挂无上限 → 每轮 dump 带全部新建资源全文（skill 连文件树）。用户拍板接受；逃生舱
  是手动取消挂载。若实测炸上下文，另开 RFC 引入「按最近提交批次保留」。
- **R2（闭包规模）**：扩边后工作流互调深链会把整条链拉进详情。复杂度已按 §6.5 修正，但 **dump 体积**
  仍随链长增长——这是 token 成本，不是正确性问题。
- **R3（判据漂移）**：`pickCallTarget` 若被某一侧绕过会重现跨可见性错位。freeze/dump 同夹具对拍 + 源码
  层断言双重兜底。
- **R4（handle 悬空）**：只持久化高水位、不持久化全映射 ⇒ 条目淘汰后重新出现的资源可能换 handle
  （§8.3）。严格弱于现状的「错指」，登记接受。

## 12. 与其它 RFC / 并发工作的关系

- **RFC-234 / RFC-235**（intent builder 本体）：本 RFC 是其 apply 管线与 dump 装配的增量，不改
  claim/preflight/prestage/big-tx/forward/converge 的相位划分。
- **RFC-271**（资源配置包）：决策 26 明确 intent 不并入包导入提交表；包导入路径不做自动挂载。
- **RFC-243**（call 节点 / 启动期闭包冻结）：面 D/E 复用其判据并把裁决抽成单点；`freezeCallClosure`
  行为零变化，由对拍测试保证。
- **RFC-282 / RFC-284**（抽象去重与防护制度化）：方向一致（消灭第三份 agent 引用读取、判据单点化）。
  已与 RFC-284 owner 确认：其批 B-F 与 RFC-285 均**不修改** `services/execution/closure.ts`，本 RFC
  可直接改，无需排队。
- **RFC-290 / `5e95ac58`**：同期在改 `intent.detail.tsx` 与 i18n 双语。本 RFC 在这两个文件只做**追加**，
  按路径精确 `git add`，不回改对方内容；该文件以符号定位而非行号。
