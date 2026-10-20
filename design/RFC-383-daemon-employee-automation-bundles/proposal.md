# RFC-383 守护进程模块组第四批：数字员工与开发自动化（RFC-294 S2b）

- **状态**：In Progress（2026-10-20 落档并派发。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与
  实现门；规则取舍由本会话按推荐决定，见 §6。RFC-382 提交（`fddf8bf74`）且主 CI 全绿后派发）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）、design §10.2；前置
  [RFC-380](../RFC-380-daemon-module-bundles/proposal.md)、[RFC-381](../RFC-381-daemon-integration-bundles/proposal.md)、
  [RFC-382](../RFC-382-daemon-task-execution-bundle/proposal.md)
- **基线**：HEAD `fddf8bf74`（RFC-382 已提交；行号仅作定位提示，以实施时源码为准）
- **落位**：守护进程装配层。新增 `cli/daemonModules/digitalEmployee.ts` 与 `cli/daemonModules/developmentAutomation.ts`，入口根改为
  调用它们；provider 核心补一个守护身份端口，任务执行组补出宿主任务环境；digital-employee 与 development-automation 模块只做接线
  层面的最小调整（把写者切换门控做成应用层函数）

## 1. 背景

RFC-382 之后，数字员工与开发自动化是两个 provider 装配仍明显分叉、SQLite 进程内仍有重复的一组。2026-10-20 的两路只读研究
（基线 `fddf8bf74`）确认：

- **SQLite 进程内有两个数字员工模块**：S 的 `employeeOs`（OS 作业、启动步骤用）与 V 的 `digitalEmployee`（HTTP、MCP、事件触发的
  工作启动用）。V 的实例不在启动时初始化，第一次创作查询或第一次 Webhook / 事件工作启动时才初始化，会重复类型注册与自动升级；
  初始化的失败被缓存，一次瞬时错误（例如 SQLite 繁忙）会让 HTTP 创作与事件工作启动一直失败到重启。反应执行、工作区、平台工作项、
  输入存储、清单参与者也各有两份。PostgreSQL 只有一份。这一拆分是 RFC-359 W12 的有意决定（`tests/rfc317-work-start-bind.test.ts`
  文件头），但研究确认没有任何功能依赖两个实例，两个实例反而引发过一次启动竞态（`tests/rfc359-w4-d6c-bootstrap-idempotency.test.ts`）。
- **开发自动化的任务操作与输入上传在 SQLite 上由 V 构造**，S 只构造自动化本身；V 另有一整套只在测试中可达的回退
  （`composeFallbackDevelopmentAutomation`）。
- **由此与 provider 分叉产生的行为差异**：
  1. **PostgreSQL 的开发唤醒不看写者切换状态**：SQLite 每个周期先刷新写者状态，切换完成（`os-active` 且不再接纳遗留任务）后
     跳过唤醒；PostgreSQL 直接唤醒，且只在启动时写一次写者状态。后果：迁移状态页的模式与待排空数陈旧到重启；切换完成后，
     已关闭未合并的遗留任务的 MR 被重开，仍会生出一个新的遗留任务并重新占用 MR，破坏单写者切换。
  2. **遗留任务恢复只在 SQLite 上跑**：PostgreSQL 也会有遗留任务（SQLite 迁到 PostgreSQL 会复制它们，`adopt-mr` 会新建）。
     PostgreSQL 崩溃后，停在 `cancel-pending` 的任务不会再被驱动，过期世代的预备效果不会失效，到期唤醒要等第一次周期（30 秒）。
  3. **写者状态启动步骤**：SQLite 保存并记录日志，PostgreSQL 丢弃。
  4. **类型包漂移策略没有传给 PostgreSQL**：开发用的类型包覆盖（`AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY=1`）在 PostgreSQL 上会让
     启动在 `employee-authoring-ready` 以 `employee-type-revision-drift` 失败。
  5. **守护身份**：SQLite 每次调用准入；PostgreSQL 在启动步骤里准入一次，存进一个可变的 `let systemActor` 持有者。
  6. **程序存储**：S 的反应执行与执行合同夹具没有收到选择的程序存储（只有托管会选择它）。
  7. **宿主任务环境**：解析守护身份、资源授权、取消、读模型的闭包在三个根里各写一份；SQLite 每次调用现建取消命令，
     PostgreSQL 用会话的取消成员。

## 2. 目标

- **G1 中立构造函数**：数字员工组由 `cli/daemonModules/digitalEmployee.ts`、开发自动化组由 `cli/daemonModules/developmentAutomation.ts`
  的 provider 中立构造函数产生，两个 provider 的会话组合各调用一次；本批没有真正的 provider 差异，不加适配器表条目，托管选择经
  `adapters` 输入进入（同 RFC-381）。
- **G2 SQLite 进程内去重**：数字员工模块、反应执行、工作区、平台工作项、输入存储、清单参与者、写者切换、开发任务操作与输入上传
  每会话只构造一次；V 改用注入实例，测试回退调用同一构造函数；删除 `composeFallbackDevelopmentAutomation`。
- **G3 唯一宿主任务环境与守护身份**：宿主任务环境由任务执行组输出一份，数字员工与开发自动化共用；守护身份经 provider 核心的
  一个端口每次调用准入，删除 PostgreSQL 的 `let systemActor`。
- **G4 统一行为**：按 §6 统一 §1 列出的七处差异。

## 3. 非目标

- 意图模块组（RFC-384）；每次调用现建的协调器、两个 provider 运行时函数合一（RFC-385）；SQLite HTTP 装配并入中立挂载表、删除测试
  回退（RFC-386）；部署 profile（S2c）。
