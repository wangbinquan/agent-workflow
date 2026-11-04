# RFC-442 实施计划

**前置**：RFC-441 落地（`19ba4671b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                      | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-442-T1 | `isAskingNodeInSnapshot` 迁入 collaboration domain 并经 `public/queries` 转出；冲突码迁入 domain 并经 `public/types` 转出 | design §1 |
| RFC-442-T2 | 删除三个 `services/` 文件；路由、collaboration 内部与用例改到新位置                                                       | design §2 |
| RFC-442-T3 | 账本 R1 170 → 169；架构报告归属表；新增 RFC-442 用例；e2e 注释                                                            | design §3 |
| RFC-442-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                     | design §6 |
| RFC-442-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第八步）                                                   | —         |

## 验收清单

- [x] AC-1 三个 `services/` 文件删除，源码不再 import 旧路径；路由经 exact public 入口取用
- [x] AC-2 计数按实测更新（路由 15 → 12，R1 170 → 169，模块 151 → 149，`services/` 226 → 223）
- [x] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `3d3f21e4b`）

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（后端与 e2e 改动的文件）；改动的 TS 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片，3311 s）：23334 pass / 127 skip / 18 fail，另有 13 条测试间未处理错误。逐条归因：
  - **本 RFC 的问题，已修**：`rfc359-w8-t29-unnormalized-unique-insert` 两条红。`clarifyAnswerWrite.ts` 的串行化插入复核证明
    （`T/fixtures/rfc395-serialized-insert-source-locks.json`）把调用方 `clarify/seal.ts` 的内容哈希一并锁住，本 RFC 改了 seal.ts 的
    一行 import，证明按设计失效。复核：同一个 `setNodeClarifyDirectiveTx`，轮次锁、调用方事务与答案插入顺序不变；按 RFC-400 先例刷新
    依赖哈希并在 `why` 里记一句。修正后该守卫与另两条引用 `clarifyAnswerWrite` 的守卫、本 RFC 用例单独复跑 35 / 35 通过；
  - **负载超时，与本 RFC 无关**：16 条按各自时限超时（RFC-396 MR 候选桥 11 条、RFC-167 dw-confirm 3 条，RFC-363 工作区分页、
    RFC-396 候选校验各 1 条），测试间错误随之而来。单独复跑：RFC-363 4、RFC-396 候选校验 27、RFC-167 29 全过；MR 候选桥第一次在负载
    23～35 时又超时一条（36 / 37），负载 12～14 时连跑三次均 37 / 37。
- **导出仓库**（`3d3f21e4b` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 262 个文件：全部 139 个架构测试；提及任务反馈、澄清指令、任务问题或冲突码的用例；路由错误码棘轮、API 合同与覆盖、
    测试套件策略与本 RFC 改动的用例；去重后合并；
  - 结果 3724 pass / 1 fail / 4 skip。唯一失败是四路并行下组合根路由面的 PostgreSQL 启动超时，单独复跑通过（2 pass）；
  - 本 RFC 用例 9 条、T29 守卫、R1 账本、RFC-122 / RFC-123 澄清指令、路由错误码棘轮、API 合同（525）与覆盖、测试套件策略均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 12 个；`R1-inbound-module-internals` 169 条，与基线一致；模块里 import `services/` 的文件 149 个；
  `services/` 223 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 冲突码原样搬迁（与 HEAD 逐字节相同），字面值即 REST 合同，新用例逐个锁住；
- `isAskingNodeInSnapshot` 连同注释原样迁入 domain，路由经 `public/queries` 取到的是同一个函数；
- `taskFeedback` 转出删除后，路由直接取它原本转出的同一组 collaboration public 函数；
- collaboration 内部与用例改取同模块文件，取到的是原转出背后的同一批函数；seal.ts 的串行化语义不变（见上）。

## PR / 提交

单个提交：`refactor(backend): RFC-442 协作的三个 services/ 兼容层收口（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
