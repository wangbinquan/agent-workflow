# RFC-401 技术设计

路径缩写：`B` = `packages/backend/src`，`RC` = `B/modules/resource-catalog`，`IN` = `B/modules/intent`，`KE` = `B/modules/knowledge-evolution`，
`T` = `packages/backend/tests`，`F` = `T/fixtures`。行号以 2026-10-31 研究时的源码为准，实施时按源码定位。

## 1. 现状

### 1.1 写入路径

| 路径 | 入口与链路 | 事务 |
| --- | --- | --- |
| Intent apply | `POST /api/intent-sessions/:id/commit` → `createIntentApplyEngine` → `createAtomicApply` → resolve changeset → prepare / prestage → 每类参与者（`intentApplyResourcePorts.ts`） | AtomicApply 的 journal adapter 开普通 `transaction`（`IN/infrastructure/intentApplyJournal.ts:22`） |
| 资源包 apply / 导入 | HTTP、CLI `package` → `createResourcePackageAtomicApplyOperations` → `planBundleOps` → prepare / prestage → 七类提交参与者（`postgresqlResourcePackageMutationArms.ts`、`…Participants.ts`） | `resourcePackageAtomicJournal` 开普通 `transaction`（`RC/infrastructure/resourcePackageAtomicJournal.ts:20`） |
| 普通 CRUD（HTTP / MCP） | routes → operation descriptor → 每类 application → repository | `runResourceCatalogTransaction`（`serializable`，`RC/infrastructure/resourceCatalogTransaction.ts:16`）；技能另走 skill operation 协议 |
| 其他 | demo 种子、fusion 种子、数字员工 agent 模板、内建 workflow（仍走 `legacy/workflow.createWorkflow`）、动态 workflow「保存为」（复用普通 create）、技能 ZIP（逐项）、资源元数据与 grant 更新、技能 boot / 恢复写入、离线迁移 | 各自 |

资源包的第七类 `capability_template` 由 code-capability 的 owner 在同一 `PersistenceTx` 写入（`B/modules/code-capability/infrastructure/
postgresqlCapabilityTemplatePackageMutationOwner.ts:84`），继续由该领域持有写规则。

### 1.2 每类每操作的分歧（研究摘录）

- **agent create / update**：Intent 不做 execution-contract 端口对账与 branch port 检查，runtime 只查存在；资源包与 CRUD 两者都做。
  rename 是独立命令。
- **skill create / update**：三份持久生命周期与 SQL 编排；CRUD 相同内容 no-op，Intent / 资源包每次 contentVersion+1，metaRevision 规则不同；
  Markdown 序列化不同（见 §2.3）。
- **MCP update**：CRUD 语义相同即 no-op；配置字段保留规则与 Intent 不同（Intent 保留未给出的旧 `config.oauth`）。
- **plugin**：CRUD 先安装后写库；Intent / 资源包先记 artifact 再安装；资源包同 spec 覆盖会重新安装。
- **workflow**：Intent 做完整图校验并拒绝重名；资源包与 CRUD 不做完整图校验、允许重名；Intent 禁止 rename，CRUD / 资源包允许。
- **workgroup**：Intent 有变化时整组重建成员，资源包只在成员 / leader 变化时重建；资源包先把包内用户名映射为 user id。
- **跨类型**：引用去重规则不同（RFC-395 A5 ledger 记录在案）；资源包的唯一冲突归一只认 PostgreSQL；隔离级别不同（普通
  `transaction` 对 `serializable`）；Intent / 资源包的 WS `committed` 回调在生产装配中没有传入，普通 workflow CRUD 有实际广播。

## 2. 错误矩阵

### 2.1 入口最先拒绝的错误

