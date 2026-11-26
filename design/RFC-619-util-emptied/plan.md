# RFC-619 实施计划

依赖：RFC-617、RFC-618（同一批账本文件，按序发布）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-619-T1 迁移**：三个文件归位，`util/` 删除，读者改指，source-control 的转出删除（design §1）。
- **RFC-619-T2 构建与锁**：构建入口、`BINARY_ENTRIES`、源码锁、`rfc575` 余量清单、owner 表、Windows 路径过滤与计数（design §1）。
- **RFC-619-T3 门与文档**：新增 RFC-619 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W9-D 注记（design §2）。
- **RFC-619-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；凭据助手入口单独打包；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-619-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `util/` 不在，三个文件在新位置，没有读者取旧路径
- [x] AC-2 构建入口与门一致；源码运行时凭据助手命令指向存在的 `src/main.ts`
- [x] AC-3 计数 47 → 45；新增 RFC-619 用例并登记
- [x] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `4a39ec7be`（RFC-618）+ 只含本 RFC 的路径（34 条）；`bootstrap/daemonApplication.ts` 按「HEAD + 本 RFC 的一行 import」写入（见下“并发”）。

- **静态**：backend `tsc --noEmit` 0 错；改动的 TS 文件与 `scripts/build-binary.ts` 的 eslint（`--max-warnings=0`，另跑 promises 配置）0；prettier 全过；凭据助手入口
  单独 `bun build --target=bun --minify` 成功（2.75 KB）。
- **用例第一轮**（改动路径的传递闭包 + 名字 + 全部架构与文档读者，693 个文件）：
  - OIDC 失败页起初放进 identity-access 的 `inbound/http/`，`rfc317-module-boundary`（R1：legacy 层不得取模块内部）、`rfc305` 的 identity-access 边账、`rfc439`
    三处红——改为放到唯一读者 `routes/oidc-auth.ts` 旁边（design §0 裁定二）。
  - `rfc575` 读 `util/` 目录清单，目录删除后 `readdirSync` 抛错；改为目录不在时按空清单计（本 RFC 自己的缺陷，`tsc` 先报了只读数组的类型错）。
  - RFC-619 用例 ① 起初断言 `util/` 目录本身不在，导出里删文件后留下了空目录；git 不跟踪空目录，改为断言 `util/` 下没有源码文件（导出工具也改为随删除清掉空目录）。
  - `rfc167-dynamic-workflow-engine` 一条在机器负载 ~70 时红（任务在等待窗口内没走到 `failed`）；同一时刻在对照导出（不含本 RFC）里同样红，负载回落后第二轮通过——
    与本 RFC 无关。`rfc321` 红：导出的本地 git 没有发布历史，环境性。
- **用例第二轮**（第一轮之后的改动 + 全部架构与文档读者，483 个文件）：除 `rfc321`（同上）外全过。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `legacy-horizontal-files` 47 → 45；跨 context import 边 −1（source-control 组合层的转出删除）。
- **变异**（4 / 4 被抓）：`util/` 下放回一跳转出（RFC-619 ①、`rfc376`、`rfc575` 红）；用例经旧路径取 OIDC 失败页（RFC-619 ①②）；构建脚本的凭据助手入口改回
  `util/`（RFC-619 ③）；租约的 `main.ts` 相对路径少两层（RFC-619 ④）。每次恢复后导出干净。
- **并发**：RFC-616 在第二次刷新导出之后往共享工作树里的 `bootstrap/daemonApplication.ts` 加了过程度量的字段（引用它尚未提交的 `daemonHttpComposition.ts` 改动）。
  验证用的导出里该文件是「HEAD + 本 RFC 的一行 import」，提交时在发布锁里按「`origin/main` 上的该文件 + 同一行替换」重建、与导出逐字比对后提交，不带入、也不改动它的在制品；
  同步 guard-manifest 行数时别人改着的 `rfc371-v2-observation-boundaries` 也被算出了新值，已改回已提交的值（同步工具改为只认本次路径）。

## CI（AC-4）

- 实现提交 `2b4eee088`：CI run 45884250904 全绿（70 / 70）。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 三个迁移文件与 HEAD 原文逐行对比：只有租约在源码运行时找 `main.ts` 的那一行不同（`'..'` → `'..', '..', '..'`），由 RFC-619 用例 ④ 与变异 m4 锁住。
- 单二进制：构建脚本的入口与 `BINARY_ENTRIES` 一致（RFC-619 用例 ③），入口单独打包成功；内嵌模式走 `process.execPath` 的隐藏子命令，与路径无关。
- source-control 组合层删去的转出没有任何读者（bootstrap 与用例都直取租约文件）。
- CI 触发面：Windows 路径过滤里的两条旧字面量删去后，新位置被同一块的 `platform/execution/local/**` 覆盖。
- 结论：功能面无遗留问题；集中验证中发现的问题均已修并复验。

## PR / 提交

一个提交：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
