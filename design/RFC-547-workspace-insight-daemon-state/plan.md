# RFC-547 实施计划

依赖：RFC-545。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-547-T1 索引缓存**：删去单例与重置，深度索引端口的组合构造缓存并交给深度 diff 与索引缓存端口（design D1）。
- **RFC-547-T2 叙述状态**：新增状态类型与构造函数，删去模块级表与重置，两个用例收下状态，workspace-insight 的组合构造一份（design D2）。
- **RFC-547-T3 用例**：新增 RFC-547 用例并登记 guard-manifest；随改 design D3 所列用例与测试助手。
- **RFC-547-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；变异验证。
- **RFC-547-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十三步。

## 验收清单

- [x] AC-1 两个文件没有模块级单例与重置函数；缓存与叙述状态由组合构造并交入
- [x] AC-2 索引缓存的共用与叙述状态的语义不变
- [x] AC-3 模块级可变单例 46 → 43、计数不升；新增 RFC-547 用例并登记；读旧接口的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（2026-11-23 重启后没有恢复，本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL
分片为准。验证在候选导出仓库里跑（HEAD `d47b73c57` 加本 RFC 的 13 个路径，核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证
没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 12 个 TS 文件无告警，改动的 5 个生产文件另过 promises
  配置；prettier：改动的代码、guard-manifest 与三件套通过。
- **选择**：按 RFC-533 的口径从 2,990 个用例文件里选出语义层 154 个：改动的 6 个用例、全部 `tests/architecture/`（142 个）、在 import 之外以路径
  点名被改文件的 2 个、点名被改 API 的 10 个、直接导入被改文件的 7 个；没有读被改源码的测试助手，`tests/fixtures/` 里也没有钉被改文件的
  摘要锁。
- **语义层**（SQLite；60 秒；候选 5 个 worker）：154 个文件全部通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：组合每次现建一份缓存（读者不再共享）、模块级单例与重置回来、每份叙述状态共用
  同一组表，各自让 RFC-547 用例红。
- **架构报告**（候选与对照各出一份）：模块级可变单例 46 → 43（删去的正是 `resetChangeNarrativeStateForTests`、`singleton` 与
  `resetScipIndexCache`）；模块符号属主 32,470 → 32,465；写入入口清单多 1 条（新的叙述状态构造函数，如实记录）；其余计数与门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **索引缓存**：原先 daemon 里只有一个 `ScipIndexCache`（模块级单例，懒建）；现在由深度索引端口的组合建一个，`composeTaskWorkspaceInsight` 在
  daemon 的 HTTP 装配里只调一次，所以仍是一份。深度结构 diff 原先在调用方没带缓存时回落到单例（实际走的路），现在回落到组合交入的同一份；
  代码智能经 `indexCache()` 拿到的也是这一份——两者照旧共享。调用方自己带缓存时照旧优先。缓存的容量、淘汰与命中逻辑没有动。
- **叙述状态**：三张表的用法逐字不变（`generating` / `failures` / `inflightTrigger` 改为经交入的状态取），读取用例收下状态作为第一个参数，触发
  用例从 `deps.state` 取；组合只建一份，生成中的单飞、失败的有效期与触发合并的语义不变。
- **测试替身**：原先靠重置函数在用例之间清状态；现在每个用例或每次组合各有一份，`change-narrative` 在每例之后换一份新状态，测试助手把
  `state` 一并转交。
- **用例**：新增 RFC-547 用例并登记 guard-manifest；随改 `rfc453`、`change-narrative`、`rfc239`、`rfc370-v16`、`structural-diff-deep-fallback`
  与测试助手 `changeNarrativeSystemAgents`。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-547 workspace-insight 的守护进程级状态归组合根构造的实例（RFC-294 S12 第二十六步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
