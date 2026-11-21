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

- [x] AC-1 业务模块里没有直接的 `setInterval` / `clearInterval`；8 处经平台定时原语、带 owner、停止点调 `stop()`
- [x] AC-2 回调、周期、`unref` 与停止时机不变；原语语义与 `setInterval` 相同
- [x] AC-3 直接全局定时器的清单只含平台定时原语与 `platform/background` 的既有几处；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 35～60）。验证在候选导出仓库里跑（HEAD `b675fc097` 加本 RFC 的路径，核对与工作树逐字相同）；对照导出仓库与
HEAD 的树相同。集中验证查出本人两处缺陷，修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 13 个 TS 文件无告警，改动的 9 个生产文件另过
  promises 配置；prettier：改动的 TS、`counts.json`、guard-manifest 与本 RFC 的三件套通过（18 个文件）。
- **首批**（60 秒；候选与对照同时、按同样的顺序各 4 个 worker）：222 个文件（对照 221 个，没有新用例）——全部 142 个 `tests/architecture/`
  （`counts.json` 与 `rfc376` 的账本随改）、读被改文件源码的用例、直接导入被改文件的用例、按用途命名的用例（MR 终止控制、MCP 诊断、预算、实时抓取、
  子调用、看门、心跳与归属）与监看全局定时器的被动装配用例。在 `tests/` 内按 import 求传递闭包会到 1,600 多个文件（共享测试助手为用例隔离导入
  任务驱动生命周期），即全量语料，交给 CI 的 backend 分片；本 RFC 不收紧任何入参（只换内部计时句柄的类型），不按被改文件在 `src/` 里的调用方
  再扩。候选 217 个文件通过、对照 218 个：
  - 本人缺陷两处：① RFC-529 用例的负对照拿真实语料里的平台文件当清单的占位，RFC-317 的判据（负对照不得碰真实语料）认不出它们，
    `rfc317-guard-negative-fixture` 两条红——改为空的伪造占位；② 子调用节点的共享体按 RFC-404 只能取 task-execution 的 domain / application /
    引擎内核、节点共享与 `platform/contracts`，改调平台定时原语后多了一条到 `platform/background/intervalTimer.ts` 的导入，`rfc404-child-call-executors`
    红——叶子规则放行这一个原语（它替代的是此前直接用的全局 `setInterval`），不经端口另造一层。另随修正让架构报告的后台作业清单认出 `startInterval`
    （种类 `platform-interval`），改走原语的 8 处照旧在清单里。修正后这两个用例、RFC-529 用例与读架构报告的 4 个用例（7 个文件）273 / 273。
  - 两边相同的 3 个：`rfc376-report` 撞自带的 300 秒时限；`rfc238-mcp-runtime-test-http` 的 PostgreSQL 一支撞 2 秒的会话轮询时限（同一条），
    `rfc238-mcp-runtime-test-service` 两边各 2 条等待条件撞时限（具体用例不同）——这两个文件两边同时各以 1 个 worker 再跑，都全过（52 / 52、4 / 4）。
- **架构报告**（候选与 HEAD 各出一份）：60 项计数里只有 `direct-setinterval-sites` 变化，按实测 14 → 7（业务模块的 8 处改走原语，原语自己
  一处）；后台作业清单 34 → 35（8 处换成 `platform-interval` 一类，加原语自己的一处）；跨上下文导入 7,518 → 7,530，新增的 12 条都是这 8 个业务
  文件取平台定时原语（取值 8 条、取类型 4 条），没有删去的；生产文件 +1；各模块符号属主只多原语、它的句柄类型与新文件。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **8 处的回调、周期与停止时机原样**：MR 终止控制的恢复扫描（`RECOVERY_SCAN_MS`，起后 `unref`，worker 停止时停）；两个诊断 effect 交出的
  `cancel` / `unref` 改转原语的 `stop` / `unref`（端口合同不变）；子任务预算告警（`LONG_WAIT_WARN_MS / 4`，没有等待者时停）；子会话实时抓取
  （`opts.pollMs`，两处停止点）；子调用节点观测（`CALL_CHILD_OBSERVE_MS`，`finally` 里停）；执行看门（`pollMs`，清理时停）；owner 心跳
  （`DEFAULT_OWNERSHIP_HEARTBEAT_MS`，起后 `unref`，换代、驱动结束与全部停止三处停，句柄照旧存在模块级 `Map`）。
- **原语语义与此前相同**：就是 `setInterval(tick, everyMs)`；`stop` 调一次 `clearInterval`，再调什么都不做（此前几处停止后把句柄置空防重复，原语自己
  也防）；`unref` 转给句柄、句柄没有 `unref` 时什么都不做（同此前的 `unref?.()`）；全局定时器在调用时取，监看全局定时器的用例照旧看得到。
- **实时抓取的回调读句柄**：此前 `setInterval` 返回后赋给 `intervalHandle`、首次触发在 `pollMs` 之后；现在原语返回后赋值，时序相同。
- **账本与锁**：`rfc376-structural-guards` 的 `KNOWN` 删去 8 处业务模块的条目、加原语的一处，`direct-setinterval-sites` 按实测 14 → 7；架构报告的
  后台作业清单认出 `startInterval`；RFC-404 的叶子规则放行平台定时原语；guard-manifest 登记新用例，改动过的条目行数按各条原有的计法随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-528 转 Done）；实现与验证后再提交
`refactor(backend): RFC-529 业务模块的周期定时器改走平台定时原语（RFC-294 S12 第十步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
