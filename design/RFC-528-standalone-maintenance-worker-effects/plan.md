# RFC-528 实施计划

依赖：RFC-527。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-528-T1 单机 worker 部分**：新增 `bootstrap/standaloneMaintenanceWorker.ts`，7 族的单机构造与此前回落同一组工厂、同一组参数；
  `standalone.ts` 头注释指向它（design D1）。
- **RFC-528-T2 一次选择**：`resolveMaintenanceWorkerEffects` 与 `MaintenanceWorkerEffects`；两个数据库适配器在打开客户端之后各调一次，图只读选好的
  效果，删去 9 处本机构造、`resourcePackageArtifactRecovery` 里的回落与内容维护的 `?? 'local-file'`（design D2）。
- **RFC-528-T3 托管描述符列全**：用例钉住生产描述符的 `capabilities` 含全部 7 族（design D3）。
- **RFC-528-T4 用例与锁**：钉旧位置的锁改指单机 worker 部分或选择处；按被改文件的路径筛出读其源码的全部用例逐个核对（design D4）。
- **RFC-528-T5 门与账本**：新增 RFC-528 用例并登记 guard-manifest；计数降的收紧到实测。
- **RFC-528-T6 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、在 `tests/` 内按 import 求传递闭包（含以字符串
  引用的 `.ts` 夹具）到达被改文件的用例与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给
  CI 的 backend 分片。
- **RFC-528-T7 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 1 项余项里维护 worker 的一半达成（daemon 一侧随第 6 项）。

## 验收清单

- [x] AC-1 图不再构造本机效果、不再逐项回落；单机 worker 的本机效果只在单机 worker 部分给出，选择只在一处
- [x] AC-2 单机、托管与部分描述符得到的对象不变；托管不构造本机实现；资源包恢复两项同时选照旧被拒
- [x] AC-3 生产的托管描述符列全 7 族；worker 线程不加载 `bootstrap/standalone.ts`；计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 35～60，主要是本机其他进程与 Docker 虚拟机）。验证在候选导出仓库里跑（HEAD 加本 RFC 的路径，核对与工作树
逐字相同）；对照导出仓库与 HEAD 的树相同。首批跑在 `49c302647` 之上；之后 HEAD 前进到 `1551dda63`（RFC-527 的用例补正，不碰本 RFC 的路径），候选随之
重同步。集中验证查出本人一处缺陷（新用例自己的写法），修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 14 个 TS 文件无告警，改动的 4 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过（18 个文件）。
- **首批**（60 秒；候选与对照同时、按同样的顺序各 4 个 worker）：320 个文件——全部 142 个 `tests/architecture/`（`census.ts` 的 bootstrap 登记表随改）、
  改动过的用例、读被改文件源码的用例，以及在 `tests/` 内按 import 求传递闭包（含以字符串引用的 `.ts` 夹具）到达维护 worker 启动路径的用例
  （装配图、效果选择、单机 worker 部分、worker 入口与登记、监督者与运行时、daemon 会话与启动；worker 线程按文件路径启动，只按导入选会漏掉经
  监督者起 worker 的用例）。候选 312 个文件通过、对照 313 个（对照没有新用例）：
  - 本人缺陷：RFC-528 用例核对“托管独有的族原样转交”时按“成员后跟逗号”匹配，而压缩写法会删去对象最后一个成员后的逗号，`objectPublications`
    一条永远对不上——用例自己的写法，生产代码无误。改为匹配逗号或右花括号，复验 4 / 4（含负对照与 worker 线程不加载单机 profile 的闭包核对）。
  - `rfc359-w5-composition-root-route-surface` 只在候选一边撞 PostgreSQL 一支 60 秒的钩子时限；两边同时各以 1 个 worker 再跑，都 2 / 2、各 13.1 秒。
  - 其余 6 个两边相同、红的同类：`rfc376-report` 300 秒、`rfc370-committed-architecture-source` 150 秒、`rfc370-employee-input-root-bindings`
    20 秒、`rfc395-v3-contracts` 90 秒钩子、`rfc311-perf-guards` 的 PostgreSQL 一支 180 秒与 30 秒钩子（时限），`rfc321-repository-publication-ratchet`
    要可达的 git 历史（导出仓库没有）。
- **契约核对**（`docs/dev-gotchas.md` RFC-527 的第二条教训）：本 RFC 不收紧任何对外的入参——装配图的入参、`MaintenanceWorkerEffectsSelections` 与
  描述符协议都不变，新增的只是 bootstrap 内的类型与单机 worker 部分；经未改的生产模块调到被改项的只有经 worker 启动路径的用例，已在首批里。
