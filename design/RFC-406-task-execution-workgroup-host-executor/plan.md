# RFC-406 实施计划

**前置**：RFC-405 落库（两者都改 agent-single 执行器、`P`、`B` 与同一批守卫）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例
完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-406-T1 | 端口增补：`P` 加 `task.repoMounts`、`resources.hostInjection`、两项 collaboration、`ledger.setNodeRunStatus`、`workspace.abandonMerge`、可选的 `extraForcedContainerPaths`、`rules.clarifyForbiddenPrefix`；`B` 补实现 | design §1.2 |
| RFC-406-T2 | host 主体迁入 `AS/runWorkgroupHost.ts`：闭包状态、装配、早退结局、clarify 落库与压制补偿、合并处置原样搬入，只做端口替换 | design §1.1、§2 |
| RFC-406-T3 | 执行器只收 `ports`、两条 lane 直接调主体；`E` 删除 `legacyHostPort`、并入引擎钩子；三个 composition 文件改用 `TaskMechanicsState` / `NodeMechanicsResult`；删除 `N` | design §1.1 |
| RFC-406-T4 | 守卫与用例：新结构锁 `rfc406-workgroup-host-executor`（含负例）、端口绑定用例；design §3 所列守卫改指；RFC-317 两本账、offered-edge 账本销账；Windows 两份 `paths:` 与 suite；账本只准备改法，按 T5 实测填值 | design §3、§4 |
| RFC-406-T5 | 集中验证：静态检查、针对性验证集（含全部架构测试与 workgroup / 动态工作流行为用例）、复跑、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §2 |

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,agentNodeExecution,wrapperMechanics,wrapperRunLifecycle,executionMergeRecovery}.ts`、`TE/engine/node/agent-single/*`、
  `TE/application/ports/agentNodeExecution.ts`；
- 守卫与账本：见 design §3。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 实施记录（2026-11-01）

- **实施**：本会话一次完成 T1～T4（新增 3 个代码 / 测试路径、修改 53 个、删除 1 个，另有三件套与 `guard-manifest.json`）。`nodeMechanics.ts`
  删除（598 行），design §5.5 第 5 步退出门「`nodeMechanics.ts` 删除」成立；host 主体 485 行在 `engine/node/agent-single/runWorkgroupHost.ts`。
- **与设计的出入**：
  - **补上 RFC-405 漏掉的守卫覆盖**：几份按显式文件清单做「不得出现」扫描的守卫（RFC-395 checkpoint 边界、RFC-285 B3、RFC-321、RFC-359 W5-T19b）
    在 RFC-405 之后只剩 `N`（host）——agent 主体迁出时没有进清单，这些不变量对 agent 主体失去了扫描，判据仍然全绿。本 RFC 把它们改为扫描 agent
    执行器的全部文件（两条 lane 的主体、绑定、运行历史读取）。
  - **计数随合并后的结构调整**：`subagentLiveCapture` 直传点 4 → 3（两条 lane 共用绑定的 `withTaskRunFields`），并加「两条 lane 都只经
    `ports.runtime.runAgent(` 发起、主体不碰 `subagentLiveCapture`」的断言；RFC-370 两份「runner 发起点」用例去掉 `N`，标题改为 every。
  - `CollaborationNodeGatePort` 的 `satisfies` 检查从 `nodeExecution.ts` 移到绑定（`legacyHostPort` 删除后 `nodeExecution.ts` 不再持有 collaboration
    runtime），RFC-334 用例随之改指。
  - RFC-403～405 结构锁里针对 `N` 内容的判据保留为合成负例（`N` 不存在时实时判据为空）；「`N` 不得重建、不得被引用」与五个退役名由 RFC-406
    结构锁统一锁定。`rfc328TaskExecutionLedger.ts` 的 worker 分类去掉已删文件的分支。
- **实现门**（本会话自审，只审功能，按路径限定在本 RFC 的候选）：
  - host 主体由脚本从原文机械转换，每个替换都带出现次数校验，转换后扫描旧状态袋、组合层绑定、`opts.persistence` / `opts.taskAgentRuns` /
    `opts.executionContext` / `writeSem` / 裸 `broadcastNodeStatus(` 等残留；`workgroupEngineSupport` 与原 `buildWorkgroupEngineSupport` 函数体逐字一致。
  - 逐项核对：注入分支（orchestrator 合成 / 资源会话）原样搬到绑定；两处 `setNodeRunStatus` 与两处 merge-state abandon 原来都带执行上下文，绑定
    统一补上；`openAgentClarify` 的执行上下文同 RFC-405；`runNode` 请求移出的 8 个字段正是 `withTaskRunFields` 补回的 8 个；`templateMeta` 的
    mountPath 由 `state.repos[i]?.mountPath` 改读 `task.repoMounts[i]`，下标越界与空串的结果相同；`legacyHostPort` 对 `hostOutputPorts` 的复制
    去掉后主体只读它（投影时本来就再复制）；collaboration runtime 改为调用时读，`opts.collaborationRuntime` 是 readonly，task 运行期间不变；
    `WorkgroupTurnHostResult` 与 `WorkgroupHostExecutionResult` 字段逐一相同。
  - 结论 PASS，没有功能差异。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；候选 55 个 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning（首轮 3 个 warning 是改指后
  不再使用的导入，已删）；prettier 通过。
- **实现门**：见「实施记录」，PASS。
- **针对性验证集**（4 worker，21 分钟，负载约 7～14）：全部架构测试、本 RFC 改动的测试、workgroup / 动态工作流行为用例，以及读取改动模块或语料常量
  的测试，共 416 个；4 个失败。
- **本 RFC 引入、已修**（2 个）：`rfc406-workgroup-host-executor` 的退役名扫描把 `services/scheduler.ts` 里另一个本地导入别名 `SchedulerState` 也算了
  进来（改为只扫 task-execution 模块，退役的是它自己的导出）；`clarify-prompt-wire-up` 仍在 `nodeExecution.ts` 里找 gate 端口的 `satisfies` 检查
  （随本 RFC 移到绑定，改指）。
- **负载超时**：`rfc359-w26-workgroup-empty-scan`、`rfc374-node-run-sequence` 的 PostgreSQL 批量用例只以 bun 默认 5 s 超时失败。
- **第二轮**（3 worker）：上述 4 个，加上 RFC-405 的 CI（`81168e759`）里两个被取消分片没跑到的文件（RFC-398 自己的 3 个除外），共 18 个，全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-6）

- **`55b13b555`**：windows-platform `41299852918` success（含本 RFC 的端口绑定用例与结构锁）。主 CI `41299852921`：57 个 job success；
  `Markdown link check (design/)` failure——RFC-294 `review-2026-10-14.md` 里一条指向被本 RFC 删除的 `nodeMechanics.ts` 的链接，属本 RFC
  引入，已由 `442fda880` 改成纯文本；backend 分片 5 / 6 / 20（共 36）跑满 15 分钟被取消（同期 RFC-398 的发布版矩阵等长文件落在这几片，
  RFC-398 随后在 `fe076d714` 按文件耗时重排分片），没有任何用例失败。三个被取消分片里没跑到或被打断的 26 个文件（按 bun 的步进分片从
  排序后的文件表算出），除 RFC-398 自己的 2 个发布版矩阵文件外，24 个在 RFC-407 集中验证的第二轮里本机复跑全部通过（工作树含 RFC-407 的候选，属补充证据）。
- **定时 backend-macos-nightly `41300188523`（跑在 `73742e27d` 上）红**：只有 `rfc370-m3-event-inbox` 的一条 SQLite 用例 6989 ms 超时
  （10-31 的夜间 41 ms 通过）。本机以 git archive 导出 `73742e27d`，按同一种子 332、同一分片 2/18 复现，该用例 44 ms 通过；用例用注入时钟、
  没有真实时间等待，判为 macOS runner 时序抖动，不归任何提交，未改测试。
- CI 证据由后继 run 补齐（见下）。

- **后继证据**：`57103c231`（该提交本身只改 CI 分片配置；本 RFC 提交是它的祖先，其后对本 RFC 代码文件的改动只来自本会话的后继 RFC）的主 CI `41312990481` 69 个 job 全部 success（windows-platform 已在本 RFC 的 exact SHA 上 success）。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