| 输入 / 条件 | CRUD | Intent | 资源包 | 证据 |
| --- | --- | --- | --- | --- |
| 同 owner 同名（agent / skill / MCP / plugin / workgroup） | `*-name-in-use` / 409 | 先 `intent-name-conflict` / 422；竞争时才可能 `*-name-in-use` | create arm `*-name-in-use` / 409 | `IN/application/resolveChangeset.ts:601`；`intentApplyResourcePorts.ts:497`；`postgresqlResourcePackageMutationArms.ts:519` |
| workflow 同名新建 | 允许 | `intent-name-conflict` | 允许 | `intentApplyResourcePorts.ts:1231`；`RC/infrastructure/workflowRepository.ts:161` |
| 新增不存在的直接 agent 依赖 | `agent-dependency-not-found` | `acl-missing-refs`；未知句柄更早 `intent-ref-unknown` | `package-external-unresolved`；内建缺失 `bundle-builtin-missing` | `RC/infrastructure/agentPersistenceSemantics.ts:232`；`intentApplyResourcePorts.ts:364`；`RC/infrastructure/resourcePackageAtomicApply.ts:398` |
| agent 自依赖 | `agent-dependency-self` | 拓扑先 `intent-draft-invalid` | 进入图后 `agent-dependency-self` | `RC/domain/agentDependencies.ts:21`；`IN/application/resolveChangeset.ts:803` |
| 包内多 agent 循环 | 单次 CRUD 形成循环：`agent-dependency-cycle` | `intent-draft-invalid` | `BundleCycleError`（普通 `Error`）→ 推断为 `internal-error` | `B/services/bundle/provider.ts:87`、`:143`；`B/util/errors.ts:142`、`:177` |
| 已有闭包中的缺失节点 | `agent-dependency-not-found` | 当作叶子，不保证报错 | `agent-dependency-not-found` | `RC/domain/agentDependencies.ts:80` |
| 引用不存在的 MCP / plugin | `mcp-not-found` / `plugin-not-found` | `acl-missing-refs` | 先 `package-external-unresolved`；arm 另有 not-found | `RC/infrastructure/agentPersistenceSemantics.ts:240`、`:248` |
| 引用不存在的 managed skill | 完整闭包校验先报 `agent-resources-invalid`（details 含具体项） | `acl-missing-refs` | 先 `package-external-unresolved`；arm 可报 `skill-not-found` | `RC/application/agents/agentResourceIntegrity.ts:266` |
| 引用 disabled plugin | `plugin-disabled` | 无同等检查 | `plugin-disabled` | `RC/infrastructure/agentPersistenceSemantics.ts:256` |
| runtime 不存在 / 改为 disabled | `runtime-not-found` / `runtime-disabled` | `agent-runtime-not-found` / 无检查 | 同 CRUD | `RC/infrastructure/agentPersistenceSemantics.ts:183`、`:195`；`intentApplyResourcePorts.ts:422` |
| 未声明 branch port | `branch-port-not-declared` | 无检查 | 同 CRUD | `RC/infrastructure/agentBranchPorts.ts:20` |
| workflow 调用循环（schema 合法） | 保存不做完整图校验；校验接口返回 `workflow-call-cycle` | `intent-workflow-invalid`（details 带图问题） | 保存不做完整图校验 | `B/routes/workflows.ts:205`；`IN/infrastructure/intentApplyEngine.ts:272` |
| workgroup 人类成员无效 | `workgroup-member-user-invalid` | `workgroup-human-inactive` | `workgroup-member-user-invalid`；映射缺失 / 歧义 `package-human-mapping-*` | `RC/infrastructure/workgroupRepository.ts:178`；`intentApplyResourcePorts.ts:1369` |
| MCP 改 type | `mcp-type-immutable`（message 带名称与 details） | 同 code，message 不同 | 同 Intent | `RC/application/mcps/mcpApplication.ts:147` |
| 资源 revision 已变 | `resource-operation-stale` | arm 同 code；另有 session / draft 基线错误 | 先 `package-selected-target-changed`，arm 才是 stale | `B/util/errors.ts:69` |
| payload schema 无效 | `agent-invalid` 等各类 `*-invalid` | `intent-op-canonical-invalid` | `package-invalid` | `IN/infrastructure/intentApplyEngine.ts:260`；`B/services/resourcePackage/parse.ts:158` |

message 也不同，例如名称冲突：arm `agent 'x' already exists`、Intent `agent name 'x' is taken`；runtime 缺失：CRUD
`agent references unknown runtime: x`（details `notFound`）、Intent `runtime 'x' not found`；人类成员：CRUD / 资源包
`human member user(s) not active`（details `userIds`）、Intent `workgroup human members must be active`。

### 2.2 目标合同

- 规范化之后的资源错误只由共同写入层产生，code / status / message / details 一份；三条入口的差别只在规范化之前（句柄、包格式、映射、
  包基线）。
