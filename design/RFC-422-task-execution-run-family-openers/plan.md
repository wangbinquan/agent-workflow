# RFC-422 实施计划

**前置**：RFC-421 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                                   | 依据          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-422-T1 | 端口文件：`infrastructure/local/nativeRunFamilyProviders.ts`、`infrastructure/crewstation/hostedRunFamilyProviders.ts` | design §1     |
| RFC-422-T2 | 三个本地 family 的打开逻辑迁入 `infrastructure/local/`，composition 改为配对                                           | design §1     |
| RFC-422-T3 | 两个托管 family 的打开逻辑迁入 `infrastructure/crewstation/`，composition 改为配对                                     | design §1     |
| RFC-422-T4 | 守卫与用例：结构锁（含负例）、端口绑定用例；源码锁改指；账本按实测；guard-manifest；Windows；全仓 grep                 | design §4、§5 |
| RFC-422-T5 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI                      | design §3     |

## 实施记录

T1～T4 完成（本会话实施），与落档设计无偏差。

1. **端口**：`nativeRunFamilyProviders.ts` 用 runtime-management public 类型（技能 / 插件引用由 public 的 `AgentMaterialIntent` 推出）、`@/services`
   类型与本地准备的入参类型写出九个端口；`hostedRunFamilyProviders.ts` 写出托管入参与托管系统代理内容端口。
2. **打开逻辑**：五段主体逐字迁移，只把对别的模块函数的调用换成 provider 袋上的成员；任务代理的输出校验内容改从同目录的
   `filePortOutputValidation.ts` 取（composition 原先取的就是它的再导出），校验组装函数由 composition 注入。
3. **composition**：五个文件只选取 provider 并注入。托管系统代理的夹具回退与运行时绑定、托管运行时管理的 effects 配对仍在 composition；
   `HOSTED_RUNTIME_PROBE_BUDGET_MS` 由 composition 再导出。
4. **类型**：本地系统代理 family 以运行时绑定的类型参数保留 `bindRuntime` 的精确类型（首轮 typecheck 用约束类型推断时退化为 `unknown`，
   改为以 `bindRuntime` 本身为类型参数后 0 错误）。
5. **守卫与用例**：
   - 新结构锁 `rfc422-run-family-openers` 与端口绑定用例 `rfc422-port-bindings`；
   - 三处读源码的锁（托管探测预算、运行目的的 `nodeRunPrompts`、端口产物映射）改读新文件；
   - 跨模块账本不变（composition 的跨模块 import 未增减）；
   - guard-manifest 新增一条；Windows `paths:` 与 suite 补上。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）首轮因本地系统代理 family 的类型参数退化报 38 处（见实施记录第 4 条），修正后 rc=0、0 个
  错误；改动的 TS 文件 eslint `--max-warnings 0` rc=0；改动文件 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：五段打开逻辑与原文做空白不敏感比对，归一化 provider 调用后全部相同；托管探测的包装保持预算与截止时间。
  PASS。
- **针对性验证集**（6 worker，负载约 30～67）：896 个文件（全部架构与守卫测试、`test-suite-policy`，以及提到系统代理 / 冒烟 / 任务代理 family /
  托管 / 运行时管理 / 诊断 / 材料 / 运行目的 / spawn 的用例），870 个通过，本 RFC 的结构锁、端口绑定用例、三处改指的锁与全部 RFC-370 family
  用例均在内。26 个失败均为负载下的超时（PostgreSQL lane 为主），或超时后夹具被拆引起的连带错误。
- **第二轮**（3 worker）：26 个里 18 个通过。
- **第三轮**（单进程，本候选与基线 HEAD `598054c42` 的导出对照，负载约 9～13）：余下 8 个在两侧均通过，用时相近，例如 `rfc396-mr-bridge`
  217 s / 207 s、`scheduler-wrapper-fanout-e2e` 27 s / 26 s。判为负载超时，不归本 RFC。
- **按已提交源码生成报告的用例**：`rfc376-report` 与 `rfc370-committed-architecture-source` 在「HEAD 加本候选」的独立导出仓库里分别 16/16、2/2
  通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。
- **测试环境**：首轮一个用例超时后遗留的 `mock-mcp-stdio.ts hang` 夹具进程（PID 42632，父进程已退出）在第三轮前清理。

## CI（AC-5）

`465fa2087` 的主 CI（运行 41400013512）67/70，windows-platform（运行 41400013679）全绿。主 CI 红了两格，汇总门 `CI required` 随之红：

- **backend shard 43/44**：`scheduler-clarify-dispatch` 的「interrupted STOP-clarify rerun」[postgresql] 以 5398ms 越过 bun 默认 5s，随后是
  超时引起的连带错误。前三个绿提交上这一例 1.0～1.6s；同一分片总耗时反而比上一提交低三成；本地单进程本候选 3858ms、基线 3814ms。归因为
  该例两次进入 runTask 的墙钟本就擦边，不是本 RFC 引入；RFC-423 给它 20s 显式预算（与同文件 clarify-no-channel 例的既有预算同形）。
- **backend shard 16/44**：`rfc311-perf-guards` 的「task-operations catalog — 过滤视图（G1 快路径）」[postgresql] 的 AC-11 塌方探测报红，
  P95 10474.78ms。语句数 / 行数 / 参数数（4 / 52 / 50）与前三次通过的运行相同（那三次 P95 12.91 / 13.40 / 45.86ms），同片 PostgreSQL
  服务容器在该例运行期间没有错误日志。本 RFC 不涉及任务目录查询；这是 `docs/audit-backlog.md` 已记录、原因未明的同一条偶发失败的复现，
  证据已补进该条目，不归本 RFC。

AC-5 以包含本 RFC 的后继提交的 CI 作后继证据收尾。RFC-423（`128e439d7`）的运行里上述两格对应的用例都已通过，但该运行另有一格与本 RFC
无关的红（`rfc311-backup-concurrency` 超时，见 RFC-423 plan「CI（AC-5）」），因此改以 RFC-424 的 CI 收尾。

- **后继证据**：`556a45573`（RFC-424）主 CI `41420057803` 70 个 job 全部 success，windows-platform `41420057759` 与 git-protocols-e2e `41420057760` success；本 RFC 的改动原样包含在该提交里（`465fa2087` 是它的祖先，其后两个提交在本 RFC 的路径上只给共享索引、
  guard-manifest 与 windows 工作流追加条目，没有改动本 RFC 的代码文件）。上面两格对应的用例在该运行里通过。AC-5 成立，RFC-422 Done。

## 冲突面

- **composition**：`TE/composition/{localSystemAgentRunFamily,localRuntimeSmokeRunFamily,localTaskAgentRunFamily,crewstationSystemAgentRunFamily,crewstationRuntimeManagement}.ts`。
- **infrastructure**：`TE/infrastructure/local/{nativeRunFamilyProviders,systemAgentRunFamily,runtimeSmokeRunFamily,taskAgentRunFamily}.ts`、
  `TE/infrastructure/crewstation/{hostedRunFamilyProviders,systemAgentRunFamily,runtimeSmokeRunFamily}.ts`。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，后继 `556a45573`，见上）
