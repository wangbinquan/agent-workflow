# RFC-409 实施计划

**前置**：RFC-408 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-409-T1 | 端口 `P`：`DagScopePorts`、`DagScopeArgs`、`DagNodeOutcome`，只用 task-execution 自有类型 | design §1.2 |
| RFC-409-T2 | 拆 `DF`：定义图纯函数进 `domain/wrapperGraph.ts`，frontier 判定进 `ES/frontierRules.ts`；`public/queries` 导出 `wrapperInnerDescendants`；改指 `runLiveness`、`wrapperRunLifecycle` 与用例；删除 `DF` | design §1.1 |
| RFC-409-T3 | `dagFrontier.ts` 迁入 `ES`；`runScope` 迁入 `ES/runScope.ts`，只做端口替换；`composition/taskDagScope.ts` 改为端口绑定与 `driveDagScope`；`driveScope` 递归改经绑定 | design §1.1、§2 |
| RFC-409-T4 | 守卫与用例：新结构锁 `rfc409-dag-scope-interpreter`（含负例）、端口绑定用例；design §3 所列守卫改指与清单补齐；Windows 两份 `paths:` 与 suite；账本按 T5 实测填值 | design §3、§4 |
| RFC-409-T5 | 集中验证：静态检查、针对性验证集（含全部架构测试与 frontier / scope / wrapper / 恢复 / 人工门行为用例）、复跑、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §2 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **`readWrapperRevivalIteration` 下沉到 `domain/wrapperProgress.ts`**：它原本直接定义在 `public/queries.ts`，frontier 规则进入 engine 后不应
   反向 import 本模块 public；`public/queries` 改为重新导出，对外 API 不变。
2. **`driveDagScope` 保留旧入口签名**：`composition/taskDagScope.ts` 的 `driveDagScope(state, args, factory)` 与旧 `runScope` 同签名，C 的两个
   调用点只改名；scope 循环本体 `runScope(ports, args)` 在 engine。
3. **legacy 调用方经 public 合同**：`services/runLiveness.ts` 改从 `public/queries` 取 `wrapperInnerDescendantIds`（原为 services 内部 import）——
   public 面不得出现可变 `Set`（RFC-294 public 合同扫描），所以 public 导出的是返回 `ReadonlySet` 的包装函数，而非直接重导出 domain 函数；
   `composition/wrapperRunLifecycle.ts` 直接 import `domain/wrapperGraph`；`architectureReport.ts` 的 legacy 归属表删去已删除文件。
4. **wrapper 成员只经 scope 索引读取**：`innerNodeIdsOf` 原样迁入 domain 后被 RFC-339 的「只有 scope 索引读 `nodeIds`」锁扫到（它在
   services 时不在扫描范围）；`domain/executionScope.ts` 导出它已有的 `directNodeIdsOf`（同样的数组判断与字符串过滤），`innerNodeIdsOf`
   委托给它，对 `undefined` 节点仍返回空数组。这两处由集中验证第一轮发现（rfc339、rfc294 preflight 各 1 条），已修。

守卫与账本（T4）：

- import 旧 `services/dispatchFrontier` 的 7 个用例分流到 `engine/scope/frontierRules` 与 `domain/wrapperGraph`；读 `composition/dagFrontier.ts` 的
  用例与 helper 改路径；读 `composition/taskDagScope.ts` 的锁改读 `engine/scope/runScope.ts`（RFC-098 提交推送、RFC-128 park 目标、RFC-332、
  transitive dispatch gate），RFC-334 另锁 scope 循环只经 `ports.executeNode(` 派发一次；RFC-395 A3 的函数抽取用例绑定改为 `ports`；rfc147
  的通道边投影改读 `domain/wrapperGraph.ts`；rfc339 的「legacy 文件只经 public」清单以 `services/runLiveness.ts` 替换已删文件；
