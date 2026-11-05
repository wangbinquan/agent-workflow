# RFC-449 实施计划

**前置**：RFC-448 落地（`df2cb6e26`，文档 `0cd746750`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                       | 依据      |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| RFC-449-T1 | task-execution 连接解析端口；运行时选项、参与者与 daemon 装配的 `codeHostConnections` / `codeHostRequests` | design §1 |
| RFC-449-T2 | 代码平台节点端口装配取注入的请求端口（未注入时报未配置）；development-automation 本地连接端口              | design §2 |
| RFC-449-T3 | 装配根与三个测试拓扑注入；新增 RFC-449 用例                                                                | design §3 |
| RFC-449-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                      | design §5 |
| RFC-449-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan                                                    | —         |

## 验收清单

- [x] AC-1 task-execution 与 development-automation 不再 import `services/codeHost/*`；代码平台节点只经注入的请求端口调用
- [x] AC-2 计数按实测更新（模块里 import `services/` 的文件 141 → 140，路由仍 4）
- [x] AC-3 受影响用例全部通过（见下文集中验证）
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `0cd746750`）

本机全程高负载（负载 15～83，主要来自 Docker VM 里的 kind 控制面）。验证都在候选导出仓库里跑（`0cd746750` 的 `git archive` 加候选路径，
提交后运行），工作树同时可用；自审补的两处用例锁同步进导出仓库后，核对 20 个候选路径与工作树逐字节相同。

- **静态**：`tsc` 0 错（含自审补的两处）；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按
  prettier 格式化；`guard-manifest.json` 不变（候选路径里没有已登记守卫）。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4272～4845 s 全部跑完，合计 23375 pass / 127 skip / 38 fail，
  另有 28 条测试间未处理错误。`rfc321-repository-publication-ratchet` 一条是导出仓库只有候选提交所致；其余 37 条都按各自时限超时（14 个文件），
  未处理错误都出在这些文件里，是超时用例被拆除后仍在跑的异步尾巴（关闭的库、拆掉的工作区）。14 个文件单独复跑：12 个全过；RFC-167 dw-confirm
  3 条、RFC-396 MR 候选桥 4 条仍超时（与 RFC-444～448 集中验证里记过的两组相同）。给 30 秒时限后 RFC-396 37 / 37；RFC-167 28 / 29——剩下那条
  是用例自带的 5 秒 `settleTask` 等待（不受用例时限影响）在 P0 lane 并跑时到点，负载降到 18 左右单独复跑 29 / 29。
- **导出仓库接 PostgreSQL 真库**：
  - 共 276 个文件：全部 139 个架构测试；提及代码平台节点 / 调用 / 连接 / 回退 / 恢复探测、任务执行运行时选项与参与者、子任务继承、开发交付与
    MR、webhook 与数字员工的用例；RFC-440～449 用例；去重后合并；
  - 结果 3417 pass / 37 fail / 11 skip，除 `rfc321` 一条（同上）外全部是 PostgreSQL 一侧超时（5 秒，以及 RFC-257 限流用例自带的 30 秒、
    RFC-310 数字员工 e2e 自带的 180 秒）；
  - 给 30 秒时限后 21 个文件里 18 个全过（含 RFC-328 尝试账本、RFC-380 装配包）；余下三个（RFC-257 webhook 入站、RFC-310 Case 运行时、
    RFC-310 数字员工 e2e）在负载降到 18 左右时单独复跑 30 / 30、11 / 11、4 / 4，PostgreSQL 一侧限流用例 4.9 秒、两条 e2e 92 秒与 80 秒。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段全部符合预期，源文件哈希前后一致。
- **新锁的负对照**：在导出仓库里删掉 `prepareTaskDrive` 对 `codeHostRequests` 的排除，RFC-408 用例随即以 `codeHostRequests` 失败（3 pass / 1 fail）；
  还原后与工作树逐字节相同。
- **计数复核**：import `services/` 的路由 4 个（不变）；模块里 import `services/` 的文件 141 → 140；`R1-inbound-module-internals` 166 条、
  `R2-outbound-module-to-legacy` 39 条（账本未改）；`services/` 213 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 生产装配：装配根在给连接的同处注入 legacy 的三个函数（与原来硬接的是同一组引用）；参与者原样透传，`prepareTaskDrive` 把它与连接一起排除在
  驱动配置之外；子任务由同一组注册参与者重新给出，与连接同档；
- 节点端口：`requests` 每次读当前运行时选项；只在没有注入时退回「未配置」端口，失败码与没有配置连接时相同；生产与测试拓扑都注入，
  这个分支只在不跑代码平台节点的装配里可达；
- 交付 provider：只把连接的类型换成本地端口，绑定解析与匹配逻辑不变；
- 自审补了两处用例锁：RFC-408 的驱动配置排除表加 `codeHostRequests`；provider 测试拓扑给调用方的运行选项与连接一样不收它；
  另把 design §2 里「`daemonTaskExecutionBundle` 给占位」的错误说法改正（它走装配根）。

## CI（AC-4）

`2f8d491cd`：exact SHA 主 CI run 42037618561 与 windows-platform run 42037618568 首轮全绿。同 SHA 的定时 `e2e-full-nightly` run 42040875015 四个分片都在「Install Playwright browsers」一步失败（`Playwright does not support chromium on ubuntu26.04-x64`：ubuntu-26.04 runner 与 Playwright 1.60.0 不兼容，环境问题、待用户决定），与本 RFC 无关。

## PR / 提交

单个提交：`refactor(backend): RFC-449 代码平台调用对 task-execution 与 development-automation 改为注入（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
