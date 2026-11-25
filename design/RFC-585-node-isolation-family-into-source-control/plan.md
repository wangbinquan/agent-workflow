# RFC-585 实施计划

依赖：RFC-584。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-585-T1 搬迁**：四个文件迁入 `SC/infrastructure/local/`，两个错误类移到 `SC/domain/isolationErrors.ts` 并由 `public/types` 交出（design §1）。
- **RFC-585-T2 task-execution**：视图删去本机退路并改用端口与 public 类型，诊断改取 public 的错误类（design §2）。
- **RFC-585-T3 用例与账本**：用例辅助与改用它的用例、钉着旧路径的用例、账本、workflow 与 JSON；新增 RFC-585 用例并登记（design §3）。
- **RFC-585-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例（隔离、快照、合并、冲突、子模块、清理与重放）；读已提交源码的用例在
  候选导出里跑；架构报告对照；变异验证。
- **RFC-585-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四个旧路径不存在、没有说明符再解析到它们；四个文件只改 import（`nodeIsolation.ts` 另改取 domain 的两个错误类）
- [x] AC-2 task-execution 不取 source-control 的 infrastructure；视图没有本机退路；隔离相关用例通过
- [x] AC-3 两个上限按实测收紧；未消费 public 符号保持 0；public 类型偏差不升；DAG 之外的边与跨 context 内部文件对不增加；新增 RFC-585 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`c17e1e7fe`，主 CI 70 / 70）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `11255a537` 加本 RFC 的路径，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希相同），对照是同一
HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md`、RFC-583 / RFC-584 的收口记录与 RFC 索引）；代码、用例、工作流与账本逐个文件
比对，与候选相同。

- **生产句柄只经作用域**：按语法树查遍生产源码，创建隔离句柄的只有 source-control 的 `localIsolationWorkspace.ts`（`createNodeIso`、
  `rebuildIsoHandle`）与两个托管实现，task-execution 只在 `workspaceView` 里把作用域登记到句柄上；引擎里的 `as IsoHandle` 都是对这些句柄的收窄。
- **本人缺陷（已修复并复验）**：选用例里 `rfc370-isolation-cleanup-context` 两条红——它种的是一个字面量句柄（没有作用域），再经
  `bindIsolationCleanup()` 清理；开发时只按“用 `createNodeIso` 造句柄”找要改用辅助的用例，漏了这一个。改用 `nativeIsolationCleanup()`（它把清理
  回执的选择照旧交给 task-execution 的绑定，这条用例测的正是这个），复跑 3 / 3。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 69 个 TS 文件无告警，生产文件（16 个）另过 promises 配置；
  prettier：改动的代码、JSON、workflow 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 288 个用例文件（隔离、快照、合并、冲突、子模块、清理、重放与取这四个文件的全部用例），修后 2358 条
  全部通过；其中改用辅助的十一个用例照旧通过（`rfc130-node-isolation` 5 / 5、`rfc210-new-submodule-topology` 10 / 10、`rfc188-isolated-agent-run`
  6 / 6 等）。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本、workflow 与 JSON 的用例与
  钉着本次改动位置的用例（并上 RFC-576～RFC-584 的清单），共 361 个文件：3583 条通过，1 条红是 `rfc321-repository-publication-ratchet` 的“账本的
  记录提交可从 HEAD 到达”——导出仓库只有一个提交、没有原仓库的历史，这一条在导出里本来就过不了；它在主树里跑 10 / 10（含账本与实际
  `git fetch` 调用点逐条相等，`gitSubmodule.ts` 的新路径按序登记）。其中 `rfc376-structural-guards` 221 / 221、RFC-585 用例 9 / 9、`rfc457` 8 / 8、
  `rfc377` 9 / 9、`rfc395-checkpoint-boundary` 5 / 5、`ci-workflow-path-filters` 3 / 3、`rfc402-task-execution-kernel` 5 / 5、
  `rfc413-wrapper-workspace-merge-recovery` 3 / 3、`route-error-code-coverage` 4 / 4。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：六种都被认出——旧的 platform 路径上重新出现一跳转出（RFC-585 用例 ① 与
  `rfc376-structural-guards` 的 platform → modules 门同红）；测试辅助文件用 import 类型取旧的 `services/gitSubmodule`（用例 ①）；task-execution 又取
  source-control 的 infrastructure（用例 ② 与 `rfc376-structural-guards` 的跨 context 内部文件对同红）；隔离视图又调用本机函数（用例 ②）；platform
  又取 `services/`（用例 ③ 与 `rfc457` 同红）；错误类在 domain 之外又声明一次（用例 ④）。m5 的锚点起初按 `fsReclaim.ts` 里不存在的 import 写，
  改正后重跑。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 64 → 63 与 `legacy-service-implementations` 4 → 3 变了；未消费 public
  符号保持 0；public 面 855 → 857（两个错误类，由 task-execution 消费）；public 类型偏差 28 不变；不可达生产文件 8、跨 context 内部文件对 6、DAG 之外
  的已提供文件对 2、platform → modules 0 都与对照相同。跨 context import 7633 → 7643：task-execution → source-control 的 offered-consumption 值边
  15 → 17（两个错误类）；task-execution → legacy 的值边 720 → 714、类型边 582 → 581（不再取原 platform 文件里的本机函数）；source-control → legacy
  的值边 306 → 316、类型边 114 → 121 与 legacy → source-control 的类型边 46 → 44 都是迁入的四个文件对 `util/git`、`services/mergeAgent`、`@/config`
  与 platform 的取用改记到 source-control 名下（报告把这一对里的 platform 也记在 legacy 名下）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `c17e1e7fe`（实现）：exact SHA 主 CI run 45613842620 的 70 个 job 全部成功——全部后端分片、真实 PostgreSQL、前端、三个平台的构建与检查、
  ubuntu / windows / macOS 的全部 e2e 分片；按路径触发的 windows-platform（run 45613842407）与 git-protocols-e2e（run 45613842465）通过。2026-11-25
  转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **隔离行为不变**：四个文件逐字迁移（两个错误类逐字移到 domain，`instanceof` 与报错文本不变）；source-control 的本机与托管实现照旧经它们工作；
  隔离、快照、合并、冲突、子模块池、清理与重放的用例全部通过。
- **task-execution 的视图**：对有作用域的句柄，四个入口的处理逐行不变（只删了“没有作用域就退回本机函数”的分支）；签名改由 task-execution 的端口与
  source-control 的作用域方法类型给出，`tsc` 检查全部连接处。生产里没有不带作用域的句柄，删掉的分支只有用例在走，现在由用例辅助原样提供。
- **诊断**：执行诊断照旧按 `IsoWorkspaceBlockedError` 输出残留现场、按 `MergeAgentChildUnreapedError` 构造合并代理子进程未回收的错误，类是同一个。
- **钉着旧路径的地方都随改**：归属表一行、`counts.json` 两个上限、`rfc457` / `rfc395` / `ci-workflow-path-filters` 的清单、`git-protocols-e2e.yml` 的两份
  路径过滤、`repository-publication-call-sites.json` 的两处、读源码的用例；`rfc377`、`rfc402`、`rfc403` 里作为负对照的字面量路径不改（它们是判据的
  输入样例，不指向文件）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
