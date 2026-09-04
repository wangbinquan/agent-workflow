# RFC-355 —— Intent bounded context 归位（RFC-294 W4-E4a）

- 状态：**Done**（2026-09-04 落地；验收见 §9）
- 关联：RFC-294 §1.1 W4-E4a；前置 RFC-353（W4-E3，Done）、RFC-352（W4-E2，Done）、RFC-345（W4-C，Done）
- owner 波次：W4-E4a
- current-source pin：`c7c6fb81b`

## 1. 背景

`modules/intent/` 已经存在（33 文件 / 9730 行，domain·application·infrastructure·composition·public 五层），
但**它并不是 intent 的全部**。摸底（`c7c6fb81b` 的 committed census）给出的分母：

| 面 | 数字 | 说明 |
| --- | ---: | --- |
| W4-E4a exact 边 | 176 | `legacy-inbound` 117 / `temporary-internal-debt` 30 / `legacy-outbound` 29 |
| W4-E4a facade | 18 | **17 个 `legacy-implementation` + 1 个 `thin-facade`**，目标层全部是 `intent/application` |
| 搁浅在 `services/intent/` 的实现 | 5136 行 | 最大三个：`dumpBuilder.ts` 928、`resolveChangeset.ts` 822、`turnEngine.ts` 726 |
| `routes/intentSessions.ts` | 1088 行 | 全仓最大的路由文件之一 |

exact 边的 owner 高度集中：176 条里 **153 条 owner=intent**，是目前所有未开工 W4-E 切片里
自足性最好的一块（对照：W4-E1 844 条但 owner 是 task-execution、W4-B 186 条 owner 是 integration）。

## 2. 立项前查明的三处真问题

不是「把文件搬个位置」。摸底实读源码后，有三件事必须在这一刀里处理，否则搬完就是给债换门牌：

### 2.1 apply 编排在两个 provider 上是**逐行并行的两份**

`intent-apply`（claim → 解析 changeset → 资源计划 → 落工件 → settle → 收敛日志）在仓里有两份：

| | SQLite | PostgreSQL |
| --- | --- | --- |
| 主文件 | `sqliteIntentApplyOperations.ts` 842 行 | `postgresqlIntentApplyOperations.ts` 684 行 |
| 工件生命周期 | `sqliteIntentApplyArtifactLifecycle.ts` 136 行 | `postgresqlIntentApplyArtifactLifecycle.ts` 435 行 |
| 工件归属 | **无** | `postgresqlIntentApplyArtifactOwners.ts`（独有） |
| 日志收敛 | `convergeIntentApplyJournal`（同文件内函数） | `createPostgresqlIntentApplyJournalConvergence`（独立工厂） |
| session 串行锁 | `withSessionApplyLock`（15 行） | `withSessionLock`（**同一算法，另写一遍**） |

两侧的 claim 段逐条对应——同样先查 session 归属、再查 `clientMutationId` 重放、再判 `active` /
`inFlightTurnId` / `draftHash` / `contextRevision`——但**写在两个文件里**。任何一次业务变更都要改两遍，
而「改两遍」正是 RFC-352 与 RFC-353 各自开局撞到的那个漂移源。

### 2.2 诊断词汇已分叉，且 **apply 层的用户可见行为已经真的漂了**（T1 实测更正）

两个 apply 实现的字符串标识做集合对比：

- **共有 15 条**用户可见错误码（`intent-session-not-found` / `intent-draft-hash-mismatch` /
  `intent-apply-unsettled` / `intent-baseline-stale` … ）——**用户可见面目前一致**；
- **只在 SQLite**：`intent-left-retryable`、`intent-converge-left-retryable`；
- **只在 PostgreSQL**：`intent-resource-abort-failed`、`intent-resource-roll-forward-recovery-failed`。

这四条是 `log.warn` 的标签，不是抛出的错误码——运维在两种部署上 grep 同一类失败拿到不同的词。

**但立项时写的「用户可见契约尚未漂」是错的**。T1 落先红 oracle 时实测发现，
`intent-changeset-invalid` 这一条在 **apply 层已经是真实的行为差异**：

| 输入 | PostgreSQL | SQLite |
| --- | --- | --- |
| draft 的 `changesetJson` 不可解析 | `ValidationError('intent-changeset-invalid')`，带具体 parse 错误 | **裸 `JSON.parse` → 未分类 `SyntaxError`**，对客户端是 500 而不是带码的 4xx |
| 可解析但不是合法 IntentChangeset | 同上，被挡下 | **完全不校验**，直接喂进 `preflight` / `resolveIntentBundle` |

