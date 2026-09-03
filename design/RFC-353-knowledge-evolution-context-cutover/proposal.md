# RFC-353 —— Knowledge Evolution bounded context 归位（RFC-294 W4-E3）

- 状态：**Done**（2026-09-04 实现完成并推上主干；用户 2026-09-03 批准实现）
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
| D6 | ACL 面板撞 409 之后草稿留还是丢？（本刀实施期间由 webkit nightly 暴出，见 §8） | **丢弃草稿、刷回服务端权威值**；同步改 RFC-170 §8 与代码注释 |
| D7 | D6 在哪儿做？                              | **直接做并计入本 RFC**（不另立 RFC）                                        |

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

## 8. 实施期间纳入的范围外修复（用户 2026-09-03 裁决 D6/D7）

T5 推上主干后，`e2e-webkit-nightly`（run `33752894225`）红在
`e2e/rfc319-iam-oidc-and-acl.spec.ts` 的 IAM-33。查明后**不是本 RFC 引入的回归，而是一处既有的
渲染时序竞态**，且暴露出设计文档与既有断言互相矛盾：

- RFC-170 `design.md §8`（G3-8）原写「**409 保留草稿并提示 reload**」，`AclPanel.tsx` 的
  `onError` 也照它写——只 `invalidateQueries`，不动草稿与 OCC fence；
- 而 IAM-33 判据二要求「面板收敛回权威快照」、判据三要求「在刷新后的快照上重做同一改动必须成功」
  （后者需要 fence 被重新武装），**与那句设计意图正好相反**；
- 两者今天同时成立靠的是一帧偶然：刷新期间若恰好有一帧 `query.fetchStatus === 'fetching'`，
  `liveCanManage` 转 false，组件走 `!liveCanManage` 分支清掉 `dirty` 并置空 fence。
  那一帧被 React 批掉就两边落空，面板停在陈旧草稿上（显示 `public`，服务端是 `private`）。

**用户裁决**：以服务端为准、草稿丢弃（D6），直接做并计入本 RFC（D7）。落地：

- `AclPanel.tsx` 的 `onError` 显式 `draftBaselineRef.current = null` + `setDirty(false)`，
  不再依赖渲染时序；**刻意不推进 `manageSessionRef`**——推进它会让 `mutationBelongsToSession`
  转 false，把错误提示一起吞掉，用户就不知道保存失败了；
- RFC-170 `design.md §8` 落勘误段，写清原意图、矛盾、以及为什么改；
- 回归锁 `packages/frontend/tests/rfc353-acl-conflict-draft.test.tsx`（先红后绿：撤掉修复后
  「刷回权威值」当场红）。

**验收补充**：**AC-14** ACL 面板撞 409 后草稿丢弃、面板显示服务端权威值，且弹窗不关、错误提示仍在；
组件层锁死，不依赖渲染时序。


## 9. 验收结论（2026-09-04）

实现落在 `9911b3a05` … `02958a8aa`（T6/T7 在 `6eb8c676b` 一次推上，T8–T11 随后）。逐条对账，
**两条与立项时的措辞不符，如实记在这里而不是悄悄放宽**：

