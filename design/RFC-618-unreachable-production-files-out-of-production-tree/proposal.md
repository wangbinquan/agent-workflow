# RFC-618 四个不可达生产文件出生产树（RFC-294 S11 余项）

- **状态**：Done（2026-11-26，`4a39ec7be`）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  每个文件的去向由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S11（生产树只留生产入口走得到的文件）；接
  [RFC-584](../RFC-584-rfc370-closure-unreachable-production-files/proposal.md)（RFC-370 收口的七个不可达文件）。

## 1. 背景

架构报告的 `unreachable-production-files` 在 HEAD 余 8 个：生产树里、但生产入口一个都走不到的文件。每个都在
`rfc376-structural-guards` 里登记了保留理由与后继。逐个读源码与历史后：

| 文件                                                                 | 现状                                                                                                      | 登记的后继                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| intent `domain/teaching/reconciliation.ts`（737 行）                 | RFC-348 的平台 / 意图字段对账表；文件头写明“由 `tests/intent-teaching-reconciliation.test.ts` 跑两条规则” | RFC-348：保留的测试数据，移出须有明确后继 |
| resource-catalog `application/portableImportReferences.ts`（256 行） | 只被下一行那个装配取                                                                                      | RFC-294 W4                                |
| resource-catalog `composition/portableImportReferences.ts`（22 行）  | 写成（2026-09-01 `6474b3ec3`，09-05 `a507b13ea` 合一）起就没有任何消费方，`src` 与用例里都没有            | RFC-294 W4                                |
| resource-catalog `infrastructure/legacy/workflow.yaml.ts`（202 行）  | YAML 预览与选择子投影；RFC-271 下线单文件 YAML 导出 / 导入后只剩两份用例里的四条在用                      | RFC-294 W9-D                              |
| system-operations `crewstation/standbyExecutionAuthority.ts`         | 托管执行权的待机实现，三份用例在用                                                                        | 执行权一族（按既有约定暂缓）              |
| task-execution `application/submitTaskContinuation.ts`               | 一行转调；`rfc333` 明锁它是 RFC-387 之后动态续跑的唯一测试调用方                                          | RFC-328 控制网关的直接闭包断言            |
| task-execution `postgresqlTaskLifecycleTransaction.ts`               | PostgreSQL 方言参照                                                                                       | RFC-359 §5hn：既有明确保留决定            |
| runtime-management opencode `plugin/aw-inventory-dump.mjs`           | 内嵌的 opencode 插件资产，按路径装载                                                                      | RFC-375 §4 / RFC-029：保留资产            |

## 2. 目标

- **G1**：后继指向本 RFC 能清的四个文件出生产树：对账表原样迁入 `tests/helpers/`（它是测试数据），portable-import 引用一对与 YAML 预览 / 选择子投影删除（无生产消费方）。
- **G2**：`unreachable-production-files` 8 → 4（max 同步降），账本（`rfc376` 的基线与保留理由、`rfc305` 的 identity-access 边账、`rfc359-w4-d14` 的中立装配清单、
  表归属债清单）与按路径读这些文件的源码锁（`rfc271`、`rfc345`、`rfc454`）随之改。
- **G3**：只测退役代码的四条用例随之删去，它们守的行为由生产路径上的既有用例覆盖（design §2）。

## 3. 非目标

- 其余四个：待机执行权（执行权一族按既有约定暂缓）、`submitTaskContinuation`（`rfc333` 明锁其为测试调用方，动它要先厘清 RFC-387 后的续跑路径）、
  PostgreSQL 方言参照（RFC-359 §5hn 既有保留决定）、内嵌插件资产（按路径装载，不是死代码）。
- 生产行为的任何改动。

## 4. 能力影响清单

无。删除的三个文件没有生产消费方；单文件 YAML 导出 / 导入在 RFC-271 已下线，由配置包取代。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：四个旧位置不在；对账表在 `tests/helpers/intentTeachingReconciliation.ts`，两份用例改取它；没有文件再取四个旧位置；生产树不取测试数据、不重新声明退役的函数。
- **AC-2**：`unreachable-production-files` 为 4，max 降到 4；账本随之改；新增 RFC-618 用例并登记。
- **AC-3**：删去的四条用例所守的行为在生产路径上有用例（design §2）。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
