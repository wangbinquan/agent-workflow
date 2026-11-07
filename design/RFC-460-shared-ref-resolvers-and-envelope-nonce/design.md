# RFC-460 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`SH/` = `packages/shared/src/`，
`TE/` = `S/modules/task-execution/`，`IN/` = `S/modules/intent/`，`ME/` = `S/modules/memory/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位。本 RFC 收两件建在 shared ref 域之上的纯件（进 `SH/ref/`）、一件三个
  context 共用的中性机制（进 `platform/contracts`）和一处遗留的类型借用（intent 端口自己命名）。
- 不新增模块之间的边：所有使用者改取 shared 或 platform。

## 1. 去向

| 原位置                                                                                                  | 新位置                                      | 说明                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `L/execution/callRefTarget.ts`                                                                          | `SH/ref/callTarget.ts`                      | `pickCallTarget`、`CallTargetRow`、`CallTargetSelector`                                                                                                                  |
| `L/ref/runtimeRef.ts`                                                                                   | `SH/ref/runtime.ts`                         | `RuntimeAgentLookup`、`agentRefOfNode`、`resolveNodeAgentRef`、`fanoutInnerAgentRefKey`、`agentSkillRef`、`runtimeIdRef`、`runtimeRefKey`；import 改 shared 内的相对路径 |
| TE `application/buildNodeRunMintRecord.ts` 的 `generateNodeRunEnvelopeNonce`；`L/nodeRunMint.ts` 的包装 | `S/platform/contracts/envelopeNonce.ts`     | 唯一实现 `generateEnvelopeNonce`（函数体与 RFC-200 的说明原样）                                                                                                          |
| `IN/application/dumpBuilder.ts` 取 `L/systemAgentRun` 的 `SystemAgentSeedFile`                          | `IN/application/ports/intentSystemAgent.ts` | `IntentSystemSeedFile`，端口的 `seedFiles` 与 dump 的 `seedFiles` 同用它                                                                                                 |

`SH/ref/index.ts` 加 `export * from './callTarget'` 与 `export * from './runtime'`（shared 入口已 `export * from './ref'`）。新导出名在 shared 与
frontend 里没有同名（已核对）。

## 2. 消费方改指

- intent：`application/dumpBuilder.ts` 取 shared 的 `pickCallTarget` 与端口的 `IntentSystemSeedFile`；`application/session.ts`、
  `application/turnEngine.ts`、`infrastructure/intentSqlPersistence.ts` 取 platform 的 nonce。
- memory：`application/distill/schedule.ts` 取 shared 的 `agentRefOfNode`；`application/distill/memoryDistiller.ts` 取 platform 的 nonce。
- task-execution：`composition/agentNodeExecution.ts`、`composition/wrapperMechanics.ts`、`infrastructure/legacyTaskExecutionInjectionResolver.ts`
  取 shared 的运行期引用；`infrastructure/legacyCallClosure.ts` 取 shared 的 `pickCallTarget`；`infrastructure/workgroupHostLedgerParticipant.ts`
  取 platform 的 nonce；`application/buildNodeRunMintRecord.ts` 删去 `generateNodeRunEnvelopeNonce` 与随之不用的 `randomBytes` import。
- `services/`：`mcpClosure.ts`、`pluginClosure.ts` 取 shared 的运行期引用；`execution/taskExecutionResourceDependencies.ts` 取 shared 的
  `pickCallTarget`；`nodeRunMint.ts` 删去包装与对应 import。
- 用例：RFC-291 调用目标、RFC-271 运行期引用各组（`rfc271-runtime-ref`、`rfc271-runtime-closure-refs`、`rfc271-ref-contract`）、
  `rfc223-pr2-refs`、`agent-output-kinds-scheduler-load`、`rfc405-port-bindings` 改取 shared；`T/helpers/rfc395Mint.ts` 改取 platform 的 nonce。

## 3. 用例与锁

- **新用例** `T/rfc460-shared-ref-resolvers-and-envelope-nonce.test.ts`：两个旧文件不在、`S/`、用例、仓库根 `tests/` 与脚本零 import 旧路径
  （census AST，带负对照）；shared 入口导出的 `pickCallTarget` 与 7 个运行期引用名就是 `SH/ref/` 里那一份；`pickCallTarget`、运行期引用的
  6 个函数与 `generateEnvelopeNonce` 在后端源码与 shared 源码里各只有一处定义，`generateNodeRunEnvelopeNonce` 不再有定义；nonce 是 16 位
  小写 hex、两次调用不同；intent 的 dump / 会话 / turn 与 memory 的调度不再取 `@/services/`、memory 蒸馏只剩 `services/runtime/types`
  （非目标，随运行时驱动一族）。
- **按路径读源码的锁**：`rfc200-source-lock` 的 nonce 链断言改读 platform 文件（`randomBytes(8).toString('hex')`）与它的四类调用方
  （节点 mint 记录仍要求 nonce、memory 蒸馏仍 `options.envelopeNonce ?? generateEnvelopeNonce()`）；迁移前按 `docs/dev-gotchas.md` 的三种形态
  全仓搜（含仓库根 `tests/` 与 `.github`）。`SH/ref/resolution.ts` 注释里的现状路径改指 `./runtime.ts`。
- 架构报告 legacy 归属表删去 2 条；`commons-debt.json` 的 `R2` 6 条按实测销账；guard-manifest 刷新行数。

## 4. 留下的债

- intent / memory 余下 5 条 `R2`（proposal §3）；`services/nodeRunMint.ts` 其余部分（mint 工厂与 legacy SQLite 适配）随 task-execution
  执行一族 / E1。

## 5. 失败模式

- 漏改的消费方：tsc（backend、shared、frontend）兜底；按路径读源码的锁经新用例零引用断言与 `test-suite-policy` 兜底。
- shared 入口同名导出：`export *` 撞名由 tsc 报出（已核对无同名）。
- nonce 出现第二个实现：新用例断言单一定义。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面 + shared 包用例）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
