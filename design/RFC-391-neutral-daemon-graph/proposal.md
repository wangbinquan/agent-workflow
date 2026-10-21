# RFC-391 中立应用图：两份守护进程会话装配合一，迁入 `bootstrap/`（RFC-294 S2b）

- **状态**：In Progress（2026-10-21 落档并派发 Codex 实施。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，
  免设计门与实现门；规则取舍由本会话按推荐决定，见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b「每模块每进程构造一次；不存在 provider 专属或
  部署专属的装配函数；图在 `bootstrap/`」）；前置 [RFC-379](../RFC-379-daemon-lifecycle-program/proposal.md)、RFC-380～390
- **基线**：HEAD `02dae8e7f`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：`bootstrap/`：被动的应用图与守护进程会话图、一张 provider 适配表；`main.ts` 把会话组合函数交给 `startCommand`

## 1. 背景

RFC-380～390 之后，模块组、任务执行、HTTP 绑定与维护 Worker 都已中立，但「把它们装起来」的代码仍有两份：

- **PostgreSQL**：`cli/start.ts` 的 `composePostgresqlProviderSession`（约 670 行），加上 `cli/postgresqlDaemonApplication.ts` 的 `composePostgresqlApplication`（约 680 行）。
- **SQLite**：`cli/start.ts` 的 `composeSqliteProviderSession`（约 1,220 行）。

2026-10-21 的只读研究逐步对照了 57 个构造步骤与 34 个启动步骤。

两侧结构计数完全相同：12 个模块组、7 个轮询作业、2 个托管 Worker、维护服务、已提交事件、生命周期程序、迁移模块各一份。真正的 provider 机制只有五处：

1. 开库；
2. 恢复钩子：SQLite 在开库前做 staged restore，PostgreSQL 在核心组之后做冷恢复；
3. 维护服务的四个 provider 输入；
4. 定时备份机制；
5. 托管选择的准入。

其余都是同一工厂写了两份，或只差输入。

研究另外发现七处漂移，其中两处有功能后果：

- **维护 Worker 的保护集**：SQLite 的是「驱动注册表 ∪ 正在物化的任务」，PostgreSQL 的只有驱动注册表。所以 PostgreSQL 上正在物化工作区的任务，
  不在维护 Worker 的 GC / 恢复保护集里。
- **SQLite 的资源上限与空闲收割**：每个 tick / 每次取消都新建取消与持久化对象，违反「每模块每进程构造一次」。

研究同时核实了 RFC-385 的一处文档表述。PostgreSQL 守护进程总会传启动租约，启动恢复实际用库世代号作证明，`createDaemonLockProof(DAEMON_GENERATION)`
分支在守护进程中走不到。执行 owner 已一律打每进程的 `DAEMON_GENERATION`，两者必然不同，所以回收仍然成立，RFC-385 的修复有效。

## 2. 目标

- **G1 一张应用图**：`composeDaemonApplication(input, phase)`，被动的每会话应用图，包括：
  - 12 个模块组；
  - 会话级操作：工作区维护、资源上限 / 空闲收割（用会话的取消命令）、集成身份；
  - HTTP（RFC-390 的中立绑定）与 WS；
  - 启动步骤记录；
  - PostgreSQL 冷恢复：作为适配器的「核心组之后」钩子，只在 daemon 相位执行；
  - `unstarted` 测试相位（今天 PostgreSQL 应用的测试口推广到两个 provider，供 RFC-392 统一测试入口）。
- **G2 一张会话图**：`composeDaemonSession(input)`，覆盖：
  - 开库、迁移模块；
  - 维护服务、7 个轮询作业、托管 Worker、已提交事件、关闭参与者；
  - 全仓唯一一次 `composeDaemonLifecycle`；
  - 运行时会话。
- **G3 provider 差异只在一张适配表**：开库、核心组适配、任务执行适配、核心组之后钩子、托管选择准入、维护服务四件套、定时备份、恢复证明世代。
  启动步骤里受 provider 限制的两步，从生命周期程序的声明取 `NotApplicable`，不写 provider 字面量比较。
- **G4 入口根装配**：`main.ts` 把会话组合函数交给 `startCommand`；`cli/start.ts` 与 `cli/dev.ts` 不导入 `bootstrap/`。
- **G5 删除**：
  - 两个会话函数与 `composeDaemonProviderSession` 查表；
  - `cli/postgresqlDaemonApplication.ts`；
  - 只为它们存在的私有件；
  - RFC-389 为入口常量模块加的部署分支门特判（失去生产用途）。

