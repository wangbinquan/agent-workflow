# RFC-587 实施计划

依赖：RFC-586。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-587-T1 搬迁与连接**：三个绑定迁入各自 owner 的 `inbound/http/`，三处窄类型，composition 转出挂载函数，`server.ts` 改指（design §1）。
- **RFC-587-T2 撤回**：三个反馈函数移进 collaboration 的 application，task-execution 删去一处转出（design §1）。
- **RFC-587-T3 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例；新增 RFC-587 用例并登记 guard-manifest（design §2）。
- **RFC-587-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-587-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 三个旧路径不存在、没有说明符再解析到它们；三个绑定只改 import 与三处窄类型
- [x] AC-2 挂载调用与顺序不变；健康、就绪、归档与反馈的路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 62 → 59；未消费 public 符号保持 0；DAG 之外的边与跨 context 内部文件对不增加；归属表删三行；新增 RFC-587
      用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI（`3469a00e1`）70 个 job 里 68 个成功，红的两格是外部链接 503 的环境性红，已逐格归因（见「CI」）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `3c4a3cefb` 加本 RFC 的路径，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希相同），对照是同一
HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 里补记的一条与 `STATE.md`）；代码、用例、工作流与账本逐个文件比对，与候选相同。

- **本人缺陷（已修复并复验）**：第一份候选的架构报告里 `unconsumed-public-symbols-memory` 0 → 1——反馈绑定改用 collaboration 自己的蒸馏端口类型之后，
  memory 的 `MemoryOperations` 在模块外没有消费者了（推算时把绑定当作原样迁入、仍算它取 memory，漏了这一项）。按 public 类型引用算到不动点，连带
  五个只经它的字段可达的类型，六个声明逐字移进 memory 的 `application/memoryOperationContracts.ts`（用 RFC-580 的语法树搬迁工具，读者的 import 随之
  拆分），`rfc552` 的 public/operations 账本删去 `MemoryOperations`。复验：静态检查重跑、按改动面另选 219 个用例文件（1767 条全部通过）、重出候选
  导出与报告（未消费计数回到 0）。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 32 个 TS 文件无告警，生产文件（18 个）另过 promises 配置；
  prettier：改动的代码、JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：第一轮选出 616 个用例文件（`/health`、`/api/tasks/archive`、反馈端点与 `server.ts` 会把大量用例选进来），
  5316 条全部通过；memory 撤回之后按改动面另选 219 个，1767 条全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-586 的清单），共 370 个文件、3666 条全部通过；其中 `rfc376-structural-guards` 221 / 221、RFC-587 用例 8 / 8、
  `rfc294-review-offered-edge-dag` 8 / 8、`rfc552` 13 / 13、`rfc559` 5 / 5、`rfc480` 13 / 13、`rfc442` 9 / 9、`rfc445` 10 / 10、RFC-576 用例 7 / 7、
  `route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11、`rfc398-health-database` 2 / 2、`task-feedback-service` 3 / 3、`rfc311-task-archive` 15 / 15。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：六种都被认出——旧路径上重新出现一跳转出（RFC-587 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用 import 类型取旧路径（用例 ①）；健康绑定又取 task-execution 的 public（用例 ② 与
  `rfc294-review-offered-edge-dag` 同红）；反馈绑定又取 memory 的 public（同上）；撤回的反馈函数又从 public 转出（用例 ③ 与未消费计数同红）；`server.ts`
  直接从 inbound 取挂载函数（用例 ④）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 62 → 59 变了；未消费 public 符号保持 0；public 面 860 → 850（撤回
  10 个：计划的 4 个与 memory 的级联 6 个）；public 类型偏差 28、不可达生产文件 8、跨 context 内部文件对 6、模块分层违规 0、DAG 之外的已提供文件对 2
  都不变。跨 context import 7631 → 7637：三个绑定对 `routes/registry`、`@/auth/actor` 与 platform 的取用改记到各自模块名下（报告把 platform 也记在
  legacy 名下），legacy → 三个模块的入边随之减少，`server.ts` 改从 composition 取挂载函数多了三条值边。DAG 之外的 context 值对仍为 0。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `3469a00e1`（实现）：exact SHA 主 CI run 45638766643 的 70 个 job 里 68 个成功——全部后端分片、真实 PostgreSQL、前端、三个平台的构建与检查、
  ubuntu / windows / macOS 的全部 e2e 分片；按路径触发的 windows-platform（run 45638766847）与 integration-opencode（run 45638766589）通过。
- 红的两格是同一件事：Markdown link check (design/)（job 139291278211）在 3339 个链接里只报 1 个错——
  `design/RFC-378-mindmap-decision-review/research.md` 第 36 行一条指向第三方公开仓库的 github.com 链接返回 503 Service Unavailable；CI required 因汇总
  它而红。归因：环境性（外部站点一时不可用），不是本提交引入——本提交没有改那份文件（`3c4a3cefb..3469a00e1` 对它无差异），前两个提交（`3c4a3cefb` 的
  run 45624158433、`035f97026` 的 run 45618436881）的同一 job 对同一链接都通过；链接本身没有失效，那份文档也不是本会话的，不改。后继证据取 RFC-588
  提交的同一 job。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：三个绑定的路由、方法、鉴权声明与处理逻辑逐行不变；三处换掉的类型只收窄到绑定实际用的那一个读取 / 端口，`server.ts` 传的还是
  原来的对象；挂载调用与先后顺序不变。健康、存活、就绪、归档与反馈的用例通过。
- **撤回不改形状**：十个声明逐字移动（反馈的三个函数与它们共用的服务构造、task-execution 的归档命令端口转出、memory 的操作束与它的五个字段类型），
  `tsc` 检查全部连接处。
- **钉着旧路径的地方都随改**：归属表三行、`counts.json`、`rfc442` / `rfc445` / RFC-576 / `rfc480` / `rfc552` 的清单；e2e 注释里的行号锚点不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
