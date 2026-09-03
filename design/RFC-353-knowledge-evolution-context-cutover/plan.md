# RFC-353 实施计划 —— Knowledge Evolution bounded context 归位

- 状态：Draft（待用户批准）
- current-source pin：`5ac6855e4`
- 开工分母：W4-E3 exact edge **13**、facade **2**（`services/fusion.ts`、`services/skillVersion.ts`）

## 1. 任务分解

| 任务     | 内容                                                                                                                                                          | 依赖      | 冲突面                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| **T1**   | **先落双 provider 等价 oracle**：`markFused` / `unfuseAboveVersion` 的行为矩阵（同数据、同回滚、两侧同结果）。改造前它必须暴露 SQLite 缺 participant 的形状差异 | —         | 仅新增测试                                                         |
| **T2**   | memory 落 `MemoryMembershipParticipant`（`public/participants.ts` + 两个 provider adapter）；`postgresqlSkillMemoryFusionParticipant.ts` 并入，SQLite 侧补齐   | T1        | `modules/memory/public/participants.ts`、memory infrastructure ×2   |
| **T3**   | resource-catalog 落 `SkillVersionParticipant`（`public/participants.ts` + 两个 provider adapter），包住既有 stage/commit/publish/abort 三段式，暴露 `txExtra`  | T1        | `modules/resource-catalog/public/participants.ts`、RC infrastructure |
| **T4**   | 建 `modules/knowledge-evolution` 骨架 + `domain/`：状态机、result 解析、prompt、workflow seed 从 `services/fusion.ts` 平移，**零行为改动**                     | —         | 新目录                                                             |
| **T5**   | `application/` 落编排：start / reconcile / decide / recover；`infrastructure/` 落 fusion 仓储（**只写 `fusions` 表**）与 workspace adapter                     | T2,T3,T4  | `services/fusion.ts`、memory infrastructure 的 fusion 三件           |
| **T6**   | fusion apply 改经两个 participant：砍掉两个适配器里手抄的版本提交机制（各约 200 行）                                                                            | T5        | 同上                                                               |
| **T7**   | skill-restore coordinator 迁入 KE；`skill-catalog.restore-skill-version.v1` 的 descriptor `invoke` 改调 KE command，**id/schema/输出逐字冻结**                 | T3,T5     | `RC legacy/skillVersion.ts`、`catalogOperationDescriptors.ts`       |
| **T8**   | `routes/fusions.ts` → `KE/inbound/fusionRoutes.ts`，收成 decode/call/map；`system-operations` 改经 KE public participant                                       | T5        | `routes/fusions.ts`、`system-operations/composition.ts`            |
| **T9**   | 【新功能】`GetSkillProvenance`：memory 加只读投影 `listFusedInto`，KE 加 domain 投影 + application query + `GET /api/skills/:id/provenance`                     | T5        | `modules/memory/public/queries.ts`、`routes/skills.ts`             |
| **T10**  | 【新功能】前端：`SkillVersionHistory` 的 fusion 行展开区（复用公共原语）+ i18n + 单测                                                                          | T9        | `packages/frontend/src/components/skill/SkillVersionHistory.tsx`   |
| **T11**  | 删 `services/fusion.ts` 与 `services/skillVersion.ts`（consumer 归零后）；`services/intent/journalArtifacts.ts` 的 type import 改指 RC                          | T5–T9     | 两个 facade + intent 一行                                          |
| **T13**  | 【范围外纳入，用户裁决 D6/D7】ACL 面板 409 冲突后丢弃草稿、刷回权威值；同步 RFC-170 §8 勘误与代码注释；组件层回归锁 | —         | `packages/frontend/src/components/AclPanel.tsx`、RFC-170 `design.md` |
| **T12**  | `architecture:write` 重采 + 收口（`STATE.md` / `design/plan.md` / RFC-294 §3.2 N17 与 §W4-E 勾选 + exact-SHA CI 取证）                                          | T11       | `architecture/*`（与并发 session 排队）                            |

## 2. PR 拆分建议

单 RFC 单 PR（本仓直推 main）。提交按 T 分批，每批自带测试：

`T1` → `T2+T3`（两个 participant 一起落，避免中间态两套判据）→ `T4` → `T5+T6`（仓储与 apply 一刀，
否则会出现「fusion 表已归位、跨聚合直写还在」的半截形状）→ `T7` → `T8` → `T9+T10`（新功能前后端一刀）
→ `T11` → `T12`。

## 3. 回滚点

- T2/T3 是纯增量（新 public 面 + adapter），无消费者时可整批 revert；
- T4 是纯平移，可整批 revert；
- **T5+T6 不可拆着回滚**：回滚要同时恢复 fusion 适配器的手抄提交机制，否则 approve 路径断；
- T7 回滚需同时把 descriptor 的 `invoke` 指回 RC，否则 operation 失去实现；
- T9/T10 是纯增量，可单独 revert 而不影响归位部分。

