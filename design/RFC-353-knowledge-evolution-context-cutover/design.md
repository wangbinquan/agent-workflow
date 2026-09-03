# RFC-353 技术设计 —— Knowledge Evolution bounded context 归位

- current-source pin：`5ac6855e4`
- 开工分母（`b3883154e` 那批账本）：W4-E3 exact edge **13**、facade **2**

## 0. 与 RFC-294 目标架构的对齐（CLAUDE.md §RFC workflow 第 8 条）

| 问题                     | 本 RFC 的答案                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 落在哪个 bounded context | 新建 `knowledge-evolution`（RFC-294 `design.md §10`、能力表 §638）；同时动 `memory` 与 `resource-catalog` 的 public 面 |
| 落在哪一层               | KE：`domain` 状态机 / `application` 编排 / `infrastructure` 双 provider / `public` 合同 / `inbound` 路由 / `composition` 装配 |
| 承担哪一步演进           | W4-E3：建 context、退役 2 个 legacy facade、把跨聚合直写换成 offered participant                                     |
| 留下哪些债               | §7 逐条列出（bootstrap→composition 全局形态、`ws/broadcaster` 全仓形态、fusion 路由未进 OperationCatalog）           |
| 偏离项                   | §8 逐条列出并呈用户确认                                                                                             |

RFC-294 `design.md:349` 的 DAG 是 `KE --> MEM`：KE 消费 memory，不反向。本设计不引入 memory→KE 的边。

## 1. 目标形状

```
modules/knowledge-evolution/
├── domain/
│   ├── fusionStateMachine.ts        # FUSION_TRANSITIONS / isValidFusionTransition（今 services/fusion.ts:118-130）
│   ├── fusionResult.ts              # result.json 解析、incorporated/skipped 归一（今 rowToFusion / jsonArray）
│   ├── fusionPrompt.ts              # MERGER_BODY / MERGER_PROMPT_TEMPLATE / serializeMemoriesForPrompt
│   ├── fusionWorkflowSeed.ts        # canonicalFusionWorkflowDefinition / fusionBuiltinWorkflowSeed
│   └── skillProvenance.ts           # 【新】版本 ↔ 融入记忆的纯投影与排序
├── application/
│   ├── startFusion.ts               # createFusion 编排
│   ├── reconcileFusion.ts           # reconcileFusion / reconcileRunningFusions
│   ├── decideFusion.ts              # approveFusion / rejectFusion / cancelFusion
│   ├── recoverFusion.ts             # repairFusionProvenance / recoverFusionDecisions
│   ├── restoreSkillVersion.ts       # 【迁自 RC】skill-restore coordinator
│   ├── skillProvenanceQuery.ts      # 【新】GetSkillProvenance
│   └── ports/
│       ├── fusionWorkspace.ts       # worktree seeding / diff 的端口（今 seedWorktree / gitDiffSnapshot 直调）
│       ├── skillVersionWriter.ts    # required：RC 提供
│       └── memoryMembership.ts      # required：memory 提供
├── infrastructure/
│   ├── sqliteFusionRepository.ts    # 只写 fusions 表
│   ├── postgresqlFusionRepository.ts
│   ├── fusionRepositorySupport.ts
│   └── fusionWorkspaceAdapter.ts    # 工作树 seeding / 拷贝 / diff（node:fs + util/git）
├── inbound/
│   └── fusionRoutes.ts              # 由 routes/fusions.ts 收敛而来（只 decode/call/map）
├── public/
│   ├── commands.ts                  # StartFusion / ApproveFusion / RejectFusion / CancelFusion / RestoreSkillVersion
│   ├── queries.ts                   # GetFusionView / ListFusionSummaries / GetSkillProvenance
│   ├── participants.ts              # 供 system-operations 的 provenance repair 入口
│   └── types.ts                     # FusionRef / FusionView / SkillProvenanceView
└── composition.ts / composition/*.ts
```

## 2. 三个 context 的合同边界

### 2.1 memory offered：`MemoryMembershipParticipantInTx`（KE-only）

design §638 memory 行写明：offered、**KE-only** 的 `MemoryMembershipParticipantInTx`。