- 首错顺序固定为：场景格式 → 场景引用解析 → 场景基线 → 共同 schema → 共同引用与图 → 共同状态（runtime / plugin enabled 等）→ 共同
  stale / 名称冲突（含竞争失败的唯一约束归一，provider 中立）。
- 资源包内循环由 `planBundleOps` 转为 `agent-dependency-cycle`（不再落到 `internal-error`）。
- 现有 `T/fixtures/rfc395-a5-reference-semantics.json` 中保留的差异逐条替换为确认后的统一合同。
- **以普通编辑现行行为为准**（用户 2026-11-02 确认的口径是「三条入口统一成普通编辑现在的 code / status / message」）。逐条核对源码后，
  proposal §5 有一处需要按此口径更正：第 4 项写的 managed skill 缺失统一为 `skill-not-found`，但普通编辑现在由 RFC-228 闭包预检
  先报 `agent-resources-invalid`（details.issues 带 refKind / code，`rfc223-pr1-impl-gate` 锁定），`skill-not-found` 只在预检通过之后的
  可见性围栏里出现（并发删除）。统一按普通编辑：缺失的 managed skill 报 `agent-resources-invalid`。
- **批内依赖环**（只有 Intent 与资源包能一次提交多个 agent）：排序不再在环上抛错（Intent 的 `intent-draft-invalid`、资源包的
  `BundleCycleError`）。环上成员排在无环部分之后、保持输入序；参与者用「本批尚未写入的 agent 及其最终 dependsOn」覆盖事务内的
  依赖读取，于是自依赖报 `agent-dependency-self`、环报 `agent-dependency-cycle`，code / message / 422 与普通编辑相同，且与其他校验的
  先后也与普通编辑相同（例如同一个 agent 既自依赖又引用不存在的 runtime，先报 runtime）。
- **Intent 的草稿校验仍是场景校验**：确认前给模型与用户的反馈——未知句柄、新建 agent 之间的 tempRef 环（含自依赖）、新建
  agent 的 branch port 未声明（`validateDraftChangeset`）——照旧在草稿期报出，apply 时以 `intent-draft-invalid`（errors 写明
  成因）先于共同写入层拒绝。草稿期看不到的情形（原地更新之间的环、更新省略 branchPorts 而存着的端口不在新 outputs 里）由
  写入参与者按普通编辑报。错误矩阵（`T/rfc401-agent-error-matrix.test.ts`）只用能通过草稿校验的 Intent 输入。

### 2.3 字节合同

技能 Markdown 固定一份序列化（确认后选定）；存量技能内容在没有实质变化时不产生新版本。现有字节测试
`T/rfc359-w40-resource-package-skill-document.test.ts`、`T/rfc359-w47-intent-skill-document.test.ts` 改为锁定统一合同。

### 2.4 引用去重（§7 第 1 项）

agent 的四个引用字段在共同写入层规范化：`dependsOn`、`mcp`、`plugins` 按 id 去重，`skills` 按（kind, skillId / name）去重，一律保留
第一次出现的位置、其余按用户输入顺序。重复引用在运行时没有含义（依赖图按集合遍历、MCP / plugin / skill 按资源注入），而现状三条入口各
不相同（普通编辑与 Intent 保留重复，资源包对 dependsOn / mcp / plugins 去重、对 skills 保留），统一为去重。只影响新写入：已存的重复行在
下一次保存该 agent 时被规范化。

## 3. 目标结构

```text
Intent 场景适配 ── 句柄 / copy / session / provenance ─┐
资源包场景适配 ─── 引用 / 映射 / 预览 / receipt ──────├─ AtomicApply（claim / lease / artifact / 提交 / receipt / 恢复）
技能 / fusion / restore 场景 ── 领域决策 / receipt ───┘        │ 调用方持有的 tx
普通 DB-only CRUD ── application 事务 ─────────────────────────┤
                                                               ▼
                     resource-catalog 六类 tx 参与者：校验 → 变更计划 → 版本 / 引用写入
                                                               │
                                     provider 中立的存储原语（PersistenceTx）
```

