# RFC-441 实施计划

**前置**：RFC-440 收尾（`260f676aa`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                             | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------ | --------- |
| RFC-441-T1 | 三个文件迁入 platform（`operations` / `http` / `configuration`），删去 `tokenAuditRetentionDays` | design §1 |
| RFC-441-T2 | 引用改到新位置：`routes/docs`、`routes/auth`、`routes/plantuml`、`mcp/server`                    | design §2 |
| RFC-441-T3 | 用例改 import / 读源码路径；架构报告归属表；新增 RFC-441 用例；e2e 注释路径                      | design §3 |
| RFC-441-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                            | design §6 |
| RFC-441-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第七步）                          | —         |

## 验收清单

- [x] AC-1 三个 `services/` 文件删除，源码不再 import 旧路径；新文件不 import 模块与 legacy 目标前缀
- [x] AC-2 计数按实测更新（import `services/` 的路由 18 → 15，`mcp/` 清零，`services/` 229 → 226）
- [x] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `260f676aa`）

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（后端与 e2e 改动的文件）；改动的 TS 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片，3497 s）：23324 pass / 127 skip / 19 fail，另有 13 条测试间未处理错误，分布在 8 个文件。
  - **本 RFC 的问题**：无。本 RFC 改动或新增的用例全部通过。
  - **负载超时，与本 RFC 无关**：19 条全部按各自时限超时——RFC-396 MR 候选桥 9 条与候选校验 1 条、RFC-167 dw-confirm 3 条、
    RFC-243 call-workflow 2 条，RFC-193、RFC-131、RFC-370 V16、RFC-294 架构预检各 1 条；测试间错误是超时后的连带失败。
    同一时限下逐个文件单独复跑全部通过（37 / 7 / 1 / 27 / 13 / 8 / 29 / 13 pass）。
- **导出仓库**（`260f676aa` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 183 个文件：全部 139 个架构测试；提及 API 文档、`/.well-known/mcp`、PlantUML、外部入口开关、MCP 端点或令牌签发的用例；
    路由错误码棘轮、API 合同与覆盖、测试套件策略与本 RFC 改动的用例；去重后合并；
  - 结果 2719 pass / 16 fail / 4 skip。16 条失败都是四路并行下（负载 30～47）PostgreSQL 的 5 s 超时，涉及 `admin-only-gate` 与
    `rfc326-mcp-review-tools` 两个文件，单独复跑全部通过（44 / 26 pass）；
  - 本 RFC 用例 7 条、RFC-247 API 文档（44）、PlantUML 代理（19）、RFC-208 外部超时、RFC-344 operation catalog、路由错误码棘轮、
    API 合同（525）与覆盖、测试套件策略均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 15 个；`mcp/`、`ws/` 不再 import `services/`；`services/` 226 个文件；platform 里
  import `services/` 的文件仍 8 个。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- `apiDocs`、`plantuml` 与 HEAD 逐字节相同；`mcpSurface` 只删去末尾零调用的 `tokenAuditRetentionDays`，开关读取不变；
- 四个引用方只改 import 路径（`routes/docs.ts` 另改一处注释里的路径），调用与路由不变；
- 维护服务的令牌审计保留期仍是它就地写的缺省 90 天，删除的读取函数在生产里从未被调用。

## PR / 提交

单个提交：`refactor(backend): RFC-441 API 文档、PlantUML 渲染与外部入口开关归 platform（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
