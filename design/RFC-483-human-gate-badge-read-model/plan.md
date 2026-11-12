# RFC-483 实施计划

**前置**：RFC-485（Done，`9699ad3fd`，Done 文档 `1fa9be87c`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-483-T1 | task-execution 的 composition 转出三个片段，`public/queries` 撤出                                                                                                   | design §2 |
| RFC-483-T2 | `TaskExecutionParticipantBindings` 增三个成员与 `HumanGateBadgeTaskScope` 切片；bootstrap 的绑定与用例 helper 补上                                                  | design §2 |
| RFC-483-T3 | application：徽标读模型端口（DTO）与查看者判定、两个徽标用例                                                                                                        | design §2 |
| RFC-483-T4 | 徽标读模型：两个计数函数改收 `(db, taskScope, viewer)`，谓词改从绑定取；路由操作组出读模型、经 application 用例计数                                                 | design §2 |
| RFC-483-T5 | 账本销账、`counts.json` 收紧、guard-manifest 登记                                                                                                                   | design §3 |
| RFC-483-T6 | 新增 RFC-483 用例；调用两个计数函数的用例改传绑定与查看者；`rfc395-a7-owner-queries` 改取 composition；字面量扫描找出的文本断言随改动改写                           | design §4 |
| RFC-483-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5 |

## 验收清单

- [x] AC-1 task-execution 的 public 不导出三个片段；collaboration 不从 task-execution 取它们；徽标读模型经绑定取得
- [x] AC-2 查看者判定在 application，读模型端口只有 DTO 签名；路由操作经 application 的徽标用例计数
- [x] AC-3 `public-surface-deviations` 65 → 57 并收紧到实测；跨 context 内部文件对、越 DAG 文件对与表归属账本不变
- [x] AC-4 两条徽标仍各发一条语句、`rfc311` 对拍通过；受影响用例全部通过；exact SHA CI 全绿（环境性红格如实记录：后端 ubuntu 5/44 片
      撞作业时限、macOS e2e 3/4 片一条撞 Playwright 动作时限，两格的红都不由本 RFC 的改动引起，以后继提交的 CI 为证，见 §CI）

## 集中验证（2026-11-11，候选基于 `fb469ce00`）

本机全程高负载（10 核；采样到的 1 分钟负载 14～63，主要是本机其他进程：Docker 虚拟机、fseventsd 与其他 bun 进程）。验证在候选导出仓库里跑（HEAD 的树加候选路径，提交后运行；修复后
重新同步，核对与 HEAD 加候选逐字相同）；对照导出仓库与 HEAD 相同（`fb469ce00` 只改文档）。验证期间 `origin/main` 未前进（一直是 `fb469ce00`）。开发期按
RFC-482 的做法用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言：真实用例里「HEAD 命中、候选不命中」的 8 条逐条核对，都不是对
改动文件的断言（用例自己的负对照字符串与 import、旧管线的对拍代码、RFC-483 用例自己的反向断言）；三份钉 sha256 的 fixture 不含改动的
文件。集中验证查出本 RFC 的一处问题，已修复并复验：

1. **RFC-483 用例自己的判据**：读模型端口「不出现 `SQL`」的文本检查把文件头注释里的「single SQL statements」也算进去，首批即红；改为对
   去掉注释后的打印结果检查，并加一条签名的正对照。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 23 个 TS 文件），promises 规则集对改动的
  9 个源码文件无告警；改动的 TS 与 RFC-483 三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；`STATE.md` 等不跑
  prettier）。
- **RFC-483 用例**：默认 5 秒、`--randomize` 下全过（两种 provider 同进程 8 / 8）；对 HEAD 的代码，5 条结构用例红 4 条（只判 fixture 的负对照
  两边都绿；查看者判定与行为用例依赖本 RFC 新增的模块，不在 HEAD 上跑）。