| 层 | 内容 | 规则 |
| --- | --- | --- |
| `RC/domain/` | 每类资源的变更计划、规范校验、typed errors | 不接受 `intent / package` 语义参数改变同一资源规则；允许显式 source、内建种子、restore 等领域操作类型 |
| `RC/application/ports/` | `AgentMutationParticipant` 等六个闭合合同；artifact 计划合同 | 接受规范化请求、expected revision、已解析引用；返回 receipt、是否变化与后续动作描述 |
| `RC/application/` | 普通 CRUD 用例；场景资源计划 | 不写 SQL、不安装插件、不复制技能文件 |
| `RC/infrastructure/` | 六类参与者实现；引用 / definition / 内容存储原语 | 全部 SQL 在传入的 tx 上；不嵌套事务；唯一冲突归一 provider 中立 |
| `RC/composition/` | `bindResourceMutations(tx, deps)` | 只有 composition / bootstrap 接触带 tx 的工厂（同 RFC-400） |
| 场景适配 | session / 基线、句柄、映射、操作顺序、领域 receipt | 转换后调用同一参与者，不再决定资源错误码、版本号、成员重建与默认值 |

要点：

1. **批量校验看同一个候选图**：先解析全部 id，再用统一读端口读取「事务内现状 + 本批候选变更」，不再用「缺失节点当叶子」。
2. **隔离策略由最终提交入口统一规定**：资源写事务沿用 `serializable`；AtomicApply 的最终事务绑定同一策略，重试时重建 attempt，不重复
   文件效果。
3. **artifact 的部署差异留在装配**：本地文件与托管内容的差异经现有 artifact 注入点处理（`B/bootstrap/crewstation.ts:381`、
   `RC/composition/crewstationArtifacts.ts:73`），不产生第二套资源 SQL。

删除：两套资源 SQL arms 与两套 session 中重复的 prepare / commit 分派（场景计划逻辑迁到场景适配，不留转发壳）；六类 repository
只保留查询；零生产调用的 legacy 写函数；迁走内建 workflow 的消费者后删除 `legacy/workflow.ts` 的旧写入部分。

## 4. AtomicApply 持久 claim / lease（Part B）

现状：`platform/atomic-apply/stateMachine.ts` 的活跃集合在进程内，`keyedLock.ts` 是进程内 Map；journal CAS 只看 id 与 state；两张 journal
表没有 lease 列。恢复判据是「不在本进程快照且 `updatedAt` 超过十分钟」（`convergence.ts:7-20`），恢复顺序是先执行效果、后 CAS state
（`convergence.ts:57`、`:70`）。维护作业本身有持久 lease（`B/platform/persistence/maintenanceRunStore.ts:195`），但它不约束前台 apply。

目标：

- journal claim 增加持有者、lease 截止与递增 fencing token；前台与恢复同一 claim 协议。
- `recordArtifact`、最终提交、receipt / state 更新、恢复完成都校验 token；租约丢失的旧持有者不能提交。
- 恢复先取得 claim 再执行效果；长时间 staging 续租；进程内活跃集合只作优化。
- committed 之后增加尾部完成标记，区分「领域已提交、尾部待完成」与「完全完成」。
- 沿用一个维护作业（持久 key `intentRecovery`），新场景只扩展 registry。

## 5. 技能、fusion、restore（Part B）

- **技能 create / save / 文件写删 / ZIP 单项**：现有 skill operation 生命周期（reserve → stage → commit → publish / compensate，
  `RC/infrastructure/legacy/skill.ts:260`、`skillVersion.ts:398`、`skillDeleteOp.ts:87`）改为 AtomicApply 场景，保留技能内容与锁定语义。
- **fusion approve**：skill / version、memory membership、fusion 结果与 receipt 同一最终事务；文件发布与 proposal 清理是可重试尾部；
  已提交后的发布失败不再把 fusion 记为 failed（现状见 `KE/application/fusionOrchestration.ts:738`、`:749`）。fusion 业务状态机保留。
- **skill restore**：新增 `skill-restore` 场景，复用技能参与者与 membership 参与者（`KE/application/skillRestoreMembership.ts:25`）；
  restore 仍是前进版本（`source='restore'`、`restoredFromVersion`），`> targetVersion` 选择规则不变（`T/rfc353-skill-restore-membership.test.ts`）。
