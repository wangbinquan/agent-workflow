# RFC-405 实施计划

**前置**：RFC-404 落库（两者都改 `nodeMechanics.ts`、`nodeExecution.ts` 与同一批守卫）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与
用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-405-T1 | 共享实现：重试与续跑判定迁入 `domain/envelopeRetryPolicy.ts`；运行历史读取迁入 `application/agentRunHistory.ts`；借壳拒绝判定 `application/agentNodeErrors.ts`；`W` 改指；删除 `Binding` / `readBindings` | design §2 |
| RFC-405-T2 | 窄合同 `application/ports/agentNodeExecution.ts`（COL 五项在端口内一次派生）与绑定 `composition/agentNodeExecution.ts` | design §1.2 |
| RFC-405-T3 | 主体迁入 `engine/node/agent-single/runAgentSingleNode.ts`：闭包状态、重试前奏、单次 attempt、装配窗口与结局映射原样搬入，只做端口替换 | design §1.1、§3 |
| RFC-405-T4 | 执行器迁入 `engine/node/agent-single/agentSingleNodeExecutor.ts`；`E` 以显式端口直接构造；删除旧执行器文件、`legacyArgs`、`OneNodeArgs` 与 `N` 中主体 | design §1.1 |
| RFC-405-T5 | 守卫与用例：新结构锁 `rfc405-agent-single-executor`（含负例）、端口绑定用例；design §4 所列守卫与 9 个直接 import 的用例改指；RFC-395 selection ledger；Windows 两份 `paths:` 与 suite；账本只准备改法，按 T6 实测填值 | design §4、§5 |
| RFC-405-T6 | 集中验证：静态检查、后端全量（含根目录守卫）、相关两 provider 用例、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §3 |

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,wrapperMechanics}.ts`、`TE/engine/node/*`、`TE/domain/envelopeRetryPolicy.ts`；
- 守卫与账本：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 实施记录（2026-11-01）

- **实施**：本会话一次完成 T1～T5（新增 8 个代码 / 测试路径、修改 55 个、删除 1 个，另有三件套与 `guard-manifest.json`）。`nodeMechanics.ts`
  2496 → 598 行，只剩工作组主机线（RFC-406）。
- **与设计的出入**：
  - 端口合同改为 task-execution 自有的结构类型：`collaboration` 不再从 COL 合同 `Pick` 派生（`openAgentClarify` 复用 TE 自有 gate 端口的请求 / 回执
    类型），`rules` 与 `resources` 也不再 `typeof` 引用 `services/` 的实现；真实实现只在绑定里接入，由编译器检查它们满足端口签名。首版按 `Pick` /
    `typeof` 写，集中验证里三本账判红（见 T6）：一条新的 TE→COL off-DAG 文件边（`off-dag-offered-file-context-pairs` 54 → 55，超 counts 上限）和
    8 条 application → `services/` 的 R2 边（commons-debt 只减不增）。RFC-026 的 inline 回退原因联合类型随之在 `agentRunHistory.ts` 声明一份 TE 自有
    副本，绑定把 `decideResumeSessionId` 交给 rules 端口时由编译器保证两者一致。结构锁新增「端口与运行历史读取不得 import `services/` 或 collaboration」
    及负例。`policy` 只留主体读取的五项（executionContext、signal 由绑定在写库、开澄清与发起运行时补上），`countAgentTextEvents` 归在 `history`。
  - `OneNodeArgs` 没有删除：它仍是 scope 解释器派发一个节点的入参，随最后一个使用者 `executeNode` 移入 `composition/nodeExecution.ts`（结构锁按此登记 owner，
    并继续禁止它出现在 agent 叶子目录）。
  - 绑定里「只补 task 级运行字段」抽成导出的纯函数 `withTaskRunFields`，端口绑定用例直接断言它不改写 engine 请求、可选字段缺省时不出现。字段的枚举顺序变为
    engine 请求在前、task 级字段在后；runner 按字段名读取，不依赖顺序。
  - RFC-328 账本不加分类：新主体、执行器、绑定与历史读取都没有直接的表写（durable mutation 为零），worker 分类只按表写归属，按实测不需要新增（design §4
    原写「纳入」）。RFC-317 transition oracle 同理：主体只用事件式 `transitionNodeRunStatus`，不在字面量 CAS 匹配集内，没有站点要改指。
  - `nodeMechanics.ts` 头注释改为「工作组主机线」，并删去 RFC-282 / RFC-284 / RFC-332 留下的、所描述声明早已迁走的悬空注释（只动注释与空行）。
  - 守卫增补（design §4 之外）：RFC-287 T1 广播反序扫描、T9 直线取许可扫描与 RFC-208 池覆盖判据纳入 `ledger.` / `ports.` 接收者（主体经端口写库、取池），
    广播反序扫描带负例；RFC-188 加「主体经 workspace 端口各调三个原语一次」；RFC-395 content boundary 的 `portFallbackMount` 站点改为 agent 绑定，并加「主体只经
    workspace 端口换算」的判定；`rfc127-self-questioner-borrow` 的借壳拒绝锁改读新主体与 `agentNodeErrors.ts`，并加正反例；`node-run-mint` 铸点清单改为
    新主体，对 `nodeMechanics.ts` 保留负向锁。
- **实现门**（本会话自审，只审功能，按路径限定在本 RFC 的候选）：
  - 13 个迁出的 helper（`decideEnvelopeFollowup`、`shouldRetryNodeFailure`、`FRAMEWORK_AUDIT_EVENT_PREFIX`、八个运行历史读取等）与 `HEAD` 原文按声明逐个
    比对，去掉 `export` 与空白后逐字一致；`nodeMechanics.ts` 余下的 `SchedulerState`、`executeWorkgroupHostMechanics`、`buildWorkgroupEngineSupport`、
    `OneNodeResult` 与移走的 `OneNodeArgs` 也逐字一致。
  - 主体由脚本从原文机械转换，每个替换都带出现次数校验，转换后对旧状态袋、组合层绑定、`opts.persistence` 等残留做了扫描。逐项核对：五处 `read` 都是单参；
    三处 `appendEvent` 与一处 `patch` 原来都带执行上下文、两处 `openAgentClarify` 原来都带执行上下文，绑定统一补上，等价；`runNode` 请求移出的 8 个字段
    正是绑定补回的 8 个；`state.task`、`log`、`agentSem`、`writeSem` 在状态上是 `readonly`，改为调用时读取与原来在函数入口取等价；collaboration runtime
    由网关构建时取一次改为每次调用时读，task 运行期间不变；原 `OneNodeResult` 与 `NodeStepOutcome` 字段逐一相同，旧执行器原样转交，现在直接返回。
  - 结论 PASS，没有功能差异。

## 集中验证（T6）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；候选 61 个 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning（首轮 6 个 warning 是改指后
  不再使用的 `node:fs` / `node:path` 导入，已删）；prettier 通过。
- **实现门**：见「实施记录」，PASS。
- **针对性验证集**（4 worker，24 分钟，负载约 22～28）：RFC-404 的 355 个文件（守卫文件名判据、读 `nodeMechanics.ts` 的测试、calls / 调度行为测试）
  并上本 RFC 的 335 个（全部架构测试、读 `N` / 相关 owner / 语料常量的测试、跑真实调度的行为测试），去重 489 个；8 个失败。
- **本 RFC 引入、已修**（4 个文件，两个原因）：
  - `rfc294-review-offered-edge-dag`、`rfc376-structural-guards`（off-DAG 文件边 54 → 55，超 counts 上限）与 `rfc317-module-boundary`（8 条 R2 边）：
    首版端口从 COL 合同 `Pick`、从 `services/` `typeof` 取类型。改为 TE 自有结构类型后三本账回到原值（见「实施记录」）。
  - `rfc317-guard-negative-fixture`：`rfc313-source-locks` 与 `rerun-prior-output-source-guards` 改读组合语料常量后，负 fixture 判据看不出那是读真实
    文件得来的语料，把 `occurrences(…, '源码片段')` 判成伪造源码。两份测试改为就地读各 owner 文件（计数覆盖的代码不变），账本 `negativeFixture` 保持 false。
- **负载超时**：其余 4 个（`rfc167-dynamic-workflow-engine`、`rfc359-w5-composition-root-route-surface`、`scheduler-envelope-followup-integration`、
  `scheduler-clarify-dispatch`）只以 bun 默认 5 s 超时失败（`rfc167` 的断言错是超时用例在拆除后继续执行的连带）。
- **第二轮**（3 worker，5 分钟，负载约 9～15）：全部架构测试、上述 8 个、本轮改过的测试，以及 RFC-404 CI（`88d4c088f`）里被取消分片没跑到的 52 个
  文件，共 171 个；只有 `scheduler-clarify-dispatch` 的 PostgreSQL 用例再次超时，单独跑 16/16 通过。该用例本机在修改前后都落在 5～8 s（RFC-404 两轮
  7.7 / 6.0 s，本 RFC 两轮 6.8 / 6.5 s，单跑 4.5 s），CI 在 `88d4c088f` 上是 1.7 s，属本机负载，不是本 RFC 的回退。
- **第三轮**（2 worker）：首轮后 `agentRunHistory.ts` 加了类型与注释、`nodeMechanics.ts` 整理了头注释，语料含这两个文件的源码锁（第二轮之外的 65 个）
  复跑，全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-6）

- **`81168e759`**：windows-platform `41295916804` success（含本 RFC 的端口绑定用例与结构锁）。主 CI `41295916543` 59 success / 2 cancelled /
  `CI required` failure：没有任何用例失败；shard 4 与 19 跑满 15 分钟上限被取消——父提交 `109ca2f81`（并发 RFC-398）的主 CI `41293473768` 同样有
  3 个分片因此取消，慢的是 RFC-395 的几份重测试（`rfc395-production-source-manifest` 在两次 run 里都约 260 s）加上 RFC-398 新增的发布版矩阵文件
  （每份约 50 s），与本 RFC 无关。两个被取消分片里没跑到的 17 个文件（按 bun 的步进分片从排序后的文件表算出），除 RFC-398 自己的 3 个外，
  在 RFC-406 的集中验证里本机复跑全部通过（工作树含 RFC-406 的候选，属补充证据）。CI 证据待后继 run 补齐，AC-6 暂不关。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
