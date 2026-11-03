# RFC-435 实施计划

**前置**：RFC-434 收尾（`309cf83c7`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                           | 依据      |
| ---------- | ---------------------------------------------------------------------------------------------- | --------- |
| RFC-435-T1 | 合同：`TaskCatalogViewer`；`TaskCatalogQueries` 搬到 `application/ports` 并类型化；public 导出 | design §1 |
| RFC-435-T2 | 查询服务实现类型化合同；来源端口字段改名 `viewer`，两个来源适配器更新                          | design §2 |
| RFC-435-T3 | 入站路由依赖 public 合同，序列化移到路由                                                       | design §2 |
| RFC-435-T4 | 用例更新；账本（R1）与 guard-manifest                                                          | design §3 |
| RFC-435-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                          | design §5 |
| RFC-435-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（E10 与 B / D 第二步）                 | —         |

## 验收清单

- [x] AC-1 类型化查询合同在 application/ports，经 public 导出，不带遗留 Actor
- [x] AC-2 路由只经精确 public 入口依赖 task-catalog
- [x] AC-3 来源端口接 `TaskCatalogViewer`，结构规则与架构测试通过
- [x] AC-4 任务目录用例通过，响应体不变
- [x] AC-5 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-435 任务目录 public 查询类型化、不接遗留 Actor（RFC-294 W4 E10）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。

## 集中验证（T5）

全部实现与用例写完后一次进行（`309cf83c7` 之上的工作树）。改动面只在 task-catalog、两个来源适配器与一个路由，验证取针对性集合。

- **静态**：后端 typecheck（含 tests，6 GiB heap）0 错误；改动的 TS 文件 eslint `--max-warnings 0` 与 prettier 全部通过。
- **架构测试**：`tests/architecture/`、`rfc294-architecture-preflight`、`rfc305`、`rfc328`、`rfc331` 共 1388 条。
  唯一差异是预期中的 R1 账本：`routes/taskCatalog.ts -> task-catalog/composition` 销账，`inboundEdges` 202 → 201。改账后架构目录 1346/1346 通过。
- **针对性用例**（任务目录查询服务、两个来源、HTTP 面、R1 账本，60 s 预算）：SQLite 13 个文件 128/128，PostgreSQL 10 个文件 95/95。
- **导出仓库（`309cf83c7` + 本候选）**：141 个按已提交源码出报告的用例全部通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 实现门（本会话自审，只审功能）

- **响应体不变**：查询服务返回的正是改前它 `JSON.stringify` 的那个对象（来源文档、经 `TaskCatalogPageSchema` 校验的页）。
  路由对同一对象调用 `JSON.stringify` 后照旧交给 `jsonDocumentResponse`，字节与响应头不变。
- **权限判定不变**：
  - 路由传入的请求 actor 在结构上满足 `TaskCatalogViewer`；查询服务只读 `permissions`；
  - 两个来源只读 `permissions` 与 `user.id`，task-execution 来源照旧经 `taskListViewerOf` 收窄。
- **游标、facets、来源校验**：逻辑未动。
- **结论**：PASS。

## CI（AC-5）

`b3a1daa98` 的主 CI run 41712173774：

- **attempt 1**：conclusion `failure`，66 success。三个 Playwright e2e（macos-latest shard 1/4、3/4、4/4）始终没有分到 runner（0 个步骤、
  runner 为空），15 分钟后被取消，「CI required」随之 failure。属 GitHub 托管 macOS runner 的可用性问题，与代码无关。
  同日 `43fcce84c` 的 CI 也出现过同样形态。
- **attempt 2**（`gh run rerun --failed`）：conclusion `success`，70/70。

windows-platform 与 maintenance-soak-nightly 带路径过滤，本 RFC 的改动不触发它们。
