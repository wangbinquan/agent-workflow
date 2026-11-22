# RFC-532 技术设计

## 1. 现状（HEAD，源码实读）

- 合同（`bootstrap/deploymentProfile.ts`）：`readonly databaseInstallation: DaemonDatabaseInstallationPort | null`，在可空一组（RFC-433）。单机
  （`bootstrap/standalone.ts`）给 `null`；托管（`bootstrap/crewstation.ts`）给 `system.databaseInstallation`（release 的
  `DatabaseInstallationPort`）。
- 读取处只有 `bootstrap/daemonStart.ts` 的 `startCommand`，两处：
  1. 探测宿主之后、打开密钥箱之前：`if (databaseInstallation === null) { … }`——`readEpochBootFactsForConfig({ appHome: Paths.root, database })`、
     `classifyEpochInstallation`、`autoUpgradeTrigger({ standalone: true, enabled: config.autoEpochMigration !== false })`（`refuse` 抛出；
     `start` / `resume` 时 `runAutoUpgradeChild()`，之后重读配置与事实，不是 epoch-2 或仍有未收尾的升级会话则抛出）、最近一次完成的会话
     有回执时以 `epoch-upgrade` 日志器记回执与限制、`epochInstallationGuidance` 非空则抛出、`applyLocalEpoch2PendingRestore(logicalSchemaContract)`；
     其后（两种 profile 都）`config = await configuration.read()`。
  2. 准备数据库：`prepareDaemonDatabaseProviderForBoot({ configuration, ...(databaseInstallation === null ? { kind: 'file' } : { kind: 'selected',
installation }), file: { config: config.database, sqlitePath, generationPointerPath, operationsRoot, contract, lockPath, lock,
backupOnMigration, sqliteOptions } })`（RFC-524 起按 `kind` 显式选），失败时的损坏指引与 schema 漂移指引照旧在 daemon 里。
- `runAutoUpgradeChild` 在 `bootstrap/autoUpgradeChild.ts`（起 `db migration auto --json` 子进程，转发信号与输出）；epoch 路径的其余函数都是
  system-operations 的 composition 导出（`composition/epochBootAdmission.ts`、`composition.ts` 的 `applyLocalEpoch2PendingRestore`）。

## 2. 机制与落位

### D1 安装选择的类型（system-operations）

新文件 `modules/system-operations/composition/daemonDatabaseInstallation.ts`：

```ts
export interface DaemonDatabaseAdmissionInput {
  readonly config: AdmissionConfiguration // 启动程序此刻读到的配置（Pick<Config, 'database' | 'autoEpochMigration'>）
  readonly configuration: { read(): AdmissionConfiguration | Promise<AdmissionConfiguration> }
  readonly contract: LogicalSchemaContract
}
export interface DaemonDatabaseInstallation {
  /** 打开密钥箱之前，把安装带到本版本能服务的状态。 */
  admit(input: DaemonDatabaseAdmissionInput): Promise<void>
  /** 为启动准备选中的数据库。 */
  prepare(input: DaemonDatabaseBootPreparation): Promise<PreparedDaemonDatabase>
}
```

`DaemonDatabaseBootPreparation`（`{ configuration, file }`）与 `PreparedDaemonDatabase` 由 `composition/daemonDatabase.ts` 导出（此前是文件内的
类型）。准备函数 `prepareDaemonDatabaseProviderForBoot` 与它按 `kind` 的两支不变；两个组合函数放在新文件里、跨模块调用它（`rfc394` 的启动
序列用例按模块导出替换它，同模块内的调用替换不到）。

### D2 两个实现

- 本机 epoch 路径的判断从 daemon 原样搬进 system-operations 的 application：`application/epochBootAdmission.ts` 的
  `admitLocalEpochInstallation(effects, config)`——升级策略、核对、回执与指引照旧调 domain 的 `classifyEpochInstallation` / `autoUpgradeTrigger` /
  `epochInstallationGuidance`；读事实、升级子进程、重读配置、待定恢复与升级日志器都是交入的 effect。不放在 `application/epochSwitch/`：那是只给 CLI 的 V3 迁移面，daemon 不得够到（`rfc395-v3-dormancy`）。组合层只装配（RFC-294 S10：组合层没有分支与
  `throw`，`composition-control-flow-system-operations` 不升）。
- `composeLocalDaemonDatabaseInstallation({ appHome, runAutoUpgrade })`：`admit` 以本机 effect 调上面的用例（读事实取
  `readEpochBootFactsForConfig({ appHome, database })`，`appHome` 取代 `Paths.root`——单机 profile 交入的正是 `Paths.root`；升级子进程由单机 profile
  交入 `runAutoUpgradeChild`，system-operations 不取 bootstrap；待定恢复是 `applyLocalEpoch2PendingRestore(contract)`；升级日志器照旧是
  `epoch-upgrade`，只在有回执时创建）；`prepare` 调 `prepareDaemonDatabaseProviderForBoot({ kind: 'file', configuration, file })`。
- `composeSelectedDaemonDatabaseInstallation(installation)`：`admit` 什么都不做（release Job 已安装）；`prepare` 调
  `prepareDaemonDatabaseProviderForBoot({ kind: 'selected', configuration, installation, file })`。
