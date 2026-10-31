# RFC-402 实施计划

**前置**：RFC-400 Done。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；两部分分两次派发只是为了让单次实施的范围可控，
派发之间不做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-402-T1 | 窄合同：`application/ports/executionKernel.ts`、`taskExecutionPermits.ts`；`platform/contracts/isolationWorkspace.ts` 抽出中立 DTO（只有一份定义） | design §1.1 |
| RFC-402-T2 | kernel 主体：assembly、isolation、merge、isolationCleanup、isolationEffectRequest、nodeRunLedger；kernel 不依赖 services / composition / infrastructure / platform 物理实现 | design §1.1 |
| RFC-402-T3 | 许可注册表 `createExecutionPermitRegistry()` 与工作区会话 `infrastructure/executionWorkspaceSession.ts`；bootstrap 按 daemon scope 构造一次并注入所有消费者；全部生产与测试 import 改指；删除七个 `services/` 文件与旧实现路径，TE public 收回隔离转导出，不留 facade | design §1.2、§1.3 |
| RFC-402-T4 | 共享 helper 归位：`application/nodeInputs.ts`、`engine/node/shared/resolveMergeConflicts.ts`、`infrastructure/nodeStatusEvents.ts`、诊断 adapter、ledger 绑定；node / wrapper / 合并恢复共用同一实现 | design §2.3 |
| RFC-402-T5 | script 试点：`engine/node/script/` 四个文件与 `application/ports/scriptNodeExecution.ts`；registry 绑定显式端口；删除旧 executor 与 `runScriptWithFamily` | design §2.1、§2.2 |
| RFC-402-T6 | 守卫与用例：新结构锁 `rfc402-task-execution-kernel`（含负例）、`rfc334-node-executor-boundary` 递归与嵌套负例、RFC-328 / 284 / 287 / 317 / 395 锁改指、许可注册表行为用例；账本只准备改法，按 T7 实测填值 | design §4、§5 |
| RFC-402-T7 | 集中验证：后端全量（含根目录守卫）、script 执行矩阵、隔离 / replay / 恢复、P0 变异 lane、编译版 worker 与二进制相关用例；按实测更新账本；实现门（只审功能）；推送后跟 CI | design §3 |

**派发**：第一次 T1～T3（Part A），第二次 T4～T6（Part B 与守卫收口），同一可写线程；T7 由本会话执行。

## 冲突面

- `TE/composition/nodeMechanics.ts`、`wrapperMechanics.ts`、`executionMergeRecovery.ts`、`nodeExecution.ts`、`taskEngineApplication.ts`；
- `TE/public/participants.ts`、`TE/composition.ts`；collaboration 的 `taskQuestions.ts`、`taskQuestionDispatch.ts`、`clarify/autoDispatch.ts`、
  `gateWorkspaceRollbackExecutor.ts`；`services/task.ts`、`taskDelete.ts`、`commitPushRunner.ts`、`codeHost/*`；
- `bootstrap/daemonHttpComposition.ts`、`bootstrap/daemonModules/taskExecution.ts`、`bootstrap/crossContextClosure.ts`；
- `platform/workspace/local/isolation.ts`（只改为 import 抽出的 DTO 定义）；
- 守卫与账本：见 design §4。

并发会话 RFC-398 的改动面（`main.ts`、`bootstrap/daemonStart.ts`、`bootstrap/epochMigration*`、`bootstrap/autoUpgradeChild.ts`、`platform/persistence/*`、
`modules/system-operations/**`、`scripts/release-upgrade/**`、`cli/epochMigration.ts`）与本 RFC 没有必需的同文件交集；实施前与提交前按路径核对工作树。

## 实施记录（2026-10-31）

- **实施**：Codex 可写线程 `01a19322-fd28-7972-b9ae-4953d7b2c014` 两次派发完成 T1～T6（Part A 148 个路径、Part B 60 个文件）；本会话审核后修正
  四条新增 RFC-317 R1 边（bootstrap 改经 TE `composition.ts` 取注册表构造入口），并把工作区会话从 `TaskMechanicsState` 字段改回
  TE composition 旁表（原因与取舍见 proposal §6 第 9 条）。
- **账本实测**：public 签名债 120→104；`legacy-service-implementations` 218→213，`legacy-thin-facades` 44→42，
  `legacy-horizontal-files` 389→381；commons R2 41 不变；RFC-334 递归语料下限 32。

## 集中验证（T7）

- **静态**：后端 typecheck（含 tests，6 GiB heap）、eslint `--max-warnings=0`、prettier 通过。
- **实现门**（只审功能，只读线程 `01a1936b-0ac0-7332-a0f9-5291ad0e61b8`）：PASS，无 findings；门后只改守卫与 CI 路径过滤，生产代码未再改动。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段全部有效，源文件指纹不变。
- **后端全量**：6 分片、`--isolate --randomize`、PostgreSQL 各用独立库，2713 个文件全部执行（31949 个用例：31783 pass、133 fail、33 skip），
  72 个文件有失败、2 个只报 error。归因：
  - **本 RFC 引入、已修**：
    - 源码锁语料没有随搬迁扩到新文件：RFC-188 装配单源锁（加 `composition/scriptNodeExecution.ts`，并锁 script 主体对三个原语端口各调一次）、
      RFC-292 trigger 锁与 RFC-345 T4a（加合并冲突解决的新位置）、RFC-359 W3-T4 与 RFC-370 删除恢复根绑定（删除恢复多了 daemon scope 的
      许可注册表参数）；
    - RFC-328 effect 账本认不出 kernel 经 binding 调用的 isolation create / merge 观察者，转发处又被记成未分类站点：账本改为把 kernel 调用
      计为原站点，并只接受「原样转发 + persistence / context」的 infrastructure 转发；RFC-402 结构锁补对应负例（改写 kind、丢掉
      request、附加字段、删 resourceKeys、删观察者调用）；
    - RFC-317 新增的 script 站点用例按数字行号写了期望，而 `casSites` 按 `file:line` 字符串排序：用例内改为按行号排序；
    - `windows-platform.yml` 的 push / pull_request `paths:` 仍指向已删除的三个 facade 与旧 `infrastructure/isolatedAgentRun.ts`
      （`test-suite-policy` 报出）：改指 kernel 四个文件与 `infrastructure/executionKernelBinding.ts`，两份列表保持一致。
  - **并发 RFC-398 未提交文件造成**（证据保留，不归本 RFC）：rfc317-module-boundary R1 多 5 条、rfc376（setInterval 15>14、不可达 28>27）、
    rfc393、rfc284 spawn / env-flags / microhelpers、rfc254、rfc349 completeness / cutover、rfc359-w5（t17 / t19 / t19d / t19f）、
    rfc395-nonruntime-source-roles，以及 8 个 `rfc398-*` 用例文件（不 import 本 RFC 改过的模块；串行复现的原因是 RFC-398 的配置 schema、
    `schema_migrations` baseline 重复、缺 `psql`、建库权限与多进程 barrier）。
  - **负载超时**：其余失败均为 PostgreSQL 5 s / 15 s 超时（全量期间机器负载 15～20）。低并发重跑（3 worker，167 个文件：失败文件、
    error-only 文件、全部 `tests/architecture/` 与本轮改过的守卫）后只剩 4 个超时文件；这 4 个以 60 s 超时串行全部通过（排除挂死），
    再按默认超时串行也全部通过。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
