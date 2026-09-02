# RFC-352 技术设计 — Memory bounded context 合同归位

- current-source pin：`6752ec8c7`
- 前置阅读：RFC-294 `proposal.md §1/§3`、`design.md`（尤其 `:3415-3470` 的 memory 事务合同）、`plan.md §8 W4-E2`
- 行为 oracle：RFC-041（注入 / 蒸馏原始设计）、RFC-044（源上下文渲染）、RFC-248 / RFC-305（scope 档位）、
  RFC-285（蒸馏候选与 Q4 可见性）、RFC-342 / P0-A（Move 事务）

## 1. RFC-294 落位

| 归属            | 落点                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| bounded context | `memory`（主）；`source-control` 只加一个 offered participant；`bootstrap` 只改装配                                  |
| 层              | 纯判定/渲染 → `domain/`；编排与授权策略 → `application/`；SQL / 进程 / FS → `infrastructure/`                        |
| 跨模块          | 只经 exact `public/{commands,queries,participants,types}`；新增一条 `memory → source-control` 的 required→offered 边 |
| 装配            | `cli/start.ts` 与 `cli/postgresqlDaemonApplication.ts` 各自唯一装配点，不新增 facade                                 |

**本 RFC 承担的演进**：把 W4-E2 的 legacy 实现面清零、把授权策略从 infrastructure 提到 application、
补上 RFC-294 设计里缺席的 SC 授权 participant。
**留下的债**：`services/fusion.ts`（E3）、`distillSessionCapture`（E4b）、6 条 off-dag offered 边的 DAG 登记
（本 RFC 登记，但 TE / collaboration 侧的 consumer 归位仍属各自波次）。

## 2. 目标目录形状

```
modules/memory/
  domain/                      # 新增：纯函数，零 IO
    injectionRendering.ts      # formatMemoryBlock* / estimateTokens / clipByBudget / memoryFencingForNonce
    distillerOutput.ts         # parseDistillerOutput / extractFirstSessionIdFromStdout / clipAndRedactStderr
    sourceContext.ts           # renderSessionTreeToDistillerMd / clipHeadTail（原 distillerSourceContext.ts）
    distillPrompt.ts           # DISTILLER_SYSTEM_PROMPT / buildDistillerUserPrompt / 输出语言指令
    scopeAuthorization.ts      # 纯判定：给定 authority 事实 + scope，判 view / manage
  application/
    memoryAuthorization.ts     # 新增：canViewMemory / canManageMemory 的应用层实现（注入 bypass 判定 + 两个 scope participant）
    injection/selectInjectableMemories.ts   # 原 loadInjectableMemories + injectMemoryForRun 编排
    distill/runDistill.ts                   # 原 runDistill 编排
    distill/schedule.ts                     # enqueue / debounce / tick / backoff / recover / retry / cancel
    ports/
      distillerProcessPort.ts  # 新增：spawn 蒸馏子进程 + 一次性 worktree 的能力口
      resourceAclBypassPort.ts # 新增：hasResourceAclBypass 的注入口（消灭 deep import）
      （既有 distillReadStore / distillWorkStore / injectionReadStore / resourceScopeAccess 保留）
  infrastructure/
    sqlite*/postgresql* …      # 既有；不再导出授权谓词
    distillerProcess.ts        # defaultDistillerSpawn + worktree mkdir/rm + stderr 裁剪
  public/
    catalog.ts commands.ts queries.ts participants.ts operations.ts fusion.ts   # 既有，增量补齐
```

## 3. 关键合同

### 3.1 source-control offered `RepositoryScopeAuthorizationInTx`

按 RFC-294 `design.md:3441` 逐字采用，落在 `modules/source-control/public/participants.ts`：

```ts
export interface RepositoryScopeAuthorizationInTx {
  assertManageable(
    authority: CurrentAuthorityInTx,
    target: VersionedRepositoryRef | VersionedRepositoryGroupRef,
  ): void
}
```

- **行为逐字等于今天**：实现体是「`hasResourceAclBypass(authority.actor)` 为真则通过，否则抛
  `ForbiddenError`」——与 `sqliteMemoryCatalog.ts:1125-1129` 现判据一致。**不引入仓库属主委派**。
- 同时校验 existence 与 expected revision（与 RC 侧 `ResourceScopeAuthorizationInTx` 对称）。
- **不作为通用 catalog API**：只在 `MemoryMoveTx` 这个 capability scope 里可见，
  provider=1 / consumer=1 的 liveness 由 `required-ports` 账本钉住。
- 错绑变异必红：把 `VersionedResourceRef<'agent'>` 传给它、或把 repo ref 传给 RC participant，编译期即失败
  （closed union，不共用一个 `ResourceRef`）。

### 3.2 授权策略上移

`application/memoryAuthorization.ts`：

```ts
interface MemoryAuthorizationDeps {
  readonly aclBypass: ResourceAclBypassPort // 注入，替代 deep import @/services/resourceAcl
  readonly resourceScopes: ResourceScopeAuthorizationInTx // agent / workflow
  readonly repositoryScopes: RepositoryScopeAuthorizationInTx // repository / group
}
```

