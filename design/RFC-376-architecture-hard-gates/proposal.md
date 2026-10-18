# RFC-376 架构治理简化：少量硬结构门 + 按需报告（RFC-294 S4）

- **状态**：In Progress（2026-10-17 立项；用户授权设计完成后直接交 Codex 执行，免设计门与实现门，由本会话审核执行正确性）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S4（W0-R 模型修订）；proposal R2、R6、C9、D9；
  design §13、§14
- **基线**：HEAD `b76a88e70`（行号仅作定位提示）
- **落位**：只改测试、生成器、脚本、CI 与文档；不改任何生产代码

## 1. 背景

RFC-294 的账本治理（N1 起）要求每个 production symbol、每条跨 context 边、每个 public 字段都入账，并以 provenance pin
固定内容。它的成本已经远大于收益（RFC-294 review-2026-10-16 R2 / F9）：

- **每个生产提交都要一笔投影提交。** 生成器把全部 backend / shared / frontend 源码加 `.dependency-cruiser.cjs` 与
  `scripts/depcheck.ts` 哈希成一个全局 `sourceDigest`，写进 8 份 canonical JSON、4 份治理 JSON 的投影块与 status.md；任何
  一个字节变化都要跑 census 再提交一次。2026-10-14 以来 64 个提交中 26 个是 `chore(architecture)` 投影提交。
- **体量**：根目录 `architecture/` 常驻 16 个文件约 36.6 MB；`tests/architecture/` 80 个文件约 3.5 万行，生成器
  `rfc294Canonical.ts` 5,123 行。
- **「只降不升」靠自助许可放行**：T17 只检查「增长时带 `allowGrowth`、下一笔已退役」，08-15 以来 1,245 次许可全部自助放行；
  可行动的债只占 exception 的约 4%，其余是「碰到了尚未迁移的文件」。
- **按行号编号**的条目（ambient、background、`node_runs` 插入点）让无关的行移动也会改账本。
- **持久的改善全部来自少数结构规则**：depcheck 的 `no-circular` / `KNOWN_VIOLATIONS`、route / transport→DB、模块内分层、
  `node_runs` 单一 INSERT、offered 边 ⊆ DAG。

RFC-294 已批准把治理改为「少量硬结构门 + 按需生成的报告」（D9 修订、C9），本 RFC 实施。

## 2. 目标

- **G1** 普通生产改动不再需要任何账本伴随提交：删除全局 `sourceDigest`、provenance pin、N1 计数、T17 增长许可、按行号编号
  的条目与 9 份全量库存 JSON。
- **G2** RFC-294 design §13.1 的硬结构门全部有机器实现：保留既有的，补上缺失的（context 值级无环且 ⊆ DAG、platform 不
  import modules、application 无直接效果、composition 禁止持久化 / 进程 / FS import、业务层零部署分支、跨 context 只经 public
  精确入口），另加 proposal C6（`export *` 桶）、C8（直接 `setInterval`）、C9（`architecture/` 只放允许的文件）与入口可达性门。
  每条门有能证明会红的负例，例外清单双向精确、只能减少。
- **G3** 库存报告可从任意已提交源码按需重新生成（`bun run architecture:report --source-ref <rev>`），默认不提交。
- **G4** 一个很小的已提交计数文件 `architecture/counts.json` 作为「减速带」：下降自动接受，上升必须在同一提交改数并写理由。
- **G5** 被隐藏在 canonical 校验里的真实保护（RFC-328 authority / effect 闭包、code-host 绑定、required port 活性）改为直接
  断言，不丢失。
- **G6** 文档与流程同步：`docs/dev-gotchas.md` 中只为旧账本机制存在的条目标为历史；RFC-294 三件套引用更新；status.md
  改为生成说明。

## 3. 非目标

- 不改任何生产代码、API、schema 或产品行为。
- 不实现「两种 provider 的生命周期作业清单一致」门（G12）：两份清单今天就不同，属 S2a 的退出门。
- 不把 C7（无 consumer 不公开）做成硬门，只保留在报告里。
- 不扩大 G6 / G7 的范围（`@/util/git`、`@/ws`、application `setInterval`、public / infrastructure → composition）。
- 不新增 CI workflow；报告在本地按需生成。
- 不做任何安全相关检视或加固（2026-08-26 用户硬规则；架构门里也不得出现安全项）。

## 4. 用户故事

- 作为任何会话的开发者，我提交生产改动后不再需要跑 census、写许可、补投影提交，也不会因为与我无关的 digest 变化而 CI 变红。
- 作为架构维护者，我想看现状时运行一条命令得到完整报告；真正的结构退化会被少量硬门挡住，而且每条门都证明过自己会红。

