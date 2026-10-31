# RFC-401 资源写入栈合一与 AtomicApply 持久租约（RFC-294 S7 余项）

- **状态**：Draft（2026-10-31 落档）。§5「用户可见变化」需要用户逐项确认后才进入实施。RFC-294 plan §3 S7 写明「错误码收敛属
  用户可见变化，须列入口与错误码呈批」。本会话在用户「你继续推进RFC294 … 按你的判断来推进」的授权下先完成研究与设计，
  §5 的每一项给出推荐。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S7；design §3、W6
- **前序**：[RFC-395](../RFC-395-database-target-schema-rebuild/proposal.md) T10（唯一状态机 `platform/atomic-apply/`）、
  [RFC-400](../RFC-400-collaboration-task-participants-actor/proposal.md)（参与者合同与装配的写法）
- **研究**：Codex 只读研究（线程 `01a192ec-bdee-70e2-9736-f4a9c598a110`，2026-10-31）。本会话抽查了关键论断：
  `platform/atomic-apply/convergence.ts:7-9` 的十分钟窗口与「持久 lease 留到 schema 切换」注释、`intent/application/resolveChangeset.ts:601`
  的 `intent-name-conflict`、`services/bundle/provider.ts:87` 的 `BundleCycleError`（普通 `Error`）。
- **落位**：resource-catalog `domain/`（每类资源的变更计划与校验）、`application/ports`（每类资源的 tx 参与者合同）、`infrastructure/`
  （唯一实现）；intent、资源包只保留场景适配；`platform/atomic-apply/`（持久 claim / lease / fencing）

## 1. 背景

RFC-294 S7 的退出门是：lifecycle 实现 1、资源写入栈 1、收敛循环 1；同一非法输入在 Intent、资源包与普通 CRUD 得到同一错误码；
旧 nonterminal journal 归零后删除旧引擎。RFC-395 T10 已经交付唯一状态机，Intent 与资源包都经 `createAtomicApply` 接入，恢复只有
一个作业。2026-10-31 的研究核对了余下部分，结论与 review-2026-10-30 §2 有三处不同：

1. **资源写入不止两份。** Intent（`aggregateAdapters/intentApplyResourcePorts.ts` + `intentApplyResourceParticipants.ts`）、资源包
   （`postgresqlResourcePackageMutationArms.ts` + `postgresqlResourcePackageMutationParticipants.ts`，名字带 PostgreSQL，实际两种 provider
   共用）和六类普通 CRUD（各 repository）各有一套校验、默认值、版本递增与引用写入的编排。技能写入另有一套 skill operation
   生命周期；内建 workflow、数字员工模板、fusion 种子也各有入口。
2. **错误码没有收敛。** review 记录的「两条写入路径共用 `domain/agentDependencies.ts`」属实，但该函数带 `intent / application / catalog`
   三种语义参数，同一输入仍得到不同结果。三条入口对名称冲突、缺失引用、自依赖、循环、runtime 与成员校验返回不同的错误码与文本；
   资源包内的 agent 循环依赖抛普通 `BundleCycleError`，按现有中间件会成为 `internal-error`。完整矩阵见 design §2。
3. **收敛没有持久 lease。** journal 的幂等占位是持久的，但 apply 没有 owner / lease / fencing：活跃集合在进程内，补偿靠「不在本进程
   快照且超过十分钟」。另一进程中超过十分钟的 staging 可能被补偿。恢复作业已经只有一个（`intentRecovery`）。

另外两项此前「未核」，结论是：fusion approve 与 skill restore 都适合接入 AtomicApply。fusion 现有一处状态分歧：文件发布失败时，
数据库已提交，fusion 却被记为 failed，启动恢复不再处理它。

## 2. 目标

- **G1 一个资源写入栈**：每类资源一个完整的 tx 参与者（校验 → 变更计划 → 版本与引用写入），Intent、资源包、普通 CRUD、种子与
  模板入口都调用它；删除两套重复的 arms。
- **G2 同一输入同一错误**：规范化后的同一非法输入，在三条入口得到相同的 code、status、message 与 details；只属于场景的错误
  （未知 changeset 句柄、包格式、映射缺失、包基线变化）保留场景码，并写明首错顺序。
- **G3 持久 claim / lease**：journal claim 带持有者、租约截止与递增 fencing token；前台与恢复同一协议；恢复先取得 claim 再执行
  效果；committed 之后的尾部动作有明确完成标记。沿用一个维护作业。
- **G4 技能写入、fusion approve、skill restore 接入**：技能的 create / save / 文件写删 / ZIP 单项、fusion approve、restore 改用 AtomicApply
  场景；membership 仍与技能版本同事务；已提交后的发布失败可恢复，fusion 最终状态与 receipt 一致。
- **G5 旧引擎退役**：旧 skill operation 生命周期在旧记录清零后删除；零生产调用的 legacy 写函数删除；现行两张 apply journal 保留各自
  幂等域。

## 3. 非目标

- 不改 fusion prompt、内建 workflow 图和 restore 的 membership 选择算法。
- 不把技能 ZIP 导入改成整包原子提交（逐项提交、逐项报错保持不变）。
- 不引入严格的 YAML frontmatter 拒绝规则。
- 不合并 Intent 与资源包的物理 journal 或幂等命名空间。
- 不改离线迁移、task execution 与开发效果 journal（RFC-294 design 已把后一类排除在 AtomicApply 资源范围外）。
- 安全相关改动。

