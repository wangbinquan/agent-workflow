# RFC-427 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-426 落库后的源码（`14fd0c903`）为准。

## 1. 部署选择与部署操作（`S/bootstrap/deployment.ts`、`S/bootstrap/deploymentProfile.ts`）

`deploymentProfile.ts`（RFC-394：只放类型）新增：

```ts
export interface Deployment {
  readonly kind: DeploymentKind
  /** The start profile; a hosted instance verifies its database while composing it. */
  profile(): Promise<DeploymentProfile>
  /** `agent-workflow migrate`. */
  migrate(): Promise<{ readonly output: string }>
  /** `agent-workflow verify-database-restore`. */
  verifyDatabaseRestore(): Promise<string>
  /** `agent-workflow verify-database-migration`. */
  verifyDatabaseMigration(): Promise<string>
}
```

`deployment.ts`：

- `selectDeployment(env): Deployment` 是唯一调用 `readDeploymentMode` 的地方，按结果构造单机或托管描述。
- 单机描述：
  - `profile` 为 `composeStandaloneProfile()`；
  - `migrate` 为原单机分支（按需 import `./migrate`）；
  - 两个校验操作以 `DeploymentOperationUnavailableError` 拒绝。
- 托管描述：在选择时捕获 `env`，`profile` / `migrate` / 两个校验操作为原 `*ForDeployment` 的托管分支逐字迁入。
- `DeploymentOperationUnavailableError(operation, required)` 的报文为 `${operation} requires ${required} deployment`，两处拒绝的文本与现在
  相同。
- 删除 `selectDeploymentProfile`、`migrateForDeployment`、`verifyDatabaseRestoreForDeployment`、`verifyDatabaseMigrationForDeployment`。
- `DeploymentMode` 类型别名保留（RFC-394 锁）。

## 2. 命令依赖的装配（新增 `S/bootstrap/commandBootstraps.ts`）

从 `main.ts` 逐字迁入：

| 入口                                               | 原位置                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `composeUserCommandBootstrap()`                    | `main.ts` 同名函数                                                                                  |
| `composePackageCommandBootstrap()`                 | `main.ts` 同名函数                                                                                  |
| `resolveCommandProvider()`（模块内私有）           | `main.ts` 同名函数                                                                                  |
| `composeBackupCommandOperations()`                 | `backup` 分支：解析 provider 运行时 + `composeLocalSystemOperations`，失败时关闭运行时              |
| `composeRestoreCommandOperations()`                | `restore` 分支：读配置、`resolveDatabaseProviderRuntimeForRestore` + `composeLocalSystemOperations` |
| `runDoctorDiagnostics()`                           | `doctor` 分支：`composeDoctorApplication(...).run()`                                                |
| `composeLocalDatabaseMigrationCommandOperations()` | `db` 分支的惰性 `composeLocalDatabaseMigrationOperations`                                           |

`bootstrap/` 不 import `cli/`（RFC-393），原来对 `UserCommandIdentityHandle` / `PackageCommandIdentityHandle` 的 `satisfies` 改由 `main.ts`
把返回值交给 CLI 处理器时的结构检查承担。

其余入口：

- **e2e 专用的进程输出探针**迁入 `S/bootstrap/managedProcessOutputProbe.ts`：`runManagedProcessOutputProbe(argv, env)` 返回输出与退出码；
  非 e2e 构建的拒绝仍在 `main.ts`。
- **托管 Git 凭据**两个子命令迁入 `S/bootstrap/hostedGitCommands.ts`，它内部按需 import 模块 composition，与原按需加载一致。

## 3. `main.ts`

只剩参数解析（`readFlag` / `readPortFlag` / `isE2eBuild`）、部署选择与分发：

- `start`：`selectDeployment(process.env).profile()` 后调用 `startCommand(profile, launch, development)`（RFC-359 W5-T19c 锁的形状不变）。
- `migrate` / `verify-database-restore` / `verify-database-migration`：调用描述的对应操作。
- `user` / `auth` / `package` / `backup` / `restore` / `doctor` / `db`：取 bootstrap 入口，交给 `cli/` 处理器。

import 白名单：`./cli/**`、`./bootstrap/**`，以及：

- `./services/execution/managedProcessLauncher`：进程启动器必须在任何装配之前执行（RFC-400 锁要求它只被 `main.ts` import）；
- `./util/version`、`./util/log`、`./util/paths`；
- `./util/gitCredentialLease`：Git 凭据协议处理器。

## 4. 守卫与账本

- **新增结构锁** `T/architecture/rfc427-entry-root.test.ts`：
  - `main.ts` 的静态与动态 import 只落在白名单；
  - `main.ts` 声明的函数恰为 `isE2eBuild` / `readFlag` / `readPortFlag` / `main`；
  - `deployment.ts` 里 `readDeploymentMode(` 只在 `selectDeployment` 中调用一次；
  - 负例两组：既有语料替换与纯伪造单元。
- **RFC-394 架构锁**：`start` 分支调用一次部署选择（`selectDeploymentProfile` → `selectDeployment(...).profile()`）。
- **RFC-349 provider 切换锁**：「CLI 装配不重新打开 SQLite」同时检查 `bootstrap/commandBootstraps.ts`。
- **guard-manifest**：新增一条；改动的守卫刷新行数。
- **组合根登记**：`T/architecture/census.ts` 的 `BOOTSTRAP_FILES` 登记两个新文件（`commandBootstraps.ts`、`hostedGitCommands.ts`），RFC-317 R1 照常
  把它们当作装配点。
- **钉住 `main.ts` 装配文本的锁改指新位置**：
  - RFC-305 / RFC-347 的 identity-access 消费者与运行时根；
  - RFC-271 资源包 CLI、RFC-346 系统运维 CLI、RFC-349 资源包 bootstrap 与 RFC-370 Doctor 的源码断言；
  - RFC-223 的「先判归档契约再打开 provider」：原断言按 `classifyRestoreArtifact(artifact)` 查找，多行调用里从不出现，一直空过；改为两处
    都必须找到且顺序正确。
- 其余引用 `main.ts` 的守卫（RFC-359 W5-T19c / T19、RFC-389、RFC-393、RFC-395 休眠、RFC-400、RFC-376 可达性）无需改动，集中验证通过。

## 5. 测试

- **部署选择**（新增 `T/rfc427-deployment-selection.test.ts`）：
  - 两种部署的 `kind`；
  - 单机两个校验操作以 `DeploymentOperationUnavailableError` 和原报文拒绝；
  - 非法模式仍报 `DeploymentModeError`；
  - 托管描述在选择后修改 `env` 不影响已选种类。
- **迁移调用方**：托管集成用例（`rfc370-m0-hosted-postgresql`、`rfc370-m3-hosted-database-restore`、`rfc370-v3-hosted-standby-boot`、
  `rfc370-v3-hosted-write-window`）与 `rfc370-m0-hosted-control-plane`、`rfc394-deployment-profile` 改用 `selectDeployment(env)` 的操作，
  断言不变。
- **CLI 子命令**：既有 `cli` / `daemon-start` / `dev-reload-cli` 用例照常覆盖分发；装配逐字迁移，不另加重复用例。
