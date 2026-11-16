# RFC-499 实施计划

依赖：RFC-498（Done）；与 S12 共用模块 composition 文件（本 RFC 只删 source-control 的 `composition/repositoryPublicationTransport.ts`，把
`composition/repositoryPreparation.ts` 收成装配，改 `composition.ts` 的一条转出并删去一个零调用方的函数）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-499-T1 发布传输**：第 1～353 行原样迁入 `infrastructure/repositoryPublicationTransport.ts`，去掉只为被删函数服务的 import；删除
  composition 的文件，`composition.ts` 改从新文件转出（design D1）。
- **RFC-499-T2 仓库准备**：输入接口与两个本机工厂迁入 `infrastructure/local/repositoryPreparation.ts`；准备绑定迁入
  `infrastructure/repositoryPreparationBridge.ts`（`createRepositoryPreparationBridge`，两组 effect 必填）；`composition/repositoryPreparation.ts`
  只留装配与转出（design D2）。
- **RFC-499-T3 删除零调用方的函数**：传输文件与 `composition.ts` 的两个密钥文件解析，`composition.ts` 去掉 `node:fs`（design D3）。
- **RFC-499-T4 锁、账本与清单**：`rfc321`、`rfc349`、`rfc376`、`rfc305`、`rfc478`、`rfc447` 改指新位置；`public/queries.ts` 的注释；
  `counts.json` 收紧（design D4）。
- **RFC-499-T5 用例**：新增 RFC-499 用例并登记 guard-manifest（design §4）。
- **RFC-499-T6 集中验证**：backend `tsc`、eslint；RFC-499 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-499-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在清单列的文件声明；传输的旧文件不存在、没有文件从旧位置取名字；`composition.ts` 从新文件转出传输、不取
      `node:fs`；两个被删的函数没有声明、import 与调用；准备的装配文件只有装配与转出、没有控制流语句
- [ ] AC-2 同样输入下发布会话与准备绑定各方法的返回、错误码、持久化与外部调用的次序和参数和此前一致
- [ ] AC-3 新文件不取 composition（`required-ports` 的类型除外）；跨 context 边、public surface 不升；两项组合层计数收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-498 转 Done 提交 `a0e2c551c` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-499 源代码管理的发布传输与仓库准备的 effect 实现归 infrastructure（RFC-294 S10 第六步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
