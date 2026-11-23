# RFC-547 workspace-insight 的守护进程级状态归组合根构造的实例（RFC-294 S12 第二十六步）

- **状态**：Done（2026-11-23，落地 `e4adb5996`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第十三步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-545](../RFC-545-live-persistence-schema-explicit/proposal.md)（第 4 项第十二步）；RFC-546（Draft，待用户确认）把余下的模块级可变
  单例分了类，本 RFC 拆“可迁移”一类里属于 workspace-insight 的 3 条。

## 1. 背景

workspace-insight 有两份守护进程级的状态放在模块级：

- **SCIP 索引缓存**（`infrastructure/deep/scipIndexCache.ts`）：`let singleton` 加 `scipIndexCache()` 懒建一个 `ScipIndexCache`，`resetScipIndexCache()`
  清掉；深度索引端口的组合（`composition/structuralDeepIndexing.ts`）与深度结构 diff（`infrastructure/deep/deepStructuralDiff.ts`，调用方没有带
  缓存时回落到单例）都取它。
- **变更叙述的在途状态**（`application/changeNarrative.ts`）：生成中、失败记录与触发合并三张模块级 `Map`，`resetChangeNarrativeStateForTests()`
  清空；读取状态与触发生成两个用例直接读写这三张表。

两份状态都只服务一个守护进程，而 workspace-insight 的组合（`composeTaskWorkspaceInsight`）在 daemon 的 HTTP 装配里只构造一次。架构报告的
模块级可变单例清单里它们共 3 条（全仓 46 条）。

## 2. 目标

- **G1 状态归实例**：删去模块级单例与两个重置函数；深度索引端口的组合构造一个 `ScipIndexCache`，深度结构 diff 与索引缓存端口都用它；
  workspace-insight 的组合构造一份变更叙述状态，读取与触发两个用例收下它。
- **G2 结局不变**：同一个 daemon 里深度结构 diff 与代码智能共用一份索引缓存、命中与淘汰照旧；变更叙述的生成中 / 失败 / 触发合并语义不变。
- **G3 门与用例**：新增 RFC-547 用例（两个文件没有模块级状态、删去的名字不在；同一组合共用一份缓存与叙述状态、两次组合各有各的；带负对照）；
  读旧接口的用例随改；模块级可变单例 46 → 43。

## 3. 非目标

- 其余 43 条模块级可变单例（source-control 的 4 条另立；schema 历史运行时的登记另立；RFC-546 的两类待用户确认）。
- 缓存的容量与淘汰规则、叙述的提示词与生成流程不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`scipIndexCache.ts` 与 `changeNarrative.ts` 没有模块级单例与重置函数；缓存与叙述状态由组合构造并交给用到它们的函数。
- **AC-2**：索引缓存的共用与叙述状态的语义不变。
- **AC-3**：模块级可变单例 46 → 43、计数不升；新增 RFC-547 用例并登记 guard-manifest；读旧接口的用例随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
