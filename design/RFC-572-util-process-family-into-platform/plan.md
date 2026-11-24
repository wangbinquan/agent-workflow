# RFC-572 实施计划

依赖：RFC-571。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-572-T1 搬迁与改指**：六个文件迁入 platform，读者与被迁文件自己的说明符改写（design §1、§2）。
- **RFC-572-T2 门、工作流、用例与文档**：归属表、`counts.json`、`windows-platform.yml`、钉着旧路径的用例与注释；新增 RFC-572 用例并登记
  guard-manifest（design §3）。
- **RFC-572-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-572-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 六个旧路径不存在、没有说明符再解析到它们；文件的可执行内容与原文件相同
- [x] AC-2 行为不变；Windows 平台工作流由这次提交触发并通过（run 45502183776）
- [x] AC-3 `legacy-horizontal-files` 上限 115 → 109；归属表删去登记过的行；新增 RFC-572 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准；Windows 上的行为本地验不了，以 windows-platform 工作流为准。用例
在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `7c9c778d4` 加本 RFC 的 131
个路径，含六个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷四处（已修复并复验）**，都是“钉着旧路径、而我的检索没有扫到”：① 两份已提交的账本——`architecture/commons-manifest.json` 把
  `platformExec`、`process` 登记为公共内核的文件，`commons-debt.json` 有三个指向 `util/process.ts` 的行号锚点。动手前我查过 `architecture/`，但那条
  命令里另一个不匹配的通配让 shell 在执行前就中止了，等于没查；`rfc317-architecture-ledgers` 与 `rfc473` 的“清单里的文件都在”在选集运行里红。
  ② `rfc356-process-tree-quiesce` 用分段参数拼路径（`readSource('util', 'process.ts')`），按 `util/process` 的文本检索扫不到。③ `rfc377` 的
  “`util/git` 是叶子”一条只放行 `@/util/` 与同目录的说明符，而 git 原语一直在用的 `platformExec`、`process` 现在在 platform 的执行目录：把这两个
  精确说明符加进放行名单并写明理由（它们自己仍是叶子，由 RFC-572 用例钉住依赖面），同目录的其他文件照旧算上层（补了负对照）；dependency-cruiser 的
  `no-util-to-upper` 本来就不含 platform。修完后按分段拼路径、全部 JSON / YAML / CJS 的写法又各搜了一遍，没有别的漏点。另有一处在集中验证前自己
  发现的：改写器是按正则找说明符的，把四个用例里**夹具字符串**中的一行也改了（`rfc494`～`rfc497` 的反例源码），对应的期望随之改成新说明符。