- **首批**（`tests/architecture/` 全部、`tests/` 里读 `src/` 文本的用例与本 RFC 改动的用例，245 个文件）：240 个通过；1 个是上面那处（改后
  复跑通过）；其余 4 个撞用例自带的时限（`rfc376-report`、`rfc400`、`clarify-review-combination-scenarios`、`rfc294-architecture-preflight`）。
  preflight 的两本账在同一份语料上直接调判据：类型偏差 57 = 57、capability 18 = 18，没有 stale 与未登记。
- **全量 SQLite**（导出仓库逐文件跑：每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  6 个 worker）：2,927 个文件、2,906 个通过。其余 21 个都不归本 RFC：
  - 发布账本一条（`rfc321-repository-publication-ratchet`）是导出仓库没有真实历史，与 RFC-485 相同；真实仓库 10 / 10。
  - 18 个撞用例自带的时限或内部等待，在只放宽时限常量的副本上全部跑完通过（3 个 worker；两个 `rfc363-*-process-recovery` 照 RFC-482 另加
    检查点的轮询兜底；preflight 的副本 14 条全过）。
  - `rfc370-execution-effect` 的两条：副本里一条通过，另一条放宽到 120 秒仍撞线。它的 `waitForFile` 只在目录事件里读标记文件，与 rfc363
    同形（`docs/dev-gotchas.md` 补记）；加 250 毫秒轮询的副本在 PostgreSQL lane 的并发负载下连跑 3 轮都是 13 / 13，原文件单独跑 13 / 13。
    本 RFC 改到的文件都不在它的 import 闭包里。
  - `rfc310-digital-employee-system-mock-e2e`：全量与副本批次里两次红在 system-mock 网关的 seed 请求上（`ECONNRESET`，没走到断言），单独跑
    在候选与 HEAD 对照上都 2 / 2。它不调两个徽标计数，import 闭包里本 RFC 改到的只有一个纯类型文件与两处 re-export。记入
    `docs/audit-backlog.md`，机制未证实。
- **PostgreSQL**：本 RFC 不改 SQL 与持久化；以 CI 的双引擎分片为证据。另把本 RFC 改写或新增的双引擎用例、经路由操作或 pending-count 端点
  计数的双引擎用例共 22 个文件接 PostgreSQL 跑（两种 provider 同进程、`--randomize`、单条 60 秒；3 个 worker）：21 个文件 304 条全过
  （PostgreSQL 一侧 144 条）。`rfc359-w6-t26-postgresql-plan-audit` 的 `beforeAll`（600 秒）在铺 10,000 条任务的语料时到点：夹具逐行先查
  再插，几万次往返落在本机 Docker 里的库上，库一侧始终在等客户端；单独再跑与 HEAD 对照单独跑都同样到点（609.7 s / 611.7 s）。它的探针
  （任务目录、仓库缓存、missions、overview、工作组 pending-count、事件归档）不含两条徽标计数，import 闭包里本 RFC 改到的只有一个纯类型
  文件与两处 re-export；这一条以 CI 为证据。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选的提交 vs HEAD 的代码出的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等，
  门里只有 `public-surface-deviations` 65 → 57 一项变化；public surface task-execution 229 → 226（三个片段），collaboration 40 不变；未消费 91
  不变（两个模块为 0）；跨 context import 7,648 → 7,646：撤掉 6 条（collaboration 取 task-execution `public/queries` 的片段 5 条、澄清文件
  取 `@/auth/actor` 类型 1 条），新增 4 条（bootstrap 取 task-execution composition 3 条、绑定文件取 drizzle 类型 1 条）；mutation 入口 2,332、
  越 DAG 的 offered 文件对 47、跨 context 内部文件对 43 不变。
