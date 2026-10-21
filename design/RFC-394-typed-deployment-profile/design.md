# RFC-394 设计：类型化部署 profile

研究基线 HEAD `55f87d0a9`（行号以实施时源码为准）。路径相对 `packages/backend/src/`，`T/` = `packages/backend/tests/`。
研究笔记见本会话 2026-10-21 的四路只读研究（77 槽逐项清单、部署分支站点、测试影响逐文件分类）。

## 1. 现状

### 1.1 选择链

| 步 | 位置 | 内容 |
| --- | --- | --- |
| 1 | `main.ts` start 分支 | 解析 `--port` / `--host` 写入 `opts`；`composeDeploymentStartOptions(process.env)`；`startCommand({ ...deployment, ...opts, ...development }, composeDaemonSession)` |
| 2 | `bootstrap/deployment.ts` | `readDeploymentMode`：单机返回 `{}`，托管调 `composeCrewStationStartOptions(env)` |
| 3 | `bootstrap/crewstation.ts` | 托管：校验数据库、读平台能力，返回 70 个键的 `StartOptions`（含 `host: '0.0.0.0'`、`port`、`executionHost: 'remote'`） |
| 4 | `bootstrap/developmentReload.ts` | 每代调用 `start({ daemonHost, developmentIntegrity })` |
| 5 | `bootstrap/daemonStart.ts` `startCommand` | 按 `opts.x` 是否存在逐项选择；`executionHost` 分支决定本机探测；`sessionInput` 逐字段复制约 70 个键 |
| 6 | `bootstrap/daemonSession.ts` | `admitSelections`（打开数据库前）；`composeDaemonApplication` 实参逐字段复制 |
| 7 | `bootstrap/daemonApplication.ts` | 再次 `admitSelections`；逐端口「选择项或本地默认」 |

### 1.2 类型

- `StartOptions`（`bootstrap/daemonStart.ts`）：77 个可选槽。
- `DaemonProviderSessionComposeInput`（`bootstrap/daemonSessionInput.ts`）：83 个成员，其中 69 个与 `StartOptions` 同名，逐字段重声明。
- `DaemonApplicationInput`（`bootstrap/daemonApplication.ts`）：84 个成员，其中 65 个与 `StartOptions` 同名，逐字段重声明。

### 1.3 部署判定点（本 RFC 涉及的）

- 启动序列 `opts.executionHost ?? 'local'` 决定本机 git merge-tree 门与 claude-code 软探测（G9 账本 `bootstrap/daemonStart.ts#startCommand#comparison#1`）。
- `bootstrap/daemonSessionAdapters.ts`：SQLite 适配器的 `admitSelections = standaloneSelectionsOf`，拒绝 `HOSTED_ONLY_SELECTIONS` 的 25 个键；
  PostgreSQL 适配器直接放行；会话与应用图各调用一次。

## 2. 设计

### 2.1 profile 类型

新增 `bootstrap/deploymentProfile.ts`（只含类型）：

```ts
export interface DeploymentProfile {
  readonly kind: 'standalone' | 'crewstation'
  /** 托管只跑 PostgreSQL；单机不限定。 */
  readonly requiredProvider: DatabaseProvider | null
  /** 本机依赖探测；返回致命错误文本或 null。 */
  readonly probeHost: (input: HostProbeInput) => Promise<string | null>
  /** profile 给出的默认监听地址；命令行参数优先。 */
  readonly listen: { readonly host?: string; readonly port?: number }
  readonly selections: DeploymentSelections
}
```

- `DeploymentSelections` 在同一文件声明一次：今天 `StartOptions` 中除 `port`、`host`、`executionHost`、`configuration`、
  `daemonHost`、`developmentIntegrity` 之外的全部键，沿用现有键名、类型与可选性。
- `HostProbeInput` 只含探测需要的事实（日志、已加载配置等），不含锁或进程句柄。
- 部署种类的联合类型只在这里声明一次；`bootstrap/deployment.ts` 的 `DeploymentMode` 改为引用它。

### 2.2 两个 profile 工厂与选择点

- 新增 `bootstrap/standalone.ts`：`composeStandaloneProfile()`。
  - `kind: 'standalone'`，`requiredProvider: null`，`listen: {}`，`selections: {}`；
  - `probeHost` 承载今天启动序列里的 git merge-tree 门与 claude-code 软探测，日志与文案逐字保留；
    git 不合格时返回原错误文本（含升级提示）。
- `bootstrap/crewstation.ts`：`composeCrewStationStartOptions` 改为 `composeCrewStationProfile(env)`。
  - 原返回对象中的 `host` / `port` 进 `listen`，`executionHost` 删除，其余键进 `selections`；
  - `kind: 'crewstation'`，`requiredProvider: 'postgresql'`；
  - `probeHost` 只记原日志「execution runs on the platform; local git and runtime probes skipped」并返回 null；
  - 构造时序不变：数据库校验与平台能力读取仍在启动序列之前完成。
- `bootstrap/deployment.ts`：`composeDeploymentStartOptions` 改为 `selectDeploymentProfile(env)`，两个分支分别调用上面两个工厂；
  `migrateForDeployment`、`verifyDatabaseRestoreForDeployment` 不变。

### 2.3 启动序列

`startCommand(profile, launch, development?)`：

- `launch: { host?: string; port?: number }` 来自命令行；监听地址取 `launch.host ?? profile.listen.host ?? config.bindHost`，
  端口同理（与今天 `{ ...deployment, ...opts }` 的覆盖顺序一致）。
- `development?: DevelopmentOverlay`（`daemonHost`、`developmentIntegrity`），类型由 `bootstrap/developmentReload.ts` 导出。
- 宿主探测：`const fatal = await profile.probeHost({ log, config })`；非 null 时打印该文本、释放启动锁、退出码 1。
  启动序列不再出现 `executionHost`。
