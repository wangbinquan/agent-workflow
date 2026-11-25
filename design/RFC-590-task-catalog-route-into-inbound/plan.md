# RFC-590 实施计划

依赖：RFC-589。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-590-T1 搬迁与撤回**：绑定迁入 `TC/inbound/http/`；三个 public 符号撤回、`public/` 删掉（design §1）。
- **RFC-590-T2 连接**：composition 转出挂载函数，`server.ts` 改从那里取。
- **RFC-590-T3 门、用例与文档**：R3 新判据、归属表、`counts.json`、四处非空下限、钉着旧路径的用例；新增 RFC-590 用例并登记（design §2）。
- **RFC-590-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-590-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧路径不存在、没有说明符再解析到它；新绑定与原文件只差 import
- [x] AC-2 任务目录的路由用例通过
- [x] AC-3 task-catalog 没有 `public/`，R3 新判据通过且有负对照；`legacy-horizontal-files` 上限 56 → 55；未消费 public 符号 0；DAG 之外的边不增加；
      新增 RFC-590 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `24d4e0a9f`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint（15 个 TS 文件）与 promises 配置（6 个 `src` 文件）无告警；改动的 TS、RFC 文档与两个 JSON 账本 prettier 通过。
- **逐字比对**：新绑定与 `routes/taskCatalog.ts` 只差一行 import（`TaskCatalogQueries` 改从 `application/ports` 取）。
- **撤回**：三个符号的定义移进 `application/ports/taskCatalogQueries.ts`，模块内三个读者改指那里，`public/` 删掉；候选报告里 task-catalog 不再有 public
  条目，其余模块的未消费计数仍为 0。
- **候选导出**（候选已提交）：选出 280 个用例文件、2513 条全部通过——含 `rfc317-module-boundary`（R3 新判据与负对照）、四处改了下限的用例、
  `rfc376-structural-guards`、`rfc376-report`、`rfc294-review-offered-edge-dag` 与 RFC-590 用例。导出工具解出 HEAD 时留下了一个空的
  `task-catalog/public/` 目录（git 不追踪空目录，干净 checkout 里没有），跑用例前已删掉。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——旧路径上重新出现一跳转出（RFC-590 用例与 `rfc376-structural-guards` 都红）；
  task-catalog 重新长出一个 public 入口；装配根不再经 composition 取 task-catalog（两处 import 换成本地桩：`rfc317-module-boundary` 恰好红 R3 那一条、
  R1 不响——新判据单独认出了“public 为空、没人装配”的模块）；绑定取别的模块（RFC-590 用例与 `rfc294-review-offered-edge-dag` 都红）；`server.ts` 绕过
  composition 直接取绑定（R1 红）。复原后导出无残留。
- **架构报告**（候选对照 `24d4e0a9f`）：`legacy-horizontal-files` 56 → 55；`unconsumed-public-symbols-task-catalog` 随 public 面一起退出报告（`counts.json`
  同步删去，60 → 59 个计数），其余计数不变；public 面 805 → 802；跨 context import 7663 → 7667（绑定原来在 `routes/`、现在是模块 → legacy 的
  `@/auth/actor`、`@/routes/registry`）。

## CI（AC-4）

- `3f07d748a`（实现）：exact SHA 主 CI run 45657867610 的后端第 16/44 片红——`rfc317-runtime-spawn-capability-guard` 把“`routes/` 的文件加一个显式列入的应用
  文件”合计要求 `> 10`，RFC-590 把 `routes/` 缩到 9 个就红了。**本人缺陷**（RFC-590 引入；按名字选用例选不到它），已在 RFC-592 的提交里改为单独证明
  `routes/` 的枚举非空。转 Done 等 RFC-592 提交的 CI 作后继证据。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **绑定逐字**：两条路由（来源与列表）的处理逻辑、权限声明、错误码与响应一行未改；`server.ts` 的 `taskCatalog` 一步与挂载顺序不变。
2. **撤回**：三个符号只改定义的位置，运行时无变化；task-execution 与 digital-employee 对 `TaskCatalogSource` 的实现照旧经 `composition/required-ports`。
3. **R3 新判据**：只放行“public 为空、由装配根经 composition 取用”的模块；死模块（装配根也不取）照旧报红（负对照与变异 m3），绕路取用照旧由 R1 报红
   （变异 m5）；账本里写着的模块必须仍是 public 为空的（销账不改账本照旧报红）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
