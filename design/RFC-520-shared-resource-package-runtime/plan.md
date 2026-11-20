# RFC-520 实施计划

依赖：RFC-519（S10 关闭）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-520-T1 授权登记归 application**：新增 `resource-catalog/application/participants/resourceAuthorityRegistry.ts`（design D1）。
- **RFC-520-T2 模块工厂**：`postgresqlResourcePackageCatalog.ts` 新增 `composeResourcePackageRuntime`（design D2）。
- **RFC-520-T3 bootstrap 共用**：`commandBootstraps.ts` 与 `daemonHttpComposition.ts` 改调新工厂（design D3）。
- **RFC-520-T4 锁与用例**：`rfc349-postgresql-resource-package-bootstrap` 改钉新位置；新增 RFC-520 用例并登记 guard-manifest（design
  D4、§4）。
- **RFC-520-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、资源包命令 / 路由 / apply 的用例与全部
  `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-520-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 两处 bootstrap 改调 `composeResourcePackageRuntime`、不再调四个资源包工厂
- [ ] AC-2 catalog、原子 apply 与授权解析的行为和此前一致
- [ ] AC-3 授权登记落 application、组合层只装配；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-520 资源包装配共用一个模块工厂（RFC-294 S12 第一步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
