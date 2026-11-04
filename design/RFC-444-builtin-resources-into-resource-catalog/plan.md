# RFC-444 实施计划

**前置**：RFC-443 落地（`21ae7afa3`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                        | 依据      |
| ---------- | ------------------------------------------------------------------------------------------- | --------- |
| RFC-444-T1 | `services/systemResources.ts` 原样迁入 resource-catalog domain；`public/types` 转出五个符号 | design §1 |
| RFC-444-T2 | 引用改到新位置；knowledge-evolution 删去兼容再导出、改从共享合同取隔离 id                   | design §2 |
| RFC-444-T3 | 账本（R2 41 → 39、锚点路径）；架构报告归属表；用例改 import；新增 RFC-444 用例              | design §3 |
| RFC-444-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                       | design §6 |
| RFC-444-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第十步）                     | —         |

## 验收清单

- [x] AC-1 原文件删除，源码不再 import 旧路径；模块外经 `public/types`
- [x] AC-2 计数按实测更新（路由 10 → 9，R2 41 → 39，`services/` 221 → 220）
- [x] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `21ae7afa3`）

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（后端与 e2e 改动的文件）；改动的 TS 文件已按 prettier 格式化。
  静态自查时 `tsc` 报出 `rfc101-builtin-list-hidden`、`rfc104-builtin-readonly` 两个用例仍经被删的兼容再导出取两个 name 常量
  （多行 import，先前按符号名的检索漏了），已改从清单本身取，proposal 的「没有消费者」相应改为「生产里没有消费者」。
- **全量 SQLite**（`bun run test:backend`，四分片，3563 s）：23345 pass / 127 skip / 19 fail，另有 12 条测试间未处理错误。逐条归因：
  - **本 RFC 的问题，已修**：`rfc317-architecture-ledgers` 的「公共内核清单里的文件都真实存在」报红——`architecture/commons-manifest.json`
    的 `systemresources-ts` 条目仍指向旧路径。改指新路径并把 `layer` 改为 `domain`，该守卫与本 RFC 用例复跑 22 / 22 通过；
  - **负载超时，与本 RFC 无关**：18 条按各自时限超时（RFC-396 MR 候选桥 10 条、RFC-167 dw-confirm 3 条，RFC-131、RFC-098、RFC-363、
    RFC-370 V16、RFC-075 自动提交各 1 条）。单独复跑：其余六个文件全过（1 / 4 / 4 / 8 / 3 / 29）；MR 候选桥在负载 16～26 时又超时两条
    （35 / 37），负载 12～14 时连跑三次均 37 / 37。
- **导出仓库**（`21ae7afa3` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 185 个文件：全部 139 个架构测试；提及内建资源、只读锁、列表隐藏或技能融合种子的用例；ACL 端点矩阵、路由错误码棘轮、
    API 合同与覆盖、测试套件策略与本 RFC 改动的用例；去重后合并；
  - 结果 2628 pass / 1 fail / 4 skip。唯一失败是四路并行下组合根路由面的 PostgreSQL 启动超时，单独复跑通过（2 pass）；
  - 本 RFC 用例 7 条、公共内核清单与 R1 / R2 账本（15）、RFC-104 内建只读（37）、RFC-101 列表隐藏（8）、ACL 端点矩阵（158）、
    路由错误码棘轮、API 合同（525）与测试套件策略均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 9 个；`R2-outbound-module-to-legacy` 39 条、`R1` 169 条，均与基线一致；模块里 import
  `services/` 的文件 149 → 145；`services/` 220 个文件。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 清单文件与 HEAD 逐字节相同（审计锚点的行号因此有效）；`public/types` 转出的五个符号就是原文件的同一批导出；
- 各引用方只改 import 路径；knowledge-evolution 的隔离 id 改从共享合同取，正是原文件原样转出的那个常量；
- 删去的兼容再导出在生产里没有消费者，两个用例改从清单本身取同一组常量。

## PR / 提交

单个提交：`refactor(backend): RFC-444 内建资源清单归 resource-catalog（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
