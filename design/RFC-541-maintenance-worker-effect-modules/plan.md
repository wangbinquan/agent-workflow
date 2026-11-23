# RFC-541 实施计划

依赖：RFC-540。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-541-T1 平台作用域**：`maintenanceWorkerEffects.ts` 删去模块级表与登记 / 加载函数，作用域的加载器取 `input.importModule`、没给时按模块名
  import（design D1）。
- **RFC-541-T2 托管根**：`maintenanceWorkerEntry.ts` 自己调一次运行时，把映射 `aw:crewstation-maintenance` 的加载器交给效果作用域（design D2）。
- **RFC-541-T3 用例与锁**：新增 RFC-541 用例并登记 guard-manifest；`rfc370-v9-maintenance-worker-entry` 与相关注释随改（design D3）。
- **RFC-541-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-541-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第九步。

## 验收清单

- [x] AC-1 `maintenanceWorkerEffects.ts` 没有模块级表与登记函数；两个 Worker 入口各自把效果加载器交给运行时
- [x] AC-2 两种部署的维护 Worker 加载的效果模块与结局不变
- [x] AC-3 模块级可变单例 51 → 50、计数不升；锁随改；新增 RFC-541 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 22～30，另有会话在跑）。验证在候选导出仓库里跑（HEAD `2f685c9e4` 加本 RFC 的 7 个路径，核对与
工作树逐字相同），对照是同一 HEAD 的另一份导出；其后的 `d6065f733` 只改文档（本 RFC 的落档与 RFC-540 转 Done）。集中验证没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 6 个 TS 文件无告警，改动的 2 个生产文件另过
  promises 配置；prettier：7 个路径与三件套通过。
- **选择**：按 RFC-533 的口径从 2,986 个用例文件里选出 242 个。语义层 225 个：改动的 2 个用例、全部 `tests/architecture/`（142 个）、语料守卫、
  在 import 之外以路径点名被改文件的 4 个、点名维护 Worker / 效果作用域 / 托管入口的 40 个、直接导入平台效果文件的 3 个、经改了注释的
  `census.ts` / `architectureReport.ts` 到达的 142 个（多数即架构用例）；`tests/fixtures/` 里没有钉被改文件的摘要锁。
- **语义层**（60 秒；候选 5 个 worker）：225 个文件 221 个通过；改过的与维护 Worker 相关的用例全过（RFC-541 用例 6 / 6、
  `rfc370-v9-maintenance-worker-entry` 4 / 4、`rfc389-maintenance-worker-root` 6 / 6、`rfc528-standalone-maintenance-worker-effects-boundary` 4 / 4、
  `rfc370-maintenance-worker-effects` 22 / 22、起真 Worker 的 `rfc370-maintenance-worker-real-effects` 13 / 13 与 `rfc338-maintenance-worker` 8 / 8）；
  红的 4 个都是长扫描用例撞写死的时限（`rfc294-architecture-preflight`、`rfc376-report`、`rfc370-committed-architecture-source`、`rfc400-collaboration-task-participants`）。
- **A/B**（候选与对照同时、各用各的库；在两边的副本里临时放大写死的时限跑到底）：`rfc294-architecture-preflight` 14 / 14、`rfc376-report` 16 / 16、
  `rfc370-committed-architecture-source` 2 / 2、`rfc400-collaboration-task-participants` 6 / 6，两边都全过。没有只在候选上红的用例。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：模块级的登记表与登记函数回来，RFC-541 的真实语料红；托管根的加载器不再映射
  `aw:crewstation-maintenance`，RFC-541 的真实语料与 `rfc370-v9` 的托管根用例红（起真 Worker 的 `rfc370-maintenance-worker-real-effects` 走单机根，
  照常通过）；效果作用域没给加载器时不再按模块名 import，RFC-541 与 `rfc370-v9` 的缺省加载用例各红一条。
- **架构报告**（候选与对照各出一份）：模块级可变单例 51 → 50（删去的正是 `registerMaintenanceWorkerEffectModule`）；模块符号属主 32,471 → 32,468
  （删去的三个名字）；跨上下文导入、写入入口清单、公开面与减速带计数、门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `896fc990a`（实现，父提交是 `d6065f733`）：exact SHA 主 CI run 45117772865 的 70 个 job 第 1 次全部通过；同一提交触发的
  maintenance-soak-nightly（run 45117772821）通过（本提交的路径不触发 windows-platform）。
- 本 RFC 的落档提交 `d6065f733`（只改 8 个 Markdown 文件；同一提交记下 RFC-540 转 Done）：主 CI run 45115889841 的 70 个 job 里，后端分片 15/44
  的 `rfc310-pr3-journey` PostgreSQL 一支「publish → wrong ref 422 → submit → working → route block」90 秒泵耗尽（停在
  `status=blocked blockCode=template-route:route-indeterminate`），`CI required` 随之红，其余 68 个通过。该提交的代码与 `2f685c9e4`（70 / 70）逐字
  相同，父提交的同一分片同一用例通过；这是 `docs/audit-backlog.md` 已登记的该用例泵耗尽一类（本次停在 blocked，补记随本 RFC 转 Done 的提交），
  不是该提交引入的；未改、未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **加载的结局不变**：效果作用域的加载器取交进来的 `importModule`，没给时 `import(specifier)`——与此前查不到登记表时的回落同义；导出名与工厂、
  能力与选择校验、生命周期（就绪、释放、关闭竞态）都不变。
- **托管部署**：托管入口自己调一次 `runMaintenanceWorker`，图与运行时与单机根同一份（`composeMaintenanceWorkerGraph`），交给效果作用域的加载器把
  `aw:crewstation-maintenance` 映射到 `import('./crewstationMaintenance')`（与此前登记的加载器同义、照旧按需加载），其余按模块名 import；监工仍按
  描述符的 `workerEntry` 选这个入口，单二进制的入口清单不变。
- **单机部署**：单机根不变，描述符的模块按名字 import，与此前（登记表里没有它）相同。
- **用例与锁**：`rfc370-v9-maintenance-worker-entry` 改钉托管根的形状与平台作用域的缺省加载；census 与架构报告里描述托管入口“登记效果模块”的
  注释随改；guard-manifest 登记 RFC-541 用例。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-540 转 Done）；实现与验证后再提交
`refactor(backend): RFC-541 维护 Worker 的效果模块由各自的 Worker 入口交给运行时（RFC-294 S12 第二十二步）`。走私有 index、按路径清单提交，在
共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
