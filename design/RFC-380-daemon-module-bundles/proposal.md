# RFC-380 守护进程模块组：同构模块每会话构造一次（RFC-294 S2b 第一批）

- **状态**：Done（2026-10-20）——内容 `99944c201`，CI 修复 `fc1527265`（gitleaks 把测试资源名常量误报为密钥），主 CI `39456875642` success。实现由 Codex 完成，本会话审核：本机后端 SQLite 全量 19423 pass / 0 fail；本地 PostgreSQL 17 上串行跑 206 个相关文件（本次改动的测试与全部双 provider HTTP 应用套件）的 PostgreSQL 一侧 1892 pass / 0 fail。实现中补的消费方：任务启动依赖改用会话的存储与租约；PostgreSQL 运行时改用已构造的记忆注入查询；资源包路径复用组内的 MCP 事务生命周期（无状态）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）、design §10.2；review-2026-10-16 F2；
  前置 [RFC-379](../RFC-379-daemon-lifecycle-program/proposal.md)（S2a，生命周期程序）
- **基线**：HEAD `8194c30dc`（行号仅作定位提示，以实施时源码为准）
- **落位**：守护进程装配层。新目录 `packages/backend/src/cli/daemonModules/` 放模块组构造函数；入口根 `cli/start.ts`、
  `cli/postgresqlDaemonApplication.ts`、`server.ts` 改为调用它们；各模块只做必要的最小调整（资源目录的 ACL 写入口）

## 1. 背景

S2a 之后，启动步骤与后台作业已经只声明一次，但**模块实例**仍由两个 provider 各装配一份，SQLite 进程内还会再装配一份：
`cli/start.ts` 的 SQLite 会话组合先构造一套模块，进入 `server.ts` 的 SQLite HTTP 装配后又构造一套（多数是无条件构造，不是测试回退）。
2026-10-20 的三路只读研究（基线 `8194c30dc`）给出的同构部分：

| 模块组 | SQLite 进程内实例数 | PostgreSQL | 差异 |
| --- | --- | --- | --- |
| provider 核心（工作区存储、运输凭据仓库、认证、身份访问、令牌审计、注册表、realtime、系统运维、维护磁盘） | 1（HTTP 认证另建一份） | 1（另建工作区存储与运输凭据仓库各一份） | 只有系统运维与维护磁盘按 provider 不同 |
| 仓库凭据组（运输模块、代码托管连接、端点发现、发布运输、开发交付、流水线证据、工作区准备） | 2（`server.ts` 重建 5 个，其中端点发现生产无人用） | 1 | 无（同一实现） |
| 资源目录组（资源目录、经典目录、MCP / 插件 / 工作组目录、能力模板、开发配置、外部 ACL、Agent 模板） | 资源目录 3、其余 2 | 1 | ACL 写入的通知（见 §4） |
| 观测 / 系统 Agent / 运行时管理（调用记录、系统 Agent 观测与四个运行族、MCP 运行时测试、运行时管理、工作区在场、运行时会话租约） | 调用记录 3（1 个无人用）、运行族 5（1 个无人用）、租约 4 | 1 | SQLite 只对记忆族尊重运行族选择、忽略工作区在场选择（单机无影响） |
| 记忆组（记忆运营、注入查询、记忆目录） | 1（`server.ts` 为测试回退） | 1（注入查询 2） | 无 |

同一份装配逻辑写两三遍，曾直接造成缺陷（工作项工具目录为空、启动恢复静默失败，见 RFC-294 review F2），新模块接线也要在
三处同步。

## 2. 目标

- **G1** 上表五组各有一个 provider 中立的构造函数（`cli/daemonModules/`），两个 provider 的会话组合各调用一次；provider 差异只经
  适配器表（查表，不比较 provider 名）进入。
- **G2** SQLite 进程内上述模块每会话只构造一次：`server.ts` 的 SQLite HTTP 装配改为接收注入的实例；其回退分支（测试直接
  `createApp` 时）调用同一个构造函数，不再有第二份装配代码。
