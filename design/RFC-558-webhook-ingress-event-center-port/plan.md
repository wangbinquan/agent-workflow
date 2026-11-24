# RFC-558 实施计划

依赖：RFC-557。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-558-T1**：integration 声明 `WebhookIngressEventCenter`，webhook 入站的两个装配函数改用它（design §1）。
- **RFC-558-T2 门与用例**：两份精确清单与 `counts.json` 降低；新增 RFC-558 用例并登记 guard-manifest。
- **RFC-558-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-558-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 integration 取 event-center 非 public 文件的只剩指定 adapter；webhook 入站的装配用 `WebhookIngressEventCenter`
- [x] AC-2 行为不变；事件中心模块满足端口由编译器检查
- [x] AC-3 跨 context 内部文件对 7 → 6；清单与减速带随之更新；新增 RFC-558 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `014a79f85` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷两处（已修复并复验）**：① RFC-310 的 OS 架构清单（`design/RFC-310-…/os-architecture-manifest.json`）逐条记着各文件对 event-center 的依赖，
  漏改——`rfc310-digital-employee-os-architecture` 在选集运行里红；清单里 `webhookIngress.ts -> composition` 换成新端口文件的 `public/participants` 与
  `public/types` 两条后 11 / 11。② RFC-558 用例对入站装配参数类型的正则只认前缀，变异“参数类型拓宽成交叉类型”没被认出；改成整行匹配后该变异被
  认出，用例与 `rfc317-guard-corpus-floor` 合跑 28 / 28。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 5 个 TS 文件（2 个生产文件、3 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、architecture 清单、OS 架构清单与三件套通过。
- **实测前提**：integration 全部源码取 event-center 非 public 文件的，改动后只剩指定 adapter 按类型取 required-ports。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 155 个（经夹具补 2 个），154 个通过；红的一个即
  上面 ① 的清单，修复只动了清单文件，其余结果沿用。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：三种变异各自让 RFC-558 用例红——入站装配重新取 event-center 的 composition、窄端口取
  event-center 的 application 类型（这两种 `rfc376-structural-guards` 同红）、重放装配把参数类型拓宽（收紧正则后认出）。
- **架构报告**（候选与对照各出一份）：`cross-context-internal-file-pairs` 7 → 6；生产文件 +1（新端口）；event-center 的 public 面多了这个端口的消费边；
  其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `aee8de63c`（实现，父提交是 `014a79f85`）：exact SHA 主 CI run 45317311399 70 / 70 通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：只换了参数类型；入站与重放装配里对事件中心的三次调用（记观察、跑通知、提示代码平台活动源）一字未动，bootstrap 交的仍是同一个
  事件中心模块。
- **编译器对齐**：窄端口的三个签名与事件中心模块相同；用例里的编译期断言与 bootstrap 交接处都由 `tsc` 检查。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-554～557 的 CI 仍未跑完，它们的转 Done 随下一个 RFC 的提交。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
