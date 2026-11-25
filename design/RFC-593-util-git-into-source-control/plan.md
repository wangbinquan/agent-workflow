# RFC-593 实施计划

依赖：RFC-592。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-593-T1 搬迁**：`util/git.ts` 整份迁入 `SC/infrastructure/local/gitRepository.ts`，四段纯逻辑 / 数据进 `SC/domain/gitRepositoryModel.ts`（design §1）。
- **RFC-593-T2 对外**：`SC/public/participants` 转出 2 个名字，task-execution 与装配根改从那里取；延后准备要的两步进 task-execution 自有的准备绑定，
  source-control 的绑定实现给出（design §1）。
- **RFC-593-T3 门、用例与文档**：归属表、`counts.json`、读源码的用例；新增 RFC-593 用例并登记（design §2）。
- **RFC-593-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-593-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `util/git.ts` 不存在、没有说明符再解析到它；新文件与它逐字相同（只差文件头说明与迁进 domain 的四段）
- [x] AC-2 source-control 之外只经 `public/participants`（两个名字）或 task-execution 自有的准备绑定取；application 层不取 infrastructure；git 相关用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 55 → 54；`public-surface-deviations` 28 → 27；`module-layer-violations` 0；未消费 public 符号 0；DAG 之外的边与跨
      context 内部文件对不增加；新增 RFC-593 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 的一格红是本人缺陷，已由补正修复（见「CI」）

## 集中验证

基于 `12d8cfb6c`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS、RFC 文档、JSON 账本与 workflow prettier 通过。
- **逐字比对**（脚本）：`domain/gitRepositoryModel.ts` 里的四段与 HEAD 的 `util/git.ts` 逐字相同；`gitRepository.ts` 与“HEAD 的 `util/git.ts` 减去这四段”
  相比只差文件头说明、对 domain 的一条 import 与删段留下的空行。搬迁脚本改写了 4 个用例里字符串夹具中的说明符，已逐处还原（`rfc370-v20` 那条
  “编排不取 git 实现”的否定断言按新路径保留，意图不变）。
- **设计在集中验证里改了两处（本人缺陷，已修复并复验）**：
  - 第一轮候选导出（403 个用例文件、3642 条）红 6 条：source-control 的 5 个 application 文件原先取 `util/git` 的四段纯逻辑 / 数据，搬进
    infrastructure 之后成了 application → infrastructure（`rfc294-review-module-layer-rules`、`rfc376` 的分层违规与计数、`rfc511` 的冲突合并锁）；
    task-execution 的延后准备直接取 source-control 的 public（违反 RFC-447 / RFC-478 的规则）。改为四段进 `domain/gitRepositoryModel.ts`、延后准备要的
    两步进 task-execution 自有的准备绑定（source-control 的绑定实现给出）。
  - 第一轮候选报告还显示：public 面若转出带回调的 registry 锁与带平台 logger 类型的 `reclaimStaleRefLocks`，`public-surface-deviations` 会 28 → 29；
    上面的改法让两者都不进 public，该计数反而 28 → 27（见架构报告）。
  - 第二轮候选导出（409 个用例文件、3725 条）红 2 条：`rfc377` 的叶子锁与 RFC-593 用例都没把本模块 domain 当作合法的下层，已补。复跑这两个与读
    guard-manifest 的全部用例（25 个文件）全部通过；`rfc321`（要 git 历史）在主树里 10 / 10。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：六种都被认出——`util/git.ts` 以一跳转出重新出现（RFC-593 用例与 `rfc376-structural-guards` 都红）；
  task-execution 直接取新文件；`public/participants` 少转出一个名字；新文件取别的模块；延后准备重新直接取 source-control（`rfc478` 红）；source-control
  的 application 文件重新取 infrastructure（`rfc294-review-module-layer-rules` 与 `rfc376` 的分层计数都红）。复原后导出无残留。
- **架构报告**（候选对照 `12d8cfb6c`）：60 个计数里只有两项变了、都在下降——`legacy-horizontal-files` 55 → 54，`public-surface-deviations` 28 → 27（上限随之
  收紧；少的那条是 source-control 的 public 类型不再取 legacy 的 `WorktreeCleanupProvenance`）；`module-layer-violations` 0；未消费 public 符号 0；public 面
  802 → 804（两个转出）；跨 context import 7666 → 7603（source-control 自己的 git 取用不再是模块 → legacy）。

## CI（AC-4）

- `f48df41c2`（实现）：主 CI 第 16/44 片红 1 条——`rfc310-pr7-no-merge-capability-scan` 的“git push 参数不带 force 形态”。归因：**本人缺陷**。这条扫描以
  development-automation、integration、source-control 三个模块为根逐行找“含 `push` 且含 force 形态”的行；`util/git.ts` 原在根外，迁进 source-control 后
  `removeWorktree` 的 `args.push('--force')`（`git worktree remove --force`，不是 push）被它认作强推。集中验证按改动路径与名字选用例，这条按模块根目录走
  文件的扫描选不到（`docs/dev-gotchas.md` 已补一句）。补正（下一提交）：照 RFC-450 排除通用执行器目录的做法，把迁入的 git 原语文件排除在扫描之外，并加
  一条锁：该文件不出现 `'push'` 子命令（往里加 push 就得重新纳入扫描）；变异验证（往该文件加一行 push 参数）会红。
- 同一次运行（run 45678070550）其余 68 个 job 成功（不算汇总它的 CI required），同 SHA 的 windows-platform run 45678070669 与
  git-protocols-e2e run 45678070684 通过。补正 `4e03ecce4` 的 run 45685757907 70 / 70 全绿（含第 16/44 片的这条扫描），作后继证据。没有改测试、没有重跑。
  2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **逐字**：仓库语义的代码一行未改（四段纯逻辑 / 数据换了文件，内容逐字）。
2. **延后准备**：重试回收的两步——持锁 `worktree prune` 与陈旧 ref 锁清理——行为不变：绑定实现里的 prune 与原调用处同一条命令、同一把锁、同样不检查
   结果；ref 锁清理同一函数、同样的参数与日志。
3. **对外的两个名字**：`rollbackToSnapshot`、`worktreeFilesChanged` 原样转出，task-execution 的节点回滚、规范差异与装配根（评审门回滚）只换了 import
   的来源。
4. **分层**：source-control 的 application 层只从本模块 domain 取那四段，不再取 infrastructure。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