- 单机 profile：`databaseInstallation: composeLocalDaemonDatabaseInstallation({ appHome, runAutoUpgrade: runAutoUpgradeChild })`（构造只建闭包，
  不碰磁盘，锁前构造无副作用）；托管：`databaseInstallation: composeSelectedDaemonDatabaseInstallation(system.databaseInstallation)`。

### D3 daemon

`startCommand` 在原位置调 `await databaseInstallation.admit({ config, configuration, contract: logicalSchemaContract })`，之后照旧重读配置；准备处调
`databaseInstallation.prepare({ configuration, file: { … } })`，`.catch` 的两种指引照旧。删去两处 `null` 判断与 epoch 路径、升级子进程、
`prepareDaemonDatabaseProviderForBoot` 的导入。

### D4 选择分组与锁

- 选择分组：`databaseInstallation` 从可空一组移到必填一组（必填 55 → 56、可空 8 → 7）；它是进程级的值，不是会话工厂。
- 钉住旧形状的锁随改：`rfc431`（计数；以 `databaseInstallation` 为靶的“可空改可选”负对照换靶 `crewStationEvents`）、`rfc433`（单机不再给
  `null`，改断言给出本机安装）、`rfc394`（托管不再原样交出安装端口，改断言它交出按端口的安装、`admit` 不碰端口）、`rfc524`（准备的两支实参
  改钉新文件）、`rfc395-af1`（读事实先于应用待定恢复的顺序改读 application 的用例）、`rfc130-git-version-gate` 与 `rfc370-startup-lease-root-wiring`（daemon
  里的准备调用改为 `databaseInstallation.prepare(`）。
- 新增 `tests/rfc532-deployment-database-installation-selection-boundary.test.ts`，登记 guard-manifest：① `bootstrap/daemon*.ts` 不拿
  `databaseInstallation` 与 `null` / `undefined` 比较，不导入本机 epoch 路径的函数、升级子进程与 `prepareDaemonDatabaseProviderForBoot`；② 合同的
  槽位不可空、类型是 `DaemonDatabaseInstallation`；③ 两个 profile 都以对应的组合函数给出；④ 行为：托管的 `admit` 不碰安装端口，单机的 `admit` 在
  全新的家目录上不起升级子进程；带负对照（只喂伪造的源码）。

## 3. 清单（退出门）

| 名字                                             | 之后                                |
| ------------------------------------------------ | ----------------------------------- |
| `databaseInstallation`（可空）                   | 必填 `DaemonDatabaseInstallation`   |
| daemon 的本机 epoch 路径（`null` 分支）          | 单机安装的 `admit`                  |
| daemon 按 `null` 选准备的 `kind`                 | 两种安装各自的 `prepare`            |
| `daemonStart.ts` 对 epoch 路径与升级子进程的导入 | 删去（单机 profile 交入升级子进程） |

## 4. 用例

- ① ～ ④ 见 D4；既有用例覆盖本机自动升级与待定恢复（`rfc398`、`rfc395-af1`、`cli` 的启动用例）、两种准备（`rfc370-daemon-database-boot-bindings`）与
  启动序列（`rfc394-start-sequence`，它替换读事实与准备两个导出、跑真实的单机选择）。

## 5. 失败模式

- **单机启动顺序变了**：`admit` 在原位置（探测宿主之后、打开密钥箱之前）被调，函数体原样搬入；`rfc394-start-sequence` 跑真实的启动程序与单机选择。
- **单机读错家目录**：单机 profile 交入的 `appHome` 即 `Paths.root`；待定恢复照旧在 `Paths` 下（函数不变）。
- **托管多做了事**：托管的 `admit` 什么都不做，RFC-532 用例以碰到即抛错的端口钉住。

## 6. 取舍（可推翻）

1. **安装选择是两个方法的值，而不是会话工厂**：daemon 每个进程启动一次，安装的两个阶段之间隔着打开密钥箱与令牌；拆成 `admit` / `prepare`
   保留原来的顺序，比“一个方法跑完全部”少改启动程序的结构。
2. **升级子进程由单机 profile 交入**：它起的是本二进制的 CLI，属于 bootstrap；system-operations 的本机安装只决定何时起。
3. **CLI 的 epoch 判定不动**：它们不读部署选择，与本 RFC 的分支无关。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只新增一个装配文件（只装配，判断在 application），模块 composition 不取 bootstrap。**C11**：各模块 public 不变（新类型在 composition）。**C12**：RFC-532 用例覆盖
  合同、两个 profile 与 daemon。**C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项余项的另一半——daemon 不再按部署能力是否为 `null` 分支（加上 RFC-531 的两处，第 1 项在 daemon 侧的余项收完）。
- **留下**：按模块分组为适配器集合（design §9.3 的终态）；S12 第 4 项；CLI 迁移命令与 daemon 共用的 epoch 判定仍各写一份（`bootstrap/migrate.ts`
  与本机安装的 `admit` 读同一组函数，随 S12 第 2 项“CLI 与 daemon 共用模块工厂”的后继判断）。
