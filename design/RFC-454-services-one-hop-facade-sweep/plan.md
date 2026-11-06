# RFC-454 实施计划

**前置**：RFC-453 落地（`6fb219f5b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                               | 依据        |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| RFC-454-T1 | 澄清判定与澄清节点查找迁入 TE `domain/clarifyRules`；TE composition 改取 domain                                    | design §2.1 |
| RFC-454-T2 | 调用闭包编解码与启动输入校验迁入 RC `domain`，经 RC public 导出；TE / integration 改取 public                      | design §2.2 |
| RFC-454-T3 | 脚本解释器解析迁入 `platform/execution/local/scriptInterpreter`；TE `scriptRun` 与 EC 改取平台                     | design §2.3 |
| RFC-454-T4 | workgroup 词表与澄清提问者键、`stringifyWorkflowYaml`、`extractWorkflowAgentRefs` 迁入 shared；本地副本改取 shared | design §2.4 |
| RFC-454-T5 | 30 个转出删除，生产消费方改取声明处 / 平台 / shared / owner public                                                 | design §1   |
| RFC-454-T6 | 用例 import 改指（按导入名分到新位置）、随迁文本锁、账本与清单、guard-manifest；新增 RFC-454 用例                  | design §3   |
| RFC-454-T7 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                              | design §6   |
| RFC-454-T8 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D 第一步）                                             | —           |

## 验收清单

- [ ] AC-1 30 个转出删除、零引用；余下 6 个转出的消费方不增
- [ ] AC-2 架构计数按实测（`legacy-thin-facades` 36 → 6、`services/` 153 → 123、`R1` / `R2` 下降），越界类计数不升
- [ ] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `fd5467bec`）

本机全程高负载（负载 25～67）。验证都在候选导出仓库里跑（`fd5467bec` 的 `git archive` 加候选路径，提交后运行）；集中验证中的修复同步进
导出仓库后，核对 310 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc`（backend、shared）0 错；eslint `--max-warnings 0` 无告警；改动的 TS、JSON 与 workflow 已按 prettier 格式化；
  `guard-manifest.json` 刷新受影响守卫的行数。
- **本 RFC 的问题，已修**（全量 SQLite 与 PostgreSQL lane 都查出，tsc / eslint 看不见）：
  - `rfc376` 不可达精确清单多出 3 个文件：TE `legacyCallClosure`、它读的 `services/workgroups`、RC `legacy/workflow.yaml`。编解码与
    `stringifyWorkflowYaml` 迁走后它们只剩用例在用，此前只是被转出的再导出链算作可达。登记为保留，继任 W9-D（design §4 末，proposal §6.4）；
  - `rfc294-architecture-preflight` 的 public surface 偏差多出 2 条：`FrozenWorkgroupRef.group: unknown` 随编解码进了 RC public。改为
    生产冻结写入的 `FrozenWorkgroupGroup`，启动处照旧复验（design §2.2）；
  - `rfc339-wrapper-runtime-cutover` 的裸成员读者：`computeRemaining` 迁进 TE 后落入「TE 里包装成员只由作用域索引读」的扫描面，改经
    `directNodeIdsOf`，新用例补了对照（design §2.1）；
  - `rfc359-w8-t29` 的串行化插入源码锁：CO `clarify/seal.ts` 的三行 import 改指使摘要失配，复核后重钉并把复核写进该条 `why`；
  - 写着已删转出路径的锁：`cross-clarify-designer-rerun-no-rollback` 的源码守卫读 `services/clarify/service.ts` 与
    `services/taskQuestionDispatch.ts`（ENOENT；两个都是转出，原断言只看到再导出行），改读 CO 实现文件；`clarify-prompt-wire-up` 的
    stop 门改读 TE `domain/clarifyRules.ts`；`windows-platform` 两份触发清单里的 `services/runtime/usage.ts`（`test-suite-policy` 两例与
    `ci-workflow-path-filters` 查出）改列 RM `domain/usageMeter.ts`。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4599～5106 s 全部跑完，合计 23409 pass / 127 skip /
  61 fail，另有 36 条测试间未处理错误。50 条是超时（21 个文件；48 条撞默认 5 秒，RFC-354 嵌套帧闭包与 RFC-363 目录分页各一例撞自带的
  30 秒），36 条未处理错误全出在其中 12 个超时文件里，是超时用例被拆除后仍在跑的异步尾巴；另 11 条是上面本 RFC 的问题（8 个文件 10 条）
  与导出仓库只有候选提交所致的 `rfc321`。
  - 修复同步后，在最终内容上复跑修过的 9 个文件、guard-manifest 的三个读者、`rfc376-report`，以及调用 `computeRemaining` 与闭包
    编解码的用例共 23 个文件（30 秒时限）：476 pass / 0 fail。
  - 21 个超时文件逐个单独复跑（30 秒时限）：20 个全过（RFC-354 嵌套帧闭包与 RFC-363 目录分页单独跑分别 19 s / 26 s 通过）；RFC-167
    dw-confirm 的 `approve` 一例（自带 5 秒 `settleTask` 等待）仍到点——对照：同一时刻在 RFC-453 的导出仓库里跑同一文件，失败的是同一例
    （5.5 s 与 5.5 s），其余 28 例两边都过（RFC-452、RFC-453 集中验证时也是这一例）。