```ts
// modules/memory/public/participants.ts（新增）
export interface MemoryMembershipParticipantInTx {
  /** 融合提交：把这批 approved 记忆标记为 fused，写入 provenance。返回真正被改的 id。 */
  markFused(input: {
    readonly memoryIds: readonly string[]
    readonly skillId: string
    readonly skillName: string
    readonly skillVersion: number
    readonly fusionId: string
    readonly actorUserId: string
    readonly now: number
  }): Promise<readonly string[]>

  /** 技能回滚：把「融进高于 aboveVersion 的版本」的记忆退回 approved 并清 provenance。 */
  unfuseAboveVersion(input: {
    readonly skillId: string
    readonly aboveVersion: number
  }): Promise<readonly string[]>
}

export interface MemoryMembershipParticipant<Tx> {
  inTransaction(tx: Tx): MemoryMembershipParticipantInTx
}
```

**为什么这一条是本刀的核心**：
`unfuseAboveVersion` 今天 PostgreSQL 有（`postgresqlSkillMemoryFusionParticipant.ts`，注释自称
「Memory-owned half of Skill restore」），SQLite 没有——SQLite 走 `legacy/skillVersion.ts` 直接
`import { unfuseMemoriesTx } from '@/services/memory'`。`markFused` 两边都没有，各自内联在
fusion 适配器里（SQLite 在 `sqliteFusionPersistence.ts:519-536`）。收成一份之后：

- memory 是这两个语义的唯一 owner；
- `services/memory.ts` 最后一个 RC consumer 消失（RFC-352 转交项销账）；
- 两个 provider 的行为由**同一份**测试矩阵锁住。

### 2.2 resource-catalog offered：`SkillVersionParticipant`

design §638「resource 子模块」行写明：`SkillVersionParticipantInTx`。**好消息是它的机制已经存在**，
只是没有 public 出口，且两个 provider 各自被内联复制了一份：

| provider   | 已有的三段式                                                                        | 今天 fusion 怎么用                              |
| ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| SQLite     | `stageSkillVersion` → `commitSkillVersionInTx` → `publishStagedSkillVersion` / `abortStagedSkillVersion` | **没用**，`sqliteFusionPersistence.apply()` 手抄了一份 |
| PostgreSQL | `createPostgresqlSkillContentLifecycle` 的 `stage → commitInTransaction → publish → abort` | 同样手抄                                        |

`commitSkillVersionInTx` 已经接受 `source: 'fusion' | 'restore'`、`fusionId`、`restoredFromVersion`、
`summary`、`authorUserId`，并且带一个 **in-tx 扩展钩子 `txExtra?.(tx, newVersion)`**——memory 的
membership 写入正好挂在这里，与版本写入同一事务。

```ts
// modules/resource-catalog/public/participants.ts（新增）
export interface StagedSkillVersionHandle {
  readonly newVersion: number
  readonly noop: boolean
  commitInTransaction(tx: unknown, extra?: (tx: unknown, version: number) => void | Promise<void>): Promise<void>
  publish(): Promise<void>
  abort(state: { readonly databaseCommitted: boolean }): Promise<void>
}

export interface SkillVersionParticipant {
  /** 把 produce 写出的目录暂存为下一版；四道 token 的复合前置在 commit 事务里重验。 */
  stage(input: {
    readonly skillId: string
    readonly produce: (stagingDir: string) => void | Promise<void>
    readonly source: 'fusion' | 'restore'
    readonly summary: string | null
    readonly fusionId?: string
    readonly restoredFromVersion?: number
    readonly authorUserId: string
    readonly precondition: SkillCompositePrecondition
  }): Promise<StagedSkillVersionHandle>
}
```

**收益**：KE 的 fusion apply 与 skill-restore 都不再自己写 `skills` / `skill_versions`，
两个 fusion 适配器各砍掉约 200 行手抄的版本提交机制，且复合前置（RFC-170 那道 fence）只剩一份实现。

### 2.3 KE required / offered

- **required**（KE 声明、别人实现）：`SkillVersionParticipant`（RC adapter）、
  `MemoryMembershipParticipant`（memory adapter）、`FusionEngineTaskOperations`（TE adapter，**已存在**，
  `modules/task-execution/infrastructure/{,postgresql}FusionEngineTaskOperations.ts`，原样保留）。
- **offered**：`public/participants.ts` 暴露 provenance repair 入口给 system-operations
  （今天是 `system-operations/composition.ts` 直接 `import { repairFusionProvenance } from '@/services/fusion'`）。

## 3. 数据流

### 3.1 融合提交（approve）

