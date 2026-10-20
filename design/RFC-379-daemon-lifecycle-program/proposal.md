# RFC-379 守护进程唯一生命周期程序（RFC-294 S2a）

- **状态**：Done（2026-10-20）——内容 `1faae97cd`，CI 修复 `24b91ba6e`，主 CI `39389525075` success（含 PostgreSQL 双引擎分片）。实现由 Codex 完成，本会话审核（免设计门与实现门）。审核记录：本机后端 SQLite 全量 19410 pass / 0 fail；首个 CI 只红在新增的单机 PostgreSQL 守护进程用例——单机 PostgreSQL 必须经一键迁移建立数据库代指针，改为在已有的托管待命启动用例中断言同一程序顺序（AC-8，本地 PostgreSQL 17 通过）。实现与设计文字的差异：provider 专属关停控制器放在 task-execution composition（`createTaskExecutionShutdownController`，避免 `services/` 反向依赖模块内部）；维护服务内部启动函数保留原名，对外为被动的 `createMaintenanceService`；MR 终止控制的重试定时器也只在 worker 启动后安装
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2a）、design §10.3、§13.1 的生命周期
  清单一致门（G12，RFC-376 留给本 RFC）；review-2026-10-16 F2 与「后台生命周期并存六套机制」
- **基线**：HEAD `f8d2d689f`（行号仅作定位提示，以实施时源码为准）
- **落位**：守护进程装配层——入口根 `cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts` 与生命周期底座
  `cli/daemonProviderRuntimeSession.ts` / `cli/daemonProviderRuntimeHandles.ts`；各模块只做「构造不带副作用」所需的最小调整，
  不改业务规则

## 1. 背景

2026-10-19 的四路只读研究（启动步骤依赖、作业清单、重复构造、锁定现状的测试）给出以下事实：

1. **两份手写清单。** PostgreSQL 与 SQLite 的会话清单各写一份（`cli/start.ts:1348-1380`、`:4337-4419`）：运行时作业 4 项、
   收尾参与者 6 项同序；后台作业 14 项集合相同而顺序不同，停止顺序因此不同；PostgreSQL 另追加 3 个托管作业。没有测试锁定两份
   一致。
2. **约 40 个启动步骤散在两个装配函数里**，顺序不同、各有缺项；现有锁只比较源码文本先后（`tests/rfc359-w3-t15-boot-step-parity.test.ts`），
   看不出语义。按真实依赖分析，PostgreSQL 的现行顺序有四个功能缺陷：
   - MR 终止对账与投递恢复在启动恢复之前（`cli/postgresqlDaemonApplication.ts:1716-1717` 早于 `:2707`）。对账会取消节点运行、
     撤销 owner，而之后的收割器只处理 running / pending 行的进程，上一代守护进程留下的子进程可能存活；托管待命实例还会把活动
     实例在途的启动守卫判为失败、把在途投递标为中断。
   - 数字员工内置工具目录在 Agent 模板之前读取（`:1960` 早于 `:2833`）：全新 PostgreSQL 安装首次启动没有内置工具，模板升级要
     再重启一次才生效。
   - 托管下 `settleAutomaticUpgrades`（`:2000`）早于取得执行权，需要执行权的程序夹具与产物写入一律失败。
   - 运行时注册表启动排在写窗口开启之后（`cli/start.ts:859`），与托管的定向续跑竞争。
3. **组合期就开始工作**：维护服务的定时器与 Worker（`platform/background/maintenanceService.ts:325-584`）、MR 终止的 5 秒定时器
   （`modules/integration/application/mrTerminalControlWorker.ts:85`）、SQLite 的 MCP 运行时测试（`cli/start.ts:3129`）、资源复核
   （`:3829`）、数字员工 authoring 初始化（构造函数内，`modules/digital-employee/application/authoringService.ts:322`）。会话的
   「冻结」状态名不副实。
4. **关停的 30 秒宽限从未生效。** 任务执行作业的停止无超时地等待全部 driver（`modules/task-execution/composition/providerBackground.ts:351-357`），
   排在它后面的 `task-execution-graceful-shutdown` 收尾找不到运行中的任务；PostgreSQL 下该收尾作用于进程全局模块而不是本 provider
   的模块。资源复核、托管的延迟初始化不在停止范围内。
5. **底座缺少观测字段。** `cli/daemonProviderRuntimeSession.ts` 有序启动、逆序停止，但没有阶段、依赖、就绪、健康与停止回执，
   `state()` 没有生产读者。无生产调用方的定时器启动函数还有 `startMemoryDistillLoop`、`startSubmoduleRefreshLoop`（RFC-294 plan
   记为 8 个，其余已随 RFC-375 删除）；`defineBackgroundJob` 没有生产使用者。

## 2. 目标

- **G1 一份程序。** 启动步骤、运行时作业、后台作业、收尾参与者的 id、阶段、失败策略、是否需要执行权都在一处声明；两个 provider
  只按 id 提供实现（类型化记录，缺项编译失败），清单与顺序由程序给出。托管附加项经 profile 在声明的槽位进入。
