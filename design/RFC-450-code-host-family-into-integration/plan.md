# RFC-450 实施计划

**前置**：RFC-449 落地（`2f8d491cd`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                       | 依据      |
| ---------- | ------------------------------------------------------------------------------------------ | --------- |
| RFC-450-T1 | 五个文件按层迁入 integration（domain / ports / infrastructure），`services/codeHost/` 删除 | design §1 |
| RFC-450-T2 | 测试连接用例；MR 用例经绑定里的 `requests`；交付 provider 收 `requests`                    | design §2 |
| RFC-450-T3 | integration composition 与 `public/types`；装配根、HTTP 装配、两个路由与 `server.ts`       | design §3 |
| RFC-450-T4 | 用例 import、MR 绑定、随迁的文本锁、账本与 guard-manifest；新增 RFC-450 用例               | design §4 |
| RFC-450-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                      | design §6 |
| RFC-450-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan                                    | —         |

## 验收清单

- [x] AC-1 `services/codeHost/` 不存在；两个路由不再 import `services/`
- [x] AC-2 分层门与 public surface 不新增债；4 条 `R2` 清偿
- [x] AC-3 计数按实测更新（路由 4 → 2，`services/` 213 → 208，`R2` 39 → 35）
- [x] AC-4 受影响用例与新增用例全部通过（另有三个与本 RFC 无关的负载受限用例本机未复跑绿，前一版对照同样失败，见下文）
- [x] AC-5 exact SHA CI 全绿（attempt 1 的红格归因见下文）

## 集中验证（2026-11-05，候选基于 `2f8d491cd`）

本机全程高负载（负载 16～166，主要来自 Docker VM 里的 kind 控制面）。验证都在候选导出仓库里跑（`2f8d491cd` 的 `git archive` 加候选路径，
提交后运行）；修复后把候选路径重新同步进导出仓库，核对 61 个候选路径与 guard-manifest 与工作树逐字节相同。实际提交的父提交是其后的
`eef504664`（RFC-449 Done 文档与 CI 微调），与本 RFC 的路径不相交。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按 prettier 格式化；
  `guard-manifest.json` 刷新 RFC-390、RFC-254 两份守卫的行数（245 → 247、494 → 498）。
- **本 RFC 的问题，已修**：两份源码文本锁没有跟着迁移——
  - RFC-269 执行用例的两条源码层锁（执行路径不 spawn 子进程、RFC-292 统一 parser）按迁移前的位置读文件，路径是逐段拼的
    `'src', 'services', 'codeHost'`，按字符串搜旧路径时没搜到；改为读迁入后的文件（覆盖原四个文件的全部去向，并加上恢复探测）。
    `test-suite-policy`「模块级读取的源码路径都存在」报的就是这一处，随之转绿；
  - RFC-310 PR-7 的「不出现 merge / approve / resolve」负扫描以整个 integration 模块为根，迁入的 RFC-269 通用执行器里 `'mr.merge'` 的分支
    被扫到；文件头已写明通用执行器不属本扫描范围，它原在 `services/`、不在扫描根内，现精确排除 `infrastructure/codeHost/` 目录，MR 用例仍在
    扫描范围内。
  - 复跑：RFC-269 执行用例 50 / 50、RFC-310 PR-7 扫描 3 / 3、`test-suite-policy` 12 / 12。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5261～6105 s 全部跑完，合计 23370 pass / 127 skip / 52 fail，
  另有 34 条测试间未处理错误。除上面两项（三个文件）与导出仓库只有候选提交所致的 `rfc321` 一条外，其余都按各自时限超时（21 个文件），
  未处理错误都出在这些文件里，是超时用例被拆除后仍在跑的异步尾巴。这 24 个文件加补了预算的 clarify 派发单独复跑：18 个全过；余下 7 个
  仍超时，给 30 秒时限后 5 个全过（RFC-396 MR 候选桥 37 / 37）；RFC-167 dw-confirm 的 `approve` 一例（用例自带 5 秒 `settleTask` 等待）
  与 RFC-363 的整段分页一例（自带 30 秒预算）在负载 40～125 下仍到点。对照：同一时刻在 RFC-449 的导出仓库（本 RFC 的前一版）里跑
  同两个文件，失败的是同两例、到点时长相同；RFC-449 集中验证时它们在负载 18～28 下单独全过，本机负载此后没再降到那一档。