PostgreSQL 侧 `parseIntentChangeset(claim.draft.changesetJson)` 后判 `ok`；
SQLite 侧是 `const changeset = JSON.parse(claim.draft.changesetJson)`（preflight 段）。
`parseIntentChangeset` 本来就在 `@agent-workflow/shared`，两侧都能用，SQLite 只是没用。

既有覆盖只在 **turn-engine 层**（`rfc234-turn-engine.test.ts` 断言 agent 产出非法 changeset 时报
`intent-changeset-invalid`），**apply 层这条路径从来没测过**——draft 落库之后才损坏、
或由更早版本写入的非法内容，走的正是这里。

`rfc355-intent-apply-changeset-validation.test.ts` 已把它变成两条先红用例
（实测 SQLite 抛 `SyntaxError: JSON Parse error: Expected '}'`），由 T4 合并编排时转绿。

### 2.3 intent 深取 resource-catalog 的技能文件机制（30 条）

30 条 `temporary-internal-debt` **全部**是 `modules/intent/infrastructure/*` →
`modules/resource-catalog/infrastructure/*`，取的是 RC 的 legacy 技能机制：
`skillFsPublish`、`skillIdentityPaths`、`skillHash`、`skillVersion`、`skillBootVerify`、`skill.ts`、
`skillOperations`，以及 RC 的 `aggregateAdapters/*IntentApplyResource*`。

这是 RFC-317 R2 明令禁止的跨 context 内部 import，也**正是 RFC-353 刚解决过的同一类问题**——
那一刀给 resource-catalog 落了 `SkillVersionCommitParticipantInTx` 与 `composition/skillVersionCommit.ts`
装配出口，并确立了「跨 context 的 provider 装配一律在 bootstrap / system-operation 根上完成」。
本刀直接沿用同一形态，不重新发明。

## 3. 目标

1. `services/intent/` 归零：18 个文件（5136 行）迁入 `modules/intent/{domain,application}`，facade 全部删除。
2. apply 编排收成**一份 provider-neutral application**，两个 provider 只剩「怎么读、怎么写、怎么开事务」的薄 adapter；
   session 串行锁、claim 判据、settle 重验、日志收敛各只有一处实现。
3. 30 条 `intent → resource-catalog/infrastructure` 深取归零：改经 RC offered participant（形态复用 RFC-353）。
4. `routes/intentSessions.ts` 迁入 `modules/intent/inbound/` 并收成 decode-call-map。
5. 诊断词汇统一：两个 provider 对同一失败类使用同一组标签（当前分叉的四条各归其位或收成一条）。

## 4. 非目标

- **不带任何用户可见的新功能**（用户 2026-09-04 裁决 D4）。这一刀是纯架构刀，wire 面逐字冻结。
- 不动 intent 的产品语义：turn 引擎的生成行为、dump 的内容与截断规则、working-set 的 mount 语义、
  changeset 的解析与冲突规则，全部保持现状，由 §7 的行为 oracle 钉死。
- 不做 RFC-294 的「bootstrap 唯一装配」（各根逐个注入收成一个装配入口）——那是 W5 / W9 的活，
  本刀反而会像 RFC-353 一样**增加**几条 bootstrap→module 的入账边，如实记在 §7 的验收里。
- 安全加固类一律不承接（用户 2026-08-26 硬规则）：不做事务内二次重验、不加并发竞态终检、
  不写存在性 oracle。§2.1 提到的 session 串行锁只做「两份合成一份」的**去重**，不改其并发语义。

## 5. 用户故事

本刀无用户可见变更。受益方是维护者：

- **改一次 intent 的 apply 行为，只需要改一处**——今天要在 SQLite 与 PostgreSQL 两个文件里各改一遍，
  漏一边就是「同一操作在两种部署上行为不同」，而这类 bug 只有切换 provider 才会暴露。
- **在两种部署上排查同一类失败，grep 到的是同一组词**——今天不是。
- **读 intent 的实现不用先分辨「这段在 services/ 还是 modules/」**——今天 5136 行在前者、9730 行在后者，
  且两边互相 import。

## 6. 能力影响清单

本刀**不关闭、不收缩任何既有能力**（RFC workflow 第 7 条的门槛因此不触发）：

