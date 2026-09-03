# RFC-353 —— Knowledge Evolution bounded context 归位（RFC-294 W4-E3）

- 状态：Draft（2026-09-03；待用户批准）
- 关联：RFC-294 §3.2 N17 / §W4-E3；前置 RFC-352（W4-E2，Done）、RFC-345（W4-C，Done）、RFC-344（W4-A，Done）
- owner 波次：W4-E3

## 1. 背景

RFC-294 的目标架构里有一个叫 **`knowledge-evolution`** 的 bounded context，它「唯一拥有 fusion aggregate、
iteration / 最终 approve/reject 状态机、skill-restore coordinator 与 memory↔skill provenance」
（`design.md §10`、能力表 §638）。

**今天这个 context 在源码里根本不存在**——`packages/backend/src/modules/knowledge-evolution/` 是空的。
它该拥有的东西散在四处：

| 今天在哪                                                                  |     行数 | 内容                                              | design 说该归谁            |
| ------------------------------------------------------------------------- | -------: | ------------------------------------------------- | -------------------------- |
| `services/fusion.ts`                                                      |     1218 | fusion 编排 + 状态机 + worktree seeding + 恢复     | KE `domain`/`application`  |
| `modules/memory/public/fusion.ts`                                         |      201 | `FusionPersistence` / `FusionOperations` 全套端口  | **KE `public`**            |
| `modules/memory/infrastructure/{sqlite,postgresql}FusionPersistence.ts` 等 |     2062 | fusion 持久化双 provider + support                 | KE `infrastructure`        |
| `routes/fusions.ts`                                                       |      226 | 7 个端点                                          | KE `inbound`               |
| `RC infrastructure/legacy/skillVersion.ts:878-979`                        |      102 | `restoreSkillVersion` + `memoriesToUnfuseOnRestore` | **KE**（skill-restore）    |
| `services/skillVersion.ts`                                                |        3 | facade，唯一生产 consumer 是 intent 的一个 type import | 直接删                     |

RFC-352 收口时按 owner 转交给 W4-E3 的 9 条 exact 边正在这里：`services/fusion.ts` 消费
`memory/public/fusion` 与 `memory/public/catalog` 的 8+1 条。W4-C（RFC-345）转交下来的
`services/memory.ts` facade 也挂在这条链上——它剩下的 RC consumer 正是 `legacy/skillVersion.ts` 的
`unfuseMemoriesTx`。**转交项不该躺着**：W4-C 转给 E2 的东西 RFC-352 消化了，E2 转给 E3 的这一批该由本 RFC 消化。

### 1.1 立项前查明的两处真问题

这两条不是「顺手优化」，是本刀不做就等于白搬的东西。

**① fusion 持久化今天是跨聚合 god repository。**
`sqliteFusionPersistence.ts`（875 行）直写 `fusions`(69 处) / `skills`(20) / `skill_versions`(15) /
`memories`(13) / `workflows`(12) / `agents`(6) / `resource_grants`(6)。
而 design 给 KE 的**禁止清单第一条**就是「memory/skill row」（§638）。
把它原样 `git mv` 进 `modules/knowledge-evolution/infrastructure/`，等于给债换个门牌——
新 context 一出生就带着一个 design 明令禁止的形状，下一刀还得重开。

**② 同一判据在两个 provider 上一份有、一份没有。**
PostgreSQL 侧已经有 `modules/memory/infrastructure/postgresqlSkillMemoryFusionParticipant.ts`
（62 行，注释自称「Memory-owned half of Skill restore」），正是 design 要的
`MemoryMembershipParticipantInTx` 形状；**SQLite 侧却是 `legacy/skillVersion.ts` 直接
`import { unfuseMemoriesTx } from '@/services/memory'`**。
这与 RFC-352 开局撞到的 `canManage` 漂移是同一类：同一件事两个来源、各自演进。
RFC-352 已经为这一类立下处置——收成一个 owner 出口——本刀照办。

### 1.2 用户可见的缺口：溯源只有一个方向

融合把记忆写进技能之后：

- **memory → skill 方向已有**：`MemoryRow` 会显示 `fused into {skill} v{n}` 的 chip；
- **skill → memory 方向今天完全看不到**：`SkillVersionHistory` 只显示版本号、来源 chip、changelog、
  回滚来源与作者，**看不出「这一版到底融进了哪几条记忆」**。

