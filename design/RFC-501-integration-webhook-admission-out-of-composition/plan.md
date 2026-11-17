# RFC-501 实施计划

依赖：RFC-500（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 integration 的 `composition/webhookAdmission.ts`，改
`composition/webhookDispatch.ts` 的一条 import 与一行注释、`composition.ts` 的一条转出，删去 `infrastructure/webhookDispatchRuntime.ts` 里
转手的函数，改 bootstrap `daemonModules/integration.ts` 的一条 import 与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-501-T1 准入归 application**：第 1～191 行原样迁入 `application/webhookAdmission.ts`，两个工厂改名（design D2）。
- **RFC-501-T2 composition 不再有这个文件**：删除 `composition/webhookAdmission.ts`；删去 infrastructure 的转手函数；`webhookDispatch.ts`
  改取 application；`composition.ts` 转出校验器工厂，bootstrap 改取它（design D3）。
- **RFC-501-T3 锁与账本**：5 个用例改取新位置；`rfc345` 改读新文件；`rfc380` 的名字表换新名字；`counts.json` 收紧（design D4）。
- **RFC-501-T4 用例**：新增 RFC-501 用例并登记 guard-manifest（design §4）。
- **RFC-501-T5 集中验证**：backend `tsc`、eslint；RFC-501 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-501-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在新文件声明；旧文件不存在、没有文件从旧位置取名字；改名前的两个工厂名没有声明；infrastructure 不再声明转手
      函数、不取 composition
- [ ] AC-2 同样输入下启动准入与保存校验的结果、错误码与端口调用和此前一致；派发与触发器服务拿到的是同一份实现
- [ ] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-500 转 Done 提交 `7bfd2c5e8` 与用例修正 `ea271ecac`
的 CI）；实现与验证后再提交 `refactor(backend): RFC-501 集成的 webhook 启动准入与触发器校验迁出 composition（RFC-294 S10 第八步）`。走
私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
