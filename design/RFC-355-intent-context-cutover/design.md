# RFC-355 技术设计 —— Intent bounded context 归位

- 状态：Draft（2026-09-04）
- current-source pin：`c7c6fb81b`
- 所有 `file:line` 锚点按该提交的 committed blob 取

## 1. 目标形状

```
modules/intent/
  domain/              纯判据：资源计划、claim 前置、settle 重验、changeset 解析结果分类
    intentResourcePlan.ts      ← 【新】自两个 provider 各自的 intentResourcePlanOf 收敛
    applyPreconditions.ts      ← 【新】claim 段与 settle 段的判据
    (既有 9 个 domain 文件不动)
  application/         provider-neutral 编排（本刀的主体）
    applyChangeset.ts          ← 【新】一份 apply 编排，取代两个 provider 各自的 842/684 行
    sessionApplyLock.ts        ← 【新】15 行串行锁，取代两处同算法拷贝
    journalConvergence.ts      ← 【新】一份收敛，取代 convergeIntentApplyJournal / createPostgresql…Convergence
    turnEngine.ts / dumpBuilder.ts / resolveChangeset.ts / session.ts / …  ← 【迁自 services/intent】
  ports/               application 声明的窄端口（provider 实现）
    intentApplyPersistence.ts  ← 【新】claim / settle / journal 的读写面
    skillArtifacts.ts          ← 【新】RC offered participant 的消费面（见 §4）
  infrastructure/      只剩「怎么读怎么写怎么开事务」
    sqliteIntentApplyPersistence.ts       ← 由 842 行瘦身
    postgresqlIntentApplyPersistence.ts   ← 由 684 行瘦身
    (既有 persistence / sqlProgramRunner 不动)
  inbound/
    intentSessionRoutes.ts     ← 【迁自 routes/intentSessions.ts】收成 decode-call-map
  public/              对外合同（commands / operations 已有；按 consumer 实际需要增删）
  composition/         装配；跨 context 的 provider 装配交由 bootstrap 注入（RFC-353 立下的口径）
```

`services/intent/` 整目录删除。

## 2. 两份 apply 的逐段对照（合并前必须逐条裁决）

这是本刀最大的风险面。下表由实读 `c7c6fb81b` 的两个文件得出，**合并时逐行确认取哪一侧**，
不允许「默认取 SQLite」或「默认取 PostgreSQL」。

| 阶段 | SQLite（`sqliteIntentApplyOperations.ts`） | PostgreSQL（`postgresqlIntentApplyOperations.ts`） | 合并裁决 |
| --- | --- | --- | --- |
| session 串行锁 | `withSessionApplyLock` L182-197 | `withSessionLock` L174-190 | **同一算法，逐字合并**；`__intentApplyLockCountForTests` / `__withSessionApplyLockForTests` 两个测试钩子保留（有用例依赖），迁到 application |
| 资源计划 | `intentResourcePlanOf` L205-248 | `intentResourcePlanOf` L85-128 | **逐字节相同，仅形参名 `op` vs `operation`**——纯判据，直接提进 `domain/intentResourcePlan.ts`，两侧共用 |
| claim | L264-380（`dbTxSync`） | L195-282（`db.transaction`） | 判据序列相同（归属 → clientMutationId 重放 → active → inFlightTurnId → draftHash → contextRevision）；**判据提进 domain，事务由 provider 开** |
| 重放出参 | 内联 | `replayIntentApplyOutcome` L148 | 取 PostgreSQL 的具名函数形态，提进 application |
| changeset 解析 | 经 `@/services/intent/resolveChangeset` 门面 | 内联 `parseIntentChangeset` + 抛 `intent-changeset-invalid` L328 | **两条取用路径合一**：`resolveChangeset` 迁进 application 后由两侧共用；`intent-changeset-invalid` 成为共有错误码 |
| preflight / prestage | L446-495（`design §9.2/§9.3/§9.4①②`） | L283-382（`recordArtifact` / `settleFailed` / `keepRetryable` 三个闭包） | 形状不同：SQLite 线性、PostgreSQL 闭包化。**取 PostgreSQL 的具名分段**（可测性更好），逐段对齐 SQLite 的注释语义 |
| 大事务 | L496-662 | L383-582 | 逐段对照后合并；写入面下沉为 `ports/intentApplyPersistence` |
| roll-forward | L663-678（`design §9.5` 幂等） | L520-560（含 `intent-resource-roll-forward-recovery-failed` 日志） | 合并；日志标签统一（见 §5） |
| 补偿 | L679-722（「durable artifact list 是 oracle」） | L536-582（含 `intent-resource-abort-failed` 日志） | 合并；**artifact 清单作为 oracle 这条不变** |
| 工件归属 | 由 RC 注入（正确 owner） | intent 自带 `postgresqlIntentApplyArtifactOwners.ts` 拷贝 | **T0 已查清（§7.1）**：删 PostgreSQL 侧的拷贝，两侧统一走 RC participant |
| 日志收敛 | `convergeIntentApplyJournal` L723-839 | `createPostgresqlIntentApplyJournalConvergence` | 合并成 `application/journalConvergence.ts`；provider 只出取数与写回 |

