# RFC-484 实施计划

**前置**：RFC-482 落地（Done，`42b52316d`，Done 文档 `b0de9c6a7`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                               | 依据      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-484-T1 | `checkCounts` 恢复 `{ errors, decreases }`：低于上限只列入 `decreases`（带应收紧到的值），其余判据不变；头注释改写；调用方打印 `decreases`         | design §2 |
| RFC-484-T2 | `rfc376-structural-guards` 的单元用例改为「低于上限通过并列出」；两个用例文件的注释与标题随改；guard-manifest 刷新行数                             | design §4 |
| RFC-484-T3 | 文档：`counts.json` 的 `note`、RFC-294 plan 三处与 §1.2 新行、design §13.4 沿革、`docs/dev-gotchas.md` 一条、RFC-479 三件套与索引行的撤回说明      | design §3 |
| RFC-484-T4 | 集中验证（静态；`tests/architecture/` 与文档用例；仓内重搜「低于即红」「below max」）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI | design §5 |

## 验收清单

- [x] AC-1 `checkCounts`：等于上限通过；低于上限通过并列入 `decreases`；高于上限、未知 / 缺失 id、非法数值、`reason` 不符报错
- [x] AC-2 仓内描述减速带判据的现行文字都是「实测不高于上限即过；后继收口时收紧到实测（C13）」；RFC-479 的历史描述带撤回说明
- [x] AC-3 `counts.json` 60 项 `max` 仍等于实测；架构报告的门不变
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-11，候选基于 `b0de9c6a7`）

验证在候选导出仓库里跑（HEAD 的树加候选路径，提交后运行；核对与 HEAD 加候选逐字相同），本机 1 分钟负载 40～60。

- **静态**：backend `tsc` 0 错；eslint `--max-warnings 0` 与 prettier 对改动的 3 个 TS 文件无告警；RFC-484 三件套、RFC-479 三件套与 RFC 索引
  prettier 检查通过（RFC-294 design 在 HEAD 上本就不是 prettier 格式，与 RFC-294 plan、`docs/dev-gotchas.md`、`STATE.md` 一样只手工改）。
- **用例**：`tests/architecture/` 全部 140 个文件、文档对账用例与另外两个读 `counts.json` 的用例共 149 个文件（逐文件、`--isolate`、单条 60 秒，
  6 个 worker）：147 个通过，1,428 条通过；`rfc376-structural-guards` 221 / 221，counts 用例在全仓语料上实测 60 项，没有报错，也没有打印
  低于上限的项（AC-3）。失败的两个是 `architecture/rfc376-report`（300 秒）与 `architecture/rfc400-collaboration-task-participants`（30 秒）撞
  用例自带的时限，与 RFC-482 全量里相同；它们不调用 `checkCounts`、不读改动的文档，在只放宽时限常量的副本上跑完：`rfc376-report` 16 / 16（95 秒）、`rfc400` 6 / 6（23 秒）。
- **变异实证**：在另一个导出仓库里把 `checkCounts` 改回「低于上限报错」，新的单元用例转红（`decreases` 为空、`errors` 多出那一项）；
  改回后该仓库与 HEAD 加候选逐字相同。
- **残留文字**（AC-2）：仓内重搜「below max」「低于即红」等：只出现在 RFC-479 的历史正文（状态行与 G1、AC-1、§6 第 1 条、design §2、
  plan AC-1 旁都有撤回说明）、RFC-484 自己的文档与注释，以及 `STATE.md` 的历史条目。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS：

- `checkCounts`：低于上限从 `errors` 移到 `decreases`，其余五条判据（未知 / 缺失 id、非法数值、`reason` 的 `max=N`、高于上限）原样保留；
  返回形状与 RFC-479 之前相同（`{ errors, decreases }`，各自排序），唯一调用方随之改回打印 `decreases`。
- 账本：`counts.json` 只改 `note`，60 项 `max` 与 `reason` 不变；guard-manifest 只刷新两个用例的行数。
- 文档：RFC-294 design §13.1、§13.3、§13.4 的规则原文不变（§13.4 只补沿革）；RFC-479 的正文保留为历史，撤回说明标在相关句旁。

## PR / 提交

一个提交：三件套、RFC 索引、`STATE.md` 条目与实现在集中验证后一起提交——改动小，先单独提交文档会在实现落地前留下「文档说已撤回、判据
仍是相等」的窗口。提交说明 `test(architecture): RFC-484 减速带判据回到「不高于上限即过」——撤回 RFC-479 的低于即红（RFC-294 design §13.4）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