- **shared 包用例**（导出仓库里，补上 `stringifyWorkflowYaml`、`extractWorkflowAgentRefs`、`WORKGROUP_TURN_CLARIFY_NODE_ID` 之后）：
  2344 pass / 0 fail。
- **导出仓库接 PostgreSQL 真库**：
  - 第一条 lane 354 个文件（全部架构测试；改动的用例；提及澄清 / 提问派发 / 复审、调用闭包与子任务启动、脚本节点与自定义观察者、
    备份恢复、插件安装、YAML 导出、意图转储与各装配根的用例）：301 个文件全过；53 个失败——上面本 RFC 的 4 个文件，其余 49 个只有
    超时（默认 5 秒；澄清 / 提问派发一族、`plugins-http`、`rfc164` workgroup 引擎等在 PostgreSQL 一侧最慢）；
  - 修复后复跑 72 个文件（失败的 53 个，加上面 SQLite 复跑的 23 个文件中不在其内的 19 个；30 秒时限）：全部通过，1529 pass / 0 fail。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段、PostgreSQL 17 个阶段全部
  符合预期（0 failures；PostgreSQL 一侧等负载降到 30 左右再单独跑）；两次运行前后 127 个受保护源文件的哈希一致。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数）：`services/` 153 → 123 个文件；`legacy-thin-facades`
  36 → 6、`export-star-barrels` 20 → 6、`legacy-horizontal-files` 274 → 244；`R1-inbound-module-internals` 148 → 121、
  `R2-outbound-module-to-legacy` 33 → 29（账本与实测相等）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、application 直接
  副作用文件 2、跨 context 内部文件对 48、off-DAG offered 文件对 55、composition 禁取文件 14、`module-layer-violations` 1、不可达生产
  文件 27（删去 3 个、新登记 3 个）、public surface 偏差 102。报告里的 `unconsumedPublicSymbols` 306 → 320：14 个 public 符号此前唯一的
  「消费方」是被删的转出（`services/lifecycle` 整面再导出 TE `public/operations`，`services/runtime/usage` 再导出 RM 的 `JsonObject`），
  现在按真实消费方计——不是新增导出。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，HEAD 的原位置对工作树的新位置）：39 个迁移的顶层声明里 36 个逐字相同，其余 3 处正是
  设计写明的改动——`computeRemaining` 取循环成员改经 `directNodeIdsOf`、`FrozenWorkgroupRef.group` 的类型、`parseCallClosure` 里对它的
  断言；留在 `legacyCallClosure` 的 `freezeCallClosure` 与它的 3 个私有助手逐字未变；原位置不留第二份定义（新用例断言）；
- 删除的 30 个转出逐个核对：每个导入名在新位置导出的是同一个绑定（新用例对 RC public 与 domain 做恒等断言；其余是同名 `export … from`
  的上游声明）；`runNode` / `WG_*` 等在用例里经别名保留原写法；
- composition 绑进 TE `agentNodeExecution` 端口的 `rules` 仍是那四个函数；子任务启动的 workgroup 校验仍在启动处（同一个 schema）；
  解释器登记与探测、YAML 序列化、代理引用提取、workgroup 宿主节点 id 与提问者键的取值不变（新用例锁线上取值）；
- `services/execution/resourcePolicy.ts` 里 `PLUGIN_DISABLED_SITES` 那一项改指实现文件，该表只用于守卫，运行时不读；
- 集中验证查出的问题（见上）已修并复验。

## PR / 提交

单个提交：`refactor(backend): RFC-454 services/ 一跳转出清仓（RFC-294 W9-D 第一步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
