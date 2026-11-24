# RFC-571 实施计划

依赖：RFC-570。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-571-T1 搬迁与改指**：八个文件迁入 platform，读者的说明符改写（design §1、§2）。
- **RFC-571-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例、两处文档；新增 RFC-571 用例并登记 guard-manifest（design §3）。
- **RFC-571-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-571-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 八个旧路径不存在、没有说明符再解析到它们；新文件内容与原文件相同
- [x] AC-2 行为不变；新位置的文件不取模块、不取 `util/`
- [x] AC-3 `legacy-horizontal-files` 上限 125 → 115；归属表删去登记过的七行；新增 RFC-571 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `b872c6ca1` 加本 RFC 的 91 个路径，含八个删除，用本地提交固化，树哈希与“HEAD 加这些
路径”的树哈希相同），对照是同一 HEAD 的另一份导出。

- **集中验证没有查出产品缺陷**。范围在动手前收窄过一次：原计划十个文件，其中 `inFlight` 与 `sqlChunk` 的读者里有身份认证与任务授权的文件，为了
  不碰那几处，这两个留在 `util/`。
- **原样迁移**：八个文件迁移前后的 SHA-256 逐个相同；生产代码的其余改动只有读者的 import 说明符（30 个文件）与一处注释里的路径。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 77 个 TS 文件（38 个生产文件、34 个用例文件、3 个测试
  助手与夹具、架构报告的归属表与一个仓库脚本）无告警，生产文件另过 promises 配置；prettier：改动的代码与三件套通过（两份 JSON 账本不进 prettier；
  `docs/env-flags.md` 在 HEAD 上就不是 prettier 的规范形态，只改了两行里的路径）。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：选出 439 个用例文件，一次全部通过（3958 条）。选法：对八个迁移文件（新旧路径）与全部改动的
  用例按 RFC-533 的口径与 RFC-550 的选法选出 311 个，经夹具与测试助手补 20 个，再加上直接 import 那 30 个“只改了说明符”的生产文件的 132 个用例
  文件。没有按这 30 个文件的文件名做文本匹配：`export.ts`、`server.ts`、`util.ts`、`main.ts` 一类的通用文件名会把选集撑到 2300 个，而它们的改动
  只是一行 import，解析得到与否由 `tsc` 与直接 import 它们的用例保证，其余由 CI 的全量运行覆盖。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部 142 个用例文件、`rfc317-*` / `rfc294-*` 与钉着本次改动位置的用例，
  共 166 个文件、1564 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-571 用例 5 / 5、
  `rfc294-architecture-preflight` 15 / 15、`rfc317-guard-corpus-floor` 24 / 24、`rfc317-guard-negative-fixture` 17 / 17、
  `rfc427-entry-root` 3 / 3、`rfc284-microhelpers` 6 / 6、`rfc143-runtime-driver-capability` 29 / 29、`zip-fixed-mtime-timezone` 1 / 1、
  `rfc284-env-flags-registry` 3 / 3、`docs-implementation-parity` 5 / 5。
- **变异验证**（候选导出仓库里，每种变异复原后导出仓库无改动、树哈希不变）：八种变异都被认出——旧路径上重新出现一跳转出（RFC-571 用例 ① 与
  `rfc376-structural-guards` 的 legacy 文件计数同红）；生产文件、测试助手各自重新取旧路径（用例 ①）；迁入的原语开始取模块（用例 ② 与
  `rfc376-structural-guards` 的“platform 不取模块”同红）或取 legacy 的 `util/log`（用例 ②）；少一个导出、多一个没登记的导出（用例 ③）；
  `monotonicNow` 不再严格递增（`rfc284-microhelpers` 红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，123 → 115（少的正是这八个文件）；public 面（989）、public
  类型偏差（32）、变更入口普查（2393）、跨 context import 的条数（7528）与生产文件数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **没有行为改动的落点**：八个文件逐字节相同；30 个读者各改一行（`opencode/util.ts` 两行）import 说明符，别名的仍用别名、相对路径的重算相对路径，
  逐行看过没有别的改动；`main.ts` 取版本的那一处与入口白名单同步。
- **新位置没有引入依赖方向的问题**：八个文件只取 `zod`、`yaml`、`fflate` 三个第三方库或什么都不取；平台不取模块、不取 legacy 目录。
- **钉着旧路径的地方都随改**：架构报告的归属表（七行；`zodJsonSchema` 原本不在表里）、`rfc427` 的入口白名单、`rfc284-microhelpers` 的 monotonic 公式
  唯一出处、`rfc143` 的 semver 单份、`zip-fixed-mtime-timezone` 读的模块路径、`docs/env-flags.md` 两行与构建脚本的一处注释。`docs/dev-gotchas.md` 里
  提到旧路径的是事故记录，没有改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