数据其实齐备（`skill_versions.source='fusion'` + `fusion_id`，`memories.fused_into_skill_id` /
`fused_into_skill_version` / `fused_at`），缺的只是查询与展示。design §638 把
`GetSkillProvenance` 列为 KE 的 public query，今天一个 provenance 查询都不存在。

## 2. 目标

- **G1** 建立 `modules/knowledge-evolution`，让它成为 fusion aggregate、fusion 状态机与 skill-restore
  coordinator 的唯一 owner；`services/fusion.ts` 与 `services/skillVersion.ts` 两个 facade 归零。
- **G2** fusion 持久化不再直写 memory / skill 行：换成 memory offered `MemoryMembershipParticipantInTx`
  与 resource-catalog offered `SkillVersionParticipantInTx`，**两个 provider 共用同一份判据**，
  顺带补齐 SQLite 侧缺失的 participant 并退役 `services/memory.ts` 的最后一个 RC consumer。
- **G3** skill-restore coordinator（`restoreSkillVersion` + `memoriesToUnfuseOnRestore`）迁入 KE，
  **operation id `skill-catalog.restore-skill-version.v1` 与 wire 逐字不变**。
- **G4** 落 KE public query `GetSkillProvenance`，在 `SkillVersionHistory` 的 fusion 版本行下展开
  「本版融入的记忆」。
- **G5** W4-E3 桶里属于 KE 自己、且修法在自己文件里的 exact id 归零；不属于 KE 的按 owner 转交并逐条记账。

## 3. 非目标

- **不改融合的产品行为**：状态机、迭代次数、澄清必答、worktree seeding、approve/reject/cancel 的语义、
  失败恢复（`repairFusionProvenance` / `recoverFusionDecisions`）逐字不变。
- **不做安全加固**。design §W4-E3 原文里的「provenance query 不泄不可见 id/count」是安全项，
  按用户 2026-08-26 硬规则**不承接**：本刀只按显式功能需求实现「溯源只返回调用者可见的记忆」
  （复用 memory 既有的可见性过滤），不做侧信道分析、不加加固层、不评价其安全性。
- **不落 memory offered `MemoryProvenanceVisibilityQuery` 与 RC offered `SkillProvenanceVisibilityQuery`**
  这两个 design 列出的独立查询面——G4 只需要 KE 自己的 `GetSkillProvenance` 加上既有的可见性过滤。
  两者留作后续（若真出现第二个消费者）。
- **不动 `services/fusion.ts` 之外的 task 启动链**：`task-execution` 的
  `fusionEngineTaskOperations` 已经是正确形状（KE 经 TE public port 启动普通 task），原样保留。
- **不把 fusion 的 7 个路由改造成 OperationCatalog descriptor**：那是 W4-A/W4-B 的形态问题，
  本刀只把路由收成 decode/call/map。
- 不改 schema / migration；不改任何既有 wire。

## 4. 用户故事

- **US-1**（技能维护者）我在技能详情页看版本历史，看到 v3 是一次融合产出的；**我想知道这一版到底把哪几条
  记忆写进来了**，好判断这次融合是不是把我要的经验收进去了。今天我只能看到一句 changelog。
- **US-2**（技能维护者）我把技能回滚到 v1，被 v2/v3 融进去的记忆应当退回待用状态、能重新参与融合。
  这件事今天是对的，回滚之后我不希望它变错。
- **US-3**（平台管理员）融合流程本身——发起、澄清、审批、拒绝重跑、取消、daemon 重启后的半状态恢复
  ——在这次重构前后必须一模一样。

## 5. 能力影响清单（RFC workflow 第 7 条）

本 RFC **不关闭、不收缩任何既有能力**。逐项对照：