## 5. 影响清单（被移除的检查与替代）

| 被移除 | 替代 |
| --- | --- |
| N1a provenance 可达、N1b 已提交 canonical = 生成 | 无（报告按需生成，不再提交） |
| T16 计数相等、T17 只降不升 + `allowGrowth`、T72 账本形常量登记 | 硬门的双向精确例外清单 + `counts.json` 减速带 |
| ~116 份非 RFC-294 清单在 `ledger-baselines.json` 的计数钉 | 各清单在自身测试中仍是双向精确（只在 diff 中可见增长） |
| 已提交 9 份库存 JSON 与 status.md 指标 | `architecture:report` 按需生成 |
| `rfc294-review-public-consumer-ledger`（零 consumer public 符号、死 required port） | 报告；死代码另由入口可达性门约束 |
| god-surface 预算（RFC-294 design §3.3 称其为「评审经验值，不是账本门」） | 无 |
| `rfc294-architecture-preflight` 的账本支持部分 | 文件内双向精确清单（跨 context 内部引用、public 偏离） |
| CI 后端分片的全历史 checkout | 浅克隆（gitleaks 的全历史需求另有原因，保留） |

这些都是开发流程上的检查，不涉及产品能力；但它们改变所有会话的提交流程，故在此列明。

## 6. 验收标准

- **AC-1** 根目录 `architecture/` 只剩允许的文件：`commons-manifest.json`、`commons-debt.json`、`guard-manifest.json`（三者去掉
  投影字段）、`e2e-capability-ledger.json`、`e2e-endpoint-coverage.json`、`e2e-route-coverage.json`、
  `repository-publication-call-sites.json` 与新增的 `counts.json`；C9 门锁定。
- **AC-2** 生产代码改动后不跑任何生成器，CI 中的架构测试仍然全绿（以一笔只改生产代码、不改 `architecture/` 的提交在 CI 上
  证明）。
- **AC-3** design §3 的每条门：有纯检测函数、每个检测分支至少一个违规负例、每个豁免边界至少一个合规样例、例外清单「少一条 →
  未登记」「多一条 → 过期」两个变异、语料下限；全部登记在 `guard-manifest.json`。
- **AC-4** `bun run architecture:report --source-ref HEAD` 只读已提交对象生成完整报告与 status 文本；`--gates` 输出可直接粘贴
  的例外清单与计数。报告不依赖工作树中的生产模块或 `KNOWN_VIOLATIONS`。
- **AC-5** RFC-328 authority / effect 闭包、code-host 绑定、required port 活性等保护以直接断言保留（见 design §4）。
- **AC-6** `counts.json` 检查：未知 / 缺失 id、超过 max、reason 未包含 `max=<N>` 均判红；低于 max 只提示。
- **AC-7** 文档：dev-gotchas 中旧账本条目标为历史；RFC-294 三件套与 `status.md` 更新；`docs/audit-backlog.md` 的 T72 条目标为历史。
- **AC-8** 推送后 exact SHA 的 GitHub Actions 全绿。

## 7. 已作出的取舍

用户授权本会话直接决定以下事项（可在执行期间推翻）：

1. 非 RFC-294 清单的计数钉随 `ledger-baselines.json` 一起删除；清单本身在各自测试中保持双向精确。
2. 硬门例外清单只能减少。新增例外须在新增它的 RFC 的 design 里作为偏离项列明并经用户确认（CLAUDE.md §RFC workflow 第 8 条），
   并在同一提交里抬高 `counts.json` 对应 max 并写理由。
3. status.md 改为不含指标的生成说明；不新增报告 CI workflow。
4. 纳入 C6、C8、C9 与入口可达性门；不扩大 G6 / G7。
5. 部署分支门把 application 端口中的厂商字面量类型算作违规，现存条目以「RFC-370 收口对账 / S2c」为后继登记。
6. 生命周期清单一致门推迟到 S2a。
7. C7 只进报告。
8. RFC-317 的 R1 / R2（commons-debt）保留为门，去掉投影字段。
9. 保留 guard-manifest 登记表，去掉投影字段。
10. RFC-349 functional evidence 中引用 canonical 测试的条目改指新门；删除 god-surface 预算。
11. 分两阶段交付（design §9），破坏性改动只在 RFC-375 / RFC-377 落地后的安静窗口内一次完成。
12. RFC-294 design §13.1 写的「2026-10-16 时 209 条」不再字面使用：初始例外清单在阶段 B 提交时从当时 HEAD 计算（按文件对粒度）。
