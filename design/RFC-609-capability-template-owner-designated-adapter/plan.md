# RFC-609 实施计划

依赖：RFC-555～557（指定 adapter 的做法）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-609-T1 合同归位**：合同迁入 resource-catalog 的 application 端口，参与方文件与装配改从端口取，required-ports 交出（design §1）。
- **RFC-609-T2 指定 adapter**：code-capability 新增 adapter，归属方改从它取合同、事务类型用平台的（design §1）。
- **RFC-609-T3 门与文档**：三处清单删去这 2 条；新增 RFC-609 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S9 与 W4-E8 注记（design §2、§5）；集中验证查出的那条教训记进
  `docs/dev-gotchas.md`（经 required-ports 交出的合同用中立名字）。
- **RFC-609-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-609-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 合同在 application 端口，经 required-ports 交出
- [x] AC-2 归属方只经指定 adapter 取合同，事务类型取自平台
- [x] AC-3 跨 context 内部文件对为 2，三处清单同步；新增 RFC-609 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `03008a73a`（RFC-546）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径的传递闭包与名字选出，再加上 `tests/architecture/` 全部、读 guard-manifest / 计数 / `STATE.md` / RFC 文档
  的用例与提到 resource-catalog / code-capability 的用例，共 1,049 个用例文件。
  - **查出一处本人缺陷**：`rfc349-provider-cutover` 红。初版沿用旧名 `PostgresqlCapabilityTemplatePackageMutationOwner`，指定 adapter 在
    application 层按名字取了引擎专属的符号，这条锁不许。合同的参数本来就是中立类型，改名为 `CapabilityTemplatePackageMutationOwner`（design §0
    裁定二），`rfc349-resource-catalog-postgresql-adapters` 对参与方文件的文本锁随之改认新名。
  - 另两个红与本 RFC 无关：`rfc321` 要 git 历史，导出里照例红；`rfc167` 在六路并行下等任务落定超时（读到的状态还是 `running`），单独跑通过。
  - 改名后按改动路径的传递闭包与名字重选 237 个用例文件（含上面两条锁、RFC-609 用例、RFC-376 结构锁与 preflight）复验，全部通过。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：5 种都被认出。
  - 归属方绕过 adapter 直接取 required-ports、归属方重新经资源目录取事务类型、adapter 改成取值：RFC-609 用例与 `rfc376-structural-guards`
    同时红（后者把它记成新的跨 context 内部文件对）。
  - required-ports 不再交出合同、参与方文件重新自己声明合同：RFC-609 用例红。
- **架构报告**（候选对照干净的 `03008a73a`）：`cross-context-internal-file-pairs` 4 → 2；生产文件多 2 个（端口与 adapter），合同的声明从
  resource-catalog 的 infrastructure 移到 application；其余有门禁的计数不变。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **行为不变**：只移动类型声明、改名、改 import 路径；`PersistenceTx` 与原来的 `PostgresqlResourceCatalogTransaction` 是同一个类型。资源包
   PostgreSQL 事务里能力模板一支的准备与提交照旧经同一份实现（bootstrap 的两处装配不变）。
2. **装配**：资源目录的装配与参与方文件从端口取合同；code-capability 的归属方工厂返回值就是 required-ports 交出的合同（编译期断言）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
