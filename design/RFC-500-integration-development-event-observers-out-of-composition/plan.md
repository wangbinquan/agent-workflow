# RFC-500 实施计划

依赖：RFC-499（Done）；与 S12 共用模块 composition 文件（本 RFC 只把 integration 的 `composition/digitalEmployeeEventObserver.ts` 收成装配，
改 bootstrap `daemonModules/integration.ts` 取它的 import、一处类型与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-500-T1 观察者归 application**：第 3～428 行原样迁入 `application/developmentEventObservers.ts`；三个用例改名为
  `createDevelopment…EventObserver`，时钟与激活标识必填（design D2）。
- **RFC-500-T2 composition 只装配**：`composition/digitalEmployeeEventObserver.ts` 只留 `composeDevelopmentEmployeeEventObserver`；bootstrap
  改为调它（design D3）。
- **RFC-500-T3 锁与账本**：`rfc310-event-center` 改取新位置；`counts.json` 收紧（design D4）。
- **RFC-500-T4 用例**：新增 RFC-500 用例并登记 guard-manifest（design §4）。
- **RFC-500-T5 集中验证**：backend `tsc`、eslint；RFC-500 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-500-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在清单列的文件声明；装配文件只有装配函数、没有控制流语句；没有文件从旧位置取迁走的名字；bootstrap 只取装配
      函数、恰好调用一次
- [ ] AC-2 同样输入下三个观察者的返回与错误和此前一致；装配交的时钟与激活标识与此前的缺省相同
- [ ] AC-3 新文件的依赖面是闭集、不用进程全局；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-499 转 Done 提交 `b1ebf236f` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-500 集成的开发员工事件观察者迁出 composition（RFC-294 S10 第七步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