- **G3** 删除被取代的 provider 专属装配函数：`composeSqliteDaemonProviderCore`、`composePostgresqlDaemonProviderCore`、
  `createPostgresqlAuthRuntime`、`composeSqliteUncredentialedDevelopmentDeliveryProvider`，以及 `server.ts` 中生产无人使用的实例。
- **G4** 规则统一（§6），单机 SQLite 的用户可见行为不变；PostgreSQL 补上资源权限变更的实时推送。

## 3. 非目标

- 集成模块（MR 终止控制、Webhook 投递 / 分发 / 入站、事件中心、事件自动化、审批网关、开发工具连接）、定时任务与融合：
  RFC-381（涉及三处行为差异的取舍）。
- 任务执行运行时与驱动协调器、数字员工、开发自动化、意图：RFC-382。
- SQLite HTTP 装配并入 provider 中立的挂载表、删除 `deps.x ?? composeX(...)` 测试回退、维护 Worker 根迁出 `platform/`：RFC-383。
- 部署 profile 与 `cli/` → `bootstrap/` 迁移：S2c。
- 不改任何业务规则、API、路由、事件或 schema；不做任何安全相关改动。

## 4. 用户可见变化

1. **PostgreSQL（托管与单机）**：修改能力模板、动作模板、验证配置、数字员工配置、自动化策略的访问控制后，其他在线用户的
   页面立即刷新可见性与编辑权限（服务端推送 `resource-acl.changed`），与 SQLite 现状一致。此前 PostgreSQL 要刷新页面才生效，
   降级的用户在刷新前保存会得到 403。
2. 其余无用户可见变化：HTTP 认证与令牌审计统一使用 provider 核心的实例（与 SQLite 现用实例逐项等价，见 design §4.1）；
   `credentials`、`systemAgentRunFamily`、`workspacePresence` 三个选择项列为仅托管（单机从不设置；SQLite 收到即按既有规则拒绝启动）。

## 5. 验收标准

- **AC-1** 五个模块组各由 `cli/daemonModules/` 中一个构造函数产生；两个 provider 的会话组合各调用恰好一次；`server.ts` 只在
  `deps.x ?? <同一构造函数>(...)` 回退中调用（结构测试锁定）。
- **AC-2** SQLite 守护进程内，§1 表中的模块各只有一个实例（以注入实例同一性的行为测试与结构测试共同证明）。
- **AC-3** G3 列出的函数与死实例删除，无残留引用；同文件 provider 孪生账本、孪生守卫与适配器生产消费者账本相应更新。
- **AC-4** 资源目录自有类型的 ACL 写入经同一个带通知的写入口，两个 provider 都触发 `resource-acl-changed` 再验证（双引擎用例）。
- **AC-5** `HOSTED_ONLY_SELECTIONS` 增加三项，SQLite 根收到即拒绝（用例）；SQLite 根不再读取这三项。
- **AC-6** design §7 列出的旧锁逐条改指新位置，不放宽断言意图。
- **AC-7** 推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **构造粒度为「每个 provider 会话一次」，不是进程级单例**：数据库迁移切换时同一进程会组合第二个会话并保留源会话作回滚点。
2. **HTTP 认证与令牌审计读取统一用 provider 核心的实例**：两边都由 `createLocalHttpAuthentication` 与同一令牌审计持久化构造，
   输入相同，单机行为逐项等价。
3. **资源目录自有类型的 ACL 写入统一经模块提供的带通知写入口**：保留 SQLite 现有的实时推送，同时补齐 PostgreSQL（§4 第 1 条）。
4. **`credentials`、`systemAgentRunFamily`、`workspacePresence` 列为仅托管选择项**：只有 CrewStation 托管装配会设置它们，
   托管恒为 PostgreSQL。
5. **`server.ts` 的测试回退保留到 RFC-383**，但回退调用与生产相同的构造函数。
6. **偏离项**：模块组构造函数放在 `cli/daemonModules/` 而不是 `bootstrap/`（RFC-376 部署分支门的口径，与 RFC-379 相同），S2c 迁移。