- **启动顺序**：保持「先恢复技能操作，再 availability / live files，再 fusion 决策恢复」的依赖（`B/bootstrap/daemonLifecycleProgram.ts:36-55`）。
- 纯 DB 的 agent / MCP / workflow / workgroup CRUD 不套 artifact journal；调用同一参与者即满足单写栈。

## 6. 旧引擎与 journal

- `intent_apply_journal`、`resource_bundle_applies` 是现行表，保留幂等域；Part B 只扩展 lease 与尾部完成列。
- 旧 SQLite Intent / 资源包引擎已由中立实现取代，不再列为待合并引擎。
- 迁移读取器（`IN/infrastructure/migration/intentApplyLegacyCodec.ts`、`RC/infrastructure/migration/resourcePackageLegacyCodec.ts`）保留到升级来源
  合同允许删除为止。
- 仍在运行的兼容执行路径：current envelope 的 `recovery` 扩展、`composeLegacyIntentSkillArtifactCompat`
  （`RC/composition/intentApply.ts:94`）、`resourcePackageOperationRecovery`。
- 删除旧 skill operation 生命周期的前提（AC-5）：旧 `prepared / applying` 为零、已提交但尾部未完成为零、需要旧 `recovery` 执行器的记录
  为零或已转换，且支持的升级来源仍能经迁移进入目标模型。

## 7. 守卫与账本

会随本 RFC 精确更新（不靠放宽）：`T/architecture/rfc395-a6-atomic-apply.test.ts`（scene 名单、恢复注册次数与顺序）、
`rfc395-reference-boundary.test.ts`（agent / workflow 写入点名单）、`F/rfc395-a5-reference-semantics.json`、
`rfc317-table-ownership` 与 `F/rfc395-module-table-ownership-debt.json`、`rfc359-converged-twins`、`rfc359-w5-provider-pair-conformance`、
`rfc359-w5-t17-provider-file-location`、`rfc359-w5-adapter-production-consumer`、`rfc359-w5-artifact-format-portability`、
`rfc359-w8-t29-unnormalized-unique-insert`、`architecture/counts.json`、`architecture/commons-debt.json`。fusion 的内建 prompt 摘要
（`T/rfc353-fusion-domain-verbatim.test.ts`）不应变化。

## 8. 测试

- 三条入口 × 两种 provider 的错误矩阵合同（§2），含首错顺序与 message / details。
- 每类资源的变更计划：no-op、版本递增、成员重建、引用顺序与去重、唯一冲突竞争。
- lease：竞争、过期接管、旧持有者提交被拒、续租、提交前后崩溃、尾部重试、旧记录升级。
- 技能 / fusion / restore 故障点；技能字节合同；WS 与 durable 后续动作。
- 现有行为测试中依赖旧差异的断言，按确认后的合同修改并写明原因。

## 9. Part A 分步与 A1（agent）

### 9.1 分步

Part A 按资源类分次提交（plan「Part A 分步」）：A1 agent；A2 MCP 与 plugin；A3 workflow 与 workgroup（分 A3a workflow、A3b workgroup
两次提交）；A4 skill（Intent / 资源包的数据库部分、版本规则与字节合同），并删除剩余 arms、加 AC-1 结构锁。每一步完整实现与用例后集中验证一次再提交。§3 要点 2（AtomicApply
最终事务的隔离策略）与 AtomicApply 本身的改动一起归 Part B。

### 9.2 A1：agent 写入参与者

- **合同** `RC/application/ports/agentMutation.ts`：`AgentMutationParticipant { create, update }`，由 `(tx) => participant` 的工厂提供。
  - create：`{ id, agent（引用已解析为 id 的 CreateAgent）, owner, batch? }`；
  - update：`{ id, fence, guard?(current), patch(current), batch? }`。`guard` 承载场景规则（Intent 的 owner-only、builtin 只读与改名限制），
    在 fence 之前执行；`patch` 由场景按当前行生成（Intent 的 sidecar 回填、资源包的引用解析）；
  - `batch`：`pendingDependencies(id)` 给出本批尚未写入的 agent 的最终 dependsOn（§2.2「批内依赖环」）；`stagedSkillIds` 是本批新建、
    提交后才发布的 managed skill，闭包校验视为可用。
  - 系统写入（数字员工模板）以 `owner: { kind: 'system' }` 调用：owner 为系统用户、public、builtin，不做引用可见性判定，其余校验相同。