## 3. 非目标

- 入口根瘦身：`startCommand` 约 80 键的会话输入转发、77 字段的 `StartOptions`、`(opts.executionHost ?? 'local') === 'local'`、`cli/` ↔ `bootstrap/` 互依。
  这些属 S2c（类型化部署 profile）。
- 删除 `server.ts` 的 SQLite 测试路径、`AppDeps` 与 `createApp(AppDeps)`，以及把 `composeProviderAppComposition` 迁入 `bootstrap/`：RFC-392。
  本 RFC 期间 SQLite 测试 lane 继续走 `server.ts`。
- `daemon-identity` 的适用范围（维持程序声明：只在 PostgreSQL 跑）。
- 安全相关改动。

## 4. 用户可见变化

1. **PostgreSQL（单机与托管）**：维护 Worker 的 GC / 恢复保护集包含正在物化工作区的任务（与 SQLite 一致），物化中的工作区不再可能被维护作业当作无主目录处理。

其余无变化：两种 provider 的启动步骤、作业集合、关闭顺序与对外接口都不变。

## 5. 验收标准

- **AC-1 一张图**（结构锁）：
  - 生产代码里 `composeDaemonApplication`、`composeDaemonSession` 各只有一个定义，`composeDaemonLifecycle` 全仓只调用一次（在会话图里）；
  - 两个会话函数、`composeDaemonProviderSession` 查表与 `cli/postgresqlDaemonApplication.ts` 不存在；
  - 图里没有 provider 字面量比较；
  - `cli/start.ts` / `cli/dev.ts` 不导入 `bootstrap/`。
- **AC-2 行为**：
  - 启动、关停、迁移切换与 HTTP 的既有双引擎用例全部通过，不改断言意图；
  - 新增用例：
    - 两个 provider 的启动步骤记录出自同一份实现；
    - 冷恢复只在 daemon 相位、早于其余模块组；
    - SQLite 拒绝托管选择；
    - PostgreSQL 维护保护集含物化中任务（带「旧接线」对照）。
- **AC-3 账本**：
  - `BOOTSTRAP_FILES`、commons-debt、RFC-379 / 380 / 390 守卫、t19c 账本、identity-access 清单、guard-manifest 同提交修订；
  - `deployment-mode-branch-sites` 与 `architecture/counts.json` 不升。
- **AC-4 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、windows-platform、维护浸泡）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一个 RFC 做完应用层与会话层**：同一批守卫与约 25 个 RFC-370 根绑定测试同时按名字钉住三个函数，拆开要改写两轮。
2. **维护保护集取并集**（§4）：只会让保护更多，不会更少；与 SQLite 一致。
3. **`daemon-identity` 维持只在 PostgreSQL 跑**：改动它会改变 SQLite 的启动（守护身份未准入时启动失败），不在本 RFC 承担。
4. **恢复证明世代由适配表给出**：SQLite 用 `DAEMON_GENERATION`，PostgreSQL 用库世代号，零行为变化。守护进程中走不到的 `createDaemonLockProof`
   分支随 PostgreSQL 应用删除。
5. **由 `main.ts` 注入会话组合函数**：`architecture/counts.json` 要求部署分支门的新例外须经用户确认。改由入口根（门豁免的 `main.ts`）装配，
   不新增例外、不改门；这也是 RFC-294「入口根调用 bootstrap 工厂图」的方向。
6. **构造顺序统一为 PostgreSQL 序**：应用先于维护服务，HTTP 经闭包晚读维护状态，维护服务读应用产出的资源包 apply 活动。构造都是被动的，启动顺序由
   生命周期程序决定，无行为变化。
7. **四个非托管 HTTP 选择两边都透传**；SQLite 的资源上限 / 空闲收割改用会话的取消命令；日志写法取信息更全的一份。单机生产无可见变化。
8. **偏离项**：会话图值导入 `cli/` 下的机制文件（`daemonLifecycleProgram`、`daemonModules/*` 等），`cli/` ↔ `bootstrap/` 互依暂时加深。
   这是 S2c 的目标（届时机制文件一并迁入 `bootstrap/`），本 RFC 记为债。