## 3. provider-neutral 化的切法

application 只认下面这一个端口（provider 实现），**事务由 provider 开好交进来**——
形态与 RFC-353 的 `SkillVersionCommitParticipantInTx` / `MemoryMembershipParticipantInTx` 一致：

```ts
// modules/intent/ports/intentApplyPersistence.ts
export interface IntentApplyPersistence<TTx> {
  /** claim 段：在一个事务里读 session/draft/journal 并落 claim 行；判据由 domain 提供。 */
  claim(input: IntentApplyClaimInput): Promise<IntentApplyClaimOutcome>
  /** 大事务：把 application 算好的写入计划交给 provider 执行。 */
  settle(plan: IntentApplySettlePlan): Promise<IntentApplySettleReceipt>
  /** 收敛：取待收敛的 journal 行、写回终态。 */
  listConvergeCandidates(now: number): Promise<readonly IntentApplyJournalRow[]>
  finishConverge(input: IntentApplyConvergeWriteback): Promise<void>
}
```

**为什么不把事务塞进 application**：`dbTxSync`（SQLite，同步）与 `db.transaction`（PostgreSQL，async）
的形状本就不同，RFC-353 已经踩过一次——SQLite 侧的同步事务回调里 `await` 会让事务在 Promise 兑现前提交。
所以 application 只产出**计划**，事务边界留在 provider。

## 4. 与 resource-catalog 的边（30 条深取）

intent 的 apply 需要 RC 的技能工件能力：路径解析（`skillIdentityPaths`）、内容哈希（`skillHash`）、
文件发布（`skillFsPublish`）、版本提交（`skillVersion`）、boot 校验（`skillBootVerify`）、
以及 RC 的 `aggregateAdapters/*IntentApplyResource*`。

**做法**（复用 RFC-353 T6/T7 的形态，不重新发明）：

1. RC 在 `public/participants.ts` 出一个 **`SkillArtifactParticipantInTx`** 合同（provider 中性）；
2. 两个 provider 的实现放 RC 的 `infrastructure/`，装配出口放 RC 的 `composition/`——
   **不从 `public/` 出 provider 适配器**（RFC-349 的 provider-cutover 账本「只能缩不能涨」）；
3. intent 的 `ports/skillArtifacts.ts` 只声明它要的窄形状，**由 bootstrap 注入**——
   RFC-294 的目标边表里有 `intent → resource-catalog`，但装配仍走根，理由见 RFC-353 §10 第 1 条。

**已知代价**：这会像 RFC-353 一样在 `cli/start.ts` / `server.ts` /
`cli/postgresqlDaemonApplication.ts` 各加一条 bootstrap→module 入账边。按 RFC-353 §9 立下的口径，
验收时**如实记数字**，不写「全局债不增」。

## 5. 诊断词汇统一

当前分叉的四条 `log.warn` 标签：

| 标签 | 现状 | 处置 |
| --- | --- | --- |
| `intent-left-retryable` | 仅 SQLite | 合并后成为共有 |
| `intent-converge-left-retryable` | 仅 SQLite | 合并后成为共有 |
| `intent-resource-abort-failed` | 仅 PostgreSQL | 合并后成为共有 |
| `intent-resource-roll-forward-recovery-failed` | 仅 PostgreSQL | 合并后成为共有 |

**15 条用户可见错误码一条不动**——`design.md` 的测试策略会用一条集合相等断言把它钉死。

## 6. 路由收口

`routes/intentSessions.ts`（1088 行）→ `modules/intent/inbound/intentSessionRoutes.ts`，
按 RFC-353 T8 的形态收成 decode-call-map：解出 authority/viewer → 调 application → 映射出参。
路由里自持的业务判断（若有）收回 application，判据进 domain。

**wire 面逐字冻结**：五条 `/api/intent-sessions*` 的 method / path / permissions / tokenAccess /
出参形状与错误码全部不变，由契约注册表（`tests/contracts/registry.ts`）与 e2e 双锁。
迁位后必须同步扩两个 HTTP 守卫的扫描面——RFC-353 T8 已经把 `src/modules/*/inbound/**`
加进 `api-contract-coverage` 与 `route-error-code-coverage`，本刀**沿用即可，无需再改**。

