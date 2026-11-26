# RFC-607 实施计划

依赖：RFC-597（装配入参的需求源必填）、RFC-603。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的
静态自查。

## 任务

- **RFC-607-T1 物化器入参**：`source` 必填、删去 `documents` 覆盖与三处缺席分支（design §1）。
- **RFC-607-T2 迁出兼容物化器**：迁入 `tests/helpers/`，删去兼容转出文件，生产使用方改取 application 的类型（design §1）。
- **RFC-607-T3 用例**：6 个用例 / helper 文件改 import；两个文档读取用例经 helper 的证据端口代理注入（design §2）。
- **RFC-607-T4 门与文档**：新增 RFC-607 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W4-E8 注记（design §2）。
- **RFC-607-T5 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-607-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 物化器入参的 `source` 必填、没有 `documents`；application 不再判断需求源缺席
- [x] AC-2 兼容物化器不在 `src/`；兼容转出文件删去；生产装配不变
- [x] AC-3 受影响用例全部通过，行为不变；新增 RFC-607 用例并登记；计数不升
- [x] AC-4 exact SHA CI 全绿（后继证据，见下）

## 集中验证

基于 `01306b9ce`（RFC-606）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（生产调用方本来就给需求源；用例经 helper）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例、遍历 development-automation
  目录的扫描与 RFC-310 夹具的使用方，共 535 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：5 种都被认出。
  - 需求源改回可选、文档覆盖加回、`src/` 里重新放一个兼容物化器：RFC-607 用例红。
  - 重新加一处需求源缺席分支：RFC-607 用例红。初版判据是正则，看不穿 `(deps.source as unknown) === undefined`；改为透过类型断言与括号的 AST 判据，
    负对照随之补上这类写法。
  - helper 不再把用例的文档读取交给物化器：`rfc370-evidence-document-read` 红。
- **架构报告**（候选对照干净的 `01306b9ce`）：生产文件少 2 个，随之少了它们的符号与一条 mutation entrypoint；有门禁的计数都不变。

## CI（AC-4）

- `e7fae1424`（实现）：exact SHA 主 CI run 45778901981 结论 failure，红在两格，都是等待超时，与本 RFC 的改动（需求物化器的入参）无关、未重跑：
  - shard 41：RFC-401 epoch-2 历史行桥的用例 5,544 ms 超过 5 秒上限；
  - shard 15：`rfc310-employee-case-runtime` 的 PostgreSQL 一支等 30 秒超时（同一格里 SQLite 一支 1.6 秒通过），超时后连接关闭又报一条查询失败。
  - 两条用例在后继 `a3def727e`（RFC-608，包含本提交）的 run 45781401766 里都通过（shard 41 一次、shard 15 两个 provider 各一次）。
- 后继证据：包含本提交的 `03008a73a`（RFC-546）run 45785450678 70 / 70 全绿。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产装配不变**：`composeDevelopmentAutomation` 本来就给需求源、从不覆盖文档读取。删去的三处分支在生产上走不到，绑定缺失时的失败码与行为照旧。
2. **兼容物化器**：迁入 `tests/helpers/` 后，物理目录需求源的包装与文件文档写入的默认一字不变；没给需求源时的替身只在用例走到外部源时才抛错。
3. **用例**：文档读取经证据端口代理注入，被测物化器读到的仍是用例的假读取；其余成员经代理绑定在原证据端口上。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