- **实现** `RC/infrastructure/agentMutationParticipant.ts`（唯一实现，全部 SQL 在传入的 tx 上）：
  1. 规范化：执行合同端口对账（`reconcileCreated/UpdatedAgentExecutionContractPorts`）；四个引用字段去重（§2.4）。
  2. update：事务内读当前行 → `agent-not-found`（404）→ `guard(current)` → fence 不符报 `resource-operation-stale`（409）→ `patch(current)`。
  3. 校验，次序同普通编辑：branch port → runtime（不存在；改成停用的）→ 依赖 / MCP / plugin 新增引用的存在与可见（批内尚未写入的
     agent 视为存在且可见）→ plugin 全量启用 → 依赖图（本批覆盖 + 事务内现状）→ RFC-228 闭包（事务内 inventory、候选覆盖、
     `stagedSkillIds` 可用）→ managed skill 新增引用的可见。
  4. 写入：create 先查 owner + name 冲突，再经 `createAgentReferenceWriteParticipant` 插入，唯一冲突经 `engineOf(tx).uniqueViolationTarget`
     归一为 `agent-name-in-use`（provider 中立）；update 按 fence CAS，0 行报 stale。
  - runtime 判定读事务内 `runtimes` 表（与 `assertRuntimeReference` 同一判据）；普通 CRUD 的装配可以继续注入 runtime registry 查询，
    数据源同为 `runtimes` 表。
- **普通 CRUD**：`agentRepository.create / update` 在 `runResourceCatalogTransaction` 内调用参与者。rename / delete 只有普通 CRUD 使用，
  留在仓库；`AgentPersistenceSemantics` 只剩删除闸与 `referenceLabels`。
- **Intent**：agent 端口的 `commitInTransaction` 调参与者。场景保留：copy 的 sidecar 回填、owner-only 与 builtin 只读、
  `intent-rename-unsupported`。删除 Intent 自己的可见性、runtime 与依赖图校验。`resolveIntentBundle` 不再对 agent 做
  `intent-name-conflict` 预检（名称冲突由参与者报 `agent-name-in-use` / 409），agent 排序遇环不再抛错。
- **资源包**：agent arm 调参与者。场景保留：wire 引用解析（`bundle-ref-invalid`、`bundle-builtin-missing`）与 `assertOwnedOverwrite`
  （`package-selected-target-*`、`bundle-overwrite-not-owned`、`resource-builtin-read-only`，先于资源层 stale）。external 引用只解码为
  id，存在与可见交给参与者，因此 agent 的四类引用不再报 `package-external-unresolved`；计划期预检对 agent 载荷只保留 builtin 名称解析。
  `planBundleOps` 遇环不再抛 `BundleCycleError`。workflow / workgroup / capability template 的引用在 A3 处理。
- **种子与模板**：数字员工模板的 create / update 改走参与者（系统写入）；fusion 与 demo 种子是受信的内建写入，经参与者模块导出的
  种子插入写行（不做校验，保持幂等与漂移修复语义不变）。
- **守卫**：结构锁断言 agent 行只经参与者模块写入（`createAgentReferenceWriteParticipant` 只被参与者模块与 legacy 测试写入函数引用），
  并对 Intent / 资源包 agent 臂各留一条负例。
- **用例**：三入口 × 两 provider 的 agent 错误矩阵（同名、缺失依赖 / MCP / plugin / managed skill、停用 plugin、runtime 缺失 / 停用、
  未声明 branch port、自依赖、批内环、stale、不可见引用），逐条断言 code / status / message / details 相同；排序容忍环的单元用例；
  引用去重；依赖旧差异的既有断言按统一合同修改并写明原因。

### 9.3 A2：MCP 与 plugin 写入参与者

