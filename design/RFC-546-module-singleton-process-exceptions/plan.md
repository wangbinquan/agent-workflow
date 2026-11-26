# RFC-546 实施计划

依赖：RFC-545、RFC-547、RFC-548、RFC-549（可迁移的一类拆完）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与
格式的静态自查。

## 任务

- **RFC-546-T1 清单**：写 `architecture/module-singleton-exceptions.json`，登记进 `ARCHITECTURE_FILES`（design D1）。
- **RFC-546-T2 守卫**：新增 RFC-546 守卫并登记 guard-manifest（design D2）。
- **RFC-546-T3 design §14**：改 RFC-294 design §14 该行的口径（design D3）。
- **RFC-546-T4 文档**：三件套记下裁定；RFC 索引、`STATE.md`、RFC-294 plan 的 S12 注记。
- **RFC-546-T5 集中验证**：backend `tsc`、eslint、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-546-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] Q1～Q3 已裁定（proposal §5）
- [x] AC-1 清单与判据结果逐条相等
- [x] AC-2 守卫在真实语料上为绿、负对照为红
- [x] AC-3 design §14 口径修订
- [ ] AC-4 exact SHA CI 全绿

## 集中验证

基于 `a3def727e`（RFC-608）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 无告警；守卫与 RFC 文档 prettier 通过（`architecture/` 按 `.prettierignore` 不进 prettier）。
- **选出的用例**：在候选导出里跑 `tests/architecture/` 全部，加上读 `STATE.md` / RFC 索引 / RFC 文档 / guard-manifest / 计数 / `architecture/` 目录、
  引用 `rfc294Gates` 或单例判据的用例，共 370 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。RFC-546 守卫 5 个用例都过：真实语料上
  判据的 37 条与两份清单逐条相等。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：6 种都被认出。
  - 生产代码里新加一个模块级 `let`、清单的一条对不上源码里的符号、待迁的一条挪进例外（超过上限 28）、例外缺理由、design §14 保留旧口径：
    RFC-546 守卫红。
  - 清单文件没登记进 `ARCHITECTURE_FILES`：`rfc376-structural-guards` 红。
- **架构报告**（候选对照干净的 `a3def727e`）：除报告时间与源 SHA 外相同。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **守卫与报告同一判据**：守卫在全部生产文件上调架构报告的 `mutableSingletons`，结果与报告的 `ambientWiring` 同为 37 条，比对按文件、符号、
   种类，不受条目序号影响。
2. **清单**：28 条例外的位置、种类与 proposal §3 逐条相同（6 处按迁移后的文件）；9 条待迁与 proposal §1 的三族相同；两份互不重叠。
3. **口径**：design §14 该行改为“不计登记的进程级例外”并指向清单；S12 第 4 项的退出门改由 `pending` 清空判定。生产代码未改。

## PR / 提交

一个提交：清单、守卫、design §14、三件套、RFC 索引与 `STATE.md` 条目一起提交（落档提交 `fc5d5c9c0` 只含三件套）。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