```
KE.application/decideFusion.approve
  ├─ fusionRepository.claimDecision(CAS approving)          [KE 自己的表]
  ├─ skillVersions.stage({source:'fusion', fusionId, produce: 从 proposedWorktreePath 拷内容})   [RC]
  ├─ handle.commitInTransaction(tx, (tx, version) =>
  │      memoryMembership.inTransaction(tx).markFused({...version}))                             [RC+memory 同一 tx]
  ├─ handle.publish()                                                                             [RC]
  └─ fusionRepository.casStatus(applying → done, appliedSkillVersion=version)                    [KE]
```

失败路径与今天一致：DB 已提交但 publish 失败 → `handle.abort({databaseCommitted:true})`；
DB 未提交 → `abort({databaseCommitted:false})` + fusion 回 `awaiting_approval`。
skill operation journal 仍归 RC（它本来就是 skill 文件系统的账），KE 不再自持 `beginSkillOperation`。

### 3.2 技能回滚（restore）

```
KE.application/restoreSkillVersion
  ├─ skillVersions.stage({source:'restore', restoredFromVersion:v, produce: 从 versions/v{v} 拷贝})  [RC]
  ├─ handle.commitInTransaction(tx, (tx) =>
  │      memoryMembership.inTransaction(tx).unfuseAboveVersion({skillId, aboveVersion:v}))         [RC+memory 同一 tx]
  ├─ handle.publish()
  └─ 返回 { versionIndex, unfusedMemoryIds }        ← operation 输出逐字不变
```

`memoriesToUnfuseOnRestore`（今 RC `legacy/skillVersion.ts:86`）是纯判据，随 coordinator 迁进
KE `domain/`；两个 provider 的实际删改由 memory 的 participant 执行。

### 3.3 GetSkillProvenance（新增）

```
GET /api/skills/:id/provenance
  → KE.application/skillProvenanceQuery
      ├─ skillVersions.listVersions(skillId)                       [RC public query，已存在]
      ├─ memory.queries.listFusedInto({skillId})                    [memory public query，新增一条只读投影]
      ├─ memory.queries.filterVisible(authority, rows)              [memory 既有可见性过滤，复用]
      └─ domain/skillProvenance.project(versions, memories)         [纯函数：按 version 分组 + 排序]
```

响应（新 wire，纯增量）：

```jsonc
{
  "skillId": "...",
  "versions": [
    {
      "versionIndex": 3,
      "source": "fusion",
      "fusionId": "01M...",
      "memories": [{ "id": "01M...", "title": "...", "scopeType": "global", "scopeId": null }]
    },
    { "versionIndex": 2, "source": "restore", "fusionId": null, "memories": [] }
  ]
}
```

**语义（功能需求，非安全加固）**：
- 只返回调用者**可见**的记忆——复用 memory 既有的 scope 可见性过滤，不新写判据、不加加固层；
- 溯源反映**当前真相**：被后续回滚解融合的记忆，其 `fused_into_skill_version` 已被清空，
  因此自然不再出现在那个版本下（与 `MemoryRow` 的 chip 同源，不会两处打架）；
- 非 fusion 来源的版本 `memories` 为空数组，前端不渲染展开箭头。

## 4. 前端（AC-11）

`SkillVersionHistory.tsx` 的 `source==='fusion'` 行下增加一个可展开区：

- 复用既有原语：展开控件走 `.btn .btn--xs`，记忆项走既有 memory 行的 chip 样式，
  空态走 `<EmptyState size="compact">`，错误走 `<ErrorBanner>`；**不新写 chrome、不落原生元素**；
- 数据经一次 `GET /api/skills/:id/provenance`（随版本列表一起 prefetch，不为每行发请求）；
- i18n key 归入既有 `skills.*` / `fusion.*` 命名空间；
- `data-testid` 挂在展开按钮与每条记忆上，测试优先用 `findByRole`。

## 5. 失败模式

| 失败                                       | 处置                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| stage 之后、commit 之前进程死              | RC 既有 skill operation journal 在启动时 `reconcileSkillLiveFiles()` 收尾（行为不变）      |
| commit 已提交、publish 失败                | `abort({databaseCommitted:true})`：保留 DB 版本，live files 由启动重同步（行为不变）        |
| memory membership 写入抛错                 | 与版本写入同一事务 ⇒ 整体回滚，fusion 保持 `applying` 由 `recoverFusionDecisions` 收（不变） |
| fusion 目标 skill 在审批期间被改（版本漂移） | RC 的复合前置在 commit 事务内重验 ⇒ `stale-skill` conflict（不变，且从两份实现收成一份）     |
| provenance 查询里某条记忆不可见            | 该条不进结果；版本仍列出，`memories` 少一条（功能语义，不做侧信道分析）                     |

