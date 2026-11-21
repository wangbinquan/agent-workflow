# RFC-528 实施计划

依赖：RFC-527。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-528-T1 单机 worker 部分**：新增 `bootstrap/standaloneMaintenanceWorker.ts`，7 族的单机构造与此前回落同一组工厂、同一组参数；
  `standalone.ts` 头注释指向它（design D1）。
- **RFC-528-T2 一次选择**：`resolveMaintenanceWorkerEffects` 与 `MaintenanceWorkerEffects`；两个数据库适配器在打开客户端之后各调一次，图只读选好的
  效果，删去 9 处本机构造、`resourcePackageArtifactRecovery` 里的回落与内容维护的 `?? 'local-file'`（design D2）。
- **RFC-528-T3 托管描述符列全**：用例钉住生产描述符的 `capabilities` 含全部 7 族（design D3）。
- **RFC-528-T4 用例与锁**：钉旧位置的锁改指单机 worker 部分或选择处；按被改文件的路径筛出读其源码的全部用例逐个核对（design D4）。
- **RFC-528-T5 门与账本**：新增 RFC-528 用例并登记 guard-manifest；计数降的收紧到实测。
- **RFC-528-T6 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、在 `tests/` 内按 import 求传递闭包（含以字符串
  引用的 `.ts` 夹具）到达被改文件的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给
  CI 的 backend 分片。
- **RFC-528-T7 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 1 项余项里维护 worker 的一半达成（daemon 一侧随第 6 项）。

## 验收清单

- [ ] AC-1 图不再构造本机效果、不再逐项回落；单机 worker 的本机效果只在单机 worker 部分给出，选择只在一处
- [ ] AC-2 单机、托管与部分描述符得到的对象不变；托管不构造本机实现；资源包恢复两项同时选照旧被拒
- [ ] AC-3 生产的托管描述符列全 7 族；worker 线程不加载 `bootstrap/standalone.ts`；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-527 转 Done）；实现与验证后再提交
`refactor(backend): RFC-528 维护 worker 的单机效果收进单机 profile（RFC-294 S12 第九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