- 五条 `/api/intent-sessions*` wire 面（method / path / permissions / 出参形状 / 错误码）逐字不变；
- 15 条用户可见错误码一条不删、不改语义；
- 两个 provider 的部署形态、启动顺序、daemon handle 均不变；
- 唯一「减少」的是 `services/intent/**` 这 18 个文件的 import 路径——它们没有外部消费者，
  §7 的 AC-2 逐条验证。

## 7. 验收标准

- **AC-1** `packages/backend/src/services/intent/` 目录不存在；18 个 facade/legacy-implementation 全部删除，
  生产 consumer = 0。
- **AC-2** 删除前逐个文件确认外部 consumer 为零或已改指 `modules/intent/public/*`；转交出去的逐条记账。
- **AC-3** apply 编排只有一份 provider-neutral 实现：claim 判据、settle 重验、session 串行锁、
  日志收敛四处各只有一个源；两个 provider 的 adapter 里不再出现这四类判断。
  **变异测试**：把任一 provider 的 adapter 换成另一半的实现必红。
- **AC-4** `modules/intent/**` 不 import 任何 `modules/resource-catalog/{infrastructure,application,domain}/**`；
  30 条 `temporary-internal-debt` 归零，改经 RC offered participant。
- **AC-5** 两个 provider 的诊断标签集合相等（当前分叉的四条收敛）；15 条用户可见错误码一条不变。
- **AC-6** `routes/intentSessions.ts` 不存在；路由住在 `modules/intent/inbound/`，文件内无 DB / OCC /
  资源计划 / 工件编排；`/api/intent-sessions*` 的 wire 面逐字不变（契约注册表断言）。
- **AC-7** 行为 oracle 全绿且**除 import 路径外一行未改**（清单见 §8）。
- **AC-8** W4-E4a 自有 exact ids 归零；转交出去的逐条带 owner 与 removeWave；
  **全局 exception 的净变化如实记账**（本刀预期会增加若干 bootstrap→module 入账边，
  按 RFC-353 §9「AC-12 的更正」立下的口径，**不写「不增」**，写实测数字与逐条归因）。
- **AC-9** exact-SHA hosted CI 终态成功（run 级 `conclusion == success`；并发 push 取消时按含本提交的后继 SHA 判）。

## 8. 行为 oracle（除 import 路径外一行不改）

摸底已确认这些是 intent 的行为预言，迁位不得改动它们的断言：

- `rfc234-apply-changeset.test.ts`（含 `intent-draft-hash-mismatch` 等错误码断言）
- `rfc291-*` intent 改单夹具
- intent builder 的 e2e 三幕（`e2e/intent-builder.spec.ts`）
- 双 provider 对拍类用例（`rfc349-*` 家族中涉及 intent 的部分）

具体文件清单与逐条对应关系在 `design.md §测试策略` 里钉死；任何行为漂移都会在那里变红。

## 9. 风险与诚实估计

| 面 | 规模 | 风险 |
| --- | ---: | --- |
| 纯平移（`services/intent/*` → `modules/intent/*`） | 5136 行 | 低，但量大；`dumpBuilder` 928 行含大量逐字文本，需按 RFC-353 T4 的教训加**字节级绊线** |
| apply 编排双份合一 | ~1500 行 → 一份 + 两个薄 adapter | **本刀最大风险**：两份拷贝已分头演进，合并时必须逐段确认「哪一侧是对的」，不能默认取其一 |
| RC 深取切 participant | 30 条边 | 中，形态已由 RFC-353 验证过 |
| 路由迁位 + 收 decode-call-map | 1088 行 | 中；wire 面由契约注册表与 e2e 双锁 |

**最大的风险是合并两份 apply 时悄悄改了行为**。对策同 RFC-353：先落双 provider 等价 oracle（先红），
再合并（转绿）；`design.md` 会把两份实现逐段对照成一张表，差异处逐条标注「取哪一侧、为什么」。


## 9. 验收结果（2026-09-04）

### 9.1 逐条对照