| AC | 结论 | 依据 |
| --- | --- | --- |
| AC-1 | 达成 | `services/fusion.ts`（T5 删）、`services/skillVersion.ts`（T11 删）都已不存在，生产 consumer = 0 |
| AC-2 | 达成 | `rfc353-skill-restore-membership.test.ts` §装配面锁死：RC 侧四个文件里不许出现 `modules/memory` / `modules/knowledge-evolution` |
| AC-3 | 达成 | `modules/memory/public/fusion.ts` 已删，端口住在 `modules/knowledge-evolution/public/` |
| **AC-4** | **部分达成，措辞已更正** | **写入面归零**（两个 provider 的 fusion 适配器里对三张表的 `insert/update/delete` 计数为 0，`rfc353-skill-version-commit-participant.test.ts` 的源码锁守着）。**读取面没有归零**，也不应该归零——见下方「AC-4 的更正」 |
| AC-5 | 达成 | `defec8a0c` 起判据收进 `memory/domain/fusionMembership`，`rfc353-memory-membership-participant.test.ts` 真库全矩阵对拍 |
| **AC-6** | **达成，但 owner 的边界与立项设想不同** | operation id / input / output / `unfusedMemoryIds` **逐字未动**（descriptor 一行没改）。但迁进 KE 的是**成员关系协调**（退回哪些记忆），不是整个 restore——版本铸造与文件系统仍归 RC，见下方「AC-6 的更正」 |
| AC-7 | 达成 | 路由迁至 `modules/knowledge-evolution/inbound/fusionRoutes.ts`，文件内无 DB / OCC / 审计 / 工作树操作；唯一一处 ACL 相关是把 actor 解成 viewer（见下） |
| AC-8 | 达成 | 六份 oracle 除 import 路径与装配入参外一行未改，全绿 |
| AC-9 | 达成 | daemon handle 与启动顺序未动，RFC-349 冻结守卫绿 |
| AC-10 | 达成 | `rfc353-skill-provenance.test.ts`：不可见的记忆不出现且不留计数；已回滚退回的不再计入 |
| AC-11 | 达成 | `rfc353-skill-provenance-expand.test.tsx`：复用 `OperationsExpandButton` + `.data-table__expand*` + `memory-row__scope`，空态文案说明「可能已被回滚或不可见」 |
| AC-12 | 达成 | `PUBLIC_SURFACE_PILOT_DEBT` 回到 10 条（T6 一度加的 7 条随 provider 再导出撤下而消失），RFC-345 的 facade 账本与 exact 兼容边各减一 |
| AC-13 | **达成** | 见下方「AC-13 取证」 |
| AC-14 | 达成 | `rfc353-acl-conflict-draft.test.tsx`；webkit nightly 在 `500a17129` 成功 |

### AC-4 的更正：「引用为 0」应为「**写入**为 0」

立项时写的是「对这三张表的引用为 0」。实现中实测：**写入确实归零**，但**读取有 40 处且都有正当理由**——

- `repairProvenance`（RFC-223 的启动自愈）必须读 `memories` 与 `skill_versions` 才能找出孤儿融合行；
- `loadSkillAccess` / `loadSkillIdentity` / `assertClaimSkill` 必须读 `skills` 才能判断这次融合还能不能落。

把这些读也搬走意味着给每一条读再造一个 participant，换来的是更多的跨 context 往返和更难懂的调用链，
**不是更好的代码**。所以 AC-4 的判据更正为「写入为 0」，读取作为**转交债**记在 §7 的表里（owner：
memory / resource-catalog；随各自下一波收）。源码锁也是按写入面写的。

### AC-6 的更正：迁进 KE 的是「成员关系协调」，不是整个 restore

立项时设想把整个 skill-restore coordinator 搬进 KE。实现时撞到 RFC-294 的目标边表：里面只有
`knowledge-evolution → resource-catalog`，**没有反向边**，而 restore 的入口是 RC 的 operation
descriptor。整体搬迁要么造一条 RC→KE 的反向边（与 KE→RC 一起成环，`implementationSccs` 会红），
要么把 descriptor 也搬走（那会动 `skill-catalog.*` 的挂载方式，与 AC-6「逐字冻结」冲突）。

因此按职责实际的归属线切：**「回滚时该退回哪些记忆」这条判据归 KE**
（`domain/skillRestore` + `application/skillRestoreMembership`），**版本铸造与文件系统留在 RC**
（那本来就是 RC 拥有的东西）。RC 只收到一个「给事务与回滚目标、还我被退回的 id」的窄端口，
装配在 bootstrap。这比原设想更贴合两个 context 的实际所有权。

### AC-7 的读法：路由里保留 `hasResourceAclBypass`

`viewerOf(c)` 把请求上的 actor 解成 `{ userId, aclBypass }`。这是**对请求主体的解码**，不是对资源的
授权判断——「这条融合谁看得见」的判据在 `domain/fusionVisibility`。把 `hasResourceAclBypass` 也推进
application 只会让 application 去 import 一个 legacy service，更糟。这条按「decode」计入达成。

## 10. 实施期间新增的两条通用教训

两条都已落 `docs/dev-gotchas.md`（仓库是唯一事实源）：

1. **`public/` 不许点名 provider 适配器**。T6 起初把 memory / RC 的 provider 工厂从
   `public/participants.ts` 再导出，撞了 RFC-349 的 provider-cutover 账本（那份账本明写「只能缩不能涨，
   新代码必须由 bootstrap 注入 owner 定义的端口」）。它与 RFC-317 R2（模块之间只能经 exact `public/*`）
   叠起来只剩一个自洽解：**跨 context 的 provider 装配一律在 bootstrap / system-operation 根上完成**。
