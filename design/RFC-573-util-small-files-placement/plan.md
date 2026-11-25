# RFC-573 实施计划

依赖：RFC-572（含 RFC-571 的补迁）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-573-T1 三个文件迁入 platform**：搬迁与读者改指（design §1、§3）。
- **RFC-573-T2 `daemonInfo` 归 system-operations**：读取并入文件实现，`status` 命令经端口读，bootstrap 交入（design §2）。
- **RFC-573-T3 门、工作流、用例与文档**：归属表、`counts.json`、`windows-platform.yml`、钉着旧路径的用例与一处文档；新增 RFC-573 用例并登记
  guard-manifest（design §4）。
- **RFC-573-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-573-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四个旧路径不存在、没有说明符再解析到它们；迁入 platform 的三个文件与原文件相同
- [x] AC-2 行为不变；`status` 命令经端口读运行信息，`cli/status.ts` 不取任何模块的 infrastructure
- [x] AC-3 `legacy-horizontal-files` 上限 107 → 103；归属表删去四行；Windows 工作流两份路径清单同步；新增 RFC-573 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`3a9a99e64`，主 CI 70 / 70）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `1db8cc54f` 加本 RFC 的 52 个路径，含四个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 的一处措辞与 `STATE.md`）；代码、用例、工作流与账本逐个文件比对，
与候选相同。

- **集中验证没有查出缺陷**：选集、候选导出里的用例与架构报告都是一次通过。
- **后续发现（RFC-574 动手前的检索，2026-11-25）**：`rfc346-system-operations-cli` 与 `rfc346-system-operations-contracts` 的“禁止取”正则里写的是
  `util\/(?:…|migrationsFolder)`，本 RFC 把 `migrationsFolder` 迁走后它们就认不出它的新位置了——判据没红，只是不再拦这个文件。本 RFC 的检索按
  路径文本搜，漏了用正则写的路径。RFC-574 改认新位置并补自证。