## 6. 测试策略

**A. 行为不变（改造前必须先绿、改造后一行不改）**
`fusion-engine.test.ts`(1188) / `fusion-provenance-repair.test.ts`(247) /
`rfc349-fusion-provider-persistence.test.ts`(220) / `rfc349-fusion-route-provider.test.ts`(27) /
`rfc319-fusion-manifest-merge-back.test.ts`(224) / `rfc349-memory-skill-fusion-postgresql-adapter.test.ts`(86)
——除 import 路径外**不得修改**。这是本刀最重要的 oracle。

**B. 新写（本 RFC 自带）**
1. `rfc353-skill-version-participant.test.ts` —— RC participant 的 stage/commit/publish/abort 四段式，
   含空写短路、复合前置在 tx 内重验、`txExtra` 与版本写入同事务；**两个 provider 对拍**。
2. `rfc353-memory-membership-participant.test.ts` —— `markFused` / `unfuseAboveVersion` 的
   **双 provider 等价性**：同一份数据、同一次回滚，两侧返回同一组 id（这条正是补 SQLite 缺口的红→绿）。
3. `rfc353-fusion-apply-no-cross-aggregate-write.test.ts` —— 源码层：KE 的两个 fusion 适配器里
   `memories` / `skills` / `skillVersions` 的引用数为 0（AC-4 的机器判据）。
4. `rfc353-skill-provenance.test.ts` —— 纯投影：分组、排序、非 fusion 版本空集、
   已解融合的记忆不再计入、不可见记忆被滤掉。
5. `rfc353-restore-operation-frozen.test.ts` —— `skill-catalog.restore-skill-version.v1` 的
   id / input schema / output schema / `unfusedMemoryIds` 逐字冻结（AC-6）。
6. 前端 `skill-version-history.test.tsx` 扩展 —— 展开区渲染、空态、只发一次请求。

**C. 先红后绿**
B2 必须先在**改造前**的 SQLite 侧复现「没有 participant、判据来自 legacy facade」的形状差异
（以源码断言表达），再由实现转绿。

## 7. 本刀之后仍留在 W4-E3 桶里的债（转交记账）

| 项                                                     | 归属          | 理由                                                     |
| ------------------------------------------------------ | ------------- | -------------------------------------------------------- |
| `server.ts` / `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` → `knowledge-evolution/composition*` | 不单方面改记 | 全仓 381 条、横跨 10 波的 bootstrap 装配形态（RFC-352 §4.1 已立此口径） |
| fusion 的 7 个路由未进 OperationCatalog                | W4-B          | 路由形态问题，不是 context 归属问题                      |
| KE → `ws/broadcaster`（若迁移后出现）                   | W9            | 全仓 46 条的 legacy WS 面，W4-C（Done）也留了 12 条       |

## 8. 与目标架构的偏离（呈用户确认）

1. **`SkillVersionParticipant` 的 `commitInTransaction(tx: unknown, …)`**：两个 provider 的事务类型
   不同（`DbTxSync` vs PostgreSQL transaction），做成泛型会把 provider 类型漏进 KE 的 required port。
   本设计取 opaque `unknown` + 各 provider adapter 内部收窄，**KE 不认识任何一种事务类型**——
   这与 design「KE 不得拥有 module transaction scope」一致，但牺牲了编译期类型。
   备选是给 participant 加 provider 泛型参数，代价是 KE 的端口签名带上 provider 形状。
2. **provenance 只落 KE 的 `GetSkillProvenance`**，不落 design 另列的 memory
   `MemoryProvenanceVisibilityQuery` 与 RC `SkillProvenanceVisibilityQuery` 两个独立 offered 面
   ——它们今天零消费者，按 RFC-294 §3.3「无 consumer 不公开」不建。
3. **fusion 内建资源 seeding**（`seedFusionResources` 写 `agents` / `workflows` / `resource_grants`）
   本刀**不切 participant**：它是一次性的 built-in 资源播种、只在 daemon 启动跑一次，
   与 RC 的 built-in 资源播种是同一形态；把它一并 participant 化会把 RC 的资源创建面整个拖进来。
   记为 W4-C 残留形态，登记转交。