- **导出仓库接 PostgreSQL 真库**：
  - 共 329 个文件：全部 139 个架构测试；RFC-449 那一批（代码平台节点 / 调用 / 连接 / 回退 / 恢复探测、任务执行运行时选项与参与者、子任务继承、
    开发交付与 MR、webhook 与数字员工）；提及代码平台路由、个人推送凭据、MR 绑定与用例、交付 provider、错误码的用例；RFC-440～450 用例；
  - 结果 4145 pass / 124 fail / 14 skip：除上面两份文本锁与 `rfc321` 外都在 PostgreSQL 一侧超时（43 个文件）；
  - 给 30 秒时限后（47 个文件，含修复后的两份锁、clarify 派发与 `test-suite-policy`）45 个全过（含修复后的两份锁 50 / 50、3 / 3，clarify 派发两引擎 16 / 16，`test-suite-policy` 12 / 12）；
    余下两个单独复跑：RFC-310 数字员工 e2e 4 / 4（PostgreSQL 一侧 169 s 与 130 s，预算 180 s）；RFC-310 Case 运行时的 WorkStart 一例在负载
    40～70 下仍以 30.2 s 到点——对照：同一时刻 RFC-449 导出仓库里同一例同样 30.2 s 到点，RFC-449 集中验证时它在负载 18 下 24.5 s 通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 4 → 2；`services/` 213 → 208 个文件；`R2-outbound-module-to-legacy` 39 → 35 条（账本删去
  mrEnsure / mrFacts → `services/codeHost/*` 的四条）、`R1-inbound-module-internals` 166 条不变；模块里 import `services/` 的文件 140 → 138。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 五个文件的函数体与原文件逐字相同，差别只有 import 与移出的类型（逐文件 diff 核对）；`UpsertInput` 改名为 `CodeHostConnectionUpsertInput`，字段不变；
- 「测试连接」用例与原路由端点在请求体解析之后的那段逐句相同：回落已存值、TLS 选项判据、缺字段报 `code-host-not-configured`、探测、只在测的就是
  已存那套时回写；路由仍先解析请求体，再交给用例；探测的出站 fetch 测试注入点由 HTTP 装配绑定（与原路由依赖同源）；
- 管理面的列表 / 保存 / 删除原样转给连接服务；个人凭据路由的探测入参同样是四项凭据；
- MR 用例里每一处调用都只把调用者换成绑定里的 `requests`，参数不变；生产绑定由交付 provider 给出，`requests` 由装配根注入，就是原来的那两个函数；
- task-execution 节点请求与启动恢复探测取 integration composition 的同一组函数；
- 集中验证查出两份源码文本锁没有跟着迁移（见上），已修并复跑。

## CI（AC-5）

`d29f951e0`：exact SHA 主 CI run 42065447650：attempt 1 只有 Windows e2e 分片 1/4 红——`crash-recovery` 两例等新启动的任务进入 running 的 10 秒屏障到点（last=pending；同文件三例这次比 run 42037618561 慢 1.4～1.7 倍；任务启动链路本 RFC 未改，与 `docs/dev-gotchas.md`「e2e 里等「运行时已经起来」的屏障」同类），只重跑失败作业，attempt 2 全绿；重跑只作佐证，屏障预算随 RFC-450 的 Done 文档提交对齐到同文件等终态用的 30 秒。windows-platform run 42065447653 与同 SHA 的 visual-regression、evidence-soak、maintenance-soak 夜间全绿。

## PR / 提交

单个提交：`refactor(backend): RFC-450 代码平台连接与调用归 integration（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
