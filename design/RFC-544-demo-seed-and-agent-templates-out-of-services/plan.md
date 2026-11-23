# RFC-544 实施计划

依赖：RFC-476。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-544-T1 演示种子**：`services/demoSeed.ts` 迁为 `bootstrap/demoSeed.ts`，`daemonApplication.ts` 改动态 import（design D1）。
- **RFC-544-T2 代理模板**：V2 声明迁入 `domain/developmentAgentTemplatesV2.ts`，旧版数据与纯函数迁入 `domain/legacyDigitalEmployeeAgentTemplates.ts`，
  两个用例迁入 `application/digitalEmployeeAgentTemplates.ts`，`public/participants.ts` 只转出，bootstrap 三个文件改取 public（design D2）。
- **RFC-544-T3 用例**：新增 RFC-544 用例并登记 guard-manifest；随改 design D3 所列用例。
- **RFC-544-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被迁名字与旧路径的字符串形态、读被改源码的测试助手与
  `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；
  变异验证。
- **RFC-544-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan §4.7 记“其余”一族第二步。

## 验收清单

- [x] AC-1 `services/` 下没有这两个文件；迁入位置与分层按 design §3，bootstrap 只经 public 取用
- [x] AC-2 内置代理对齐、公开模板列表、工具展示名、升级映射、工具配置与首启示例的结局不变
- [x] AC-3 新增 RFC-544 用例并登记；钉着旧路径的用例与锁随改；减速带计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 22～33，另有会话在跑）。验证在候选导出仓库里跑（HEAD `7604bebbe` 加本 RFC 的代码与清单路径，核对与
工作树逐字相同、两个删去的文件在候选里也不在），对照是同一 HEAD 的另一份导出。集中验证查出一处本人遗漏，已修并复验：

- **本人遗漏：RFC-310 的数字员工 OS 架构清单仍写旧路径**。`design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json`
  按文件登记 digital-employee 的外部依赖，其中 `services/digitalEmployeeAgentTemplates.ts -> public/participants` 随文件迁成
  `modules/development-automation/application/digitalEmployeeAgentTemplates.ts -> public/participants`（同一条对 digital-employee public 的依赖），
  `rfc310-digital-employee-os-architecture` 首批即红；清单改为新路径后复验通过。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 30 个 TS 文件无告警，改动的 8 个生产文件另过 promises
  配置；prettier：代码、guard-manifest、RFC-310 清单与三件套通过。
- **选择**：按 RFC-533 的口径从 2,988 个用例文件里选出 529 个；语义层 355 个：改动的 22 个用例、全部 `tests/architecture/`（142 个）、语料守卫、
  在 import 之外以路径点名被改文件的 157 个（多是读 bootstrap 源码的锁）、点名被迁名字与旧路径的 27 个、直接导入迁入文件与 public 的 17 个、
  经读源码助手（`daemonGraphSource` 等）读到被改文件的 206 个；bootstrap 三个文件只改了 import 来源，它们的 import 闭包交给 CI 的全量分片；
  `tests/fixtures/` 里没有钉被改文件的摘要锁。
- **语义层**（60 秒；候选 5 个 worker）：355 个文件 346 个通过（RFC-544 用例 6 / 6）。红的 9 个：上面那条清单遗漏；`rfc321-repository-publication-ratchet`
  只在导出仓库里红（它要回放可达历史，导出没有 git 历史），在主树工作树里 10 / 10；其余 7 个都撞写死的时限（`rfc376-report`、
  `rfc395-neutral-query-boundary`、`rfc400-collaboration-task-participants`、`rfc294-architecture-preflight`、`rfc370-committed-architecture-source`
  与 PostgreSQL 支的 `rfc370-evidence-artifact-root-bindings`、`rfc396-case-intake`）。
- **A/B**（候选与对照同时、各用各的库；在两边的副本里临时放大写死的时限跑到底）：7 个两边都全过（`rfc376-report` 16 / 16、
  `rfc395-neutral-query-boundary` 2 / 2、`rfc400-collaboration-task-participants` 6 / 6、
  `rfc294-architecture-preflight` 14 / 14、`rfc370-committed-architecture-source` 2 / 2、`rfc370-evidence-artifact-root-bindings` 9 / 9、
  `rfc396-case-intake` 4 / 4），没有只在候选上红的用例。清单遗漏修好后，`rfc310-digital-employee-os-architecture`、RFC-544 用例与
  `rfc349-digital-development-provider-boundary` 在候选上复验通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：public 又声明 V2 常量、application 改从本模块 public 取 V2（成环的写法）、bootstrap
  绕过 public 直取 application、升级映射错一位、演示种子留在 `services/`，各自让 RFC-544 用例红。
- **架构报告**（候选与对照各出一份）：`legacy-service-implementations` 6 → 4、`legacy-horizontal-files` 125 → 123、development-automation 的未消费
  公开符号 8 → 6（V2 不再公开的两个原本无人消费），门面清单少了这两个 services 文件；跨上下文导入多 6 条，是 bootstrap 改经
  development-automation 的 public 取用与迁入文件原有的依赖；其余计数与门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `bbcc840e2`（实现，父提交是 `7604bebbe`）：exact SHA 主 CI run 45169590551 的 70 个 job 第 1 次全部通过；同一提交触发的 windows-platform
  （run 45169590437）与 maintenance-soak-nightly（run 45169590357）通过。
- RFC-543 的撤回提交 `c953ac2d1`（只改 7 个 Markdown 文件）：主 CI run 45148076261 的 70 个 job 里，macOS 的 Playwright e2e 分片 3/4 运行 20 分
  19 秒后被取消（该 job 的 `timeout-minutes: 20`；工作流 `cancel-in-progress: false`，不是被后继推送取消），`CI required` 随之红，其余 68 个通过。
  父提交 `b3181fc02` 70 / 70；这是 runner 偏慢撞 job 时限，与该提交无关；未重跑。后继证据：`c953ac2d1` 是 `7604bebbe` 的祖先，内容原样保留，
  后者的主 CI 见下条。
- 本 RFC 的落档提交 `7604bebbe`（只改文档）：主 CI run 45152098677 的 70 个 job 第 1 次全部通过——它包含 `c953ac2d1`，也是后者的后继证据。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **演示种子不变**：文件逐字迁入 `bootstrap/demoSeed.ts`（只多一行注释），全用 `@/` 绝对 import；`daemonApplication` 的动态 import 改为 `./demoSeed`，
  启动步骤与完成标记的组装不变；取用的仍是三个模块 public 的参与者类型与完成端口。
- **模板不变**：V2 声明逐字迁入 `domain/developmentAgentTemplatesV2.ts`；旧版数据与纯函数逐字迁入 `domain/legacyDigitalEmployeeAgentTemplates.ts`（V2
  名字改取同层文件，原先不导出的模板接口与旧版模板数组改为导出给 application 用）；两个用例与私有的存储形态还原、内容签名、单行对齐逐字迁入
  `application/digitalEmployeeAgentTemplates.ts`。名字、值与行为不变：启动对齐的模板集合与顺序、碰撞时的 `builtin-agent-id-collision`、按内容签名的
  修复、公开模板列表的过滤、工具展示名、升级映射与分类器的工具配置。
- **求值顺序无环**：三个模板文件不取本模块 public，public 只转出；bootstrap 三个文件只改 import 来源。
- **公开面**：`public/participants.ts` 照旧转出证据暂存的两个断言，另转出 bootstrap 用的六个名字；V2 的五个名字不再公开（迁入后本模块之外
  没有生产使用方），测试改从 domain 取。
- **用例**：新增 RFC-544 用例并登记 guard-manifest；随改 21 个用例（15 个 import 路径；`rfc474`、`rfc476`、`rfc477`、`rfc471`、`rfc349` 两个文件
  的锁）与 RFC-310 的数字员工 OS 架构清单。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-544 演示种子与数字员工代理模板迁出 services/（RFC-294 §4.7 其余一族第二步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
