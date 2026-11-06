# RFC-453 实施计划

**前置**：RFC-452 落地（`4f0ede4c5`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                   | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------ | --------- |
| RFC-453-T1 | 新模块 workspace-insight：32 个文件按 domain / engine / application / infrastructure 落位（含四处拆分） | design §1 |
| RFC-453-T2 | code-capability 的 code-review 产物存储迁入 workspace-insight；删 code-capability `public/participants`  | design §1 |
| RFC-453-T3 | source-control 收回快照摘要与类声明索引；类索引语言判定改用 shared 的表（shared 导出表）                 | design §3 |
| RFC-453-T4 | `repoLabels` 并入 shared；`reviewRoundStart` 迁入 task-execution 并经 `public/queries` 导出比较器       | design §1 |
| RFC-453-T5 | 深度索引端口与装配；用例读依赖改必填；路由合同 `TaskWorkspaceInsight` 与装配；路由、HTTP 装配与装配根 | design §2、§4 |
| RFC-453-T6 | 用例 import、直调 helper、随迁文本锁、账本与清单、guard-manifest；新增 RFC-453 用例                      | design §5 |
| RFC-453-T7 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                    | design §7 |
| RFC-453-T8 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W4 B / D 路由退出条件、E5）                     | —         |

## 验收清单

- [x] AC-1 旧文件删除、零引用；`routes/` → `services/` 为 0；source-control 不取 workspace-insight；平台 → 模块仍为 0
- [x] AC-2 架构计数不升（off-DAG 值边 0、值环 0、application 直接副作用文件不增、跨 context 内部文件对不增）；`R1` / `R2` 不增
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `05b746aa4`）