- **原样迁移**：`platformExec`、`windowsJobObject`、`spawnDiagnostics` 迁移前后逐字节相同；`process` 只差两个说明符与两处提到旧路径的注释，
  `daemonLock` 只差一处这样的注释，`archive` 只差一个说明符。其余生产代码的改动只有读者的 import 说明符（59 个文件，其中三个 application / 组合
  文件之外都是 infrastructure、bootstrap、`cli/`、platform 与 `util/git.ts`；个别文件因为说明符变长被 prettier 重新折行）与四处注释里的路径。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 117 个 TS 文件无告警，生产文件另过 promises 配置；
  prettier：改动的代码、工作流文件与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：选出 587 个用例文件——对六个迁移文件（新旧路径）与全部改动的用例选出 215 个，经夹具与测试
  助手补 34 个，再加上直接 import 那 59 个“只改了说明符”的生产文件的用例文件（与前两类去重后合计 587）。首轮 583 个通过，4 个红就是上面 ①～③；
  修完后重跑这 4 个、RFC-572 用例与读三份账本的用例共 33 个文件，全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部 142 个用例文件、`rfc317-*` / `rfc294-*`、读工作流与账本的用例与钉着
  本次改动位置的用例，共 187 个文件、1816 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-572 用例 7 / 7、
  `rfc294-architecture-preflight` 15 / 15、`rfc317-architecture-ledgers` 15 / 15、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc377-util-git-leaf-lock` 9 / 9、`rfc356-process-tree-quiesce` 12 / 12、
  `rfc473-execution-outcome-and-resource-sessions` 12 / 12、`root-test-entrypoint`（工作流守卫）24 / 24、`rfc284-microhelpers` 6 / 6、
  `rfc284-spawn-site-ratchet` 14 / 14、`rfc254-platform-surface-guard` 7 / 7、`rfc396-windows-flat-process-group` 3 / 3、
  `scheduler-audit-s15-sigterm-no-escalation-pid-unused` 7 / 7、`lock` 8 / 8。
- **变异验证**（候选导出仓库里，每种变异复原后导出仓库无改动、树哈希不变）：十一种变异都被认出——旧路径上重新出现一跳转出（RFC-572 用例 ① 与
  `rfc376-structural-guards` 同红）；生产文件重新取旧路径（用例 ①）；迁入的文件开始取模块（用例 ② 与 `rfc376-structural-guards` 同红）、少一个
  导出（用例 ③）、daemon 锁不再转出存活判断（用例 ③ 与 `scheduler-audit-s15` 同红）；工作流的 push 清单漏掉执行目录的通配、pull_request 清单
  重新出现旧路径（用例 ④）；drained-race 写法在别的文件重复（`rfc284-microhelpers` 红）；daemon 锁不再拒绝第二个持有者（`lock` 红）；git 原语取
  执行目录里两个叶子之外的文件（`rfc377` 红）；公共内核清单指回旧路径（`rfc317-architecture-ledgers` 与 `rfc473` 同红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，115 → 109（少的正是这六个文件）；public 面（989）、public
  类型偏差（32）、跨 context import 的条数（7528）与生产文件数不变；变更入口普查条数不变（2393，三条随文件换了路径）；模块级状态清单里五条随
  文件换了路径。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `cbbcf4692`（实现，父提交是 `7c9c778d4`）：exact SHA 主 CI run 45502183866 的 70 个 job 里 68 个成功；
  `Backend tests (ubuntu-latest shard 41/44)`（job 138828038086）失败，汇总格 `CI required` 随之不通过。同一提交按路径触发的另四个工作流全部通过：
  windows-platform（run 45502183776，AC-2 的 Windows 一项）、integration-opencode（run 45502184034）、git-protocols-e2e（run 45502183763）与
  visual-regression-nightly（run 45502184032）。
- **归因：本 RFC 引入，本会话修复**。那个分片里只有一条用例红——`rfc456-services-single-owner-placement` 的负对照拿 `cli/stop.ts` 当真实样本，
  把它“取 platform 的 import”整份列表钉成了只有 `controlListener` 一条；RFC-572 把 daemon 锁挪进同一目录后，这个文件多了一条 platform import，
  列表不再相等。它证的是“判据认得出真实文件里的别名 import”，与 `cli/stop.ts` 还取不取别的 platform 文件无关，改成断言列表里包含那一条。
- **本地为什么没查出来**：选集把 59 个“只改了 import 说明符”的生产文件按“谁直接 import 它”选用例，没有按“谁把它当源码读”选（按文件名做文本
  匹配会把选集撑到两千多个，收窄时把这一类一起收掉了）。这条用例不 import `cli/stop.ts`，只按路径读它的源码。主 CI 的全量运行里整个后端只有这一条
  红，所以没有第二处同类遗漏；教训写进 `docs/dev-gotchas.md`。
- 修正提交的 CI 结果见下一条提交的记录；本 RFC 在那之后转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **没有行为改动的落点**：六个文件的可执行内容不变（见上“原样迁移”）；59 个读者只改 import 说明符，逐文件看过 diff 里除 import 行、被 prettier 重新
  折行的 import 成员与四处注释之外没有别的行。这六个文件里没有按自身位置找资源的写法（`import.meta`、`__dirname`、`new URL`），换目录不影响运行。
- **依赖方向**：迁入的文件只取彼此、`util/log`、node 内置模块与 `bun:ffi`，不取模块；`util/git.ts` 改取 platform 执行目录里的两个叶子，
  dependency-cruiser 的 `no-util-to-upper` 不含 platform，`rfc377` 的叶子锁按两个精确说明符放行。
- **Windows 的 CI 触发面没有缩小**：工作流两份路径清单删去的三行，对应的文件现在落在两份清单里早就有的 `platform/execution/local/**` 通配之下；两份
  清单仍逐行相同（`root-test-entrypoint` 的既有守卫与 RFC-572 用例 ④）。
- **改动里涉及凭据与边界一带的文件只有 import 说明符一行**：source-control 的 `taskImageGitCredentials.ts`、runtime-management 的
  `workspaceBoundary.ts` 与 `claudeCode/boundary.ts` 各改一行 `platformExec` 的说明符，别的一个字没有动。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例、工作流一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
