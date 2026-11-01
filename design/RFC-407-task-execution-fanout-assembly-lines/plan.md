# RFC-407 实施计划

**前置**：RFC-406 落库（共用 agent-single 端口与绑定）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-407-T1 | 端口增补：`P` 加 `subprocessSem`、`ledger.listOutputs` / `shardSet`、`workspace.completeInterruptedMerge` / `adoptedExecution` / `undoShard`、`resources.sourcePortKind`、`rules.shardValueHash`，四个工作区原语加可选 `log`；`B` 补实现，`sourcePortKindOf` 迁入 `B` | design §1.2 |
| RFC-407-T2 | 两条装配线迁入 `AS/runFanoutShard.ts`、`AS/runFanoutAggregator.ts`：重试外层、候选选择、铸行、输入、注入、prior output、装配与处置原样搬入，只做端口替换 | design §1.1、§2 |
| RFC-407-T3 | `AS/fanoutAttempts.ts` 实现 `FanoutAttemptPort`；`W` 改用它构造 `fanoutAttempts`，删除 `W` 中的两条线 | design §1.1 |
| RFC-407-T4 | 守卫与用例：新结构锁 `rfc407-fanout-assembly-lines`（含负例）、端口绑定用例；design §3 所列守卫改指与清单补齐；Windows 两份 `paths:` 与 suite；账本只准备改法，按 T5 实测填值 | design §3、§4 |
| RFC-407-T5 | 集中验证：静态检查、针对性验证集（含全部架构测试与 fanout 行为用例）、复跑、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §2 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **`sourcePortKindOf` 放在 `B`，不放 application**：它读任务的注入会话与共享端口表，挪到 application 只能把两者都改成参数传入，
   没有第二个消费者受益。先试过独立的 `composition/fanoutSourcePortKind.ts`，但那会新增两条 composition → `services/` 的文件边
   （R2 精确账本只降不升），故改放 `B`：`B` 本就 import 这两个模块，`W` 本就依赖 `B`，零新增边、无环。
2. **`workspaceRecord` 按语义拆成 `adoptedExecution` / `undoShard`**：两条线只用记录的这两项，engine 不接触工作区记录的形状。
3. **四个工作区原语加可选 `log`**：迁移前两条线把自己的子 logger 直接传给 kernel，端口照此转交，缺省仍是任务 logger。
4. **运行发起改经 `runtime.runAgent`**：绑定的 `withTaskRunFields` 补的 task 级字段（observationInvocations、memorySnapshots、
   memoryInjectionQueries、runtimeSessionLeases、runtimeRegistry、persistence、signal、subagentLiveCapture）与迁移前两条线逐项直传的完全相同，
   family 同为 `opts.taskAgentRuns`；live capture 直传点因此 3 → 1（只剩绑定）。
5. **端口文件强制路径改用 `workspace.portFileContainerPaths`**：`portFallbackMount` 与旧表达式 `state.repos[0]?.mountPath ?? ''`
   在单根仓、无仓、多仓 / 非根单仓三种布局下结果相同。
6. **triggerContext 经 task facts、合并状态 abandon 经 `workspace.abandonMerge`**：前者 getter 返回同一冻结值，后者绑定写同一次
   `mergeStates.tryTransition`（`{ kind: 'abandon', reason }` + 执行上下文），两条线仍 `await` 它再返回 failed。

守卫与账本（T4）：

- RFC-287 T1 / T5 的语料补入两条线的新文件，T1 广播序列、T9 灭绝锁经 `LEAF_NODE_SOURCES` 覆盖；T14 改锁 `await workspace.abandonMerge(…)`
  并加锁绑定把 abandon 交还同一个 transition promise；
- 按 `W` 路径取语料的锁改读新 owner 或 `WRAPPER_MECHANICS_SOURCE`（`W` + 两条线 + `fanoutAttempts.ts`）：RFC-130、RFC-200、RFC-210、
  RFC-223 PR-2、RFC-271、RFC-292、RFC-066 PR-B、RFC-067、RFC-370 启动点、S21、wrapper-fanout routing、shard kind、retry budget、envelope followup；
  缺席断言一律改读复合语料，保住对两条线的覆盖；`LEAF_NODE_SOURCES` 与复合语料不在同一计数里并用（避免重复计数）；