| AC | 结论 | 取证 |
| --- | --- | --- |
| **AC-1** `services/intent/` 归零 | ✅ | 目录不存在；18 个文件里 16 个 `git mv` 平移进 `modules/intent/{domain,application}`、1 个（`legacyIntentApplyResourceDependencies.ts`）迁进 resource-catalog 的 composition、2 个兼容门面删除。`facades.json` 里提到 `services/intent` 的行 **18 → 0** |
| **AC-2** consumer 逐条确认 | ✅ | 63 个文件、135 处引用脚本化改指；`postgresqlApplyChangeset.ts` 零 consumer 直接删；`applyChangeset.ts` 的装配正身收进 `modules/intent/composition/apply.ts`，10 个测试改指该处 |
| **AC-3** apply 编排单一实现 | ⚠️ **部分达成**，见 §9.2 | 判据、串行锁、诊断词汇、收敛决策、**大事务内的全部计算**已各只有一份；**事务机制本身仍是两份**（设计裁决，见 §9.2） |
| **AC-4** 30 条深取归零 | ⚠️ **28/30**，剩 2 条纯类型 | `modules/intent/**` 不再 import RC 的 `infrastructure/legacy/**`；剩 `postgresqlIntentApplyResourceParticipants` 的 `PostgresqlIntentApplyArtifact` 类型两处引用，见 §9.3 |
| **AC-5** 诊断词汇统一、错误码不变 | ✅（**数字两次更正**：不是 15 条，是 **36** 条） | `INTENT_APPLY_DIAGNOSTICS` 一处定义两侧共用（四条分叉标签收敛）；apply 面真正被 `throw` 出去的标识在 pin `c7c6fb81b` 与收工时**集合逐字相同**，由 `rfc355-intent-provider-parity` 的精确清单断言（增删都红）。立项时 §2 写的「共有 15 条用户可见错误码」是把 `log.warn` 标签与抛出的错误码混在一起数的。**第一版更正也没数对**：清单只手挑了 7 个文件，实现门第二路实测在 `application/resolveChangeset.ts`（同样在 apply 路径上、自带 9 个 `intent-*` 码）新增一个全新错误码照样全绿，而且反引号写法即使写在清单内文件里也漏抓。现在的清单覆盖真正的 apply 路径（两个 provider 编排 + SQL 持久化 + 共享判据 + changeset 解析），实测 pin 与收工时都是**同样的 36 条、零增删**，两种此前能溜进去的写法现在都变红。两次更正**都不是**放宽验收，是把当初数错的分母改对；集合本身自始至终一条没变 |
| **AC-6** 路由 decode-call-map + wire 冻结 | ✅ | `routes/intentSessions.ts` 不存在；`modules/intent/inbound/intentSessionRoutes.ts` 1094 → 836 行，详情 handler 的 ~180 行编排收进 application、两条判据进 domain；`api-contract-coverage` / `route-error-code-coverage` / 契约注册表全绿 |
| **AC-7** 行为 oracle 除 import 外未改 | ✅ | 16 个平移文件 git 认出的都是 rename，除 `dumpBuilder.ts` / `turnEngine.ts` 各一行相对 import 外内容一字未动（design §7 R2 要的字节级绊线——没有手抄，绊线的目的结构性地不存在） |
| **AC-8** W4-E4a 归零 + 全局净变化如实记账 | ⚠️ **176 → 41**，未归零；全局 **净减 116** | 见 §9.4 |
| **AC-9** exact-SHA hosted CI success | ✅ | `bec6c29f0` run `33834461744` **run 级 conclusion == success**（覆盖 T4/T6/T7/T8/T9）；T4b 的取证见 §9.5 |

### 9.2 AC-3 的诚实结论：合并到「事务机制」为止

`design.md §3` 当初的设想是 application 出计划、provider 开事务，两份编排合成一份。实际落地
到「**大事务内的全部计算**收成一份、事务机制留在 provider」为止，理由在 design §3 已经写明并
在落地时再次确认：`dbTxSync`（SQLite，同步回调）与 `db.transaction`（PostgreSQL，async）的形状
不同，同步事务回调里 `await` 会让事务在 Promise 兑现前提交（RFC-353 实测过）。硬把事务反转进
application 只会得到一个「两边都用不满」的抽象。

因此现在的分法是：

- **一份**：claim 判据（`domain/applyClaim`）、changeset 解码（`domain/storedChangeset`）、
  资源计划（`application/intentResourcePlan`）、串行锁（`application/sessionApplyLock`）、
  收敛决策与诊断词汇（`application/journalConvergence`）、重放三档（`application/applyReplay`）、
  **大事务内的基线重验 / bundle 内创建名 / plan↔op 同序 / receipt 行 / 谱系与新 manifest /
  handle 水位**（`application/applyCommitPlan`）；