## 4. 分两部分实施

- **Part A（无 schema 变化）**：G1、G2，以及 DB-only 资源（agent、MCP、workflow、workgroup、plugin 行）的合一。
- **Part B（含 schema 变化）**：G3、G4、G5。journal 增加 lease 列、技能写入迁入 AtomicApply 需要目标 schema 与迁移；RFC-398
  正在改迁移与升级链，Part B 在 RFC-398 Done 之后开工，避免两边同时改迁移面。

## 5. 用户可见变化（需逐项确认；「推荐」为本会话的建议）

| # | 入口 / 条件 | 现行为 | 推荐 |
| --- | --- | --- | --- |
| 1 | Intent 新建与已有资源同名（非 workflow） | `intent-name-conflict` / 422 | 与 CRUD / 资源包相同：`<kind>-name-in-use` / 409 |
| 2 | Intent 新建与已有 workflow 同名 | 拒绝 | **允许**，与普通目录、资源包一致（普通目录本就允许 workflow 重名） |
| 3 | 缺失直接 agent 依赖 | CRUD `agent-dependency-not-found`；Intent `acl-missing-refs`；资源包 `package-external-unresolved` | 规范化后统一为 `agent-dependency-not-found`；句柄未知、包格式错误仍用场景码 |
| 4 | 缺失 MCP / plugin / managed skill 引用 | 三条入口的包装与 code 不同 | 统一为 `mcp-not-found` / `plugin-not-found` / `skill-not-found`，details 一致；批量上下文附 opId |
| 5 | agent 自依赖；资源包内 agent 循环 | Intent `intent-draft-invalid`；资源包循环可能是 `internal-error` | 统一为 `agent-dependency-self`、`agent-dependency-cycle` |
| 6 | Intent 的 runtime / branch port / plugin 状态检查 | 缺检查，或 `agent-runtime-not-found` | 与共同写入一致：`runtime-not-found`、`runtime-disabled`、`branch-port-not-declared`、`plugin-disabled` |
| 7 | Intent 中 workgroup 人类成员无效 | `workgroup-human-inactive` | `workgroup-member-user-invalid` |
| 8 | workflow 图校验（调用循环等） | Intent apply 时拒绝；CRUD / 资源包保存时不做完整图校验，另有校验接口 | 保留「草稿可保存」：三条入口保存时都不做完整图校验，完整校验是显式操作。**这会放开 Intent 现在的拒绝** |
| 9 | 技能内容相同的更新、description 变化 | 各入口的版本递增规则不同（CRUD 相同内容 no-op；Intent / 资源包每次 +1） | 同一变更计划：内容不变不增版本，description 变化按同一规则递增 metaRevision；`source` 字段保留来源差异 |
| 10 | 资源包对同 spec plugin 覆盖 | 可能重新安装并推进 installedAt | 采用共同变更计划：spec 不变不重装；重新解析版本由显式 upgrade 表达 |
| 11 | 资源包已选基线变化 | 可能先报 `package-selected-target-changed` | 保留这一场景能力；资源层 stale 统一为 `resource-operation-stale`，并写明两者先后 |
| 12 | fusion 文件发布失败 | 可能资源已提交而 fusion 记为 failed | 已提交的结果可恢复、可重放；fusion 最终状态与持久 receipt 一致 |

每一项的 status、message、details 与首错顺序在 design §2 列全；不是只改外层 code。

## 6. 验收标准

- **AC-1 写入栈 1**：六类资源各只有一个 tx 参与者实现；Intent、资源包、CRUD、种子与模板入口都经它写入；两套 arms 删除；结构锁
  锁定（含负例）。
- **AC-2 错误收敛**：design §2 的输入矩阵在三条入口 × 两种 provider 上逐条断言相同的 code / status / message / details。
- **AC-3 租约**：lease 竞争、过期接管、旧持有者提交被拒、提交前后崩溃、尾部重试都有确定性用例；两种 provider 同一合同。
- **AC-4 技能 / fusion / restore**：故障点用例（claim 后、数据库提交后、发布前后）覆盖三类场景；fusion 发布失败后最终状态与 receipt 一致。
- **AC-5 旧引擎**：旧 skill operation 生命周期删除前，旧 `prepared / applying`、已提交但尾部未完成、需要旧恢复执行器的记录都为零，
  且支持的升级来源仍能经迁移进入目标模型。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 7. 待用户确认

§5 的 12 项，以及：

- 引用中的重复项是否去重（RFC-395 A5 ledger `tests/fixtures/rfc395-a5-reference-semantics.json` 记录过资源包对 dependsOn / MCP / plugins
  去重、对 skills 保留重复）。推荐保留用户输入顺序，逐字段决定是否去重，写进 design §2。
- 技能 Markdown 字节：Intent / 资源包用 `renderResourcePackageSkillMarkdown`，CRUD 用 `stringifyFrontmatter`，两者的空行、末尾换行与
  YAML 格式不同。推荐固定一份字节合同，存量内容不因换序列化器而产生新版本。
