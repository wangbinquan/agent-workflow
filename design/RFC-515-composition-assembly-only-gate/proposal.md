# RFC-515 组合层只装配的全模块门（RFC-294 S10 第二十二步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻；分支上限见 design §3，按同一授权记为
  已确认）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）。
- **前序**：[RFC-514](../RFC-514-task-execution-composition-try-throw-out/proposal.md)（S10 第二十一步）：RFC-370 之外的各模块 `composition/`
  目录都已没有 `try` / `throw`。本 RFC 落下 S10 要求的那一条门。

## 1. 背景

RFC-294 plan §3 S10 要求“把 RFC-414 / RFC-423 的收口锁改写为一条覆盖全部模块的门：无循环与 switch，`try` 与 `throw` 只出现在登记清单内，不做
DB / FS / 进程 / git 工作”，退出门是“上述门对全部模块为绿、例外清单为空；`composition-forbidden-import-files` = 0；各模块 `composition/` 的分支
计数不高于后继 design 给出并经用户确认的上限，该上限写入减速带”。现状：

- RFC-414 与 RFC-423 的锁只看 task-execution 的 `composition/`；其他模块只有 F13 的计数（`composition-control-flow-<module>`）在挡增长。
- 按语法树清点全部模块：`composition/` 目录（339 个文件）里违反“无循环与 switch、无 `try` / `throw`、不取 DB / FS / 进程 / git”的，除 RFC-370
  的 27 个 `crewstation*` / `taskImage*` 文件外只有一处：resource-catalog `composition/intentApply.ts` 的旧词汇兼容面用 `first(…)` 自己读库；
  各模块根的 `composition.ts`（19 个）里有 6 个带循环、`try` 或 `throw`（模块生命周期与几处装配期整理），不在 F13 与两条旧锁的扫描面。

## 2. 目标

- **G1 一条门**：新增 `architecture/rfc515-composition-assembly-only` 覆盖全部模块的 `composition/` 目录与模块根 `composition.ts`：无循环与
  switch、无 `try` / `throw`、不取 DB / FS / 进程 / git 的模块（RFC-414 的清单）也不做这两类调用；例外清单逐文件登记、写明后继，例外文件不再违反时
  门报“陈旧”，逼清单只减不增。
- **G2 唯一的非 RFC-370 违反项归位**：`loadSkillOperationState` 迁入 resource-catalog `infrastructure/skillOperationStateQuery.ts`，组合文件只引用。
- **G3 旧锁并入**：RFC-414 与 RFC-423 锁里与新门重复的形状检查删去（禁用 import / 调用、循环 / switch / `try` / `throw` 账本），两条锁只留各自
  的归属检查；分支上限按 design §3 写明。

## 3. 非目标

- 例外清单里的文件本身（RFC-370 余项；模块根 `composition.ts` 的运行期逻辑另立后继）；`composition-forbidden-import-files` 的 12 个 RFC-370 文件。
- 任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：新门覆盖全部模块的 `composition/` 目录与模块根 `composition.ts`（语料下限 350），规则如 G1；例外清单之外为绿；例外清单与实测逐文件相等
  （新增违反与陈旧例外都报红）；带负对照。
- **AC-2**：`loadSkillOperationState` 的行为不变（同一条查询、同一个取首行）；组合文件不再取 `@/platform/persistence/queryHelpers`。
- **AC-3**：RFC-414 与 RFC-423 的锁只留归属检查、仍通过；public surface 不升；计数不升；分支上限（design §3）与 `counts.json` 的
  `composition-control-flow-<module>` 一致。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