- 计数按实测：RFC-188 三个装配计数 7 / 8 / 7 不变（另加两条线各经 workspace 端口一次的逐体断言）；注入入口 6 个不变（字面量 6 → 4，
  三个端口读取者经绑定的同一个 delegate）；RFC-066 PB-G2 的 `canonRepos` 计数 4 → 2，换成三条派发线逐线钉住「经绑定的
  `createIsoUnderLock` 建 iso」；live capture 3 → 1；
- RFC-317 allowTerminal 账本与 transition oracle 偏离账本的 `W` 条目拆到两个新 owner，全仓站点数与表外边集合不变；
- RFC-395 checkpoint 边界的显式文件清单补入两条线与 `fanoutAttempts.ts`（RFC-406 的教训）；familyHistory 站点不变，选择语义账本无需改；
- RFC-395 content-boundary「只经 workspace 端口用回退挂载编解码」的锁扩到两条线：迁移前两条线在 `W` 里内联旧公式
  `state.repos[0]?.mountPath ?? ''`（结果与编解码相同，但不在编解码里），旧公式没有跟着搬过来；
- 新结构锁 `tests/architecture/rfc407-fanout-assembly-lines.test.ts`（owner 唯一、`W` 不再声明 / 引用线主体、端口装配、两条线取 agent 端口
  并声明两个池，均带负例）；端口绑定用例 `tests/rfc407-port-bindings.test.ts`；Windows 两份 `paths:` 与 suite；guard-manifest 新增一条、
  同步三条行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 38 个 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过
  （含 Windows workflow）。
- **实现门**（本会话自审，只审功能）：逐段 diff 两条线迁移前后的全文，每处替换对照绑定实现核对——重试预算、候选行读取与选择、中断合并补完、
  铸行 / 改状态 / patch（执行上下文由绑定补齐，与旧条件展开同义）、注入、两个池、建 iso / 落基线、撤销（`adoptedExecution` 类型为
  `boolean | undefined`，真值判断与 `=== true` 等价）、运行时解析与发起（task 级字段逐项相同、运行路径不对请求整体序列化）、合并 / 冲突解析 /
  abandon / 合并失败标记 / 清理，以及 `fanoutAttempts` 的参数整理与子 logger 命名，均与迁移前一致；`createAgentNodeExecutionPorts` 构造时全部
  惰性读取。PASS。
- **针对性验证集**（6 worker，24 分钟，负载约 10～22，并发会话在编译二进制）：全部架构测试、本 RFC 改动的测试、fanout / wrapper / agent 行为
  用例，以及读取改动模块或语料常量的测试，共 489 个；15 个失败。
- **本 RFC 引入、已修**（1 个文件两条断言）：`rfc317-guard-negative-fixture` 的账本漂移——新结构锁的负例都从真实语料派生，判据认不出，
  补了三条纯伪造输入的负例；`source-text-rfc066-pr-b-guards` 改读复合常量后，PB-G1 带源码片段的断言被判成负 fixture，改回在文件内
  `readFileSync` 读 `W`，PB-G2 的计数语料显式拼上两条线（即 RFC-405 记下的那条坑）。
- **负载超时**：其余 14 个都是 `[postgresql]` 用例以 bun 默认 5 s 超时失败（同文件的 SQLite 变体通过）。
- **第二轮**（3 worker）：上述失败、验证中改过的守卫，加上 RFC-406 的 CI（`55b13b555`）里三个被取消分片没跑到的 24 个文件（RFC-398 自己的 2 个
  除外），共 44 个，43 个通过；`scheduler-clarify-dispatch` 仍有 1 条 PG 用例超时。
- **第三轮**：`scheduler-clarify-dispatch` 单独一个进程跑，候选 16 / 16 通过；在 `73742e27d`（RFC-406 基线）的导出目录里同样 16 / 16，逐条耗时
  几乎相同（例如 5,495 ms 对 5,435 ms），判为该文件 PG 用例本身贴着 5 s 预算，与本 RFC 无关。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{wrapperMechanics,agentNodeExecution}.ts`、`TE/engine/node/agent-single/*`、`TE/application/ports/agentNodeExecution.ts`；
- 守卫与账本：见 design §3。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