- **G2 规范顺序**（design §3）：`prepare` → `execution-recovery` → `pre-listen` → `post-ready`，修复 §1.2 的四个缺陷；托管下
  `execution-recovery` 与全部作业在取得执行权后运行，`executionAuthority.start()` 移到 `prepare` 末尾。
- **G3 组合无副作用。** 组合只构造；定时器、Worker、初始化与对账由程序在对应阶段启动。
- **G4 底座字段。** 阶段、依赖（只能依赖更早声明的 id）、就绪、轮询作业健康（最近运行与失败）与停止回执（stopped / timeout /
  error 及耗时），并输出结构化日志。
- **G5 有界关停。** 任务执行停止受 30 秒宽限约束，超时的任务按既有语义标为 interrupted；收尾作用于本 provider 的模块；程序跟踪的
  分离工作在关停时排空或放弃并留下回执。
- **G6 G12 门。** 单机 profile 下两个 provider 的有序 id 清单相同，由结构与行为两层测试锁定，替换按文本比较先后的旧锁。
- **G7 删除死代码。** `startMemoryDistillLoop`、`startSubmoduleRefreshLoop` 与 `defineBackgroundJob`。

## 3. 非目标

- 不合并模块构造（每模块每进程构造一次属 S2b）；SQLite HTTP 侧的第二份数字员工、资源目录等重复构造保留。
- 不改 `StartOptions` 与部署 profile 的形状（S2c）；不把 `cli/` 底座迁入 `bootstrap/`（S2c，连同 `cli/` ↔ `bootstrap/` 互依）。
- 不把任务执行后台内部的私设循环（自动修复、心跳清理、孤儿对账、定时任务、托管恢复）拆成独立周期作业（W9-B 余项）。
- 不统一「同一规则的两份实现」（定时任务可启动性校验、开发唤醒门控、意图转储默认运行时、恢复锁证明的代际来源等；S2b）。
  步骤的**适用范围**保持现状，只改顺序与时机，§1.2 的缺陷修复除外。
- 不改变托管执行权的释放方式：关停时不主动交还租约（RFC-370 语义）。
- 不做任何安全相关改动。

## 4. 用户可见变化

无能力收缩。以下变化均为缺陷修复或顺序调整：

1. PostgreSQL（单机与托管）：启动时先收割上一代守护进程的孤儿进程，再执行 MR 终止对账与投递恢复。
2. 全新 PostgreSQL 安装首次启动即有数字员工内置工具；模板升级在当次启动生效。
3. 托管：待命实例不再改写活动实例的启动守卫、终止效果与在途投递；自动升级结算在取得执行权后运行。
4. 关停在 30 秒宽限后继续，届时仍在运行的任务标为 interrupted（以前会一直等待）。
5. SQLite：部分启动步骤移到启动恢复之前（无数据依赖）；后台作业的启动与停止顺序改为统一顺序；MCP 运行时测试的启动恢复在会话
   恢复时执行（仍在监听之前）；bootstrap 管理员提示在就绪后输出。
6. 关停时运行中的节点以「daemon 关停」原因中止（此前经会话暂停原因）：本地节点按 RFC-202 落为 interrupted，可续跑；托管执行
   detach，不向 CrewStation 发取消（RFC-370 的优雅关停语义）。
7. 托管：模板、定时任务载荷修复、融合与演示播种、技能活文件对账、运行时注册表这些幂等的 `prepare` 步骤在待命实例上也执行
   （执行权开启之前，写屏障不拦截）；此前它们在 PostgreSQL 路径上要等取得执行权。

## 5. 验收标准

- **AC-1** 两个 provider 的生命周期只经程序产生；启动步骤、运行时 / 后台作业、收尾参与者的有序 id 清单单一来源；单机 profile 下
  两个 provider 相同；托管附加项只能经 profile 槽位进入（结构测试 + 行为测试）。
- **AC-2** design §3 的规范顺序由程序执行；§1.2 的四个缺陷各有回归用例。
- **AC-3** 组合完成到会话恢复之间没有定时器、Worker 或初始化在运行；冻结会话下不创建维护 Worker。
- **AC-4** 托管：`prepare` 在 `executionAuthority.start()` 之前完成；`execution-recovery` 与全部作业在激活后运行；待命实例不执行
  `execution-recovery` 的任何步骤。
- **AC-5** 底座的阶段、依赖校验、就绪、轮询作业健康与停止回执可从 `state()` 读出；单个作业停止超时产生 timeout 回执且不阻塞
  其余停止。
- **AC-6** 关停：不响应中止的 driver 不会让关停无限等待，超时任务标为 interrupted；收尾作用于本 provider 的模块（两个 provider
  各有用例）。
- **AC-7** G7 删除的符号无残留引用；design §6 列出的旧锁按表处置。
- **AC-8** 真实守护进程：SQLite 启动日志按规范顺序记录全部步骤（本地与 CI）；PostgreSQL 真实守护进程在 CI 上有同一断言（落在托管待命启动用例：待命期间 prepare 全部按序、恢复阶段不执行，激活后恢复阶段按序；单机 PostgreSQL 需一键迁移建立数据库代，不适合每次提交都跑）。
- **AC-9** 推送后 exact SHA 的 GitHub Actions 全绿。