- **终验**（最终候选，重同步后）：5 个文件——修正后的 RFC-528 用例与读 guard-manifest 的 4 个架构用例（新用例的行数随修正改了一行），
  全过（66 条：4 + 15 + 24 + 17 + 6）。
- **架构报告**（`scripts/architecture-report.ts`，候选与 HEAD 各出一份）：60 项计数与各门的位置都不变；跨上下文导入 7,518 条不变（装配图删去 10 条
  导入，单机 worker 部分新增同样的 10 条）；生产文件 +1；各模块符号属主只有删去的 `resourcePackageArtifactRecovery` 与新增的选择、单机 worker
  部分与四个类型。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- `b675fc097`（实现，父提交是 `07d6542d3`）：exact SHA 主 CI run 44929174434 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与 `CI required`）；
  未重跑。
- 本 RFC 的落档提交 `07d6542d3`（只改文档；同一提交记下 RFC-527 转 Done）：主 CI run 44928972265 的 70 个 job 第 1 次运行 68 个通过（含 design/
  的链接检查与 backend 全部分片）；macOS e2e 分片 3/4 在测试步骤里撞 job 的时限被取消（同一分片在 `49c302647` 上 17 分 33 秒通过；本提交只改文档），
  属 runner 环境，`CI required` 随之红；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **单机 worker（没有描述符）得到的对象不变**：7 族在选择处由单机 worker 部分构造，工厂与实参逐个对照此前的回落——内容存储
  `createLocalRuntimeContent(db, appHome)`（同一个适配器客户端）、归档内容 `{ content: createFileTaskArchiveContent() }`、资源包恢复
  `composeLocalResourcePackageArtifactRecovery({ db, appHome, pluginsDir: join(appHome, 'plugins'), recoveryEffectsFactory, log })`（PostgreSQL 此前不传
  `log`、现在传 `undefined`，函数里同为缺省日志器；SQLite 照旧传 `intentMaintenance`）、草稿区与准备 effect 建在
  `{ taskPorts: composeSourceControlTaskPorts(db), db, appHome }` 上、维护文件系统
  `createNodeWorkspaceMaintenanceFilesystem({ appHome, isMaterializingTask, invalidateWorkspacePath: invalidateCallGraphIndex })`、插件代际回收
  `createPluginGenerationFilesystemGcPort(join(appHome, 'plugins'))`、intent 的草稿区与工件内容（`pluginsDir` 此前是同值的 `intentPluginsDir`）。
- **构造时机不变**：此前这些回落分别在图的装配里与工作区维护命令的工厂里（工厂在命令构造时调一次）构造，现在在适配器打开客户端之后的选择处构造，同在
  装配期、任何作业运行之前。草稿区与准备 effect 现在用自己的一份 task 端口：`composeSourceControlTaskPorts` 只在客户端上建不带状态的查询与存储
  （`TaskWorkspaceMaintenanceStore` 只持有客户端），与此前共用一份等价。
- **托管 worker 不变**：生产描述符列 11 族，7 族都由描述符给出，`??` 的右侧不求值，不构造单机实现；托管独有的 4 族原样转交；工作区维护一族此前按
  子项逐个回落，类型上三项必有，托管给的对象原样使用，与此前相同。
- **部分描述符（用例）不变**：每族取描述符给的或单机部分的，与此前逐项回落相同；选了恢复内容时它照旧交给本机恢复，两项同时选照旧在选择处被拒。
- **内容维护不变**：单机的内容存储外部类型就是 `local-file`，与此前没给时的缺省相同；托管照旧按托管内容存储的外部类型。
- **对外合同不变**：装配图的入参、`MaintenanceWorkerEffectsSelections`、描述符协议与 daemon 的单机 profile 都不变（`standalone.ts` 只改头注释）；
  worker 线程照旧不加载 `bootstrap/standalone.ts`（用例按值导入求闭包钉住）。
- **账本与锁**：`census.ts` 的 bootstrap 登记表登记单机 worker 部分；钉旧位置的锁随改（RFC-389 的惰性回落改钉选择处、`rfc431` 把单机 worker 部分
  归为 worker 一侧，RFC-513 / 523 / 525 / 526 / 527 与 `rfc370-storage-and-worker-root-bindings` 改钉选择处与单机 worker 部分）；guard-manifest
  登记新用例，改动过的条目行数按各条原有的计法随改；计数不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-527 转 Done）；实现与验证后再提交
`refactor(backend): RFC-528 维护 worker 的单机效果收进单机 profile（RFC-294 S12 第九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
