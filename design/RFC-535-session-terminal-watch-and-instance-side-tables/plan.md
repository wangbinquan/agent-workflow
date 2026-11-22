# RFC-535 实施计划

依赖：RFC-534。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-535-T1 终态看门**：`executionWatch.ts` 改为 `createTaskTerminalWatch()`；运行期选项、动作执行依赖加必填的看门；daemon 的
  task-execution 装配建一份交给运行期参与者、`hostTasks` 与模块集合，会话的已提交事件消费者调它（design D1）。
- **RFC-535-T2 参与者**：`agentExecutionEffect.ts` 的参与者改为带私有字段的实例，删去模块级表（design D2）。
- **RFC-535-T3 对照范围**：`scope.ts` 把范围盖在快照的行数组上，删去模块级表（design D3）。
- **RFC-535-T4 工作区读取**：`workspaceRead.ts` 删去多余的能力集合（design D4）。
- **RFC-535-T5 材料引用**：`createNativeAgentMaterialReferences()`；每份材料定义一张、交给它建的编译器，遗留编译自建一张；删去模块级表、
  `bindNativeAgentMaterialReference` 与别名（design D5）。
- **RFC-535-T6 用例与锁**：新增 RFC-535 用例并登记 guard-manifest；读旧形状的用例与测试拓扑随改（design D6）。
- **RFC-535-T7 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干、不带目录的文件名与删去的名字）、
  直接导入被改文件与其在 `src/` 里调用方的用例、经 `tests/` 内 import 传递到被改测试助手的用例、逐个扫 `tests/` 的语料守卫、全部
  `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。
- **RFC-535-T8 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第三步。

## 验收清单

- [ ] AC-1 `executionWatch.ts` 没有模块级状态与 reset；看门每会话一份，子调用节点、动作执行与已提交事件消费者用同一份
- [ ] AC-2 参与者、对照范围、工作区读取与材料引用不再有进程级侧表；解读与判定不变
- [ ] AC-3 模块级可变单例 66 → 61、计数不升；锁随改；新增 RFC-535 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-534 转 Done）；实现与验证后再提交
`refactor(backend): RFC-535 终态看门由会话构造、按对象挂的侧表归各自实例（RFC-294 S12 第十六步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
