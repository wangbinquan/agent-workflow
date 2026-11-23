# RFC-552 实施计划

依赖：RFC-551。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-552-T1 判据**：`publicSurfaceViolations` 不再整体跳过 `public/operations`，按 design §1 处理合同类型 import 与描述工厂。
- **RFC-552-T2 收口**：knowledge-evolution 的运维函数改由 composition 转出、bootstrap 改取；`OwnerIdentityQueries` 移到 identity-access
  `public/queries`（design §2）。
- **RFC-552-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 按实测更新并写明来由；新增 RFC-552 用例并登记 guard-manifest；随改读旧
  位置的用例。
- **RFC-552-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；先跑读源码文本的用例，再按 RFC-533 的口径与 RFC-550 的选法选用例；
  架构报告对照；变异验证。
- **RFC-552-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第八步。

## 验收清单

- [x] AC-1 检测器不再整体豁免 `public/operations`；合同类型 import 与描述工厂按 design §1 处理
- [x] AC-2 knowledge-evolution 的运维函数不再从 public 导出、bootstrap 改取 composition；`OwnerIdentityQueries` 在 `public/queries`
- [x] AC-3 显形的偏差逐条入账并写明后继；`public/operations` 的导出逐条入账；新增 RFC-552 用例并登记
- [ ] AC-4 行为不变；受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `7f9ef1a5d` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证查出两处本人缺陷（下面的连锁与 `rfc305` 的边清单），已改并复验；另查出 RFC-551
的一处遗漏，已单独修正（`7f9ef1a5d`）。

- **判据**（design §1）：`public/operations` 的根照常遍历；其中取 `@/platform/operations/contracts` 的类型不计、不往里遍历（类型实参照查）；调用
  平台描述构造器的函数跳过——平台实际只有 `defineQueryOperation`、`defineCommandOperation` 两个，design 写的第三个不存在；遍历去重的键带上入口
  类别，同一声明从两类入口到达时各查一遍。`rfc294-architecture-preflight` 里原先钉着整体豁免的 fixture（不构造描述的 `create*Descriptors` 也
  不计）改为真的描述工厂，另加“不构造描述的函数照常检查”的负对照。
- **连锁**（与 design §2 不同的一处）：运维函数离开 public 后，knowledge-evolution 有 14 个类型只经它们的签名才算 public 可达，逐轮变成未消费
  （共五轮），按使用方落位：`FusionOperations` 进 `application/ports/fusionOperations.ts`；`FusionPersistence` 连同它带的命令载荷、认领输入、
  状态比较、两个回执、资源播种、技能访问与身份、内建代理播种、记录补丁进 `application/ports/fusionPersistence.ts`；domain 在用的内建工作流播种
  与持久化记录进 `domain/fusionWorkflowSeed.ts`、`domain/fusionRow.ts`（domain 不取 application）。运维函数转出改放 `composition/fusion.ts`
  ——`composition.ts` 是只装 schema 的组合根（RFC-395 I-a），在那里转出会把编排代码带进 schema 的 import 图。knowledge-evolution 的
  public 少 19 个名字，`FusionPersistence` 的 `Partial` 那条偏差随之离开清单。
- **显形的旧债**（与 design §3 相比多一组）：除 OIDC provider 仓储与 source-control 仓储存储两组外，development-automation 交给路由的四个句柄合同
  带开放载荷（`Record<string, unknown>`、索引签名、证据文件视图的流打开函数）——原先被描述工厂的根抢先遍历、归在工厂名下，工厂跳过后在各自的根
  下显形。七条都登记进 `PUBLIC_SURFACE_DEBT` 并写明后继（四个句柄合同的后继是按路由的 zod schema 收成闭合类型，S9 第 2 项）。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 23 个 TS 文件（18 个生产文件、5 个用例）无告警，生产
  文件另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：首轮按 RFC-533 的口径与 RFC-550 的选法选出 605 个（语义层 421、经夹具与测试助手补 184），
  603 个通过——`rfc376-structural-guards` 红在 knowledge-evolution 的未消费计数 1（上面那条连锁的第一轮，**本人遗漏**，随连锁处理），
  `rfc376-report` 红在 RFC-551 留下的非空校验（它读已提交的 HEAD，与本 RFC 无关，已单独修正）。连锁处理完后按全部改动重选 654 个（语义层
  467、补 187），653 个通过；红的 `rfc305` 是**本人遗漏**——它的 identity-access 边清单还记着 knowledge-evolution `public/participants.ts`，
  连锁把那条 import 带进了 `application/ports/fusionPersistence.ts`；已随改，复跑 15 / 15，读 guard-manifest 的 22 个用例文件复跑全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：八种变异各自让 RFC-552 用例红——整体豁免回来（`rfc294-architecture-preflight` 的
  精确清单同时红）、所有函数都算描述工厂、`public/operations` 里不再放行合同类型（偏差清单同时红）、合同类型在所有入口都放行、
  `public/operations` 多出一个导出、knowledge-evolution 的 operations 入口回来、bootstrap 改回从旧入口取运维函数、`FusionPersistence` 重新从
  public 转出（`rfc376-structural-guards` 的计数门同时红）。
- **架构报告**（候选与对照各出一份）：public 类型偏差 53 → 59（显形 7 条、离开 1 条，逐条与 `PUBLIC_SURFACE_DEBT` 相等）；public 面少 20 个、
  多 1 个（knowledge-evolution 的 19 个名字离开、`OwnerIdentityQueries` 从 operations 换到 queries）；未消费 public 符号仍为 0；后端生产文件
  净多 1 个；跨上下文 import 清单条数不变；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：五个运维函数与 14 个类型逐字搬，使用方只改 import；bootstrap 的两处动态 import 与一处静态 import 改从 `composition/fusion.ts`
  取，拿到的是同一组函数（它只转出 application 的实现），启动步骤的次序与调用不变；`OwnerIdentityQueries` 是类型、只换入口。
- **判据**：只影响 `public/operations` 的根——别的入口里合同类型照旧计、描述工厂之外的导出照常检查；fixture 与负对照钉住三条规则的两侧，
  偏差清单与实测逐条相等。
- **分层**：挪入的端口在 application、两个记录与播种在 domain，domain 不取 application；`composition/fusion.ts` 只转出、不加逻辑。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-551 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-552 public/operations 的类型检查豁免收窄到操作描述工厂（RFC-294 S9 第八步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