- **原样迁移**：迁入 platform 的三个文件迁移前后的 SHA-256 逐个相同。生产代码的其余改动：15 个读者的 import 说明符（`epoch1/bundle.ts` 的那一行
  变长后被 prettier 折成四行），五处注释里的路径，以及 design §2 的五个文件（运行信息的读取并入文件实现、装配根多一条导出、bootstrap 多一个
  函数、`status` 命令与 `main.ts` 的接线）。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 40 个 TS 文件（23 个生产文件、14 个用例文件、2 个测试
  助手与架构报告的归属表）无告警，生产文件另过 promises 配置；prettier：改动的代码、工作流文件与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 596 个用例文件，一次全部通过（4958 条）。四路取并集：对迁移的四个文件（新旧路径）、
  `cli/status.ts` 与改动的用例按 RFC-533 的口径与 RFC-550 的选法选出 189 个；经夹具与测试助手补 3 个；对 23 个改动的生产文件
  选直接 import 它们的用例（379 个）与按完整相对路径读它们源码的用例（51 个；`main.ts` 只取同时提到 `status` 子命令
  的）；再加上在 import 之外提到三个目的目录的用例（45 个，防目录清点类的断言）。没有沿 `main.ts`、`commandBootstraps.ts` 与
  system-operations 那两个文件做传递闭包——那会选进两千多个经装配根起应用的用例，而这几处的改动是一个函数、一条导出与一行调用，解析得到与否由
  `tsc` 与直接读者保证，其余由 CI 的全量运行覆盖。`cli.test` 里起真实 daemon 的 `status + stop` 一条在新接线下通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本与 Windows 工作流的
  用例、钉着本次改动位置的用例，共 203 个文件、1934 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-573 用例 15 / 15、
  `rfc294-architecture-preflight` 15 / 15、`rfc317-architecture-ledgers` 15 / 15、`rfc427-entry-root` 3 / 3、`rfc377-util-git-leaf-lock` 9 / 9、
  `ci-workflow-path-filters` 3 / 3、`rfc254-no-unref-deadline-guard` 4 / 4、`cli-embedded-migrations` 3 / 3、
  `rfc359-w5-same-file-provider-pairs` 6 / 6、`rfc370-daemon-host-root-wiring` 3 / 3、`test-suite-policy` 12 / 12、`root-test-entrypoint` 24 / 24。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：十五种都被认出。搬迁一侧：旧路径上重新出现一跳转出（RFC-573
  用例 ① 与 `rfc376-structural-guards` 的 legacy 文件计数同红）；生产读者重新取旧路径（用例 ①）；迁入的文件开始取模块（用例 ② ③ 与
  `rfc376-structural-guards` 同红）；少一个导出（用例 ③）。`status` 一侧：命令又自己读运行信息文件（用例 ④ 的结构断言与行为断言同红）；命令问了
  端口却丢掉答案（结构断言照过，两条行为断言红）；bootstrap 交入别的文件；文件实现对损坏的文件抛错（`daemon-info-route` 同红）；文件实现不理会
  交入的路径。工作流一侧：pull_request 清单少了 `fsReclaim`；两份清单仍写旧路径（`ci-workflow-path-filters` 同红）。随改的既有守卫：`util/git` 取
  工作区目录的另一个文件（`rfc377` 红）；别的源码文件用 `AbortSignal.timeout`（`rfc254` 守卫红）；解包前置被抄进别的文件
  （`cli-embedded-migrations` 红）；解析器少了 PostgreSQL 那一半（同文件孪生账本红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，107 → 103（少的正是这四个文件）；生产文件数少 1。跨
  context import 7528 → 7530：去掉五条（三条模块取 `util/` 的、文件实现取 `util/daemonInfo` 的、`util/daemonInfo` 取 system-operations public
  的），新增七条（三条模块取 platform 的、`cli/status.ts` 取 system-operations public 的两条类型 import、bootstrap 取 system-operations 装配根的
  一条、文件实现取 `util/paths` 的一条）；没有新的跨 context 内部 import。public 面（989）、public 类型偏差（32）与变更入口普查（2393）条数不变，
  `DaemonRuntimeQueries` 与 `DaemonRuntimeInfo` 的消费方里 `util/daemonInfo` 换成了 `cli/status.ts`。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `3a9a99e64`（实现，父提交是 `1db8cc54f`；同一提交记 RFC-571 补迁转 Done）：exact SHA 主 CI run 45518146982 的 70 个 job 全部成功——全部后端分片、真实 PostgreSQL、前端、三个平台的构建与检查、
  ubuntu / windows / macOS 的全部 e2e 分片。同一提交按路径触发的另三个工作流也全部通过：windows-platform（run 45518147036，`fsReclaim` 的
  新位置在它的路径清单里）、integration-opencode（run 45518146958）与 git-protocols-e2e（run 45518146932）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **三个迁入 platform 的文件没有行为改动的落点**：文件逐字节相同；21 处说明符逐行看过，各只改了路径（别名的仍用别名、相对路径的重算）；
  `auth/oidc/` 的三个文件、`util/git.ts` 与 `nodeWorkspaceMaintenanceFilesystem.ts` 除 import 那一行外只有 `auth/oidc/` 三处注释里的路径。
- **运行信息的读取与原来等价**：`readDaemonInfoFile` 的函数体与 `readDaemonInfo` 逐行相同（缺失或损坏返回 `null`），默认路径仍在调用时取
  `Paths.daemonInfo`；`createFileDaemonRuntimeQueries` 的 `readCurrent` 仍把 `options.infoPath` 交给它。
- **`status` 命令的三种状态不变**：没有锁文件 → `not-running`、不读运行信息；锁里的进程不在 → `stale-lock`；在 → 经端口读运行信息、再探
  `/health`。端口的返回可以是同步值或 Promise，命令统一 `await`；`null` 仍然落成“没有运行信息、只报 PID”。`main.ts` 交入的是 bootstrap 用默认
  路径造的文件实现，读的仍是安装目录下的 `.daemon.info`。
- **钉着旧路径的地方都随改**：归属表四行、`rfc254` 守卫放行助手自身的那条与注释、`cli-embedded-migrations` 放行解析器自身的那条、同文件孪生账本
  的一行（新键仍排在末尾）、`rfc377` 的叶子锁（只放行 `fsReclaim` 一个说明符，同目录其他文件与相对路径写法仍被拒）、Windows 工作流的两份路径
  清单、`docs/dev-gotchas.md` 的现行指引一句。`docs/audit-backlog.md` 里的是事故记录，没有改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
