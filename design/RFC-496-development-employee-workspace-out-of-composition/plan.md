# RFC-496 实施计划

依赖：RFC-495（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/digitalEmployeeWorkspace.ts`，
另动 infrastructure 的 `protectedSnapshot.ts`、`workspaceValidator.ts`、`attemptSupport.ts` 与 `graph-development/employeeWorkspace.ts` 的 import）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-496-T1 用例迁入 application**：第 34～588 行、组合输入接口与第 674～1402 行的用例原样迁入 `application/employeeWorkspace.ts`；
  读侧改名交出（design D2）。
- **RFC-496-T2 快照与校验迁入 application**：两个文件原样迁入 application，三个开作用域的函数取已选定的工厂；infrastructure 只留三个包装与
  三个转出；使用方按 D3 改取（design D3）。
- **RFC-496-T3 常量迁入 domain**：三组 git 元数据前缀迁入 `domain/gitMetadataOwnership.ts`，使用方改取（design D4）。
- **RFC-496-T4 composition 只留装配**：组合输入类型（形状不变）、装配函数与读侧的数据库绑定（design D5）。
- **RFC-496-T5 锁、账本与清单**：读用例源码的锁改指新文件；RFC-494 / RFC-495 用例钉住的同名声明改指；`counts.json` 收紧；
  `commons-debt.json` 锚点按内容改指；OS 依赖清单改指（design D6）。
- **RFC-496-T6 用例**：新增 RFC-496 用例并登记 guard-manifest（design §4）。
- **RFC-496-T7 集中验证**：backend `tsc`、eslint；RFC-496 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-496-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新的 application / domain 文件声明（infrastructure 的三个包装除外）；composition 只声明、只交出组合输入类型与
      装配函数，没有控制流语句；没有文件从旧位置取迁出的名字（三个包装与三个转出除外）
- [ ] AC-2 同样输入下工作区的准备、快照、校验与回退的结果、外部调用的次序与参数和此前一致；选定时机不变，未给实现的调用方仍选本机实现，
      远端树操作照旧优先
- [ ] AC-3 新文件的依赖面是闭集（application 不取 infrastructure、composition、IO 包与进程全局；domain 不取任何模块）；跨 context 边、
      public surface 不升；组合层控制流收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-495 转 Done 提交 `a8e04f58f` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-496 开发自动化的员工工作区用例迁出 composition（RFC-294 S10 第三步）`。走私有 index、按路径清单提交，在
共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
