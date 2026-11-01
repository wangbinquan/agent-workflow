# RFC-414 实施计划

**前置**：RFC-413 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                | 依据              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-414-T1 | infrastructure 查询：`taskExecutionTaskReads.ts`（`readTaskStatus`、`readTaskWorkspaceRef`）、`digitalEmployeeExecutionReads.ts`                                                                                                                    | design §1         |
| RFC-414-T2 | infrastructure 本地 I/O：`workspacePreparationGc.ts`、`local/localActionWorkspaceEntries.ts`、`local/canonicalDelta.ts`、`crewstation/taskImage{Execution,Archive}.ts`；`resolveNativePortContentDetailed` 迁入 `local/filePortOutputValidation.ts` | design §1         |
| RFC-414-T3 | composition 改为绑定 / 再导出：`workspacePreparationMaintenance`、`crewstationExecution`、`crewstationRecovery`、`actionExecutionRunners`、`digitalEmployeeExecution`、`nodeExecution`、`taskImage*`、`portOutputValidation`                        | design §1、§3     |
| RFC-414-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；旧路径锚点改指；Windows paths；全仓（`packages/`、`e2e/`、`scripts/`、`design/` 链接）grep                                                                                                              | design §2、§4、§5 |
| RFC-414-T5 | 集中验证：静态检查、针对性验证集（全部架构测试、test-suite-policy、维护 / 托管 / 动作 / 数字员工 / 零增量 / 镜像用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                                                             | design §3         |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **与 RFC-376 账本对齐**：实施时发现 RFC-376 已有 `composition-forbidden-import-files`（fs / child_process / drizzle 可达）的精确账本，
   task-execution 的七条正是本 RFC 迁走的文件（`nodeExecution.ts` 的 `util/git` 不在其规则内）。账本删去这七条，`architecture/counts.json`
   的 max 21 → 14；新结构锁只补 RFC-376 规则没有覆盖的持久化 helper（`sessionTables` / `queryHelpers` / `bun:sqlite`）、`util/git` 与
   `tablesOf(` / `Bun.spawn(` 调用，并钉住新 infrastructure owner。
2. **`readTaskStatus` 合为一份**：托管恢复与动作运行器原本各写一遍同一条状态查询，迁到 `infrastructure/taskExecutionTaskReads.ts` 后共用。
3. **人审闸门快照的用例改从 owner 取**：四个用例（`rfc359-w12-…-human-review-parity`、`rfc368-reaction-execution-adapter`、
   `rfc310-…-human-review-system-mock-e2e`、`execution-contract-platform`）的 `inspectDigitalEmployeeHumanReviewSnapshot` 改从
   `infrastructure/digitalEmployeeExecutionReads.ts` import，不在 composition 留再导出。
4. **托管任务镜像的导出面**：bootstrap 只依赖模块 composition / public，`composition/taskImageExecution.ts` / `taskImageArchive.ts` 改为只做再导出；
   原文件经 composition 取 `resolveNativePortContentDetailed`，该函数（把 native IO 绑进校验策略）随之迁入
   `infrastructure/local/filePortOutputValidation.ts`，composition 的 `portOutputValidation.ts` 再导出它——`infrastructure/local/nativeTaskAgentRun.ts`
   原先反向 import composition 取它，现改为同目录取用。
5. **GC 相位的类型收窄**：composition 判完相位后以 `{ ...request, phase: request.phase }` 交给 infrastructure，函数签名据此只收
   `orphan` / `scratch`；交给 source-control 的请求字段不变。

守卫与用例（T4）：新结构锁 `rfc414-composition-io-out`（task-execution composition 不 import 七类模块、不调 `tablesOf(` / `Bun.spawn(`，十一个
infrastructure 符号 owner 唯一，均带负例）与端口绑定用例 `rfc414-port-bindings`（两 provider 上的状态 / 工作区 / 数字员工元数据读，GC 相位的透传与
回执，canonical delta 的无 base 报错，本地工作区入口检查，composition 的绑定锚点）；`rfc187-zero-delta-done` 的逐仓 delta 锚点改读
`infrastructure/local/canonicalDelta.ts`；RFC-376 账本销账七条；Windows 两份 `paths:` 与 suite；guard-manifest 新增一条并同步 RFC-376 守卫行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 Windows
  workflow）。
- **实现门**（本会话自审，只审功能）：迁移主体逐段比对——托管任务归档逐字一致，托管任务镜像操作只差 import 路径，GC 相位与人审闸门快照
  空白归一后逐字一致，状态 / 工作区 / 元数据读的列、条件与 limit 不变，canonical delta 与本地入口检查逐字迁移；composition 的绑定在原调用点
  以同样的参数调用新 owner。PASS。
- **针对性验证集**（6 worker，负载约 9～30）：全部架构测试与守卫命名的测试、`test-suite-policy`，以及提到工作区准备 / 托管 / 动作执行 /
  数字员工 / Reaction / 零增量 / 任务镜像 / 端口输出校验 / 执行合同的用例，共 625 个文件；8 个失败，全部是负载下的 PG 超时或连接被关
  （`rfc396-mr-bridge` 两 lane 均超时），无本 RFC 引入的失败。
- **第二轮**（3 worker，负载约 8）：8 个全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{workspacePreparationMaintenance,crewstationExecution,crewstationRecovery,actionExecutionRunners,digitalEmployeeExecution,nodeExecution,taskImageExecution,taskImageArchive,portOutputValidation}.ts`、
  `TE/infrastructure/` 下新文件与 `local/filePortOutputValidation.ts`、`S/bootstrap/workspaceTaskImage.ts`；
- 守卫与账本：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-5）

- **`7bcab1997`**：windows-platform `41350432810` success。主 CI `41350432956`：67 success；backend 分片 2/44 失败于本 RFC 新增结构锁
  `rfc414-composition-io-out` 的 owner 负例——对 11 个 owner 各跑两次全语料检查、每次重走全部 AST，CI 上 5307 ms 超出 5 s 默认时限（属本 RFC
  引入），已由 `c4b025f4c` 按单元缓存扫描（本地 11 ms）并给 20 s 预算；分片 43/44 为 `scheduler-clarify-dispatch` 的一个 PG 用例 5 s 超时——
  本 RFC 未触及澄清 / 调度路径，同文件其余 PG 用例约 2 s 通过，同一用例在 `7f8abe5a0` 的主 CI（70/70）上通过，判为 runner 负载超时，不归本 RFC，
  证据已留；`CI required` 随之失败。
- **`c4b025f4c`**（结构锁超时修复，含 `7bcab1997` 全部改动）：主 CI `41353445349` 70 个 job 全部 success（分片 2/44 的结构锁与
  分片 43/44 均通过），windows-platform `41353445348` success。AC-5 成立，RFC-414 Done。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，`c4b025f4c`，见上）
