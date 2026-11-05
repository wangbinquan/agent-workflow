# RFC-448 实施计划

**前置**：RFC-447 落地（`531566b35`，文档 `9636d1073`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------- | --------- |
| RFC-448-T1 | 探测、协调器类原样迁入 infrastructure；记录读写迁入 application；两个实例进 composition             | design §1 |
| RFC-448-T2 | 三个端点的编排迁入 `application/mcps/probeOperations.ts`；合同与协调器端口；`public/types` 转出     | design §2 |
| RFC-448-T3 | `composeMcpProbeOperations`（探测选择、测试注入点与时钟）；装配根三处接线；路由变薄；删除三个旧文件 | design §2 |
| RFC-448-T4 | 架构报告；EK-05 锚点；用例与辅助改 import；新增 RFC-448 用例                                        | design §3 |
| RFC-448-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                               | design §5 |
| RFC-448-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第十四步）                           | —         |

## 验收清单

- [x] AC-1 三个 `services/` 文件删除；路由不 import `services/`、对 resource-catalog 只经 public；装配根不再从路由取时钟
- [x] AC-2 计数按实测更新（路由 5 → 4，`services/` 216 → 213，模块里 import `services/` 的文件 142 → 141）
- [x] AC-3 受影响用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `9636d1073`）

本机全程高负载（负载 26～58）。验证都在候选导出仓库里跑（`9636d1073` 的 `git archive` 加候选路径，提交后运行），工作树同时可用；
每次修复后把候选路径重新同步进导出仓库并核对逐字节相同。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按 prettier 格式化；
  `guard-manifest.json` 刷新 RFC-390、RFC-201 两份守卫的行数（244 → 245、48 → 63）。
- **本 RFC 的问题，已修**：两份源码文本锁仍按迁移前的位置读——RFC-345 合同用例要求路由含 ACL 身份端口与 `queries.list(` /
  `aclIdentity.load(`，RFC-370 托管探测用例要求路由含探测方式的分支；它们随编排迁入探测用例与装配，改为读迁入后的文件，并锁路由
  不再持有它们；复跑 RFC-345 18 / 18、RFC-370 托管探测通过。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4088～4637 s 全部跑完，合计 23363 pass / 127 skip /
  45 fail，另有 33 条测试间未处理错误。除上面 RFC-345 一条（同上，已修）外：`rfc321-repository-publication-ratchet` 一条是导出仓库
  只有候选提交所致；其余都按各自时限超时，未处理错误都是超时用例被拆除后仍在跑的异步尾巴。18 个文件单独复跑：16 个全过；RFC-167 dw-confirm、RFC-396 MR 候选桥各 2 条仍超时（与 RFC-444～447 集中验证里记过的两组相同），给 30 秒时限后 29 / 29、37 / 37 通过。
- **导出仓库接 PostgreSQL 真库**：
  - 共 203 个文件：全部 139 个架构测试；提及 MCP 探测 / 协调器 / `/api/mcps`、MCP 与插件服务、路由注册 / 错误码 / API 合同、测试套件策略的用例；
    RFC-440～448 用例；去重后合并；
  - 结果 2646 pass / 241 fail / 13 skip。除上面两份文本锁外都在 PostgreSQL 一侧：5 秒时限，以及 RFC-238 MCP 运行时测试的真实进程用例在
    子进程退出后输出没能及时读到 EOF（`post-exit-flush-timeout`）、会话随之结束（SQLite 一侧通过；本 RFC 对该服务只改了协调器的 import 路径）；
  - 给 30 秒时限后 24 个文件（含修复后的两份文本锁）591 / 592 通过，剩下的一条即 RFC-345 未修完的那半，补修后单独复跑 18 / 18；
    PostgreSQL 一侧最长 31.8 秒。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 4 个（5 → 4）；`R1-inbound-module-internals` 166 条、`R2-outbound-module-to-legacy` 39 条
  （账本只改了 EK-05 的锚点）；模块里 import `services/` 的文件 141 个；`services/` 213 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 探测、协调器类与原文件逐字相同（探测文件体整体顺移 3 行）；记录读写只把结果类型改为同形的 `McpProbeMeasurement`；
- 三个端点的编排与原路由归一化后逐句相同，差别只有：探测方式的选择移到装配（同一个分支）、探测后的重验沿用调用方给的 authority
  （装配根的 `authorityFor` 对同一 actor 每次得到同一份）；路由仍先校验请求体再进入用例，422 / 404 的先后不变；
- 两个协调器实例只在 composition 创建，装配根、观测模块与探测用例经同一个 barrel 取到同一份；MCP 写入时钟与探测时钟仍是同一个；
- 路由去掉的三项依赖只被探测端点使用；其余端点不变。

## CI（AC-4）

`df2cb6e26`：exact SHA 主 CI run 42008858737 与 windows-platform run 42008858797 首轮全绿。

## PR / 提交

单个提交：`refactor(backend): RFC-448 MCP 探测用例与资源操作协调器归 resource-catalog（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
