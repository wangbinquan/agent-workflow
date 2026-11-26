# RFC-618 实施计划

依赖：RFC-584、RFC-617（同一批账本文件，先发布 RFC-617）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-618-T1 迁移与删除**：对账表迁入 `tests/helpers/`；三个无生产消费方的文件删除（design §1）。
- **RFC-618-T2 用例与账本**：两份用例改取 helper；四条只测退役代码的用例删去；`rfc376` / `rfc305` / `rfc359-w4-d14` 账本与计数随之改（design §1）。
- **RFC-618-T3 门与文档**：新增 RFC-618 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S11 注记（design §2）。
- **RFC-618-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-618-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四个旧位置不在，对账表在 `tests/helpers/`，没有读者取旧位置
- [x] AC-2 计数 8 → 4；账本随之改；新增 RFC-618 用例并登记
- [x] AC-3 删去的用例所守的行为在生产路径上有用例
- [x] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `9f1b2535f`（RFC-617）+ 只含本 RFC 的路径（26 条）。

- **静态**：backend `tsc --noEmit` 0 错；改动的 TS 文件 eslint（`--max-warnings=0`，另跑 promises 配置）0；prettier 全过。
- **用例第一轮**（改动路径的传递闭包 + 名字 + 全部架构与文档读者，281 个文件）：四份按路径读被删文件的锁红——`rfc317`（表归属债清单逐条相等，
  `legacy/workflow.yaml.ts` 依赖 `users` 那条随文件删除而清偿）、`rfc271`（“下线不得误伤仍被使用的帮手”锁着后端选择子投影）、`rfc345`（锁 portable-import
  那一对的事务绑定）、`rfc454`（读 `legacy/workflow.yaml.ts` 断言不再导出 `stringifyWorkflowYaml`）。按 design §1 改：清单删去那条，`rfc271` 改锁 shared 里仍在用的
  `stripCallWorkflowNodeIds` / `workflowDefinitionToNameSelectors`，`rfc345` 删去那一条，`rfc454` 删去那一句。
- **用例第二轮**（同一 281 个文件）：全过。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `unreachable-production-files` 8 → 4；其余差异都随删文件而来（跨 context import 边 −10、
  符号 −56、生产文件 −4），没有别的计数变化。
- **变异**（4 / 4 被抓）：YAML 预览放回原位（RFC-618 ①③、`rfc376`）；用例重新取对账表的旧路径（RFC-618 ①②）；生产文件取 `tests/helpers/`
  的对账表（RFC-618 ③）；在别的装配里重新声明 `composePortableImportReferences`（RFC-618 ③）。每次恢复后导出干净。

## CI（AC-4）

- 实现提交 `4a39ec7be`：CI run 45868996879 全绿（70 / 70）。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 删除的三个文件：生产入口一个都走不到（架构报告 `unreachable-production-files`），`src` 与用例里没有消费方（RFC-618 用例 ②，按语法树取模块说明符）；
  单文件 YAML 导出 / 导入的路由在 RFC-271 已下线，没有用户可见变化。
- 迁移的对账表与原文逐行对比：只有三条 import 改别名与文件头一行来由。
- 删去的四条用例：守的行为在生产路径上各有用例（design §2）；`rfc345`、`rfc454` 删去的断言只针对已删的代码。
- 结论：功能面无遗留问题。

## PR / 提交

一个提交：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
