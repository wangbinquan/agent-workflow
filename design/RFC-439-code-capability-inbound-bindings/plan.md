# RFC-439 实施计划

**前置**：RFC-438 收尾（`0bf8272c2`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                               | 依据                |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| RFC-439-T1 | 两个路由迁入 `code-capability/inbound/http`，本模块 import 改相对路径，历史查询合同改用 application 类型           | design §1           |
| RFC-439-T2 | 新增 `composition/routes.ts` 转出挂载；`server.ts` 改 import                                                       | design §2           |
| RFC-439-T3 | 守卫语料跟着走（RFC-317 ACL 写门、RFC-349 provider 边界、历史组合）；改 import 的用例；架构报告；新增 RFC-439 用例 | design §3           |
| RFC-439-T4 | 账本：R1 176 → 170，guard-manifest 刷新行数                                                                        | design §4           |
| RFC-439-T5 | 订正 RFC-438 文档中「定时启动合同经 task-execution public 导出」的过期描述                                         | proposal §6 第 4 条 |
| RFC-439-T6 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                              | design §6           |
| RFC-439-T7 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第五步）                                            | —                   |

## 验收清单

- [x] AC-1 两个路由迁入模块、原文件删除，绑定只依赖本模块与 HTTP 传输工具，`composition.ts` 保持 schema-only
- [x] AC-2 账本与计数按实测更新（R1 176 → 170，深引路由 2 → 0，import `services/` 的路由 23 不变）
- [x] AC-3 受影响用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `0bf8272c2`）

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警；改动的 TS 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片，4672 s，期间机器负载峰值约 60）：23291 pass / 127 skip / 34 fail，另有 20 条
  测试间未处理错误，分布在 18 个文件。逐条归因：
  - **本 RFC 的问题，已修**：新用例「两个绑定只依赖本模块与 HTTP 传输工具」用正则取 import 说明符，正则跨行把 `codeRoutes.ts`
    注释里的 `from "it arrived…"` 当成了 import。改用 census 的 AST 提取（与 R1 账本同一口径），并加非空对照：两个绑定都必须
    提取到 `@/routes/registry`；
  - **提交前的工作树假象**：路由错误码棘轮用 `git ls-files` 取语料，提交前仍列出已删的 `routes/capabilityTemplates.ts`，读文件时
    ENOENT。它在导出仓库（候选已提交）上通过，见下；
  - **负载超时，与本 RFC 无关**：其余 33 条失败都是按各自时限超时（多数为默认 5 s，RFC-354 嵌套循环 20 s、RFC-363 工作区分页
    30 s），测试间错误是超时后临时目录被清理、后台 git 操作随之失败。涉及 16 个文件：RFC-396 MR 候选桥（11 条）与候选校验、
    RFC-167 dw-confirm、RFC-243 call-workflow、RFC-023 反问派发、RFC-193 两个文件、RFC-075 自动提交、RFC-131、RFC-165、RFC-187、
    RFC-188、RFC-269、RFC-354、RFC-363 与 wrapper fan-out。同一时限下逐个文件单独复跑全部通过（含修正后的 RFC-439 用例 8 / 8）。
- **导出仓库**（`0bf8272c2` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 209 个文件：全部 139 个架构测试、引用 code-capability 的双引擎用例 58 个、路由错误码棘轮、API 合同与覆盖、按已提交源码出
    报告的用例与本 RFC 改动的用例，去重后合并；
  - 结果 3299 pass / 7 fail / 4 skip。7 条失败都是 PostgreSQL 应用在四路并行下（负载约 70）启动超时，涉及 `api-code-routes` 与
    组合根路由面两个文件，单独复跑全部通过（34 / 2 pass）；
  - 路由错误码棘轮、API 合同与覆盖、RFC-317 ACL 写门守卫、provider 边界与本 RFC 用例（两个引擎共 10 条）均在已提交的候选上通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异各自变红、
  当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：`routes/` 50 个文件，import `services/` 的 23 个，深引模块内部的 0 个；`R1-inbound-module-internals` 170 条，与基线一致。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 两个绑定的句柄逐字搬迁：路由、方法、权限点、令牌访问、请求解析、响应与错误码不变；`server.ts` 的挂载调用与先后不变；
- 历史查询合同改用 application 的真实类型，投递链从 `unknown[]` 收紧为 `DeliveryRow[]`，只影响编译期；bootstrap 的连接由类型检查核对；
- ACL 端点仍经 `mountAclEndpoints` 原样委托同一个 owner，RFC-317 的精确委托锁改指新位置后仍然命中；
- 守卫语料扩到模块 `inbound/` 后没有新的违例；集中验证发现的本人用例缺陷已修（见上）。

## CI（AC-4）

`ce164ed44`：exact SHA 主 CI run 41811487655 attempt 1 70/70 全绿；windows-platform run 41811487613 通过。

## PR / 提交

单个提交：`refactor(backend): RFC-439 代码能力的两个 HTTP 绑定归入 code-capability 模块（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