- **合同** `RC/application/ports/mcpMutation.ts`、`pluginMutation.ts`；实现 `RC/infrastructure/mcpMutationParticipant.ts`、
  `pluginMutationParticipant.ts`（全部 SQL 在传入的 tx 上），规则与错误取普通编辑现行的那一份：
  - MCP create：按类型校验配置（`mcp-config-invalid`，校验函数迁入 `RC/domain/mcps/mcpConfig.ts`）→ owner + name 冲突
    （`mcp-name-in-use`，唯一约束经 `engineOf(tx).uniqueViolationTarget` 归一）→ 插入。
  - MCP update：读当前行（`mcp-not-found`）→ 场景 guard → fence（`resource-operation-stale`，「the MCP changed; reload before
    modifying it」，details 带 expected / current configHash）→ 类型不可变（`mcp-type-immutable`，「mcp 'x' type cannot change」，
    details 带两种类型）→ 配置校验 → 取一次 updatedAt（普通编辑注入 RFC-201 的因果时钟，其余用 `monotonicNow`）→ 语义
    no-op 不写 → 整行 CAS 写入 → 同一事务里记运行时测试会话的失效意图。提交的配置整份替换库里的配置。
  - plugin create：选项校验 → 名称冲突（`plugin-name-in-use`）→ 带安装产物插入。
  - plugin update：读当前行 → guard → fence（「plugin changed since this operation was prepared; reload and retry」，details 同上）
    → 选项校验 → 语义 no-op 不写 → 整行 CAS 发布。安装是事务外的效果，由场景在事务前完成并以 `installation` 交进来；
    `null` 沿用当前安装与 installedAt，规格改变却没有新安装是编程错误。
- **普通 CRUD**：MCP 仓库的 create / update、plugin 仓库的 create / publish 改为调参与者；application 只保留可见性、编辑权、
  进程内互斥、删除确认、事务前的安装（规格改变或显式 upgrade）与事后的运行时意图调和。
- **Intent**：MCP / plugin 端口调参与者。场景保留：owner-only；plugin 的改名限制；**MCP 的 OAuth 回填**——Intent 给模型看的
  MCP 配置里 `oauth.clientSecret` 是哨兵，模型改写时可能省略整个 `oauth`，场景按库里的值补回（RFC-348 D2）。这是 Intent 对
  模型产物的还原（与工作流特权节点的回填同类），共同写入层的规则仍是「提交的配置整份替换」。
- **资源包**：MCP / plugin arm 调参与者。覆盖保持规格不变时事务前不安装（会话工厂注入 `currentPluginSpec`，由
  `composePostgresqlResourcePackageProvider` 从库里读），proposal §5 第 10 项；新建仍必有安装。
- `resolveIntentBundle` 的名称预检对 MCP / plugin 也不再做（与 agent 一起由共同写入层报 `<kind>-name-in-use` / 409）。
- **守卫**：A1 的结构锁推广为 `T/architecture/rfc401-resource-write-participants.test.ts`：每类只有参与者引用该类的行写入原语，
  各场景函数必须调参与者（含负例）。
- **用例**：`T/rfc401-mcp-plugin-error-matrix.test.ts`（MCP 名称冲突、类型不可变、stale、no-op；plugin 名称冲突、stale；三入口 ×
  两 provider）；`T/rfc359-w12-plugin-publication-conformance.test.ts` 加「覆盖保持规格不变不重装」。

### 9.4 A3a：workflow 写入参与者

- **合同** `RC/application/ports/workflowMutation.ts`；实现 `RC/infrastructure/workflowMutationParticipant.ts`（全部 SQL 在传入的 tx
  上，只有它驱动定义 + 依赖索引的写入原语 `workflowDefinitionWrite`）。写入者是当前用户（`actor`）或系统内建写入（`system`：系统用户
  所有、public、builtin，作者门放行、不判可见性）。规则与错误取普通编辑现行的那一份：
  - create：目录 id 可写 → 定义迁移到最新版本并要求规范 agent id（`workflow-agent-id-required`，details.nodeIds 排序）→ 脚本 / 代码托管
    作者门（`script-author-forbidden` / `code-host-author-forbidden`，普通编辑的措辞）→ 快照 schema → 引用可见性（`acl-missing-refs`，
    「you do not have access to: …」，details.missing 为 `{ type, name }`；不存在的 agent id 允许悬空到校验 / 启动期，名字域
    dangle-tolerant；本批新建的名字视为可见）→ 插入。`verbatim-copy`（普通编辑的复制）只迁移版本、作者门按 RFC-253 D21 放行。
  - update：读当前行（`workflow-not-found`）→ 场景 patch → 规范化 → 按当前行回填打码的特权节点（RFC-270）→ 场景 guard（返回要写的
    名称）→ 作者门（对比当前定义）→ 快照 schema → 新增引用的可见性 → 版本 fence：版本不符时内容相同为 already-current，否则
    `resource-operation-stale`（「workflow 'x' changed; reload」，details.current 为当前修订）；内容与存储字节都相同为 already-current
    → CAS 写入。guard 排在规范化之后，是普通编辑此前的首错顺序（规范 agent id 先于改名校验，
    `rfc359-w16-workflow-boundary-conformance` 锁定）；Intent 此前也是规范 agent id（prepare）先于 owner-only 与禁止改名（commit）。
  - **不判重名**（§5 第 2 项）、**保存时不做完整图校验**（§5 第 8 项）。名称格式是入口格式：普通编辑新建由请求 schema、改名由改名规则
    （编辑者不能改名、改动后的名称须合法）校验，Intent 由变更集 schema，资源包由包 payload schema（历史名称可导入）；参与者只要求快照
    schema。
