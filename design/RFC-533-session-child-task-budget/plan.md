# RFC-533 实施计划

依赖：RFC-532。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-533-T1 会话预算**：`childBudget.ts` 删去模块级状态与 setter / reset，导出 `createChildTaskBudgetRuntime`（design D1）。
- **RFC-533-T2 交入与读取**：daemon 的 task-execution 装配构造一份并经运行期选项交给子调用节点；会话的生命周期放行与配置热应用调这一份，
  热应用一并推深度（design D2）。
- **RFC-533-T3 用例与锁**：新增 RFC-533 用例（含深度热应用的回归用例）并登记 guard-manifest；读旧形状的用例与锁随改（design D3）。
- **RFC-533-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干与删去的名字）、直接导入被改文件与
  其在 `src/` 里调用方的用例与全部 `tests/architecture/`，红的与 HEAD 同时 A/B；回归用例在 HEAD 上红、在候选上过；架构报告对照。
- **RFC-533-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第一步。

## 验收清单

- [ ] AC-1 `childBudget.ts` 没有模块级可变状态与导出的 setter / reset；预算每会话一份
- [ ] AC-2 容量热应用、懒建与放行不变；深度保存后立即生效（回归用例）
- [ ] AC-3 模块级可变单例 79 → 71、计数不升；锁随改；新增 RFC-533 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-532 转 Done）；实现与验证后再提交
`refactor(backend): RFC-533 子任务预算由会话构造、调用链深度的热应用恢复（RFC-294 S12 第十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
