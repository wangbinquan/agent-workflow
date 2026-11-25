# RFC-574 实施计划

依赖：RFC-573。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-574-T1 搬迁与改指**：两个文件迁入 platform（`installationPaths.ts` 改层数），读者的说明符改写（design §1、§2）。
- **RFC-574-T2 门、用例与文档**：归属表、`counts.json`、公共内核清单、钉着旧路径的用例、三个正则判据与它们的自证、两处文档；新增 RFC-574 用例
  并登记 guard-manifest（design §3）。
- **RFC-574-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-574-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个旧路径不存在、没有说明符再解析到它们；`requestParsing.ts` 逐字节相同，`installationPaths.ts` 只差两处层数
- [x] AC-2 行为不变；两条迁移目录仍解析到 `packages/backend/db/` 下
- [x] AC-3 `legacy-horizontal-files` 上限 103 → 101；归属表删去两行；三个正则判据改认新位置并带自证；新增 RFC-574 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `3a9a99e64` 加本 RFC 的 148 个路径，含两个删除，用本地提交固化，树哈希与“HEAD 加这些路径”
的树哈希相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design §6 的一句、`STATE.md`，以及 RFC-573 转 Done 的三处记录）；
代码、用例、工作流与账本逐个文件比对，与候选相同。

- **集中验证没有查出产品缺陷**：选集与候选导出里的用例一次通过。设计里有一句断言被变异推翻（design §6：以为开库的用例也会因层数写错而
  红，实际开库走 epoch-2、不读编号迁移目录），已改正，m5 的证人换成读第一代迁移历史的三个用例。动手前的检索查出 RFC-572 / RFC-573 留下的两条失效
  正则与 e2e 里五处旧路径指针（design §3、§4），本 RFC 一并改。
- **迁移的两个文件**：`requestParsing.ts` 与原文件逐字节相同；`installationPaths.ts` 与原文件只差两处层数（`'..', '..'` → `'..', '..', '..'`）与
  解释它们的注释（新增三行、补一句）。生产代码的其余改动：78 个读者的 import 说明符与两处注释里的路径。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 131 个 TS 文件无告警，生产文件（80 个）另过 promises
  配置；四个 e2e spec 只改注释与一条断言说明，另过 eslint 与 prettier；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 829 个用例文件，一次全部通过（7435 条）。四路取并集：对迁移的两个文件（新旧路径）与改动的用例按
  RFC-533 的口径与 RFC-550 的选法选出 179 个；经夹具与测试助手补 343 个（取安装目录的测试助手很多，这一路占了大头）；对改动的生产文件选
  直接 import 它们的用例（232 个）与按完整相对路径读它们源码的用例（230 个）；再加上在 import 之外提到两个目的目录的用例（19 个）。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本与 Windows 工作流的
  用例、钉着本次改动位置的用例，共 206 个文件、1965 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-574 用例 7 / 7、
  RFC-573 用例 15 / 15、`rfc294-architecture-preflight` 15 / 15、`rfc317-architecture-ledgers` 15 / 15、`rfc427-entry-root` 3 / 3、
  `rfc473-execution-outcome-and-resource-sessions` 12 / 12（读公共内核清单）、`rfc346-system-operations-cli` 4 / 4、
  `rfc346-system-operations-contracts` 10 / 10、`rfc303-architecture-lock` 6 / 6、`docs-implementation-parity` 5 / 5、`rfc284-env-flags-registry` 3 / 3。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：十二种都被认出。搬迁一侧：旧路径上重新出现一跳转出（RFC-574
  用例 ① 与 `rfc376-structural-guards` 的 legacy 文件计数同红）；生产读者重新取旧路径（用例 ①）；迁入的文件开始取模块（用例 ② 与
  `rfc376-structural-guards` 同红）；少一个导出（用例 ③）；两条迁移目录的层数改回两级（用例 ④ 与读第一代迁移历史的 `rfc395-v1-frozen-source`、
  `rfc395-v1-source-evidence`、`rfc395-history-response-parity` 同红——起初配的证人是 `users-cli`，它不红：开库走 epoch-2 的运行时、不读编号迁移
  目录，design §6 据此改正）。正则判据一侧：备份 CLI 直取 daemon 锁、还原 CLI 直取迁移目录（`rfc346-system-operations-cli` 红）；
  system-operations 的 application 取安装目录、还原路由取迁移目录（`rfc346-system-operations-contracts` 红）；integration 的 infrastructure 取安装
  目录（`rfc303` 红）。其余随改的判据：code-capability 的 inbound 取 `platform/http` 下别的文件（`rfc439` 红，白名单只放行 `requestParsing`）；
  安装目录的源码丢了控制文件的“at-rest secret”说明（`rfc254-control-listener` 红，证明它读的是新文件）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，103 → 101（少的正是这两个文件）。跨 context import（7530）、
  符号归属（32529）、变更入口普查（2393）、public 面（989）与 public 类型偏差（32）条数不变；有差别的 30 条 import 与 9 条符号都是这两个文件自己
  的，差在路径、由路径算出的 id 与所在层。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **两条迁移目录的解析结果不变**：`installationPaths.ts` 在 `src/platform/configuration/` 下，三级回到 `packages/backend`，与原文件在 `src/util/`
  下两级回到的是同一个目录；RFC-574 用例 ④ 直接比对两个值并确认两处都有迁移日志；源码树里读第一代迁移历史的三个用例经 `resolveMigrationsFolder()` 读这两个
  目录，也通过。单二进制里这两个值不用，不受影响。
- **其余没有行为改动的落点**：`requestParsing.ts` 逐字节相同；改写的说明符逐行看过，各只改了路径（别名的仍用别名、相对路径的重算）；
  `util/gitCredentialLease.ts`、`util/gitHardening.ts` 与 `routes/` 下的认证、OIDC、账号凭据路由只动 import 那一行。
- **三个正则判据的覆盖面恢复到原意**：`rfc346-system-operations-cli` 重新拦得住 daemon 锁、安装目录与迁移目录三者的现位置；
  `rfc346-system-operations-contracts` 的两条与 `rfc303` 的一条改认新位置；三处都有伪造 import 的自证，走 public 合同的放行。
- **钉着旧路径的地方都随改**：归属表两行、公共内核清单一条（`rfc284` 的行号引用仍然有效）、入口白名单、inbound 依赖白名单、`rfc254` 读的源码、
  `rfc505` 的两处 import 描述、RFC-573 用例的两个依赖清单、两处带行号的注释、`docs/env-flags.md` 一行与 e2e 里指向被挪文件的现状指针。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
