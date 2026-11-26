# RFC-610 实施计划

依赖：RFC-606（平台 `JsonValue` / `JsonObject` 是指定的平台合同类型）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做
语法与格式的静态自查。

## 任务

- **RFC-610-T1 回执类型**：结论的回执与记录端口 `receipt()` 的返回改为 `JsonObject`；文件记录实现第一次也返回发布字节的解析结果（design §1）。
- **RFC-610-T2 门与文档**：preflight 的 `PUBLIC_SURFACE_DEBT` 去掉这 1 条、计数 12 → 11；新增 RFC-610 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan
  的 S9 注记（design §2）。
- **RFC-610-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-610-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `receipt()` 第一次与恢复时返回同一份发布出去的 JSON
- [x] AC-2 结论的回执是 `JsonObject`
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 去掉这 1 条，计数为 11
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（后继证据，见下）

## 集中验证

基于 `8cf8ee11d`（RFC-609）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径的传递闭包与名字选出，再加上 `tests/architecture/` 全部、读 guard-manifest / 计数 / `STATE.md` / RFC 文档
  的用例与自动升级、`db migration` 相关的用例，共 302 个用例文件，全部通过。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：4 种都被认出。
  - 第一次调用改回返回传入的对象、恢复时改为返回新传入的值：RFC-610 用例红。
  - 结论的回执改回任意对象：RFC-610 用例与 preflight 的精确清单同时红；端口的返回改回任意对象：RFC-610 用例红。
- **架构报告**（候选对照干净的 `8cf8ee11d`）：`public-surface-deviations` 12 → 11；其余有门禁的计数不变。

## CI（AC-4）

- `0fdb118d8`（实现）：exact SHA 主 CI run 45795931974 结论 failure，红在两格，都是等待超时，与本 RFC（自动升级回执的类型）无关、未重跑：
  - shard 43：RFC-026 调度器澄清 inline 模式的 PostgreSQL 一支 15,776 ms 超过 15 秒上限；
  - shard 41：RFC-401 epoch-2 历史行桥的用例 5,137 ms 超过 5 秒上限（RFC-607 的 run 里同一条也超时过，这条用例在 CI 上贴着上限跑）。
- 后继证据：包含本提交的 `6c92e2be2`（RFC-615）run 45846353277 第 2 次尝试 70 / 70 全绿（第 1 次尝试只有 macOS e2e 3/4 一格在 36 分钟后被取消、日志已不可取，没有失败的用例作业）。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **输出不变**：结论的回执此前在第一次运行时是传入的对象本身，现在是同一份值序列化后的解析结果。`db migration auto --json` 用 `JSON.stringify`
   打印，值为 `undefined` 的键本来就不进输出，打印出的字节相同；`completed` 记录与日志里的回执同理。
2. **恢复**：已发布时照旧读回原来的字节，不看新传入的值；文件只写一次（`writeEpochFile` 的 once 语义不变）。
3. **用例消费面**：生产代码里只有自动升级用例读回执（写 `completed` 记录、打日志、遍历 `restrictions`），都按 JSON 读。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
