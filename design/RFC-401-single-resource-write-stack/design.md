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

### 2.3 字节合同

技能 Markdown 固定一份序列化（确认后选定）；存量技能内容在没有实质变化时不产生新版本。现有字节测试
`T/rfc359-w40-resource-package-skill-document.test.ts`、`T/rfc359-w47-intent-skill-document.test.ts` 改为锁定统一合同。

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
