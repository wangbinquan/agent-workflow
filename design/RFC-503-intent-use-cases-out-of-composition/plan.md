# RFC-503 实施计划

依赖：RFC-502（Done）；与 S12 共用模块 composition 文件（本 RFC 删除 intent 的 `composition/platformInventory.ts` 与
`composition/graphValidation.ts`，改 `composition/maintenance.ts` 的一个函数与一条类型 import、`composition/dispatch.ts` 的一行、intent
`composition.ts` 的两条转出，改 bootstrap `daemonModules/intent.ts` 的两条 import 与两处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-503-T1 用例归 application**：平台清单参与者、图校验端口的实现与两条维护命令原样迁入 application 的三个新文件，工厂改名为
  `create…`，维护命令的时钟改为传入（design D2）。
- **RFC-503-T2 composition 只装配**：删除两个组合文件，经 `composition.ts` 转出、bootstrap 改取；`composeIntentMaintenanceCommands` 只交时钟；
  `dispatch.ts` 去掉多余的判空（design D3）。
- **RFC-503-T3 锁与账本**：`rfc349` 平台清单用例改取新位置；`rfc380` 的名字表换新名字；三个边账本改钉新文件；`counts.json` 收紧
  （design D4）。
- **RFC-503-T4 用例**：新增 RFC-503 用例并登记 guard-manifest（design §4）。
- **RFC-503-T5 集中验证**：backend `tsc`、eslint；RFC-503 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-503-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新文件声明；两个组合文件不存在、没有文件从旧位置取名字；改名前的名字没有声明；`maintenance.ts` 与
      `dispatch.ts` 没有控制流
- [ ] AC-2 同样输入下平台清单、图校验与两条维护命令的结果、日志与端口调用和此前一致；bootstrap 拿到的是同一份实现；开机恢复对空列表与非空
      列表的行为不变
- [ ] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-intent` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-502 转 Done 提交 `7d2e82937` 与用例修正 `249e9f0b0`
的 CI）；实现与验证后再提交 `refactor(backend): RFC-503 意图的平台清单、图校验与维护命令迁出 composition（RFC-294 S10 第十步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
