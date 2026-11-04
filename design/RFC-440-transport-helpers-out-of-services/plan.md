# RFC-440 实施计划

**前置**：RFC-439 收尾。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                    | 依据                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| RFC-440-T1 | `services/deleteConfirm.ts` → `platform/http/deleteConfirm.ts`；`services/tokenAudit.ts` 的快照抓取 → `platform/http/deleteSnapshot.ts` | design §1              |
| RFC-440-T2 | `services/tokenRedaction.ts` → `auth/tokenRedaction.ts`                                                                                 | design §1              |
| RFC-440-T3 | 删除 `services/tokenAudit.ts` 的审计转出与 `legacyTokenCallAudit`；原 3 个文件删除；全部引用改到新位置                                  | design §1、§2          |
| RFC-440-T4 | 用例与辅助改 import / 改写调用；架构报告归属表；新增 RFC-440 用例                                                                       | design §3              |
| RFC-440-T5 | 夜跑 workflow 路径过滤与跨包注释里的旧路径                                                                                              | design §4、proposal §6 |
| RFC-440-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                                   | design §6              |
| RFC-440-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第六步）                                                                 | —                      |

## 验收清单

- [x] AC-1 三个 `services/` 文件与 `legacyTokenCallAudit` 删除，源码不再 import 旧路径；新文件的依赖符合 design §0
- [x] AC-2 计数按实测更新（import `services/` 的路由 23 → 18 等，见 proposal §5）
- [x] AC-3 受影响用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `b82af321a`）

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（后端改动的 34 个文件，外加前端、shared 与 e2e
  改了注释的文件）；改动的 TS / YAML 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片，3490 s）：23317 pass / 127 skip / 19 fail，另有 14 条测试间未处理错误，
  分布在 7 个文件。逐条归因：
  - **本 RFC 的问题**：无。本 RFC 改动或新增的用例全部通过。
  - **负载，与本 RFC 无关**：
    - 17 条按各自时限超时：RFC-396 MR 候选桥 11 条、RFC-167 dw-confirm 3 条，RFC-075 自动提交、wrapper fan-out、RFC-370 V16
      各 1 条；测试间错误是超时后数据库已关闭、临时目录已清理，后台操作随之失败；
    - 2 条不是超时，改动面与本 RFC 无交集（不触及工作区、git 与升级路径）：
      - RFC-398 phase-validated 的「SIGKILL 父进程」用例在 22 s 时读到截断的子进程 JSON；
      - RFC-370 V3 工作区树操作的边界检查多出一个 `git-meta/info/refs`；
    - 同一时限下逐个文件单独复跑全部通过（37 / 6 / 3 / 5 / 8 / 3 / 29 pass）。
- **导出仓库**（`b82af321a` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 210 个文件：全部 139 个架构测试；提及删除确认、删除快照、token 审计或 token 读视图的用例；用到改动辅助的 WebSocket 用例；
    路由错误码棘轮、API 合同与覆盖、测试套件策略与本 RFC 改动的用例；去重后合并；
  - 结果 3241 pass / 7 fail / 4 skip。7 条失败都是四路并行下（负载约 30）PostgreSQL 的超时：`agents` 的 beforeEach 钩子、
    `api-tasks-repair` 的应用启动。两个文件单独复跑全部通过（44 / 26 pass）；
  - 本 RFC 用例 8 条、路由错误码棘轮、API 合同（525）与覆盖、测试套件策略（含「workflow 字面路径必须存在」）、RFC-222 / RFC-247 /
    RFC-270 各用例、RFC-344 operation catalog（bound operation 删除审计）与 RFC-359 W4-D9 双引擎 token 审计均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 18 个；platform 里 import `services/` 的文件 8 个，模块里 151 个；`services/` 229 个文件；
  `mcp/server.ts` 仍 import `services/mcpSurface`。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- `deleteConfirm`、`tokenRedaction` 原样搬迁：前者只改一处注释里的路径，后者只把两个 import 改成同一目标的相对路径。
  删除确认的顺序与错误码、token 通道的脱敏结果不变；
- 删除快照：同一个 `WeakMap`、同样的「只有 PAT 写入、取一次即删」语义；写入方（路由与 integration 的定时任务绑定）和取出方
  （`server.ts` 的审计中间件、bound operation invoker）都指向这一份文件；
- `legacyTokenCallAudit` 与 facade 的审计转出在生产里零调用；用例改用的 `createTokenCallAudit(db)` 正是兼容桥每次调用时做的事；
- 夜跑 workflow 的路径过滤只指向存在的文件，token 审计与投递 GC 的实现改动会照常触发夜跑。

## CI（AC-4）

`452673a11`：exact SHA 主 CI run 41822844875 attempt 1 70/70 全绿；windows-platform、visual-regression 通过。
本提交改了夜跑 maintenance-soak 的路径过滤，该 workflow 因此按新过滤触发并通过（run 41822844908）。

## PR / 提交

单个提交：`refactor(backend): RFC-440 删除确认、删除快照与 token 读视图离开 services/（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
