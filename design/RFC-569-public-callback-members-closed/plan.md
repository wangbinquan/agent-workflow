# RFC-569 实施计划

依赖：RFC-568。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-569-T1 task-execution**：`applyRepair` 收 `notices`；回收策略改为闭合接口，两个实现与调用点随改（design §1、§2）。
- **RFC-569-T2 resource-catalog 与 development-automation**：钩子改可选方法；文件视图继承下载句柄；问题码类型（design §3～§5）。
- **RFC-569-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 降低；构造这些形状的用例随改；新增 RFC-569 用例并登记 guard-manifest。
- **RFC-569-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-569-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 五个 public 根的闭包里不再有函数类型节点或裸 `typeof`；`PUBLIC_SURFACE_DEBT` 删去 5 条，`public-surface-deviations` 40 → 35
- [x] AC-2 行为不变（既有用例与新增断言）
- [x] AC-3 新增 RFC-569 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（70 / 70）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `0a1069435` 加本 RFC 的 37 个路径，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷一处（已修复并复验）**：漏查一个读端口形状的结构守卫。`architecture/rfc317-lifecycle-origin-neutrality`（RFC-317 T28）钉着回收策略端口的
  两件事——入参属性集逐字等于中立集合、返回的是闭合联合而不是裸 boolean——它的两个读法只认“函数类型别名”，端口改成接口后读不到，选集运行里红。
  守卫的意图没变：把两个读法改成读接口方法 `decide` 的第一个参数与返回类型（入参认内联的字面量类型与同一文件里声明的接口 / 字面量别名；端口不是
  “带这个方法的接口”、入参声明在别的文件或带继承时回 null，不假绿），自变异夹具随改。改完后对真实端口做了两种变异（入参多一列集成归属、返回裸
  boolean），守卫都红。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 26 个 TS 文件（11 个生产文件、13 个用例文件、2 个测试
  助手）无告警（中途一处：codemod 留下的一个未使用 import，eslint 报出后删去），生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与
  三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 639 个用例文件（语义层 445、经夹具与测试助手补 194；
  只改类型的六个生产文件不按“被谁 import”扩选）。首轮 638 个通过，1 个红就是上面那处；守卫改好后单独重跑 8 / 8。没有把选集扩到“经任何测试助手
  间接走到状态写点”的近两千个用例文件：策略的值全部经有类型的位置传递（用例与生产代码里没有对它做 `as never` / `as any` 一类的转换），形状由
  `tsc` 保证，其余由 CI 的全量运行覆盖。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部 142 个用例文件、`rfc317-*` / `rfc294-*` 与钉着本次改动位置的边界
  用例，共 169 个文件、1615 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-569 用例 10 / 10、
  `rfc294-architecture-preflight` 15 / 15、`rfc317-guard-corpus-floor` 24 / 24、`rfc317-guard-negative-fixture` 17 / 17、
  `rfc317-lifecycle-origin-neutrality` 8 / 8、`rfc282-single-implementation-lock` 24 / 24、`rfc477-rollback-limits-launch-preflight-owners` 15 / 15、
  `rfc534-session-process-registrations-boundary` 6 / 6、`rfc467-injection-oracle-relocation` 7 / 7、`rfc551-public-unconsumed-sweep-lock` 11 / 11。