- **两份**：`applyInner` / `applyUnlocked` 的**步骤序列与读写机制**（各 ~200 行，主体是
  `tx.select/update` 与 `await transaction.…` 的机制差异）。

两个 provider 的 apply 文件因此从 842/684 行降到 653/520 行。**AC-3 原文写的「四处各只有一个源」
（claim 判据 / settle 重验 / 串行锁 / 日志收敛）确实全部达成**；「编排只有一份实现」这一句在
事务机制层面没有达成，且按设计裁决**不应**达成。变异测试以 `rfc349-dual-provider-predicate-drift`
的 exact 清单承担（同名顶层函数实现不同即红），本刀把该清单从 18 降到 17。

### 9.3 AC-4 的剩余 2 条

`modules/intent/infrastructure/postgresql{IntentApplyOperations,IntentApplyArtifactLifecycle}.ts`
仍 `import type { PostgresqlIntentApplyArtifact }`。这是**纯类型**边，两处都登记在
`rfc355-intent-provider-parity.test.ts` 的 `DEEP_IMPORT_DEBT` 精确账本里（只能缩不能涨）。
彻底消除要把该工件分类搬到某一侧独占：搬给 intent 则 RC 的适配器反向依赖 intent，搬给 RC 则
intent 的 journal 契约由别的 context 定义——两条路都得连带动 RC 的 `public/`，超出本刀范围。

### 9.4 AC-8：数字与逐条归因

| 面 | 开工（`c7c6fb81b`） | 收工 | 变化 |
| --- | ---: | ---: | ---: |
| W4-E4a exact ids | 176 | **41** | **−135** |
| 其中 legacy-inbound | 117 | 34 | −83 |
| 其中 temporary-internal-debt | 30 | 5 | −25 |
| 其中 legacy-outbound | 29 | 2 | −27 |
| facade 行（提到 `services/intent`） | 18 | **0** | −18 |
| **全局 exception 总数** | 5313 | **5197** | **−116** |
| `services/intent/` 行数 | 5136 | **0** | −5136 |
| `routes/intentSessions.ts` 行数 | 1088 | **0**（inbound 836 行） | −1088 |

**没有归零，原因写清**：剩下的 34 条 `legacy-inbound` 全部是 bootstrap（`server.ts` /
`cli/start.ts` / `cli/postgresqlDaemonApplication.ts` / `platform/background/maintenanceWorker.ts`）
指向 `modules/intent/{composition,application}` 的装配边。**那正是 RFC-294 的目标形态**——装配
只在根上做；它们仍被记成 `legacy-inbound`，只因为 bootstrap 文件本身还住在 `src/cli` /
`src/server.ts`，把它们搬出 legacy 目录不在本刀的刀口内（且会影响所有 context）。
剩 5 条 `temporary-internal-debt`：2 条是 §9.3 的纯类型边，3 条是 intent 的 composition 向 RC 的
composition 要 provider 适配（RFC-353 立下的 bootstrap 装配口径，形态正确）。
剩 2 条 `legacy-outbound`：`infrastructure/intentSessionWsProjector.ts` → `@/ws/broadcaster`
的值 / 类型两记，是**专职投影文件**，与 task-execution / collaboration 的既有形态一致。

**与 RFC-353 的对比**：那一刀因为把跨 context 的 provider 装配收到 bootstrap，全局 exception
净增 17；本刀净**减** 116——差别在于本刀同时消灭了 `services/intent/` 整目录与 18 个 facade，
减掉的边远多于装配边带来的增量。这个数字按 RFC-353 §9 立下的口径直接实测，没有做任何折算。

### 9.5 落地链

`68ea535e1`（先红 oracle 收成账本）→ `a6bf2193a`+`5cd217e9f`（T6 技能工件补偿归 RC）→
`2f54a8be8`+`5cdc712a6`（T7 整目录归位）→ `9ef861059`+`948efb1d4`（T8 路由归位 + decode-call-map）
→ `7caf1e91f`+`391dd7efb`（T7 修红：Actor 收窄归 auth）→ `c31844a30`+`bfe459560`（T9 public 收口）
→ `db8dbf424`+`bec6c29f0`（T4 大事务计算合一）→ `b21d102c2`+`b8f02ad92`+`83be39dc0`（T4b 会话事件端口）。