## 4. 验收清单

对齐 `proposal.md §7`：AC-1 两个 facade 归零 / AC-2 KE 不反向借 / AC-3 fusion 端口离开 memory public /
AC-4 fusion 适配器不再直写三张表 / AC-5 双 provider 解融合判据收成一份 / AC-6 restore operation 逐字冻结 /
AC-7 路由只 decode-call-map / AC-8 六份行为 oracle 一行未改 / AC-9 daemon handle 与启动顺序不变 /
AC-10 provenance 只返回可见记忆且反映当前真相 / AC-11 前端展开区复用公共原语 / AC-12 转交记账、全局债不增 /
AC-13 exact-SHA hosted CI 终态成功。

## 5. 工作量与风险的诚实估计

这一刀**比账本上的「13 条边 / 2 个 facade」大得多**，立项时说清楚：

| 面                         | 规模                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| 纯平移（低风险）           | `services/fusion.ts` 1218 行 + `routes/fusions.ts` 226 行            |
| 迁位 + 改形（中风险）      | memory 的 fusion 三件 2062 行 → KE，其中 apply 要重写成 participant   |
| 新公共合同（中风险）       | memory / RC 各一个 offered participant，各含两个 provider adapter     |
| 跨 owner 迁移（中高风险）  | skill-restore coordinator 102 行 + descriptor 改绑                    |
| 新功能（低风险、纯增量）   | provenance 查询 + 前端展开区                                          |

**最大的风险不是搬不动，是搬的过程中悄悄改了行为**。对策是 §6 A 类那六份 oracle
（合计 1992 行、覆盖状态机 / 恢复 / 双 provider / merge-back）**除 import 路径外一行不改**——
任何行为漂移都会在那里变红。

**次大的风险是 `apply()` 改形**：它今天是「journal + 文件系统三段 + 一个大事务」的手工编排，
换成 RC participant 之后，事务边界与失败补偿必须逐段对齐（design §3.1 / §5 已逐条列出对应关系）。
T5+T6 不拆开提交就是为了不留半截。

## 6. 并发协调

- `modules/memory/**`：RFC-352 刚收口，当前无人占用；本刀会动它的 `public/participants.ts`
  与 fusion 三件（后者整体搬走）。
- `modules/resource-catalog/**`：RFC-345 已 Done；本刀动 `public/participants.ts` 与
  `legacy/skillVersion.ts`（切出 restore 段）。开工前 `git fetch` 看 tip。
- `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` / `server.ts`：只改 fusion 的装配几行；
  这三个文件是全仓最热的并发面，按路径精确 `git add`，提交前逐 hunk 认领。
- `architecture/*`：重采前先确认 census 输入面
  （`packages/{backend,shared,frontend,system-mocks}/src` + `.dependency-cruiser.cjs` + `scripts/depcheck.ts`）
  只剩自己的改动；躺着别人在制品时按 RFC-352 §4.4 的做法处置（临时还原 HEAD 版、采完按备份还回并核 sha256）。

## 7. 门禁

- **设计门**：本三件套写完、请批前跑一次 Codex 设计门（只审功能；安全类一律不扫描、不分析、不提 findings）。
- **实现门**：declare done 前跑一次，范围按路径限定到本刀改过的文件。
- **CI**：唯一权威门禁。push 后按 exact SHA 盯到绿；被并发 push 取消时看含本提交的后继 SHA。
- **本地秒级自查**：只对改过的文件跑 `bunx prettier --check` 与 `bunx eslint --max-warnings 0`，
  以及**按 `docs/dev-gotchas.md` 那条新规**——拿被改动路径的字符串去 `tests/` 搜字面量，
  命中的账本 / 守卫全部跑一遍，而不是只跑 `tests/architecture/`。
- **账本涨了必须两笔一次 push**（`docs/dev-gotchas.md` §「N1 账本涨了要**两笔**提交」）：
  内容笔带 `allowGrowth`，**紧接着**的退许可笔把它删掉再重采，两笔**同一次 `git push`**
  ——CI 只评估推送顶端，中间插进任何一笔（哪怕纯测试、哪怕别人的文档）都会让顶端上的
  `allowGrowth` 变成过期条目而红。
  **本 RFC 已在 T4 实撞**：`027df6cd3` 带涨与豁免单独推了，其后 `5e268f743`（纯测试）与并发
  session 的 `546c70fd5`（文档）都没再涨，于是 run `33740247217` 红在
  「allowGrowth 无过期条目」，由 `4be2397eb` 收。RFC-352 已经被同族判据咬过一次
  （那次是「删账本条目后 baseline 没跟着减小」），两次根因相同：**账本类改动天然跨两笔，
  把「改动本身」当终点就会漏掉配套的那一笔**。T5–T12 一律按两笔一次 push 执行。