- **场景保留的规则**：普通编辑——改名规则（访问级别在事务外按保存前的行解析）、复制命名、删除前的引用检查、事件；Intent——owner-only、
  禁止改名、提交后的回调；资源包——包内引用解析（external 不可解析为 `package-external-unresolved`、builtin 缺失为
  `bundle-builtin-missing`、本包新建按 slug）与已选目标基线（`assertOwnedOverwrite` 先于资源层 stale）；内建目录——布局规划、内容冲突
  检查与创建广播；演示 / 融合种子——经参与者模块的 `insertSeedWorkflow` / `repairSeedWorkflow` 原样落行（受信任内容，与此前相同）。
- **Intent 图校验**（§5 第 8 项，取代 RFC-358 决策 D3 与 D7 的阻断部分）：提交期不再跑图校验（`intent-workflow-invalid` 删除，apply
  组合不再注入图校验端口）。草稿期照旧跑：error 不再进 blocking 列表，落在 `validation.graphErrors`——INTENT.md 单列一节给模型、照旧
  触发一轮图修复、确认页以提醒列出并挂到对应操作上，**不禁用提交**；「图校验不可用」也只提示。本变更之前生成的草稿把图校验 error 存在
  `errors` 里，无法可靠拆出，仍按 blocking 显示，重新生成一轮即可。
- **用户可见变化**（都在 §5 已确认的范围或以普通编辑为准的统一里）：
  - Intent：允许重名；图校验不阻断提交；workflow 里不存在的 agent id 不再拒绝（悬空到启动期，与普通编辑相同）；不可见引用的 details
    键由 `id` 改为 `name`，按名字调用的不可见 workflow / workgroup 合并报且带 details；stale 带 details.current；作者门措辞同普通编辑。
  - 资源包：按名字调用他人私有的 workflow / workgroup 报 `acl-missing-refs`（此前不查）；资源层 stale 的措辞同普通编辑（仍在已选
    目标基线之后）。缺 agent 引用的节点仍由包的 wire 格式先拒（`package-invalid`），到不了共同写入层。
  - 普通编辑：code / message / details 不变；规范化、回填与作者门改在写入事务里对被写的那一行执行。
- **守卫**：`T/architecture/rfc401-resource-write-participants.test.ts` 加 workflow 一类（参与者独占写入原语，测试用的旧写入
  `legacy/workflow.ts` 例外到 Part B；Intent 端口、资源包 arm、普通 CRUD 仓库、内建目录必须调参与者），并锁 `workflow-name-in-use`、
  `intent-workflow-invalid` 与 apply 期图校验函数不再出现（含负例）。RFC-395 写入边界、RFC-199 写入清单与 RFC-349 适配器锁改指参与者。
- **用例**：`T/rfc401-workflow-error-matrix.test.ts`（重名允许、图校验不拦、按名字调用不可见 workflow、不可见 agent、脚本作者门、缺规范
  agent id、stale；三入口 × 两 provider，场景码单独断言：资源包的 external 解析、导入权限、wire 格式与已选基线，Intent 的变更集
  schema）；`rfc358-intent-graph-validation` 改锁「提交不拦」与 INTENT.md 的图校验
  一节；前端 `intent-detail-inline` 锁图校验 error 与「不可用」不禁用提交。

