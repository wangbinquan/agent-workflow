# RFC-542 实施计划

依赖：RFC-541。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-542-T1 行规则标记**：`rowRules.ts` 删去 `boundSessions`，“已套过”记在会话对象自己的符号属性上（design D1）。
- **RFC-542-T2 单行写入**：`singleInsert.ts` 删去 `inserts`，带围栏的单行写入记在根库对象自己的符号属性上（design D2）。
- **RFC-542-T3 用例**：新增 RFC-542 用例并登记 guard-manifest（design D3）。
- **RFC-542-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-542-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十步。

## 验收清单

- [x] AC-1 `rowRules.ts` 与 `singleInsert.ts` 没有模块级集合；标记与单行写入记在各自的对象上
- [x] AC-2 行规则翻译与单行写入的结局不变
- [x] AC-3 模块级可变单例 50 → 48、计数不升；新增 RFC-542 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 22～33，另有会话在跑）。验证在候选导出仓库里跑（HEAD `c9a5f9388` 加本 RFC 的代码路径，核对与工作树
逐字相同），对照是同一 HEAD 的另一份导出。集中验证查出一处本人缺陷，已修并复验（另有静态自查时新用例一处未用的辅助函数被 eslint 认出，
已删）：

- **本人缺陷：包着根库的代理会拿到根库的围栏写入**。单行写入最初按 `Object.hasOwn(db, key)` 认根库。实现门自审时认出：代理的默认 trap 把
  `Object.hasOwn` 与属性读都转发给根库，测试里包着根库、拦截 `insert` 的代理在已标记代际的 PostgreSQL 库上会拿到根库的围栏写入、直接走连接池，
  而按身份键的旧表从不认代理。把修复前的写法放回候选（变异 m4），`rfc359-w7-resource-limit-conformance` 的 PostgreSQL 一支「⑧ 审计写失败只降级
  告警」就红（应无审计行，实有 1 行）；按 RFC-533 口径选出的语义层没有选到这条用例。改为槽里记登记时的对象、读时比身份（design D2、§5、
  §6 第 2 条），RFC-542 用例补透明代理与拦截 insert 的代理两条；`docs/dev-gotchas.md` 记下这一类。
- **静态**（修复后的最终树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 3 个 TS 文件无告警，改动的 2 个生产文件另过
  promises 配置；prettier：改动的代码、guard-manifest 与三件套通过（`docs/dev-gotchas.md` 的新条目不引入 prettier 差异；该文件原有 3 处差异，
  不是本 RFC 的）。
- **选择**：按 RFC-533 的口径从 2,987 个用例文件里选出 1,934 个，绝大多数经 `insertOne`（几乎每个种数据的测试助手都用它）与句柄上下文的 import
  闭包入选。语义层 179 个：改动的 1 个用例、全部 `tests/architecture/`（142 个）、语料守卫、在 import 之外以路径点名被改文件的 2 个、点名行规则 /
  单行写入 / 代际围栏 API 的 37 个、直接导入 `rowRules.ts` 的 4 个；`insertOne` 的数百个导入方只经 import 闭包入选，交给 CI 的全量分片；
  `tests/fixtures/` 里没有钉被改文件的摘要锁。修复后另加代理清单：全部用 `new Proxy(` 的用例文件与 `helpers/competingWriter` 的导入方，共 59 个。
- **修复前的语义层**（60 秒；候选 5 个 worker）：179 个文件 178 个通过；红的 1 个是长扫描用例 `rfc376-report` 撞写死的 300 秒，与对照同时 A/B、
  在两边放大时限后都 16 / 16。
- **修复后的复验**：代理清单 59 个文件在候选上 57 个通过（RFC-542 用例 6 / 6、`rfc359-w7-resource-limit-conformance` 16 / 16、`runner` 40 / 40 等）；
  红的 2 个（`rfc370-isolation-workspace-bindings` 与 `rfc395-v3-source-access` 的 PostgreSQL 支各撞写死的 30 / 90 秒）与对照同时 A/B，在两边放大
  时限后都全过（30 / 30、24 / 24）。语义层 179 个在修复后的树上全部重跑：`rfc376-report` 放大时限后 16 / 16；其余 178 个里 174 个通过，红的
  4 个都撞写死的时限（`rfc395-neutral-query-boundary` 的 60 秒语料扫描、`rfc400-collaboration-task-participants` 的 30 秒、
  `rfc395-target-test-database` PostgreSQL 支的 20 秒、`rfc395-v2-collab-gates` 编译 PostgreSQL 源目录的 90 秒 `beforeAll`），修复前的同一批里
  它们都通过；这 4 个与对照同时 A/B，在两边放大时限后都全过（2 / 2、6 / 6、22 / 22、6 / 6，两边用时相当）。没有只在候选上红的用例。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：去掉身份比较（派生句柄与代理都取到根库的围栏写入）、会话不记“已套过”的标记
  （重复绑定再包一层）、模块级登记表回来、放回修复前的 `Object.hasOwn` 判定，各自让 RFC-542 用例红；最后一种另让
  `rfc359-w7-resource-limit-conformance` 的 PostgreSQL 一支红。
- **架构报告**（修复后的候选与对照各出一份）：模块级可变单例 50 → 48（删去的正是 `bindSchemaRowRuleErrors` 与 `bindSingleInsert` 两条写模块状态的
  登记）；模块符号属主 32,468 → 32,470（两张表换成两个符号键、一个槽类型与一个读取函数）；跨上下文导入、写入入口清单、公开面与减速带计数、
  门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对；自审认出一处本人缺陷（见集中验证第一条），修复并复验后结论 PASS：

- **行规则翻译不变**：“已套过”从模块级 `WeakSet` 改为会话对象自己的不可枚举、不可写符号属性，判断与记下的时机不变（有标记即返回、套之前记下）；
  查询与会话方法的翻译包装、事务进入时对事务句柄再套一次，逐字不变。交给翻译层的都是 drizzle 原生会话（可扩展的普通对象，包装本就要给它写
  方法），不经代理；SQLite 事务与 PostgreSQL 保存点共用外层会话，照旧认作已套。
- **单行写入不变**：带围栏的 INSERT 从模块级 `WeakMap` 改为根库对象自己符号属性上的冻结槽 `{ owner, insert }`，`insertOne` 只在 `owner` 就是传入的
  对象时用它——与按身份键的旧表同一判定：根库走围栏（未标记代际或有 `beforeWrite` 时照旧回落），派生句柄、包着根库的代理与没登记的库照旧走
  普通写入；重复登记照旧以后一次为准（属性可重定义）。PostgreSQL 客户端把登记过的 `db` 原样交给调用方，生产代码里没有包库或会话的代理
  （`new Proxy` 只包 bun:sqlite 的预编译语句）。
- **用例**：新增 RFC-542 用例并登记 guard-manifest（`lines` 随用例定稿同步为 205）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-541 转 Done）；实现与验证后再提交
`refactor(backend): RFC-542 行规则错误翻译与单行写入的按句柄侧表归各自的句柄（RFC-294 S12 第二十三步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
