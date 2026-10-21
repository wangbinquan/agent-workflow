# RFC-390 中立 HTTP 绑定：SQLite 守护进程改走 `composeProviderAppDeps`（RFC-294 S2b）

- **状态**：Done（2026-10-21：`02dae8e7f`。主 CI `39608407556` 只红在本会话 RFC-389 新增结构锁的 5 秒超时（带覆盖率的 ubuntu 分片 3），
  `4dc728a0c` 补显式超时；该提交的 CI `39612132689` 除 macOS e2e 分片 2/3 外全绿——那个分片 165 passed / 0 failed，作业在收尾时越过
  20 分钟上限被取消（同分片近几次耗时 6～20 分钟，runner 波动）。本机 SQLite 全量、767 个 PostgreSQL 相关文件与双 lane 路由面守卫全绿。
  用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b「SQLite 与 PostgreSQL 的应用装配合并为一张
  provider-neutral 图，以 `server.ts` 现有的 provider 无关挂载表为起点」）；前置 [RFC-388](../RFC-388-task-execution-runtime-merge/proposal.md)、
  [RFC-389](../RFC-389-maintenance-worker-root-bootstrap/proposal.md)
- **基线**：HEAD `8186c9852`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：`server.ts`（已登记在 `BOOTSTRAP_FILES`）：一个中立的 HTTP 组合函数；整体迁入 `bootstrap/` 属 RFC-391

## 1. 背景

`server.ts` 已有两侧共用的路由拓扑（`AppApiRouteMounts` + `mountApiRoutes`）与请求管线，也有一个中立的绑定
`composeProviderAppDeps(ProviderAppCompositionInput<P>)`——但只有 PostgreSQL 用它：

- **PostgreSQL**：`composePostgresqlApplication` 在 12 个模块组之后自己构造 HTTP 专用 owner 与 13 组路由输入，再调
  `composePostgresqlAppDeps`。
- **SQLite**：会话根向 `composeSqliteAppDeps` 传 76 个键，由 `server.ts` 手写的另一份路由闭包表 `composeSqliteApiRouteMounts`
  （约 480 行）和 SQLite 公共路由表挂载。76 个键里生产 HTTP 真正读到的约 33 个，其余约 40 个只喂给测试回退。

2026-10-21 的只读研究逐字段对比了约 85 个叶子输入：

- **没有两侧真正不同的实现**；
- 只差输入的 8 处全是托管专属选择、测试接缝通道或进程并发作用域键；
- 其余都是同一工厂、写了两份。

另有几处漂移：

1. SQLite 的 `/api/maintenance/status` 不带 `database` 遥测，SQLite 运行时本有 `telemetry()`；
2. 资源包插件安装器写了两份；
3. 两个根仍给融合路由传已无人读的 `appHome` / `configPath` / `launchConfiguration`；
4. SQLite 的 MCP 路由不传 `probeRunner`（单机下恒为空，无行为差）。

还有两个生产可达的「回退」：`deps.appHome ?? Paths.root` 与 `deps.configConcurrencyHotApply ?? composeLegacyConfigConcurrencyHotApply(db)`。

## 2. 目标

- **G1 一个中立 HTTP 组合函数**：`composeProviderAppComposition<P>` 由会话模块组、少量会话标量、部署选择与显式测试接缝，构造
  `ProviderAppCompositionInput<P>` 与资源包 apply 活动查询；PostgreSQL 根、SQLite 根与 SQLite 测试路径都经它进入 `composeProviderAppDeps`。
- **G2 删除 SQLite 的第二份路由表**：`composeSqliteApiRouteMounts`、SQLite 公共路由表及只为它存在的类型与常量。
- **G3 消除漂移与生产回退**：
  - 插件安装器只留一份；
  - 融合路由只收它读的字段；
  - MCP 路由两边都带 `probeRunner`；
  - 删除 `| null` 死守卫；
  - `appHome` 显式传入；
  - 配置热应用的作用域取自任务执行模块组交出的 `processConcurrencyScope`（与调度器读的是同一个池）。
- **G4 SQLite 会话根变薄**：约 40 个只喂测试回退的「死转发」随之消失。

## 3. 非目标

- 两个会话里 12 个模块组的构造、启动步骤与两个结构平行的会话函数合并：RFC-391（中立应用图，同时把装配迁入 `bootstrap/`）。
- 删除 `deps.x ?? composeX(...)` 测试回退、`createApp(AppDeps)` 与 `composeSqliteAppDeps`：RFC-392。测试接缝里**有测试在用**的保留为
  显式的、两个 provider 同形的测试口；无人使用的逐字段覆盖本 RFC 直接删除。
- 不改路由面、API 路径、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

1. **单机 SQLite 的 `GET /api/maintenance/status`**（及其 MCP 对应操作）从此带 `database: { version: 1, provider: 'sqlite', poolWait: null }`，
   与 PostgreSQL 一致。共享 schema 已接受该形状；前端只做 schema 解析，不渲染该字段，界面无变化。

其余无变化。

## 5. 验收标准

- **AC-1 一份绑定**（结构锁）：
  - 三个调用方（PostgreSQL 根、SQLite 会话根、SQLite 测试路径）各恰好调用一次 `composeProviderAppComposition` 与 `composeProviderAppDeps`；
  - `server.ts` 不再有 `composeSqliteApiRouteMounts` 与第二份公共路由表；
  - `mount*Routes(` 只出现在 `composeProviderAppDeps` 与请求管线里。
- **AC-2 行为**：
  - 路由面一致性守卫照常通过；
  - 既有 HTTP 双引擎用例全部通过，不改断言意图；
  - 新增 SQLite / PostgreSQL 维护状态都带 `database` 的用例；
  - 热应用作用域与调度器同源的用例保持。
- **AC-3 账本**：
  - commons-debt 双向精确（PostgreSQL 根的 2 条 R1 消失）；
  - 同文件 provider 孪生账本销账；
  - 其余精确清单同提交修订；
  - `architecture/counts.json` 不升。
- **AC-4 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **中立函数放在 `server.ts`**：它已导入全部 HTTP owner 工厂，又在 `BOOTSTRAP_FILES` 里，不新增导入边，不碰 RFC-380 的模块组规则。
   整体迁入 `bootstrap/` 与应用图合并一起做（RFC-391）。
2. **SQLite 会话根直接调用中立函数**（不再经 `composeSqliteAppDeps`），一次改到位。约 20 个钉着旧实参的 RFC-370 根绑定测试改指模块组
   调用或中立函数的实参，不放宽断言。
3. **SQLite 维护状态带 `database` 遥测**（§4）：两种 provider 同形；前端已兼容，属补漏接。
4. **测试路径保留 12 个模块组回退**（RFC-380 规则，RFC-392 删除）；`databaseMigration` 在路由组合里保持必填，测试路径缺省时补一个
   惰性准入的模块（与 HTTP 双引擎夹具的做法相同，路由面因此与生产一致）。
5. **删除 `composePostgresqlAppDeps`**：PostgreSQL 根直接调 `composeProviderAppDeps`；同文件 provider 孪生账本的
   `server.ts::composeAppDeps` 一行随之销账。
6. **SQLite 构造顺序不变**：维护服务仍先于 HTTP 构造，对「在执行的资源包 apply」的晚读改为读中立函数的输出。
7. **偏离项**：无（装配暂居 `server.ts` 是 RFC-294 允许的中间状态，RFC-391 收口）。