- RFC-395 选择语义账本三条站点随主体迁移（`runScope` 的提交推送续跑站点 source 随接收者更新）；
- 新结构锁 `tests/architecture/rfc409-dag-scope-interpreter.test.ts`（owner 唯一、两个已删文件不得复活或被引用、绑定不得重获 scope 循环、
  `engine/scope/` 的 import 层级，均带纯伪造输入的负例）；端口绑定用例 `tests/rfc409-port-bindings.test.ts`（含一次空 scope 的真实驱动）；
  Windows 两份 `paths:` 与 suite；guard-manifest 新增一条、同步两条行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0（`runLiveness.ts` 的两条同源 import 合并后复跑仍为 0）；改动的 TS 文件 eslint
  `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 Windows workflow）。
- **实现门**（本会话自审，只审功能）：把原 `runScope` 函数体按固定替换（`state` / `opts` → 端口）规范化后与 `engine/scope/runScope.ts` 逐段
  diff，27 处差异全部是预期的端口替换（任务事实、执行上下文与信号、selection / nodeExecution / nodeRuns / intents、协作读取、`executeNode`、
  提交推送）；`dispatchFrontier.ts` 的全部声明在 `frontierRules.ts` / `wrapperGraph.ts` 中逐字一致，唯一差异是实施记录第 4 条的
  `innerNodeIdsOf` 委托（同样的数组判断与字符串过滤，`undefined` 仍返回空数组）；绑定一侧递归经 `createDagScopePorts(nestedState, …)`。PASS。
- **针对性验证集**（6 worker，39 分钟，负载约 10～25）：全部架构测试、本 RFC 改动的测试，以及 frontier / scope / wrapper（loop / git /
  fanout）/ 恢复 / 取消 / 人工门 / 提交推送 / workgroup / 动态工作流 / run liveness 等用例，共 954 个；19 个失败。其中 2 个是本 RFC 引入的
  真实失败——RFC-339「只有 scope 索引读 `nodeIds`」与 RFC-294 preflight「public 面不得出现可变 `Set`」（见实施记录第 3、4 条），已修，
  复跑这两个文件与 rfc409 / dispatch-frontier 共 64 个用例通过；其余 17 个均为负载下的超时（以 PG 为主）。
- **第二轮**（3 worker，负载约 13～20）：这 17 个、修复后的 rfc339 与读 `runLiveness` 的另 3 个用例共 21 个，14 个通过；7 个仍是超时。
- **第三轮**（负载降到 15 以下，单进程，候选与 RFC-408 基线 `7aca6d6f0` 的导出各跑一次）：`rfc396-mr-bridge` 216 s / 227 s、
  `scheduler-clarify-dispatch` 49 s / 49 s、`review-detail-render-rfc158` 17 s / 18 s、`rfc359-w28` 21 s / 20 s 两侧都通过；
  `lifecycle-property` 候选通过、基线在 PG 属性用例上超 15 s；`rfc359-w26` 与 `rfc374-node-run-sequence` 两侧都超 5 s（机器上常驻一个
  约 450% CPU 的容器，负载降不到 9 以下）。另在 import 合并后复跑读 `runLiveness` 的 4 个用例，全部通过。
- **第四轮**（两侧都超时的 2 个，单进程、每用例 30 s 上限）：`rfc359-w26` 20 s / 20 s、`rfc374-node-run-sequence` 9 s / 8 s，两侧全部
  通过——断言本身在两侧一致，失败只是 5 s 预算在负载下不够，与本 RFC 无关。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{taskDagScope,dagFrontier,taskEngineApplication,wrapperRunLifecycle}.ts`、`TE/engine/scope/*`、`TE/domain/wrapperGraph.ts`、
  `TE/application/ports/dagScope.ts`、`TE/public/queries.ts`、`services/{dispatchFrontier,runLiveness}.ts`；
- 守卫与账本：见 design §3。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-6）

- **`ea07e2aec`**：windows-platform `41321761090` 失败：shared 腿 `packages/shared/tests/wrapper-kind-single-source.test.ts` 的文件清单含本 RFC
  删除的 `services/dispatchFrontier.ts`（ENOENT）。属本 RFC 引入（同一个改名半径遗漏），已由 `a06fcae26` 换成承接它的
  `engine/scope/frontierRules.ts` 与 `domain/wrapperGraph.ts`；该 job 在这一步即停止，本 RFC 的 Windows suite 由后继 run 补跑。
- AC-6 待后继 run 补齐。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
