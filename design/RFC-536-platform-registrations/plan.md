# RFC-536 实施计划

依赖：RFC-535。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-536-T1 配置生效监听**：`createConfigAppliedListeners()`；应用配置绑定带一组、`composeCommands` 通知它；daemon 会话与维护服务在这一组上
  登记（design D1）。
- **RFC-536-T2 执行可用性**：读取器记在 app 上，删去模块级表（design D2）。
- **RFC-536-T3 事务观察**：观察者记在客户端上，删去模块级表（design D3）。
- **RFC-536-T4 用例与锁**：新增 RFC-536 用例并登记 guard-manifest；读旧形状的用例随改（design D4）。
- **RFC-536-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径与被改名字的字符串形态选用例、按分段拼出的路径补搜，红的与 HEAD
  同时 A/B；架构报告对照；变异验证。
- **RFC-536-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第四步。

## 验收清单

- [x] AC-1 三个文件没有模块级集合与写模块状态的登记函数；配置生效监听每份应用配置一组，登记与通知用同一组
- [x] AC-2 执行状态读取器与事务观察者随各自的对象走；行为不变
- [x] AC-3 模块级可变单例 61 → 58、计数不升；锁随改；新增 RFC-536 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 17～28，另有会话在跑）。验证在候选导出仓库里跑（HEAD 加本 RFC 的 22 个路径，核对与工作树逐字相同）：
语义层的候选以 `8b625e2a8` 为底，A/B 的候选与对照以 `bd3b4a323` 为底（两者只差 RFC-535 的补正，不碰本 RFC 的文件）。集中验证没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 21 个 TS 文件无告警，改动的 9 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **选择**：按 RFC-533 的口径选出 1,518 个文件，绝大多数只因 `db/client.ts`（几乎每个用例都导入，它的改动只有事务观察者的存放处，生产里只有
  维护 Worker 的客户端带观察者）与 provider HTTP 测试助手（多交出一个字段）的 import 闭包入选。先跑语义相关的一层：改动的用例、全部
  `tests/architecture/`、读被改文件源码的用例、语料守卫，加上提到配置热应用、执行可用性、事务观察、维护服务、daemon 会话与应用配置绑定的用例，
  共 693 个（其中 14 个只按关键字入选）；其余 839 个只经 import 闭包入选，交给 CI 的全量分片。按被改与删去名字的字符串形态全仓搜，语义层之外
  只剩一处测试注释与冻结协议的测试助手 `tests/helpers/epoch1Protocol/sqliteClient.ts`（它有自己的同名表）。
- **语义层**（60 秒；候选 6 个 worker）：693 个文件。改过的用例文件全过（RFC-536 用例 8 / 8、`test-suite-policy` 12 / 12、`rfc266` 16 / 16、
  `rfc370-root-background-bindings` 4 / 4），`rfc384-daemon-intent-bundle` 的 PostgreSQL 一支一条撞时限（SQLite 一支同名通过，A/B 两边都过）；红的
  13 个，见下面的 A/B。
- **伪造的依赖**：全仓搜手搭的应用配置绑定与维护服务选项：绑定都经 `composeApplicationConfigurationBinding` 构造、自带 `listeners`；维护服务选项
  都有类型、`tsc` 看得到（`rfc359-ac10-maintenance-service-seam`、`rfc384-daemon-intent-bundle` 补上）。
- **变异验证**：在候选导出仓库里把监听集合挪回模块级（所有应用配置共用一组），RFC-536 用例红三条——真实语料认出
  `module-level collection:configAppliedListeners.ts:listeners`，“两组监听互不通知”收到另一组的监听，“两份绑定各通知各的”单独跑时收到 `second`
  （Expected 只有 `first`）；复原后与工作树逐字相同。
- **A/B**（候选与对照同时、各 3 个 worker、各用各的库；按 RFC-535 的教训，两个长扫描用例 `rfc294-architecture-preflight` 与 `rfc376-report` 在
  两边的副本里临时放大它们写死的时限、跑到底再比）：语义层红的 13 个文件。两边都红的 7 个、都过的 4 个（`rfc376-report`、
  `rfc384-daemon-intent-bundle`、`rfc395-target-test-database`、`scheduler`），只在对照上红的 2 个（`rfc238-mcp-runtime-test-real-e2e`、
  `rfc294-architecture-preflight`），没有只在候选上红的文件；按用例名 169 过 / 13 红对 167 过 / 15 红。`rfc294-architecture-preflight` 在候选上
  14 / 14（能力伪造门那条也过），对照上一条公开面清单的扫描撞 60 秒时限；语义层里它在候选上红的能力伪造门违例是 RFC-535 的缺陷（当时的候选
  以 `8b625e2a8` 为底），补正后两边都没有。两边同名同错：`rfc167`（Expected `failed`，Received `running`）、`rfc321` 只因导出仓库没有真实的 git
  历史，`epoch1-permission-text-backup`、`rfc359-w6-t26`、`rfc395-production-source-manifest`、`rfc398-postgresql-provisioning` 与
  `scheduler-default-retries` 撞时限。