## 7. 失败模式与未决项

| # | 项 | 处置 |
| --- | --- | --- |
| R1 | `postgresqlIntentApplyArtifactOwners.ts` 在 SQLite 侧无对应物 | **T0 已查清，见 §7.1**：两者都不是——是同一能力被实现在了边界的错误一侧 |
| R2 | `dumpBuilder.ts` 928 行含大量逐字文本（inventory 截断说明、redaction 说明） | 迁位时按 RFC-353 T4 的教训加**字节级绊线**（长度 + digest），防手抄漏字 |
| R3 | 两份 apply 合并时取错侧 | §2 逐段对照表 + §8 的先红后绿等价 oracle |
| R4 | 5136 行平移量大，易与并发 session 撞车 | 开工前 `git fetch` 看 tip；按路径精确 `git add`，**提交前逐 hunk 认领**（RFC-353 §11.1 的教训） |

## 8. 测试策略

**A 类：行为 oracle（除 import 路径外一行不改）**

- `rfc234-apply-changeset.test.ts` —— apply 的错误码与重放语义
- `rfc291-*` intent 改单夹具
- `e2e/intent-builder.spec.ts` 三幕
- `rfc349-*` 家族里涉及 intent 的双 provider 用例

**B 类：本刀自带的新守卫**

1. `rfc355-intent-resource-plan.test.ts` —— `intentResourcePlanOf` 提进 domain 后的判据矩阵
   （update 需 fence、plugin 的 options 剥离、copiedFromHandle 解析），**并加源码断言：
   两个 provider 文件里不得再出现这个函数**。
2. `rfc355-intent-apply-equivalence.test.ts` —— **先红后绿**：同一份 session/draft/changeset，
   两个 provider 走完 apply 后 receipt 与 journal 终态逐字段相等。改造前它必须因「两份实现」而红。
3. `rfc355-intent-diagnostic-vocabulary.test.ts` —— 两个 provider 的诊断标签集合相等；
   15 条用户可见错误码逐条列出（集合相等，新增/删除都红）。
4. `rfc355-intent-inbound.test.ts` —— 路由只 decode-call-map 的源码锁 + 旧路径必须不存在。
5. `rfc355-intent-verbatim.test.ts` —— `dumpBuilder` 等逐字文本的字节级绊线。
6. `rfc355-intent-rc-boundary.test.ts` —— `modules/intent/**` 不得出现
   `modules/resource-catalog/{infrastructure,application,domain}`。

**C 类：先红后绿**

B2 与 B3 必须在改造**前**就能复现两份实现的差异（B3 今天即红：四条标签分叉），再由实现转绿。


## 7.1 T0 结论：`postgresqlIntentApplyArtifactOwners` 是「同一能力实现在边界错误一侧」

实读 `c7c6fb81b` 的两条路径：

| | SQLite 路径 | PostgreSQL 路径 |
| --- | --- | --- |
| 技能工件 stage / 发布 | 注入 **resource-catalog 自己的** `aggregateAdapters/legacyIntentApplyResourceParticipants.ts`（`stageSkillVersion` L258/L1042） | intent 自带 `postgresqlIntentApplyArtifactOwners.ts` 的 `createPostgresqlIntentSkillArtifactLifecycle`（288 行） |
| 插件生成 / 安装 | 同上（`plannedGenerationDir` / `installPlugin` 由 RC 注入，L229/L1018） | intent 自带 `createPostgresqlIntentPluginArtifactLifecycle`，直接 `import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'` |
| 对 RC 内部的依赖 | 无（RC 自己用自己的） | **深取 `skillFsPublish` / `skillHash` / `skillIdentityPaths`**——30 条 `temporary-internal-debt` 里 13 条出自这一个文件 |

所以：

- **不是** PostgreSQL 特有的持久化机制细节（能力本身两侧相同：建/改技能版本的暂存与发布、插件生成目录与安装）；
- **也不是** SQLite 漏实现的业务面（SQLite 有，只是由**正确的 owner**（resource-catalog）提供）；
- 而是 **PostgreSQL 路径把 RC 的能力在 intent 里重写了一遍**，并因此深取 RC 的内部实现。

**对 T6 的影响（设计因此收紧）**：目标不是「给 SQLite 补一个 ArtifactOwners」，而是
**让 PostgreSQL 路径改用 RC 的 owner 实现**——RC 出一个 provider 中性的技能/插件工件 participant，
两个 provider 的 intent 都从那里取。`postgresqlIntentApplyArtifactOwners.ts` 整个删除。

**对 §2 对照表的影响**：表中「工件归属」那一行的裁决由「必须查清」改为
**「删 PostgreSQL 侧的拷贝，两侧统一走 RC participant」**。