- `canViewMemory` / `canManageMemory` 从 `infrastructure/sqliteMemoryCatalog.ts` 移到这里，
  **判据逐格不变**（含 RFC-248 AC-29 的 repo_group 同档、RFC-285 Q4 的 candidate 收窄）。
- `domain/scopeAuthorization.ts` 承载纯判定（给定「是否 bypass」「scopeType」「memory status」输出 view/manage），
  application 只负责取事实与调 participant。这样权限矩阵可以在 domain 上做**表驱动的 characterization 测试**。
- `cli/start.ts:1917` 的 `memoryVisibility` 适配器改为直接引用 application 出口，不再自己包一层。

### 3.3 注入：只做 task-owned required port 的实现

- `application/injection/selectInjectableMemories.ts` 实现 `TaskMemoryInjectionPort`；
  memory public **不**暴露正文查询。
- 保持 `memoryInject.ts:16-20` 记的三条设计不变量：BEGIN/END 锚点、全空返回 `null` 不渲染空块、
  每次 runNode 实时重取 current-approved（live read，不做快照）。
- `parseInjectedSnapshotJson` 目前被 `modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts:111`
  直接 import——它是**快照 JSON 的解码器**，随 `InjectedMemorySnapshot` 类型走，迁入
  `memory/domain/injectionRendering.ts` 后经 `memory/public/types` 提供给 TE，登记为一条 offered 边。

### 3.4 蒸馏：编排与副作用分离

```ts
interface DistillerProcessPort {
  run(input: DistillerSpawnInput): Promise<DistillerSpawnResult> // 含一次性 worktree 的创建与清理
}
```

- `application/distill/runDistill.ts` 只做编排：装配 prompt → 调 port → `parseDistillerOutput`（domain）→
  逐候选 `validateAndPersistCandidate`（经 `distillWorkStore`）。
- 候选级容错、`IndeterminateRuntimeProcessError` 的上抛语义、退避与 `DISTILL_MAX_ATTEMPTS` 全部保持。
- `application/distill/schedule.ts` 保持 `distillTick` 的语义：一次最多 `DISTILL_BATCH_LIMIT=5`、
  同 `debounce_key` 合并、失败指数退避、不做租约（单 daemon 单进程内 worker）。

### 3.5 分页下推

`MemoryCatalogQueries` 的列表方法接受 `{ limit, cursor }` 并下推到 provider（SQLite `LIMIT/OFFSET` 或 keyset），
路由不再在内存里切片。两个 provider 的分页结果必须逐页一致（AC-7 的对拍）。
**不做**「不可见 count 无侧信道」——按用户 2026-08-26 硬规则不承接（见 proposal §4）。

## 4. 数据流（不变）

```
route ──decode──▶ public/commands|queries ──▶ application ──▶ ports ──▶ infrastructure(provider) ──▶ DB
                                     │
                                     ├──▶ ResourceScopeAuthorizationInTx (RC)     agent/workflow
                                     └──▶ RepositoryScopeAuthorizationInTx (SC)   repository/group
runner ──TaskMemoryInjectionPort──▶ application/injection ──▶ injectionReadStore ──▶ DB
daemon(memory-distill pausable handle) ──▶ application/distill/schedule ──▶ runDistill ──▶ DistillerProcessPort
```

## 5. 失败模式

| 场景                                    | 期望                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| scope 目标不存在                        | participant 抛 NotFound，与今天同形（不泄漏存在性差异之外的信息，行为不变） |
| 非管理员改 repo scope memory            | `ForbiddenError`，与今天逐字相同                                            |
| 蒸馏子进程超时 / 非零退出 / 无 envelope | 记 `last_error` + 退避，行为不变                                            |
| 单条候选 zod 失败                       | 该候选丢弃，整批继续（既有语义）                                            |
| 迁移窗口内 daemon 冻结                  | `memory-distill` handle 被 stop+drain，无写穿透（RFC-349 不变量）           |
| 注入时全 scope 为空                     | 返回 `null`，不渲染空块（既有不变量）                                       |

## 6. 测试策略

1. **权限矩阵 characterization（先落，作为 oracle）**：六 scope × 三角色 × 读/管，表驱动跑在
   `domain/scopeAuthorization.ts` 上；迁移前后逐格相同。
2. **participant 错绑变异**：把 agent ref 传给 SC participant / repo ref 传给 RC participant → 编译红；
   provider/consumer liveness = 1/1。
3. **注入不变量**：三条 grep/行为守卫（锚点、空集不渲染、live read）继续绿；
   `parseInjectedSnapshotJson` 的解码对拍。
4. **蒸馏行为 oracle**：去抖合并、退避序列、`MAX_ATTEMPTS`、候选级容错、`recoverRunning`、retry / cancel。
5. **分页对拍**：SQLite 与 PostgreSQL 逐页相同；边界（空页、末页、cursor 失效）。
6. **RFC-349 冻结守卫**：`rfc349-sqlite-daemon-pausable-writers` 覆盖 `memory-distill`。
7. **架构守卫**：`architecture:write` 重采后 W4-E2 自有 ids = 0、转交 ids 带 owner/removeWave、全局债不增。
8. **零 wire 证据**：路由 golden（状态码 / DTO 形状）迁移前后逐字相同。