本机全程高负载（负载 40～100，主要来自本机的虚拟机容器、FSEvents 与三个残留的空转 mock MCP 进程）。验证都在候选导出仓库里跑（`05b746aa4`
的 `git archive` 加候选路径，提交后运行）；集中验证中的修复同步进导出仓库后，核对 184 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc`（backend、shared）0 错；eslint `--max-warnings 0`、promises 配置与 e2e 配置无告警；改动的 TS、e2e 与 workflow 已按
  prettier 格式化；`guard-manifest.json` 刷新受影响守卫的行数。
- **本 RFC 的问题，已修**（全量 SQLite 与第一条 PostgreSQL lane 都查出）：
  - `rfc317-module-boundary` 的 `R2` 两例：迁入 domain 的 `languages.ts` 带着原 `resolveLang` 的 `extname`，而 `node:path` 是 domain 禁包
    （census 的 `DOMAIN_FORBIDDEN_PACKAGES`），账本多出一条、「`R2` 债务全在 application」随之失败（tsc / eslint 看不见）。`resolveLang`
    改用纯字符串取扩展名，新用例锁它与原 posix `extname` 在 19 个路径上逐例相同（目录名带点、点文件、尾随斜杠、`..`、大小写、多点名）；
    `docs/dev-gotchas.md` 记下；
  - `rfc370-v16-code-review-services` 的路由装配锁仍按已删除的依赖 `codeReview` 断言（缺它不再报错）。改为缺 `workspaceInsight` /
    `changeNarrativeAccess` 各自报 `task-workspace-insight-not-composed` / `task-change-narrative-not-composed`。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4604～5357 s 全部跑完，合计 23404 pass / 127 skip /
  50 fail，另有 35 条测试间未处理错误。46 条是超时（19 个文件；45 条撞默认 5 秒，RFC-363 的 5004 项目录分页一例撞自带的 30 秒），未处理
  错误都出在这些文件里，是超时用例被拆除后仍在跑的异步尾巴；另 4 条是上面两处本 RFC 的问题（3 条）与导出仓库只有候选提交所致的 `rfc321`。
  - 修复同步后，在最终内容上复跑受影响面 199 个文件（全部架构测试 139 个；workspace-insight 一族、它的消费方与路由 / 装配用例 64 个，
    两份清单重叠 4 个；30 秒时限）：1906 pass / 4 skip / 0 fail。
  - 19 个超时文件逐个单独复跑（30 秒时限）：17 个全过；RFC-363 的分页一例（自带 30 秒）与 RFC-167 dw-confirm 的 `approve` 一例（自带
    5 秒 `settleTask` 等待）仍到点——对照：同一时刻在 RFC-452 的导出仓库里跑同一文件，失败的是同一例（31.1 s 与 31.0 s；5.8 s 与 5.9 s），
    其余用例两边都过（RFC-452 集中验证时也是这两例）。
- **导出仓库接 PostgreSQL 真库**：
  - 第一条 lane 396 个文件（全部架构测试；改动的用例；提及这一族、修订内容、产物存储、复审轮次、repo key、`mountTaskRoutes`、HTTP 装配
    与各装配根的用例；RFC-440～453 用例）：4015 pass，40 个文件失败——上面两处本 RFC 的问题、`rfc321`，其余 37 个在 PostgreSQL 一侧超时
    （`tasks` 58 例与 `repos` 8 例是钩子超时：测试应用在 PostgreSQL 上启动超过默认 5 秒；`rfc370-m3` 的恢复用例跑满 120 秒时连接池已关闭）；
  - 修复后复跑 41 个文件（失败的 40 个加 RFC-453 用例；30 秒时限）：734 pass，除 `rfc321` 外 37 个文件全过（含 `tasks` 与 `repos` 的
    路由用例、`rfc370-m3` 的恢复、RFC-317 与 RFC-370 V16 两处修复、RFC-453 用例）；RFC-395 的三个文件在自带时限上仍到点（V2 混合集成一例
    20 秒；V3 托管作业的 70 秒一例与紧随其后的一例；V3 激活验证两例 35 秒）——对照：同一时刻在 RFC-452 的导出仓库里跑同一文件，三个
    文件失败的都是同一组用例（22.2 s 与 23.1 s；70.6 s 与 70.6 s；35.3 s 与 35.3 s、35.5 s 与 35.5 s），其余用例两边都过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库）：SQLite 17 个阶段全部符合预期。PostgreSQL 一侧第一次与
  上面的复跑同时跑（负载 85～100），未变异的基线阶段有两例撞默认 5 秒，于是变异阶段没跑；复跑结束、负载降下来后单独重跑 PostgreSQL，
  17 个阶段全部符合预期。两次运行前后 127 个受保护源文件的哈希一致。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数）：`services/` 187 → 153 个文件；import `services/` 的路由
  1 → 0；模块里 import `services/` 的文件 134 → 133；`R1-inbound-module-internals` 148、`R2-outbound-module-to-legacy` 33 不变（账本与实测
  相等）；架构 counts 只有 `legacy-horizontal-files` 308 → 274 与 `legacy-service-implementations` 152 → 118 变化（各 −34），off-DAG 值边 0、
  值环 0、平台 → 模块 0、application 直接副作用文件 2、跨 context 内部文件对 48、composition 禁取文件 14、不可达生产文件 27、public surface
  偏差 102 都不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 整体迁移的 33 个文件与原文件逐个比对（去掉 import / re-export 语句后逐行 diff）：27 个逐字相同；其余 6 个只差设计里写明的改动——用例
  读依赖的产物存储与深度索引改必填、深度索引经端口调用（`deep.computeDeepStructuralDiff` / `deep.indexCache()`）、查询类型与结果类型移到
  端口、叙述的成员门移到路由（触发函数原第一句）、`ScipIndexCache implements ScipIndexAnswers`；
- 拆开或并入别处的 10 个文件（语法表、类索引、索引器登记、索引运行、深度服务、产物存储 helper、索引缓存的结果类型、code-capability 的
  既有资源端口与 `public/participants`、`repoLabels`）：原文件除注释外每一行都落在去向文件里，例外只有设计写明的几处——`resolveLang` 改用纯字符串取扩展名（见上）、深度
  结构 diff 没给快照摘要时改经 source-control 本机修订内容的 `snapshotDigest()`（`bind(worktreePath)` 后就是同一个
  `worktreeSnapshotDigest(worktreePath)`）、只被一个用例用的 `writeStoredDiff` / `readStoredDiff` 删除；
- 路由 7 个端点与原实现等价：参数校验、权限门、404、深度配置与叙述 runtime 的配置读取都没动，只把调用点换成合同方法；叙述的触发
  仍是「读配置 → 成员门 → 触发」的顺序；
- HTTP 装配给合同的工作区查询、修订内容、产物存储、任务工作树定位、调用图读模型与叙述的 runtime 解析 / 系统代理，与原来路由拿到的是
  同一批对象；合同的 7 个方法逐一落到原调用的参数上（结构 diff 与符号 / 代码智能用同一组读依赖，文件正文用工作树定位与修订内容，调用
  目标用调用图读模型与修订内容，叙述状态用选定的产物存储）；
- 其余装配根只改 import 来源（同一组函数）；
- 集中验证查出的两处问题（见上）已修并复验。

## CI（AC-4）

`6fb219f5b`：exact SHA 主 CI run 42156306149 首轮全绿（70 个 job）；windows-platform run 42156306183（workflow 自身、装配根、
source-control 的本机修订内容与叙述用例等触发清单里的文件）与同 SHA 的 maintenance-soak 夜间 run 42156306405（`daemonApplication.ts`）
随本提交触发并全绿。

## PR / 提交

单个提交：`refactor(backend): RFC-453 workspace-insight 一族归新模块 workspace-insight（RFC-294 W4 B/D、E5）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