2. **`git archive` 导出树只隔离「按路径读源码」的东西，不隔离 workspace 包**。
   `node_modules/@agent-workflow/shared` 是回指工作树的软链，所以导出树跑普查没问题，
   **跑测试仍会吃到别人未提交的 shared 改动**——本刀曾因此误判自己的字节绊线变红。

## 11. 实施期间我造成的两次主干红（取证与归因）

两次都不是设计问题，是**提交纪律**没执行到位。记在这里而不是只记进 `docs/dev-gotchas.md`，
因为账要落在造成它的 RFC 上。

### 11.1 `7fdada126` 夹带了他人未提交的一行删除（严重）

**现象**：`71935702e` 的 CI（run `33787067101`）24/35 job 红，含 typecheck 与全部 backend 分片。

**取证**：`git show 7fdada126 -- packages/shared/src/index.ts` 是 **+1 −1**——
`+export * from './schemas/skillProvenance'`（我的 T9）与
`-export * from './systemChannelPorts'`（并发 session RFC-354 PR-2 在工作树里**未提交**的删除）。
`systemChannelPorts.ts` 在 HEAD 里仍在，于是 backend 里所有
`channelEdgeDataflowSkip` / `isSystemChannelEdge` / `touchesSystemChannelPort` 的 import 全断。

**根因**：我按 CLAUDE.md 的要求用了精确 pathspec（`git add <file>` + `git commit -- <file>`），
但**只跑了 `git diff --cached --name-only`**——它回答「哪些文件」，不回答「文件里有谁的东西」。
`git add <file>` 的粒度是**文件不是 hunk**：只要要提的文件别人也改过，整文件的暂存就会把别人的
hunk 一起带走。

**处置**：agent-workflow-22 在 `87aab47cb` 里原位补回该行（连同他们 PR-1 的收红），
`7c79ca6e0` 收尾。我没有另推 revert——他们正在做账本的两笔（上涨 + 退许可），
我插任何一笔都会让顶端的 `allowGrowth` 变成过期条目而红。

**事后自查**：把本 RFC 全部 13 笔逐笔扫了一遍「纯删除且与本笔主题无关的行」，
**夹带只此一处**，其余纯删除行都是自己的路由重写 / participant 重构 / 门面删除。

### 11.2 T8 改路径字面量后漏跑 prettier（轻微）

`624a14647` 用脚本替换了九个既有守卫里的 `routes/fusions.ts` 路径字面量，替换后只对**新增**的文件跑了
`prettier --write`，两个被改的既有测试（`rfc108-launch-budget-timeout-floor.test.ts`、
`rfc345-resource-catalog-contracts.test.ts`）超了行宽却没格式化，`format:check` 因此红。
本 RFC 收尾一笔补格式化。教训与 11.1 同源：**改动面比验证面宽**——脚本批量改了 N 个文件，
只对其中一部分跑了检查。


## 12. AC-13 取证（2026-09-04）

- **sha**：`fb608f89cc87a3eca9e0f6496e2d762fc7775a19`
- **run**：`33800356235`（workflow `CI`），**run 级 `conclusion == success`，35/35 job 全绿**
- **本 RFC 的全部提交都是该 sha 的祖先**（`git merge-base --is-ancestor 94767e66a fb608f89c` 通过），
  即 `9911b3a05` … `94767e66a` 十三笔全部被这一轮覆盖。

**为什么不是本 RFC 自己那个 sha**：本 RFC 收口期间主干上并行着 RFC-354 的 PR-1/2/3，
每次 push 都会取消前一轮 run。按 `CLAUDE.md` 的规矩，被并发 push 取消时按**含本提交的后继 sha**判。
中间几轮的红逐条按路径归因过，没有一条落在本 RFC 的改动面（详见 §11 与实施记录）。

**一个取证口径上的坑（已实撞）**：run 被取消时，汇总 job `CI required` 也会显示成 `failure`，
而被取消的 job 计的是 `cancelled` 不是 `failure`。只按 job 状态粗看会同时得出「红了」和「红在哪」
两个错误结论——**判绿只认 run 级 `conclusion == success`**。

**还有一次非 push 导致的中断**：`fb608f89c` 首轮以 `cancelled` 收场（32 绿 + 2 个 macOS backend
分片被 runner 侧中断 + 汇总 job failure），而 `origin/main` 并未前进——排除了「被取代」。
以 `gh run rerun --failed` 只重跑那两个分片（其余 32 绿保留）后，run 级结论转为 `success`。
这不是「重跑就过了」——**没有任何一个测试失败过**，中断发生在 runner 层。