- 维护 Worker 线程里的数字员工与开发自动化维护命令（`platform/background/maintenanceWorker.ts`）保持原样。
- 唤醒提示表 `development_wake_hints` 的清理、切换后积累的未消费提示：不处理。
- 不改 API 路径、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

单机 SQLite：

1. **数字员工 HTTP 不再懒初始化**：创作页与事件触发的工作启动使用启动时已初始化的实例，第一个请求不再重复类型注册与自动升级；
   一次初始化失败不再让它们一直失败到重启（启动步骤本身失败时启动失败，同 PostgreSQL）。
2. **工作项「运行一个」与 OS 作业共用一个租约持有者**（同 PostgreSQL 现状）。

PostgreSQL（单机与托管）：

1. **迁移状态实时**：数字员工迁移状态的模式与待排空数随周期刷新，不再陈旧到重启。
2. **切换完成后不再生出遗留任务**：已关闭未合并的遗留任务 MR 被重开时，不再新建遗留任务、不再重新占用 MR（同 SQLite）。
3. **崩溃后恢复遗留任务**：启动时恢复停在 `cancel-pending` 的任务、使过期世代的预备效果失效、立即处理到期唤醒（同 SQLite）。
4. **启动日志记录写者状态**（同 SQLite）。
5. **开发用类型包覆盖可用**（仅开发环境变量打开时）。

两边：守护身份每次调用准入，未准入时报 `digital-employee-host-identity-not-admitted` / `digital-employee-catalog-authority-not-admitted`
（PostgreSQL 的启动检查保留）；托管选择的程序存储在所有反应执行与合同夹具上生效。

## 5. 验收标准

- **AC-1 构造位置**：两个模块组各由一个构造函数产生；S 与 P 各调用恰好一次；`server.ts` 只在 `deps.x ?? <同一构造函数>(...)` 回退中
  调用；三个入口根中不再直接调用 `composeDigitalEmployee(`、`composeDevelopmentAutomation(`、`composeReactionExecutionProvider(`、
  `composeDevelopmentMissionOperations(`、`composeMissionInputUploadOperations(`、`composeDigitalEmployeeWriterCutoverFor(`（结构锁）。
- **AC-2 单实例**：SQLite 守护进程内上述成员各一个实例，V 拿到的数字员工模块、写者切换、任务操作与 S 的是同一对象（行为测试）；
  迁移状态查询使用会话的写者切换实例。
- **AC-3 行为统一**：§1 的七处差异按 §6 统一，各有双引擎回归用例（design §5）。
- **AC-4 旧锁与账本**：受影响的旧锁改指新位置，不放宽断言意图；`server.ts` 到 resource-catalog `resourceAccess` 的两条 R1 随路由
  持久化迁出删除；`architecture/counts.json` 不升；RFC-310 OS 架构清单与新构造位置一致。
- **AC-5 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **构造粒度为每个 provider 会话一次**：同 RFC-380～382。
2. **SQLite 的数字员工统一为一个实例**：推翻 RFC-359 W12「SQLite 保留独立 OS worker 实例」的决定。理由：业务状态全部持久化，
   进程内只有缓存与一次性备忘；两实例带来懒初始化、失败缓存与重复升级；统一后与 PostgreSQL 相同。
3. **写者切换每会话一个实例，归数字员工组**：数字员工模块（迁移状态）与开发自动化（`{ read, refresh }` 窄接口）共用。
4. **开发唤醒在两个 provider 上都按写者状态门控**：每个周期先刷新写者状态，`os-active` 且不再接纳遗留任务时跳过。门控做成
   development-automation 应用层函数，作为模块组成员 `sweepWakesWhileDraining()` 暴露（RFC-310 锁禁止在 composition 里写业务分支）。
5. **遗留任务恢复在两个 provider 上都跑**：去掉 `legacy-mission-recovery` 的 `providers: ['sqlite']`，门控改读 `writerCutover.read()`，
   不再读启动步骤留下的局部变量；写者状态启动步骤两边都保存并记录日志。研究确认它在 PostgreSQL 上可以原样运行（中立持久化、
   与唤醒周期相同的 CAS 与乐观版本检查、尽力而为的失败策略）。
6. **类型包漂移策略传给两个 provider 的数字员工组**。
7. **守护身份每次调用准入**：provider 核心新增一个守护身份端口（每次调用 `admitDaemonIdentity`），数字员工、开发自动化与观测组
   共用；删除 PostgreSQL 的 `let systemActor` 持有者。PostgreSQL 的 `daemon-identity` 启动步骤保留为启动检查，不扩展到 SQLite
   （避免改变 SQLite 启动的失败语义）。
8. **宿主任务环境归任务执行组**：任务执行组输出 `hostTasks`（启动内核、守护身份解析、资源授权、取消、读模型），取消改用会话的
   `cancellation`（SQLite 上与现行 `composeTaskCancellation(db)` 到达同一个停止注册表，行为不变）。
9. **程序存储从选择推导一次、到处传入**：包括 S 的反应执行与执行合同夹具（只影响托管）。
10. **`composeDigitalEmployeeRoutePersistence` 迁入数字员工组文件**：改取身份目录的窄端口，名称检查改用资源目录授权的
    `assertNameUnchangedForEditor`；删除 `server.ts` 到 resource-catalog `resourceAccess` 的两条 R1 与 P 对 `@/server` 的值导入。
11. **构造时创建证据目录**：读取 `developmentPurposeRoot.evidenceArtifacts` 会建目录，这是现状且幂等，本 RFC 不改，记为已知偏离。
12. **偏离项**：构造函数放在 `cli/daemonModules/`（同 RFC-379～382），S2c 迁入 `bootstrap/`。