- **最终候选**：导出仓库与 HEAD 加 31 个候选路径逐字相同（12,149 个文件逐字节比对），临时副本已删。文档对账与读 guard-manifest 的 16 个
  用例 167 条（两种 provider 同进程、默认 5 秒、`--randomize`，含 3 个 rfc317 守卫账本用例）166 条通过；`rfc128-p5-a-pre-refactor-net` 的
  `[postgresql]` 一条在负载下用了 7.2 秒、撞默认 5 秒，按 PostgreSQL lane 的单条 60 秒再跑 3 / 3（那条 4.4 秒；它不调两个徽标计数）。候选 2
  之后只同步了文档，代码与用例的结果沿用，架构报告不变。

## CI（AC-4）

- `8f7463f57`：exact SHA 主 CI run 43141424266 的 70 个 job 里 67 个通过（run 结论 cancelled，「CI required」随之红）；同 SHA 的
  windows-platform run 43141424278 通过。两格没过，都不归本 RFC：
  - `Backend tests (ubuntu-latest shard 5/44)` 撞作业 15 分钟上限被取消。这一片与父提交 `fb469ce00` 的同一片是同样的 11 个
    release-upgrade-matrix 文件（父提交上每个约 47 秒、8.6 分钟跑完，与 `.github/backend-test-timings.json` 记的 46～49 秒相符）；这次每个
    约 2.7 分钟，跑完 5 个就到点。矩阵用例不调两条徽标计数，新增的用例文件也没进这一片。
  - `Playwright e2e (macos-latest shard 3/4)` 139 条通过、1 条红：`rfc372-recorded-mindmap.spec.ts:154` 两次尝试都撞 Playwright 15 秒的
    动作时限（首轮 `fill`、重试 `click`，元素都已解析、可见且稳定；同一时段 daemon 日志 7 次 `event loop stalled`，1.1～1.8 秒）。外壳的
    收件箱按钮会轮询两条 pending-count，同一分片其余 139 条与其余 10 个 e2e 分片都照常通过；这条 spec 不读徽标，RFC-444 的运行里撞过同样
    的点击超时（`docs/audit-backlog.md` 第九条）。父提交同一分片通过。

  未重跑；内容不变的后继提交（本 RFC 的 Done 文档提交）的 CI 作后继证据，结果记在下一条目。

- 后继证据：`f6a7fadea`（本 RFC 的 Done 文档提交，`8f7463f57` 的直接后继，只改 6 个文档文件）exact SHA 主 CI run 43146287814 的 70 个
  job 全部通过，含上面两格（后端 ubuntu 5/44 片 9.1 分钟、macOS e2e 3/4 片 4.7 分钟）与 real PostgreSQL。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS：

- 谓词同源：bootstrap 交给绑定的三个成员与此前 `public/queries` 转出的是同一函数，读模型的两条语句与条件次序逐字不变（只把函数名前加
  `taskScope.`），往返数不变。
- 查看者判定：`humanGateBadgeViewer` 对没有 actor 或带 `tasks:read:all` 的给 all-tasks，其余给 task-member；评审计数原来在「actor 存在且
  没有 `tasks:read:all`」时收窄，澄清计数原来以 `canReadAllTasks` 选 includeMissing 与是否加可见性——两边与 all-tasks / task-member 一一
  对应，评审 task-member 分支里可见性的 `canReadAllTasks` 原来也恒为 false。
- 路由：两个 `countPending` 改调 application 的徽标用例，读模型的两个方法照旧在调用时懒加载 `review.ts` / `clarifyRounds.ts`，传的是路由
  操作手里的同一个 db 与绑定。
- 账本：`counts.json` 60 项，`reason` 都含与 `max` 相同的 `max=N`；`PUBLIC_SURFACE_DEBT` 销 8 条，按 preflight 的语料核对精确相等；
  guard-manifest 新增一条的字段取自 census 的实测，改到的一条只刷新行数。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-483 评审与澄清徽标的联合投影归 collaboration 读模型、task-execution 的三个 SQL 条件片段撤出 public（RFC-294 S9 第五步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
