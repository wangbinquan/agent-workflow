# RFC-529 实施计划

依赖：RFC-528。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-529-T1 平台定时原语**：`platform/background/intervalTimer.ts` 的 `startInterval`（design D1）。
- **RFC-529-T2 8 处改走原语**：业务模块的 8 处直接 `setInterval` / `clearInterval` 改调原语，句柄类型随改；诊断 effect 端口合同不变（design D2）。
- **RFC-529-T3 门与用例**：RFC-529 用例（门与原语的行为）并登记 guard-manifest；读被改文件源码的锁随改（design D3、§4）。
- **RFC-529-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、在 `tests/` 内按 import 求传递闭包（含以字符串
  引用的 `.ts` 夹具）到达被改文件的用例、经未改的生产模块调到被改文件的用例（被改文件在 `src/` 里的调用方的直接导入者）与全部
  `tests/architecture/`，与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-529-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 5 项达成。

## 验收清单

- [ ] AC-1 业务模块里没有直接的 `setInterval` / `clearInterval`；8 处经平台定时原语、带 owner、停止点调 `stop()`
- [ ] AC-2 回调、周期、`unref` 与停止时机不变；原语语义与 `setInterval` 相同
- [ ] AC-3 直接全局定时器的清单只含平台定时原语与 `platform/background` 的既有几处；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-528 转 Done）；实现与验证后再提交
`refactor(backend): RFC-529 业务模块的周期定时器改走平台定时原语（RFC-294 S12 第十步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