| 既有能力                                                              | 本刀之后                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST/GET /api/fusions`、`:id`、`:id/approve|reject|cancel`、`pending-count` | 路径、入参、响应、错误码、权限逐字不变；实现从 `services/` 迁到 KE       |
| `skill-catalog.restore-skill-version.v1`（含 MCP 绑定）               | operation id、input/output schema、`unfusedMemoryIds` 语义逐字不变        |
| `GET /api/skills/:id/versions` 及 diff/content/restore                | 不变                                                                     |
| 融合的失败恢复（provenance repair / decision recovery / reconcile 循环） | 行为不变；`fusion-reconcile` 仍注册为同一个可暂停 daemon handle           |
| memory 的 `fused` 状态与 `MemoryRow` 的 chip                          | 不变                                                                     |
| `services/fusion.ts` / `services/skillVersion.ts` 两个 legacy 入口     | **删除**——但两者都是 backend 内部 import 路径，不是 wire/CLI/配置面      |

**新增**（G4）：`GET /api/skills/:id/provenance` 与前端版本行的展开区。纯增量，既有调用者零改动。

## 6. 用户拍板记录（2026-09-03）

| # | 问题                                       | 裁决                                                                       |
| - | ------------------------------------------ | -------------------------------------------------------------------------- |
| D1 | 下一刀切 RFC-294 的哪一部分？             | **W4-E3 knowledge-evolution**                                              |
| D2 | 切多深？跨聚合直写要不要本刀换 participant？ | **归位 + 切 participants**——E3 原文本就含「skill/memory exact-set tx participants 收口」 |
| D3 | skill-restore coordinator 迁不迁？         | **迁**；RC 保留 skill 版本机制并提供 `SkillVersionParticipantInTx`          |
| D4 | 三个 provenance 查询面落不落？             | **只落 KE 的 `GetSkillProvenance`**                                        |
| D5 | 溯源的用户可见形态？                       | **版本行展开列融入的记忆**（不新开页面）                                    |

## 7. 验收标准

- **AC-1** `packages/backend/src/services/fusion.ts` 与 `services/skillVersion.ts` 已删除，生产 consumer = 0。
- **AC-2** `modules/knowledge-evolution/**` 不 import 任何 `@/services/fusion*`、`@/services/skillVersion`、
  `@/services/memory`；不直接 import 其它 context 的 `application/` / `infrastructure/` / `domain/`。
- **AC-3** `modules/memory/public/fusion.ts` 已删除；fusion 端口住在 `modules/knowledge-evolution/public/`，
  memory 的 public 面不再出现 fusion aggregate 的持久化契约。
- **AC-4** KE 的 fusion 持久化**不再直写** `memories` / `skills` / `skill_versions` 三张表：
  两个 provider 的 fusion 适配器里对这三张表的引用为 0，改经 memory offered
  `MemoryMembershipParticipantInTx` 与 RC offered `SkillVersionParticipantInTx`。
  变异测试：把任一 provider 的 participant 换成另一半的实现必红。
- **AC-5** SQLite 与 PostgreSQL 两侧的解融合判据**收成一份**（`postgresqlSkillMemoryFusionParticipant`
  的孤儿状态消失）；同一 skill 回滚在两个 provider 上退回同一组 memory id。
- **AC-6** `restoreSkillVersion` 的 owner 是 KE；operation id `skill-catalog.restore-skill-version.v1`、
  input/output schema、`unfusedMemoryIds` 顺序与既有 MCP 绑定逐字不变（源码层 + 契约测试双锁）。
- **AC-7** `routes/fusions.ts` 只 decode/call/map：文件内无 DB / ACL / OCC / 审计 / 工作树操作。
- **AC-8** 融合行为 oracle 全绿且**一行未改**：`fusion-engine.test.ts`(1188 行) /
  `fusion-provenance-repair.test.ts` / `rfc349-fusion-provider-persistence.test.ts` /
  `rfc349-fusion-route-provider.test.ts` / `rfc319-fusion-manifest-merge-back.test.ts` /
  `rfc349-memory-skill-fusion-postgresql-adapter.test.ts`（除 import 路径外）。
- **AC-9** `fusion-reconcile` 仍注册为可暂停 daemon handle，RFC-349 冻结守卫绿；
  `repairFusionProvenance` / `recoverFusionDecisions` 的启动顺序不变。
- **AC-10** `GET /api/skills/:id/provenance` 返回逐版本的融入记忆；**只返回调用者可见的记忆**
  （复用 memory 既有 scope 可见性过滤）；已被后续回滚解融合的记忆不再计入该版本。
- **AC-11** `SkillVersionHistory` 的 `source='fusion'` 版本行可展开列出本版融入的记忆（标题 + scope），
  空集有明确空态；组件复用既有公共原语（§Frontend UI consistency）。
- **AC-12** W4-E3 桶中 KE 自有的 exact ids 归零；转交出去的逐条带 owner 与 removeWave 记账，全局债不增；
  `architecture:write` 重采后各波分母不回升。
- **AC-13** exact-SHA hosted CI 终态成功（并发 push 取消时按含本提交的后继 SHA 判）。