- **架构报告**（候选与对照各出一份）：模块级可变单例 61 → 58（删去的正是三个文件各 1 条）；计数、门与指标没有变化；跨上下文导入 7,532 → 7,533
  （system-operations 的两个组合文件对 platform 配置监听的导入随改名换了形状）；模块符号属主 32,470 → 32,470（改名）；写入入口清单 2,388 → 2,391
  （三个新函数各一条）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- `577db8ccd`（实现，父提交是 `b556cb703`）：exact SHA 主 CI run 45062944465 的 70 个 job 第 1 次全部通过；同一提交触发的 windows-platform
  （run 45062944463）与 maintenance-soak-nightly（run 45062944454）通过。
- 本 RFC 的落档提交 `b556cb703`（只改 8 个 Markdown 文件；同一提交记下 RFC-535 转 Done）：主 CI run 45059624802 的 70 个 job 里，Playwright e2e
  （windows-latest 2/4）红在 `rfc199-save-reliability.spec.ts:375`（“editor exact revision handoff shows a wizard mismatch before any stale launch”，
  `wizard-workflow-version-mismatch` 15 秒内没出现，弱网保存的时序用例），`CI required` 随之红，其余 68 个通过。该提交的代码与 `bd3b4a323`（70 / 70）
  逐字相同，后继 `577db8ccd` 的主 CI 里同一分片通过，此前 9 个红过的主 CI 也都不在这一分片——不是该提交引入的，按环境性时序记录；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **配置生效监听不变**：`createConfigAppliedListeners(key)` 的 `register` / `notify` 就是此前两个函数逐字搬进闭包——同步调全部监听，监听抛错只记
  日志（照旧带 `configPath`），有异步结果时返回等全部完成的 Promise，否则返回 `undefined`；注销即删。应用配置在设置持久化之后才通知
  （`createApplicationConfiguration` 的顺序未动）。
- **同一组监听**：部署 profile 只建一份应用配置绑定，同一个对象交给 daemon 应用（HTTP 装配的设置保存经它的 `composeCommands` 通知）与 daemon
  会话（镜像刷新在 `listeners` 上登记、维护服务的 `configApplied` 就是这一组）；此前三方靠同一个 `notificationKey` 在进程表里相遇，现在直接
  共用一组。两份绑定即使键相同也不再串通——生产里每个 daemon 只有一份绑定，用例改为在各自的绑定上登记。
- **执行门控不变**：读取器记在 app 自己身上（只认自有属性，与此前按对象身份查表等价）；重复绑定照旧抛 `execution-availability-already-bound`，
  未绑定时状态查询照旧抛 `execution-availability-unbound`、门控照旧放行；读到的状态与 503 的内容不变。
- **事务耗时上报不变**：观察者记在客户端自己身上，`observeDbTransaction` 在原来的两个时点（显式事务结束、同步事务结束）以同样的毫秒数调它；
  没挂观察者的客户端什么都不做。生产里只有维护 Worker 的客户端带观察者。
- **用例与锁**：读旧形状的用例改用绑定或一组监听（`rfc370-application-configuration-binding`、`rfc370-selected-settings-storage`、
  `rfc370-config-applied-ack`、`rfc266-concurrency-hot-apply` 经测试助手交出的那一组、`rfc349-config-route-provider-boundary`）；钉登记点的
  `rfc370-root-background-bindings` 改钉维护服务的 `configApplied` 与 `listeners.register`；`rfc370-m1` / `rfc370-v2-execution-authority` 随改名；
  构造维护服务选项的 `rfc359-ac10-maintenance-service-seam`、`rfc384-daemon-intent-bundle` 补字段；guard-manifest 登记 RFC-536 用例，改动过的条目
  行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-535 转 Done）；实现与验证后再提交
`refactor(backend): RFC-536 配置生效监听、执行可用性与事务观察不再挂进程级登记（RFC-294 S12 第十七步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
