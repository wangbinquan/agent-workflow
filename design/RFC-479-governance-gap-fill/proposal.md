# RFC-479 治理补洞：减速带上限 = 实测、public 合同两项计数与 composition 控制流入带（RFC-294 S11）

- **状态**：Done（2026-11-10，落地 `0d591604b`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审
  功能地自审。
- **部分撤回**（2026-11-11）：G1、AC-1 与 §6 第 1 条的「低于上限即红」与 RFC-294 design §13.4（不改成逐次相等）相悖，由 [RFC-484](../RFC-484-count-gate-not-above-max/proposal.md)
  撤回：`checkCounts` 回到「不高于上限即过」，低于上限只报不红；4 项收紧与本 RFC 的其余内容不变。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S11；
  [review-2026-11-09](../RFC-294-backend-layered-target-architecture/review-2026-11-09.md) R10、F12、F13 与 §9 第 3 条（上限收紧归 S11）。
  按 review §7 / plan §5 的顺序，S11 排在 W4-E1 收尾（RFC-478，Done）之后、S9 之前：S9 的退出门要用本 RFC 的未消费 public 符号计数。
- **前序**：[RFC-376](../RFC-376-architecture-hard-gates/proposal.md)（硬结构门与 `architecture/counts.json` 减速带）、RFC-477 / RFC-478
  （按 RFC-294 C13 把触及的两项减速带收紧到实测）。

## 1. 背景

1. **减速带有余量**。`architecture/counts.json` 的 21 项里有 4 项 `max` 高于实测（HEAD `27a42a3aa`）：`cross-context-internal-file-pairs`
   48 / 43、`export-star-barrels` 21 / 1、`legacy-thin-facades` 42 / 0、`unreachable-production-files` 27 / 18（review 时是 6 项，另两项已由
   RFC-477 / RFC-478 按 C13 收紧）。余量就是不被发现的回长空间：这 4 项合计可以再长 76 个文件或文件对而 CI 不红。RFC-294 C13 只要求收口时
   收紧「触及的」项，靠人记得；`checkCounts` 对低于上限只打一行日志。
2. **public 合同没有总量减速带**。未被消费的 public 符号（322 个）与 public 类型偏差（88 条）只是架构报告的两个章节。偏差另有
   `rfc294-architecture-preflight` 的逐条白名单；未消费符号没有任何门——RFC-478 撤出工厂后，它们的返回类型成了无人用的符号
   （322 → 326），只是因为人工对比了两份报告才发现（RFC-478 集中验证第 2 处）。S9 的退出门（public 合同收敛）要用这个计数。
3. **composition 只装配只在 task-execution 有锁**。S6 的锁只覆盖 task-execution；其余 18 个有 `composition/` 的模块里，行首的分支、循环、
   `try` 与 `throw` 共 1,154 行（review F13 的口径；development-automation 一家 660 行）。S10 会给全模块立「composition 只装配」的门，
   在它落地前这些行可以继续长。
4. **已关闭后继索引不写覆盖范围**。plan §1.2 只列后继与范围，看不出每个后继的结果由哪条结构锁守着、锁覆盖到哪（全仓扫描还是指定
   文件）。RFC-294 C12 要求新后继写明覆盖范围，存量后继没有。

## 2. 目标

- **G1 上限 = 实测，并由机器保持**（「低于上限判红」已由 RFC-484 撤回）：4 项收紧到实测；`checkCounts` 把「低于上限」与「高于上限」同样判红（报出应改成的值），此后任何
  减少都必须在同一提交里把 `max` 一起改小——C13 从约定变成门。
- **G2 public 合同两项计数入带**：`unconsumed-public-symbols`（322）与 `public-surface-deviations`（88）成为减速带的两项，与架构报告的
  两个章节同一个函数、同一份输入算出。
- **G3 composition 控制流临时入带**：每个有 `composition/` 的模块一项 `composition-control-flow-<module>`（19 项，F13 口径：从行首开始的
  `if` / `for` / `while` / `switch` / `try` 与 `throw` 语句，按语法树数，不数字符串与注释里的同名词）；S10 的门落地时由 S10 删除。
- **G4 覆盖范围如实**：plan §1.2 增一列「结构锁 / 覆盖范围」，逐行写明守着该后继结果的结构锁、覆盖面与有无负对照；没有专属结构锁的
  如实写「无」及接替它的全仓门或行为用例。
- **G5 经验落档**：`docs/dev-gotchas.md` 补「收口时收紧上限（低于上限即红）」一条。

## 3. 非目标

- 不改任何生产代码（`packages/*/src`）；不收敛 public 合同本身（S9）、不改 composition 的内容（S10）。
- 不改既有门的判据；不把偏差白名单从 `rfc294-architecture-preflight` 挪走（它是逐条精确锁，计数是总量锁，两者并存）。
- 不处理 review §9 的第 1、2 条（待用户决定）。

## 4. 用户可见变化

无。只改用例、`architecture/counts.json` 与文档。对其他会话的影响：减少了某项计数的提交必须同时改小 `architecture/counts.json` 里该项的
`max`（以及 `reason` 里的 `max=N`），否则 CI 的减速带用例报 `below max`。

## 5. 验收标准

- **AC-1**（低于上限报错一句已由 RFC-484 撤回）：`architecture/counts.json` 每项 `max` 等于实测；`checkCounts` 对低于上限报错（带负对照：等于上限通过、低于与高于都报错）。
- **AC-2**：`unconsumed-public-symbols`、`public-surface-deviations` 两项在减速带用例与架构报告的 `counts` 里出现，数值与报告章节逐条
  相同；各有会红的变异用例（多一个无人用的 public 导出 / 多一条偏差即超上限）。
- **AC-3**：19 项 `composition-control-flow-<module>` 入带，计数与 F13 口径对账（差异逐条说明）；有会红的变异用例（行首 `if` 计入、
  `} else if` 与字符串 / 注释里的同名词不计入、新增带 `composition/` 的模块缺项即红）。
- **AC-4**：plan §1.2 的新列没有空格，逐行内容可复核（锁文件、覆盖面、负对照）。
- **AC-5**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **「低于上限」判红是永久规则，不只在 S11 收口时成立**（已由 RFC-484 撤回：与 RFC-294 design §13.4 相悖，并发会话会互相打红）。只在收口时收紧一次，余量会随下一次减少重新出现（本 RFC 的 4 项就是这样
   攒出来的）；判红的代价是减少计数的提交多改一行 JSON，这正是 C13 已经要求的动作。
2. **composition 控制流按模块分项，不合成一个总数**。合成总数时一个模块的减少会掩盖另一个模块的增长；分项后每个模块各自只降不升，
   也与 S10 按模块收口的推进方式一致。
3. **按语法树数，不照搬 F13 的正则**。正则会把模板字符串里以 `if` 开头的行计入（development-automation 多 7 行）；语法树口径与 F13
   的其余 18 个模块逐个相同，差异写进 design。
4. **偏差同时有白名单与计数**：白名单回答「是哪几条」，计数让总量与其他减速带同处一张表、同一个判据，S9 的退出门直接引用。