- 原 `opts.x` 读取改为 `profile.selections.x`；会话输入以 `{ ...profile.selections, …会话专属字段 }` 构造，不再逐字段复制。
- 直接导入 `composeDaemonSession`，不再接收注入的会话组合函数（RFC-391 为跨目录依赖留下的写法，RFC-393 后已无必要）。

### 2.4 会话输入与应用图输入

- `DaemonProviderSessionComposeInput extends DeploymentSelections`：只声明会话专属字段；今天由启动序列派生、因而必填的同名字段
  （如 `applicationConfiguration`、`secretBox`、`runtimeLegacyConfiguration` 的派生值）以必填形式覆盖声明。
- `DaemonApplicationInput<P> extends DeploymentSelections`：只声明应用图专属字段。
- 会话图调用应用图时，选择项以一次展开传递；用一个与 `DeploymentSelections` 键集合由类型锁定一致的键表取出，不再逐字段复制。
- 新增 `requiredProvider` 输入：会话在打开数据库前判定 `requiredProvider === null || requiredProvider === 解析出的 provider`；
  应用图对直接调用它的测试路径再判定一次。失败沿用错误码 `hosted-deployment-requires-postgresql`。
- 删除 `DaemonSessionAdapter.admitSelections`、`standaloneSelectionsOf`、`HOSTED_ONLY_SELECTIONS`。

### 2.5 `main.ts` 与开发热重载

- start 分支：解析 `--port` / `--host` 为 `launch`；`const profile = await selectDeploymentProfile(process.env)`；
  非热重载直接 `startCommand(profile, launch)`；热重载把 `(development) => startCommand(profile, launch, development)` 交给 `reloadDevelopmentDaemon`。
- `bootstrap/developmentReload.ts` 的回调类型改为接收 `DevelopmentOverlay`。

### 2.6 守卫与账本

- **新结构锁** `T/architecture/rfc394-deployment-profile.test.ts`（登记 guard-manifest）：
  - §5 AC-1 列出的符号不存在；
  - `DeploymentSelections` 只声明一次，`DaemonProviderSessionComposeInput`、`DaemonApplicationInput` 继承它，且除必填覆盖清单外不重声明它的键；
  - 启动序列与 `main.ts` 不出现 `executionHost`、部署模式字面量比较；
  - `main.ts` start 分支恰好一次 `selectDeploymentProfile`、一次 `startCommand`，无对象展开合并；
  - 每条都有会红的负例。
- **G9**：`bootstrap/daemonStart.ts#startCommand#comparison#1` 从账本删除，`counts.json` 的 `deployment-mode-branch-sites` 6 → 5。
- **按旧形状锁定的测试**（研究清单约 30～43 个文件）：
  - RFC-370 根接线测试族里锁 `X: opts.X` / `X: input.X` 逐字段转发的，改为锁「profile 类型声明 X、会话输入经展开得到 X、应用图读 `input.X`」；
  - t19c 的 `main.ts` start 字面量、`rfc370-m0-hosted-control-plane` 的「单机返回 `{}`」、`rfc370-v9-sqlite-root-selections` 与 `rfc391` 的
    `HOSTED_ONLY_SELECTIONS` 锁、`rfc370-m2` 的 SQLite 拒绝断言（改为托管 profile 的 `requiredProvider` 在 SQLite 上被拒）、`dev-reload` 的
    `StartOptions` 用法，按新形状改写，保持原意。
- 其余：`docs/dev-gotchas.md` 中描述 `StartOptions` 或 start 调用形状的当前规则段落。

## 3. 测试策略

1. profile 工厂：单机与托管各自的 `kind`、`requiredProvider`、`listen`、`selections` 键集合；托管工厂的键集合与改造前返回的 `StartOptions`
   （去掉 `host`、`port`、`executionHost`）逐键一致。
2. 宿主探测：单机 git 合格 / 不合格（返回原文案）、claude-code 软探测仅告警；托管只记日志并返回 null；启动序列对致命结果释放锁并退出。
3. 监听地址：命令行参数覆盖 profile 默认，profile 默认覆盖配置文件。
4. provider 判定：托管 profile 配 SQLite 在打开数据库前被拒（会话）与在应用图被拒（直接调用）；单机 profile 两个 provider 都放行。
5. 结构锁正例与负例（§2.6）。
6. 回归：后端 SQLite 全量；PostgreSQL 补跑覆盖改动过的 PG 用例与托管集成用例；双 lane 跑路由面一致性、守护进程与 RFC-379～394 守卫。

## 4. 与 RFC-294 目标架构的对齐

- 部署选择点返回一个类型化的值，入口根只做参数解析与 profile 选择（design §10.1）；
- 宿主探测这一部署能力差异由 profile 表达（§9.2），启动序列不再按部署分支；
- 选择项单一声明，消除三层逐字段重声明。

留下的债（S2c 后继）：

- 单机默认值仍分散在应用图与模块组的 `?? local` / `select*` 回退里，选择项仍可选；
- 执行权端口的部署字面量、SPA 标记、生命周期 profile、备份来源仍读端口或槽位；
- `main.ts` 自装配的命令依赖。

## 5. 风险

- **托管时序**：profile 构造带真实 IO（数据库校验、平台能力），必须仍早于启动锁与日志配置之外的任何会话动作，与今天一致。
- **覆盖顺序**：`--host` / `--port` 覆盖托管默认只有一条字面量锁，本 RFC 补行为用例。
- **选择项继承**：会话输入里由启动序列派生的同名字段必须以必填覆盖声明，避免把「可选」带进会话图。
