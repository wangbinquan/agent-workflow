# RFC-605 实施计划

依赖：RFC-604（指定的平台合同接口清单）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-605-T1 平台原语**：`S/platform/contracts/opaqueIdentity.ts` 与检测器的指定清单（design §1、§2）。
- **RFC-605-T2 引用类型与铸造点**：四个引用的 `reference` 改为对应 tag 的 `OpaqueIdentity`，两个模块 infrastructure 的 12 个铸造点改用
  `mintOpaqueIdentity()`；用例里手工构造的同样改（design §2）。
- **RFC-605-T3 任务房间结果**：`continueTask` / `failTask` 的结果去掉 `eventRef`，实现不再返回（design §2）。
- **RFC-605-T4 账本、计数与门**：`PUBLIC_SURFACE_DEBT` 去掉 3 条，`public-surface-deviations` 19 → 16；新增 RFC-605 用例并登记；RFC 索引、`STATE.md`、
  RFC-294 plan 的 S9 注记（design §3、§4）。
- **RFC-605-T5 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-605-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四个引用是 `OpaqueIdentity`，铸造点都用 `mintOpaqueIdentity()`，运行期行为不变
- [x] AC-2 任务房间参与方的结果不带 `eventRef`
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 去掉 3 条且逐条相等；计数降到 16；检测器正反用例
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `be07a4e96`（RFC-604）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：
  - 先改类型，按 `tsc` 列出的调用点逐个补上：用例与 helper 里手工构造引用的 17 处；生产代码的 12 个铸造点按 grep 改。
  - 之后 backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：
  - 范围：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例，以及遍历 development-automation、integration、
    task-execution 目录的扫描，共 926 个用例文件，6 个红。
  - `rfc321`：要 git 历史，导出里照例红。
  - 并发负载下的时序红：`rfc167` 断言状态未到；`rfc300-webhook-workspace-cleanup-e2e`、`rfc363-workspace-content` 超时。三者单跑都过，本 RFC 不改它们走的
    运行期路径。
  - 本 RFC 的 2 个：
    - `rfc508` 的替身把令牌里的数据写进日志，令牌不再带数据。改为用一个 `WeakMap` 给每个令牌记名，日志预期不变。
    - `rfc359-w26` 钉的是任务房间参与方源码的摘要，本 RFC 改了该文件探针之外的结果构造。按它的惯例加注释、重定基线。
  - 改后复跑这 6 个与 RFC-605 用例全绿。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：5 种都被认出。
  - 命名空间的 `reference` 改回 `object`：RFC-605 用例与 preflight 红。
  - 一个铸造点改回空对象字面量：RFC-605 用例红。初版判据看不穿 `{} as never` 这样的类型断言，于是改为透过类型断言、`satisfies`、括号与非空断言去看，
    负对照随之补上这两种写法。
  - 检测器不再放行 `OpaqueIdentity`：RFC-605 用例与 preflight 红。
  - 结果里加回事件引用：RFC-605 用例与 preflight 红。
  - 每次铸造返回同一个对象：RFC-605 用例与 `rfc508` 红。
- **架构报告**（候选对照干净的 `1b5eb8944`）：
  - `public-surface-deviations` 19 → 16，正好少这 3 条。
  - 新增平台文件 `contracts/opaqueIdentity.ts` 及八条指向它的 import 边，少了 task-execution 对平台事件类型的一条。
  - 若干 public 面的叶字段预算变小；`taskExecutionAuthority` 里 `failTask` 写点的行号 366 → 367（上方加了注释）。这些只记在报告里，不是门。
  - 有门禁的计数除上述一项外都不变。

## CI（AC-4）

- `170f3e2cc`（实现）：exact SHA 主 CI run 45772006810 70 / 70 全绿。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **身份语义不变**：铸造的仍是空对象，只多了冻结；所有实现只把它当 `WeakMap` 键与 `===` 比对，没有往上写数据。不同用途的令牌在类型上不能互递。
2. **任务房间**：事件照旧在同一事务里追加，由持久投递送达；结果去掉的字段没有任何消费方或用例读过。
3. **账本**：`PUBLIC_SURFACE_DEBT` 与检测结果逐条相等，计数随之降到 16。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
