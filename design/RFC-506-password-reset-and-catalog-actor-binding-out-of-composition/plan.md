# RFC-506 实施计划

依赖：RFC-505（Done）；与 S12 共用模块 composition 文件（本 RFC 改 identity-access 的 `composition/userOperations.ts` 与 intent 的
`composition/resourceCatalog.ts`；两个装配入口不变）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与
格式的静态自查。

## 任务

- **RFC-506-T1 用例与用例状态归 application**：改密用例迁入 identity-access `application/commands/resetUserPassword.ts`（系统用户 id、
  认证运行时的两次凭据写、哈希与时钟传入），演员绑定迁入 intent `application/resourceCatalog.ts`（design D2）。
- **RFC-506-T2 composition 只装配**：两个组合文件的装配入口改为从新位置取实现（design D3）。
- **RFC-506-T3 账本与锁**：`counts.json` 两项收紧；T19b 账本销掉 intent 组合文件那一行；`rfc349-auth-caller-closure` 改钉新位置；
  guard-manifest 登记（design D4）。
- **RFC-506-T4 用例**：新增 RFC-506 用例（design §4）。
- **RFC-506-T5 集中验证**：backend `tsc`、eslint；RFC-506 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-506-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的新位置声明；两个组合文件没有控制流、从新位置取实现；装配入口不变
- [ ] AC-2 同样输入下改密与演员绑定的结果、错误与端口调用和此前一致；时钟仍在调用时取、每次一次
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；两项 `composition-control-flow-*` 收紧到实测；T19b 账本只减不增
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】