- **变异验证**（候选导出仓库里，每种变异复原后导出仓库无改动、树哈希不变）：十六种变异都被认出。
  - 形状：五个声明各自退回开放形状——修复入参多一个回调、策略的成员写成函数类型的属性、提交钩子写回函数类型的属性、文件视图自己声明一个函数类型
    的成员、问题码经 `typeof` 取常量（都是 RFC-569 用例 ① 与 `rfc294-architecture-preflight` 同红）。
  - 修复路径：路由不传共用的通知对象而自己拼一个（用例 ②）；修复不再上报新告警、不再上报已解决的任务、把整行告警交出去（用例 ② 的文本与
    `rfc359-w8-auto-repair-conformance` 的行为断言同红）。
  - 回收策略：状态写点在每个状态都询问策略、策略抛错时让状态写入失败（后者 `rfc534-session-process-registrations-boundary` 同红）、“永不回收”策略
    改成回收（RFC-569 用例 ④）；webhook 策略给没有 webhook 归属的任务回收（`rfc359-w7-integration-composition-roots` 红）；第二处直接调用策略
    （用例 ③）；入参多一列集成归属、返回裸 boolean（`rfc317-lifecycle-origin-neutrality` 红）。
  - 类型层：给 `decide` 与 `TaskLifecycleAlertNotices.alert` 各加一个必填入参、把问题码类型改成另一个字面量，候选导出里 `tsc` 报 18 处、11 个文件
    ——策略唯一的调用点、诊断与修复两处对通知的调用、问题码常量的声明，以及 7 个用例文件（含 RFC-569 用例的两条编译期断言）。策略的两个实现与
    路由的通知对象不报（参数更少的函数照样可赋值），所以调用点才是这类改动的编译期防线。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `public-surface-deviations` 变了，40 → 35（删去的正是清单里那 5 条）；public 面的符号数
  （989）、变更入口普查（2393，逐条相同）、跨 context import（7532）、生产文件数与其余各节不变。public 面里十个条目的形状记录随之变化：回调变成
  方法后，`TaskRouteOperations` 的方法计数 27 → 29、`DevelopmentMissionOperations` 24 → 26（字段数不变）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，46 / 46 通过。

## CI（AC-4）

- `412767ff0`（实现，父提交是 `0a1069435`）：exact SHA 主 CI run 45464888702 的 70 个 job 全部成功——全部后端分片、真实 PostgreSQL、前端、三个
  平台的构建与检查、ubuntu / windows / macOS 的全部 e2e 分片。同一提交触发的 windows-platform（run 45464888629）通过；同一提交上的定时运行
  git-protocols-e2e（run 45468226002）、integration-opencode（run 45465516785）与 Release upgrade nightly（run 45465191167，87 个 job）通过。
- **给前四个 RFC 的后继证据**：这个 run 里 macOS 的四个 e2e 分片都分到了 runner 并通过，其中 `shard 4/4` 是 RFC-565～RFC-568 四次主 CI 都没有跑到的
  那一格。`412767ff0` 是这四个提交的后继（`ff3442970`、`948d2353c`、`f8dc493ec`、`0a1069435` 都是它的祖先），其间没有改 e2e 用例、前端与 Playwright
  配置，所以这一格的结果对它们同样成立。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **修复路径的广播不变**：路由原来把 `broadcastLifecycleAlert`、`broadcastLifecycleAlertResolved` 两个函数作为回调传入；现在传的
  `LIFECYCLE_ALERT_NOTICES` 的两个成员就是这两个函数。修复执行里“新告警只交出 `taskId`、`rule`、`severity` 三个字段”的投影原样保留（原来在
  `noticeCallback` 里，现在在同一处的箭头函数里），解决通知照旧只传任务 id。自动修复那一路的入参没有动。
- **回收判定不变**：`resolveTerminalWorkspacePruneDecision` 仍只在 `done` / `canceled` 询问策略，策略抛错（同步抛或拒绝）仍记日志并回“不回收”；
  webhook 策略的函数体原样搬进 `decide`；“永不回收”仍回 `{ prune: false }`。
- **提交钩子与文件视图**：只是声明形态变了。钩子的调用点（`hooks?.before?.()`、`hooks?.after?.(versionIndex)`）与融合交入的对象不用改；文件视图
  对象的四个键与出站校验不变，路由照旧调 `openAll()`。
- **问题码**：常量的值与类型都还是 `'plugin-disabled'`；类型与常量相邻声明，常量标注成这个类型，写错任何一处编译不过。`rfc282` 的“字面量只在声明
  处出现”一条把该文件的允许次数由 1 改为 2 并写明原因，`rfc477` 钉着的导出名单多一个类型名。
- **用例一侧**：一次性的策略经新助手 `prunePolicyOf` 构造；调用策略处改调 `decide`；`applyRepair` 的调用改传 `notices`。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-568 的转 Done（主 CI 的 macOS e2e 4/4 没有分到 runner、windows-platform 的 push 运行被同一提交的定时运行顶替，已归因）同批。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
