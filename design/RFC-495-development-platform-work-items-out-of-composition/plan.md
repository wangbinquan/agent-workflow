# RFC-495 实施计划

依赖：RFC-494（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/digitalEmployeePlatformWorkItems.ts`）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-495-T1 用例迁入 application**：第 52～440 行与第 704～2306 行的用例原样迁入 `application/employeePlatformWorkItems.ts`，组合输入接口
  迁为 `DevelopmentEmployeePlatformWorkItemsInput`（design D2）。
- **RFC-495-T2 四处 infrastructure 改为注入**：选定的工作区效果、证据存储的懒取函数、业务树摘要、基线读取；默认时钟交给 composition
  （design D2、D3）。
- **RFC-495-T3 composition 只留装配**：组合输入类型（形状不变）与两个装配函数（design D3）。
- **RFC-495-T4 锁、账本与清单**：读用例源码的锁改指新文件；基线读取一条改实参名；`counts.json` 收紧；`commons-debt.json` 锚点按内容改指；
  OS 依赖清单改指（design D4）。
- **RFC-495-T5 用例**：新增 RFC-495 用例并登记 guard-manifest（design §4）。
- **RFC-495-T6 集中验证**：backend `tsc`、eslint；RFC-495 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-495-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新的 application 文件声明；composition 只声明、只交出组合输入类型与两个装配函数，没有控制流语句；没有文件从
      composition 取迁出的名字
- [ ] AC-2 同样输入下各工作项的输出、上下文补丁、外部调用的次序与参数和此前一致；选定、懒建、基线读取与业务树摘要的时机不变
- [ ] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-494 收口两次提交的 CI）；实现与验证后再提交
`refactor(backend): RFC-495 开发自动化的平台工作项用例迁出 composition（RFC-294 S10 第二步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
