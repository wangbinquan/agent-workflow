# RFC-398 技术设计

- 版本：v6（2026-10-31，按第 1～5 轮设计门修订，处置见 §10）。
- 行号均以 `d7c5d5462`（= `origin/main`，产品代码与 tag `v0.19.3` 相同）为准。

## 1. 落位（RFC-294 对齐）

全部改动落在 `system-operations` bounded context 与 `platform/persistence`，不新增跨 context 耦合。

| 层 | 新增 / 修改 | 说明 |
| --- | --- | --- |
| domain | `modules/system-operations/domain/epochSwitch/autoUpgrade.ts`（新） | 纯函数：触发判定、自动会话状态折叠、计划评估、PG 库名分配与建库语句生成、失败分类、退出码映射 |
| application | `application/epochSwitch/autoUpgrade.ts`（新）；`planner.ts`（改：发现阶段接受请求的操作 ID） | 自动会话编排，只经由既有 `EpochSwitchApplication` 与新增端口 |
| ports | `application/ports/epochSwitch.ts`（改） | 新增 `AutoUpgradeRecordPort`、`PostgresqlProvisioningPort`、`LegacyMigrationFinalizePort`、`SessionLockPort` |
| infrastructure | `infrastructure/epochSwitch/{autoUpgradeRecords,postgresqlProvisioning,legacyMigrationFinalize}.ts`（新）；`infrastructure/local/epochSwitchQuiesce.ts`（改：会话锁借用）；`infrastructure/local/nativeDaemonStartupLease.ts`（改：识别进行中的升级）；`infrastructure/epochSwitch/bootAdmission.ts`（改：读会话状态） | |
| converter | `platform/persistence/migration/supportedSources.ts`、`sourceAccess.ts` 等（改：v0.18.18 / v0.18.19 PG 桥接源，§3.8） | 不改转换规则 |
| composition | `bootstrap/epochMigration.ts`、`bootstrap/epochMigrationEntry.ts`（改） | 组装端口；CLI 动词 `db migration auto` |
| platform | `platform/persistence/sqlite/openForRead.ts`（新）、`platform/persistence/postgresqlProfileRef.ts`（新）、`packages/shared` 的 `PostgresqlDatabaseConfigSchema`（加 `databaseName`） | 只读打开与 profileRef 语法各一处实现 |
| 入口 | `bootstrap/daemonStart.ts`、`main.ts`（`migrate`、`db migration` 分支）、`cli/epochMigration.ts`（改） | `start` 只调用 domain 判定并**拉起子进程**，不 import 切换模块 |

**为什么 `start` 用子进程**：`tests/architecture/rfc395-v3-dormancy.test.ts:30-36` 与
`tests/helpers/epochMigrationReachability.ts:3-8` 锁定四个运行时入口（含动态 import）不得触达
`modules/system-operations/{application,infrastructure}/epochSwitch/`、转换器 `migration/{run,target,freeze}` 与
`bootstrap/epochMigration*`；`domain/epochSwitch/`、`bootAdmission.ts` 与启动租约在允许范围内。子进程执行同一二进制的
`db migration auto`，守卫不变，转换器的内存峰值也留在子进程。`migrate` 与 `db migration` 是 `main.ts` 的 CLI 分支
（不在运行时入口集合内），沿用现有的动态 import。

**本 RFC 承担的演进**：RFC-349 遗留操作收尾、只读打开、profileRef 语法各收口到一处；不新增 facade。**偏离项**：无。

## 2. 自动切换

### 2.1 触发条件（domain 纯函数）

单机部署（`profile.selections.databaseInstallation === undefined`）、`config.autoEpochMigration !== false`（新配置项，默认
`true`），且满足任一：

1. 安装分类为 `epoch1`（`classification.ts:73-84`），且不存在以「校验失败」告终的最近自动会话（§2.6）；
2. 存在**未收尾的自动会话**（§2.3），不论安装分类为何——覆盖 `activated` 已落盘、分类已是 `epoch2` 但尚未 verify / 写回执，
   以及校验失败后撤回尚未收尾的情况；
3. 分类为 `switch-recovery-required` 且原因为 `activation-unreconciled`，对应操作属于某个自动会话。

存在**非自动**的进行中操作（人工 `db migration plan` 创建）时不触发，维持现有拒绝。其余分类同今天拒绝，指引补上
`agent-workflow migrate`。`bootAdmission.ts` 把自动会话状态读进 `InstallationFacts`。

### 2.2 进程关系与锁

**会话锁**：自动会话从开始到收尾全程持有 daemon 锁（`.daemon.lock`）。会话内每次 plan / run / verify / rollback 调用通过
`SessionLockPort` **借用**该锁：quiesce 不取锁、不放锁、不发信号（今天 `session.ts:388` 在每次调用结束释放 quiesce，
`epochSwitchQuiesce.ts:94` 会放掉实际锁；在会话锁模式下这两处改为空操作）。人工命令不在会话内，行为不变。

```text
start（PID P）取得 daemon 锁（现状）→ 读配置 → 分类 → 触发
  └─ 拉起子进程 C：<self> db migration auto --json
       环境：继承 + AGENT_WORKFLOW_EPOCH_LOCK_DELEGATION=P
       C 第一件事：原子写 database-migrations/auto-upgrade/active.json = {pid: C, parent: P}
       C 校验委托（环境变量 == P、锁文件 PID == P、process.ppid == P），之后以「P 代持」作为会话锁
       C 的 stderr 逐行转发到 P 的 stderr 与 daemon 日志（logger 'epoch-upgrade'）
       P 收到 SIGINT / SIGTERM：转发给 C，等 C 退出后再退出
  C 退出码：0 → P 重读配置、重新分类，必须为 epoch2 且无未收尾会话，继续启动
            3 → P 打印 C 的 stdout 中的结论与指引，释放锁，退出码 1
            其他 → P 打印错误，释放锁，退出码 1
```

自身调用沿用 `util/gitCredentialLease.ts:36-40` 的形状（编译产物与源码运行两种 argv）。

- **取锁即复核（唯一协议）**：任何进程取得 daemon 锁（启动租约，以及下面 C 的接管）之后、在做任何安装分类、拉起子进程或数据库准备
  **之前**，都必须再读一次 `active.json`：若其中记录的是**另一个**存活进程的自动会话，则只在锁文件仍是自己的 PID 时释放本次取得的锁，
  然后等待、稍后重试，不得返回可用租约。只有会话所有者（P 存活时的 P，或接管后的 C）能在存活会话期间持有 daemon 锁。取锁失败
  （`util/lock.ts:59` 抛出 `DaemonLockHeldError`）时，在套用现有 already running / 等待超时规则（`daemonStart.ts:130`、
  `nativeDaemonStartupLease.ts:32`）**之前**也先读 `active.json`：存在存活的自动会话即进入升级等待。
- **P 消失**：C 每秒检查 P。P 不在了，C 尝试接管：仅当锁文件中的 PID 已死亡（P）或锁文件不存在时，才把锁文件**原子改写**为自己的 PID
  （写满临时文件后 `rename` 覆盖，锁文件不会出现内容不完整）；若锁暂时被另一个存活进程持有（它会按上一条复核后自行释放），C 稍后重试。
  接管期间 C 继续持有操作锁（`fileJournal.ts:131`）并照常推进。会话锁从「P 代持」转为「C 自持」，做完后先释放锁、**再**删除
  `active.json`，不启动 daemon。
- **启动租约识别进行中的升级**：`nativeDaemonStartupLease.ts:27` 在做任何取锁或回收**之前**先读 `active.json`：只要其中的 `pid` 存活，
  就不取锁、不回收、不报 already running——不论锁文件此刻是否存在、是否已写入 PID、PID 是 P 还是 C——打印「数据库升级进行中
  （pid …，操作 …）」并每 2 秒复查，直到该进程退出后再按正常流程取锁、按 §2.1 重新判定。`active.json` 的 `pid` 死亡即视为陈旧。
  这样 P 已死但 C 尚未接管、接管进行中、C 已释放锁但尚未删除 `active.json` 这三个窗口里，新的 `start` 都只会等待；即使它在 C 登记之前
  读过一次 `active.json`、之后才取得锁，也会被「取锁即复核」挡下。
- **C 被杀**：`active.json` 中的 PID 死亡即视为陈旧；daemon 锁与操作锁（`fileJournal.ts:131`，PID 锁）都可回收；下一次 `start`
  续做同一会话。

`migrate` 是 CLI，进程内直接调用同一编排：它自己取得 daemon 锁作为会话锁（不经委托）。

### 2.3 自动会话

**身份先行**：自动流程在任何副作用（RFC-349 收尾、建库、发现、计划）之前生成 `operationId`（`dbm_e2_…`），先写会话意图，再以该 ID
发现操作。`discoverEpochOperation`（`application/epochSwitch/planner.ts:68-247`）增加可选的「请求的操作 ID」，只在新建时使用。

**记录**：`database-migrations/auto-upgrade/sessions/<operationId>/NNNN-<kind>.json`，逐条一次性写入、编号递增，不改写。journal 的阶段
仍是唯一事实源，记录只保存自动流程自己的决定。PG 库名分配另记于跨会话的 `database-migrations/auto-upgrade/allocations/NNNN.json`（§3.2）。

| kind | 内容 |
| --- | --- |
| `intent` | 操作 ID、候选构建、provider、触发原因、会话序号 |
| `rfc349-finalized` | 收尾的 RFC-349 操作 ID 与结果（§4） |
| `provisioned` | 某个 run 的目标 / scratch 分配号与「是否本会话创建」 |
| `plan-evaluated` | runId、计划摘要、approvalDigest、blocks 数、restrictions 列表 |
| `approved` | runId 与批准的 approvalDigest |
| `refused` | 阻塞原因（blocks、可确认项、权限不足、非空目标等），会话保持可续做 |
| `verify-failed` | 校验失败详情，**同时即是撤回承诺**：写入后该会话不得再进入 verify，只能把首写前撤回做完 |
| `rolled-back` | 撤回完成（journal 已 `rolled-back`、指针已恢复） |
| `completed` | 自动升级回执摘要（§2.7），会话收尾 |
| `failed` | 终止原因（含校验失败），会话收尾 |

journal 只接受合法 `operationId` 目录（`fileJournal.ts:93`），RFC-349 探测只读含 `manifest.json` 的目录（`installationProbe.ts:33`），
`auto-upgrade/` 不会被误认；仍各补一条用例锁定。

**状态折叠**：会话「未收尾」= 没有 `completed` / `failed`。对应操作被人工 `rolled-back` / `abandoned` 且会话没有 `verify-failed`
时，追加 `failed`（原因：外部撤回）。

### 2.4 编排（每步可重入）

```text
A. 取会话：最新的未收尾自动会话 → 续做；否则若触发条件 1 成立 → 新建（会话序号 +1，写 intent）；否则 noop（退出 0）。
B. 撤回承诺：满足任一即进入——会话已有 verify-failed；当前 run 的 journal 已持久化**验收失败**（`journal.failure` 的
   `detailCode === 'v3-acceptance-failed'` 且 `category === 'health-failed'`，`completion.ts:40`、`session.ts:378`）；当前 run 已有任何
   **已发布的负向验收产物**（`completion.ts:31-41` 保存的 `acceptance-health-<revision>.json`，不论 journal 是否已引用——未引用的在
   `<operationRoot>/.artifacts/<digest>/` 下，`fileJournal.ts:145`；只按 journal 引用遍历的 `session.ts:260` 找不到它们，须直接扫描；
   未发布的 `.tmp` 不算）。会话尚无 verify-failed 时先补记，再把撤回做完（§2.6），写 rolled-back、failed，退出 3。绝不重新进入 verify。
   其他 `journal.failure`（如 `v3-source-changed`，`runner.ts:407`、`status.ts:117`）**不**构成撤回承诺，按 E / F 的失败分类续做。
C. RFC-349 遗留操作（§4）：需要且可收尾 → 收尾并记录；不可收尾 → refused，退出 3。
D. PG：为当前 run 分配并准备目标 / scratch（§3），记录 provisioned；权限不足或目标被占 → refused，退出 3。
E. 按 journal 状态分派：
   - 无操作或 phase ≤ planned：plan（新建时带请求 ID，否则对同一操作重新计划）→ 评估（§2.5）。
       blocks 非空 → refused，退出 3（处理可确认项后再次启动，回到此处对同一操作重新计划）。
       否则 approved → F。
   - status = awaiting-approval：读该 run 已持久化的待批计划（`status.ts:79` 的计划引用）→ 评估 → approved → F。
       不对冻结后的 run 调 plan（`planner.ts:437` 会拒绝）。
   - phase ∈ (planned, activated)：F（用该 run 最近一次 approved 的摘要；run 若要求重新批准，回到上一行）。
   - phase = activated → G；phase = verified → H。
F. run --approve <digest>，按「返回值或抛出的结构化失败」（`session.ts:364` 记录后重新抛出）分类：
   - 返回 awaiting-approval → 回到 E（每个 run 最多 3 次，超出 → refused）。
   - 源已变化（failure category / code 表示需要 --new-run）→ run --new-run：PG 的新目标由注入的
     `nextTargetLocation(previous, next)`（`runner.ts:270`）按 next.runId 幂等分配、建库并记录，在 journal 替换与计划（`runner.ts:300`）
     之前确定；回到 E。
   - activated → G。其他失败 → 输出并退出 1（会话保持可续做）。
G. verify：通过 → H；失败 → §2.6。
H. 写回执（§2.7），追加 completed，删除 active.json，退出 0。
```

### 2.5 计划评估

只有 `blocks` 为空才批准该计划的 `approvalDigest`。可确认项属于 blocks，不自动确认（RFC-395 用户裁决）；restrictions 自动接受
并记录（proposal C2）。评估是 domain 纯函数，输入是计划视图，输出 `approve(digest)` 或 `refuse(reasons)`。

### 2.6 校验失败

1. 负向验收结果的**第一次持久化**即构成撤回承诺：今天的顺序是保存 `acceptance-health` 产物 → journal 引用 → 抛错 → 写
   `journal.failure`（`completion.ts:31-41`、`session.ts:336-349,378`）；自动模式追加 `verify-failed`（失败详情），**再**执行 RFC-395
   首写前撤回（此时 daemon 未启动、没有业务写入）。负向结果尚未落盘就中断，等同校验未完成，重新校验是正确行为。
2. 撤回完成后追加 `rolled-back` 与 `failed`，退出 3。
3. 任一步之间中断（含负向产物已落盘而 journal 未引用、已引用而 `journal.failure` 为空、journal 已记失败而 `verify-failed` 尚未写入）：
   下次进入 §2.4 B，先补记缺失的 `verify-failed`，再按 journal 与
   pointer 的实际状态（撤回 journal 已提交、目标已 retired、pointer 已恢复）把撤回做完并收尾；会话未收尾前不得新建会话，也不得因
   第二次校验恰好通过而写 `completed`。
4. 收尾后，最近会话以校验失败告终 → `start` 拒绝并输出持久化的失败详情，不自动重试（避免每次重启都重做全量转换）。运维修复后用
   `agent-workflow db migration auto --retry` 开新会话（新的分配号，§3.2）；旧二进制仍可直接使用源库。

### 2.7 回执与可见性

`completed` 附带回执文件 `receipt.json`：源 fingerprint、目标位置（PG 含实际库名）、restrictions、RFC-349 收尾、建库与保留、
各阶段耗时、切换前备份位置与回到旧版本的方法。启动日志打印同样的摘要（有 restrictions 时逐条 WARN）；`db migration status`
显示 `mode: auto`；`doctor` 与存活探针 `/health` 的数据库信息包含实际 PG 库名（实现期更正：仓内没有 `/api/health` 路由，legacy 操作 ID 会去掉 `/api/` 前缀，两者不能并存）。`complete`（保留期登记）仍由运维在验收后执行，
不属于自动收尾的完成判据。

## 3. PostgreSQL 目标与 scratch

### 3.1 定位顺序

1. 环境变量 `AGENT_WORKFLOW_EPOCH_TARGET_URL` / `AGENT_WORKFLOW_EPOCH_SCRATCH_URL` 已设置 → profileRef `env:<名>`（与今天的
   `--target-url-env` / `--scratch-url-env` 同义；切换后 daemon 须继续带着目标变量；只能用于一个 run，新 run 或 `--retry` 需要
   运维换成新的空库并更新变量）。
2. 否则在源库所在服务器**派生**同级数据库，profileRef 为 `env:<源变量名>/<库名>`（§3.6），切换后不需要新变量。

### 3.2 库名分配

- 跨会话分配账本 `auto-upgrade/allocations/NNNN.json` 逐条追加：`{n, kind: target|scratch, sessionOperationId, runId, database}`，
  已分配的库名永不复用（退休目标、旧 scratch 都保留）。
- 源库名取 `SELECT current_database()`。目标：第 1 次分配为 `<db>_epoch2`，之后为 `<db>_epoch2_<n>`；scratch：每个会话一个，
  第 1 个为 `<db>_epoch2_scratch`，之后为 `<db>_epoch2_scratch_<n>`。超过 63 字节时以 `<db 前缀>_<sha256(db) 前 8 位>` 代替 `<db>`。
- 分配在建库之前落盘，按 `(会话, runId, kind)` 幂等：重复执行得到同一库名。

### 3.3 建库语句

由 domain 纯函数按源库属性与服务器主版本（支持 15～18）生成，自动建库与打印给 DBA 的语句共用：

- 读源库 `pg_database`：`datlocprovider`、`datcollate`、`datctype`，以及 provider 对应字段（PG 15/16 的 `daticulocale`，
  PG 17+ 的 `datlocale`，PG 16+ 的 `daticurules`）。
- 生成 `CREATE DATABASE "<名>" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER <libc|icu|builtin> LC_COLLATE … LC_CTYPE …`
  并按 provider 追加 `ICU_LOCALE` / `ICU_RULES` / `BUILTIN_LOCALE`；打印给 DBA 时另加 `OWNER "<当前角色>"`。
- 建成后读回新库属性，与源库逐项比较，不一致即删除本会话刚建的库并 refused。

### 3.4 建库、复用与阻塞

- 不存在 → 用源连接执行 §3.3 的语句，记录「本会话创建」。
- `42501 insufficient_privilege` → refused `postgresql-create-database-denied`，输出两条语句；DBA 执行后再次 `start` 即继续。
- 已存在：目标为空，或已是本会话该 run 的目标（`targetEvidence` 能读到对应 generation）→ 复用；否则 refused
  `postgresql-target-not-empty`。scratch 为空或带本会话标记表（`preparePostgresqlScratch` 现有机制，`postgresqlDatabases.ts:208`）
  → 复用；否则 refused。
- 既有目标预检（`classifyExternalTarget`，`postgresqlDatabases.ts:84-132`）照常进入计划。
- 退休目标与旧 scratch 一律保留，列入回执与 `doctor`。

### 3.5 scratch 保留

scratch 库**不自动删除**：`db migration trace … --replay` 会重新冻结源并经 scratch 读取（`bootstrap/epochMigration.ts:181,370`、
`freeze/sourceManifest.ts:31`；较老 PG 源还会重开保留的升级副本，`freeze/sourceAccess.ts:340`）。回执、`status` 与 `doctor`
列出其库名、大小与用途；文档说明保留期结束后可由运维手工 `DROP DATABASE`，此后 PG 源的追溯重放不可用。

### 3.6 profileRef 语法与全部校验点

- 语法：`env:<VAR>` 或 `env:<VAR>/<库名>`；`<库名>` 1～63 字节、不含 `/` 与空白，按 `encodeURIComponent` 存放。托管的
  `crewstation:source` / `crewstation:target` 不变。
- 唯一实现 `platform/persistence/postgresqlProfileRef.ts`（纯函数，无依赖），替换以下全部校验 / 解析点：
  `domain/epochSwitch/model.ts:199`（source）、`:212`（target）、`:235`（scratch）及复用它们的 plan / activation 文档 schema；
  `domain/epochSwitch/supportMatrix.ts:19-23`（`environmentProfile`）；`platform/persistence/databaseProviderRuntime.ts:102`
  （`pointerConfiguration`）；`platform/persistence/migration/freeze/postgresqlDatabases.ts:20`（`postgresqlRuntimeFor`）。
- application 输入：`EpochSwitchTargetInput`（`public/types.ts:292-295`）与 `EpochSwitchPlanInput` 增加 `profileRef` /
  `scratchProfileRef`，与 `urlEnv` / `scratchUrlEnv` 二选一。
- `PostgresqlDatabaseConfigSchema` 增加可选 `databaseName`；`postgresqlRuntime.ts` 的 `safeUrl` 在其存在时替换 URL 路径，
  保留主机、凭据与查询参数。它由 pointer 推导，不写入 `config.json`，文档注明不作手工配置项。pointer v2 的 `profileRef`
  本就是任意非空字符串（`generationPointerV2.ts:40`）。
- 整链用例：派生引用 → plan → 进程退出 → 重读 journal → run → verify → 以 pointer 启动 daemon → 业务读写成功。

### 3.7 「原生建在 PG 上」的判定

自动模式下：v1 指针引用的 RFC-349 操作带 `legacyArchiveDigest` → 用保留归档（`bootstrap/epochMigration.ts:543-574`）；否则视为
原生建在 PG 上，转换器照旧核对 6 张归档表不存在（`epochSourceArchiveInput`），不满足即阻塞。人工命令继续认
`AGENT_WORKFLOW_SOURCE_BORN_ON_POSTGRESQL`。

### 3.8 v0.18.18 / v0.18.19 的 PostgreSQL 源

- **事实**（本机 2026-10-30 用正式版二进制复现）：两版的 PG 基线 `0000_rfc349_baseline_v1` 合同 / 计划为 `05a9771c…` / `8a257cc1…`
  （v0.18.18）与 `3ee9be23…` / `faba80bb…`（v0.18.19），对应 SQLite 第 223 条迁移；该基线在 v0.19.0 之前被改写（RFC-359 T19h
  之后才冻结已发布字节），当前冻结链的基线为 `9aabfa48…` / `35a4a5ce…`（第 224 条）。v0.19.0 与 v0.19.2 启动这样的库报
  `database generation schema digest does not match this binary`；v0.19.3 的转换器报 `Unknown source fingerprint`。即这两版的 PG
  实例**自 v0.19.0 起就没有升级路径**。
- **原始基线入库**：两版的 PG 基线（SQL、journal、合同含归档表合同、计划、catalog，取 tag 原字节）存入
  `migration/epoch1/released-postgresql/<tag>/`。它们是独立登记的支持源，不作为冻结线性 history 的相邻版本插入。
- **重建 SQLite@0223（装载协议）**：桥接的目标是还原这些 PG 库当初由 RFC-349 复制自的那份完整 SQLite@0223：
  1. 按该版本的**真实 SQLite 收据**（223 条迁移字节与当前冻结文件逐一相同，已核对）构建离线副本；
  2. 保存全部触发器 DDL 后删除触发器（例如 `0210_rfc328_task_execution_ownership.sql:101` 的 AFTER INSERT 触发器会把旧 daemon 在 PG
     上正常写入的 NULL `lineage_slot_path_json` 补写成派生值，`0224_rfc359_node_run_lineage_explicit.sql:3-13,24` 记录了这一事实）；
     清空迁移建库时插入的行，保留 `__drizzle_migrations`；
  3. 以 `foreign_keys = OFF` 装载：PG 活跃表的全部行按**该版本自己的合同 codec** 解码、原值写入；六张 archive-only 表的行取自
     RFC-349 保留归档——先按该版本原始归档合同与归档摘要验真，再用同一合同解码写入；
  4. 按保存的 DDL 原样重建触发器；`PRAGMA foreign_key_check` 与 `quick_check` 必须通过；副本的物理 catalog 与该版本 catalog 精确相等；
  5. 判据：每张活跃表的行数与逻辑摘要等于 PG 源，六张归档表等于保留归档，写入桥接回执。两版 PG 基线缺少部分 SQLite 约束
     （RFC-359 W7 之后才补齐），若源数据在 SQLite@0223 约束下不成立，按行列出证据并阻塞，不丢弃、不修改数据。
- **读取视图**：源身份（fingerprint、watermark、元数据、identity 高水位）仍是原 PG 库；重建的副本作为 `pre-upgrade` 物理读取者，之后走
  既有 SQLite 离线补迁移（0224 起）与转换路径，目标仍是 PostgreSQL。六张归档表此时就在副本里，由 SQLite 源的归档路径归档，**不**经
  PG 归档合成（`postgresqlArchiveSource.ts:23` 的 `expectedAbsent` 合同不适用于桥接源）；桥接回执约束归档产物与保留归档内容一致。
  原始合同的查找同时接入支持源识别、归档验真与 artifact reader（`freeze/postgresqlArchive.ts:30`、`artifactSourceReader.ts:109`），
  追溯重放时按同一协议重建副本并以桥接回执核对。
- RFC-349 迁移来的此类实例另需 §4 的收尾（v0.18.19 runner 同路径 `705-723,771-811` 与 v0.19.2 同形，已核对）。

## 4. RFC-349 遗留操作：epoch-1 收尾适配器

HEAD 的 RFC-349 runner 已改为写 v2 指针（`application/databaseMigrationRunner.ts:346`），协调器按 epoch-2 history 解析合同
（`infrastructure/databaseMigrationCoordinator.ts:285`、`schema/history/logicalHistory.ts:17`），不能用于 epoch-1 安装。新增
`infrastructure/epochSwitch/legacyMigrationFinalize.ts`，按 v0.19.2 的 `finalize`（v0.19.2 `databaseMigrationRunner.ts:711-729,777-817`）
逐步移植：

1. **状态刷新**：读并校验 manifest；从 PG 读取首次业务写入时间并按 v0.19.2 规则更新 manifest（v0.19.2 `:711-727`）。
2. **重放分支**：`phase === 'finalized'` 且 `rolledBackAt === null` → 以已持久化 checkpoint 的时间幂等重做 `markFinalized` 与 v1 指针
   刷新（覆盖「manifest 已推进、指针未刷新」时被杀）。
3. **收尾分支**：`phase === 'accepting-writes'` 且 `rolledBackAt === null` → 写最终回执（一次性，字段同 v0.19.2）→ 在源库上执行 v0.19.2
   的 `markFinalized`（epoch-1 schema 元数据，幂等）→ 推进 manifest 到 `finalized` → 用 v1 写入器（`writeDatabaseGenerationAtomic`，
   v0.19.2 `:341,374`）刷新 v1 指针。
4. 其余阶段 → refused `rfc349-operation-unfinished`，指引写明用旧二进制 `db migration status|resume|cancel`。
5. 合同解析用冻结 epoch-1 history（含 §3.8 的两版原始基线）。
6. `db migration status|finalize <dbm_…>`（`main.ts:441-447` 的分派）在 epoch-1 安装上改走本适配器，**不得**写出 v2 指针。

等价性：L2 录制工具用 v0.19.2（以及 v0.18.19）二进制产出「一键迁移后未 finalize」「PG 已首写但 manifest 未刷新」「随后 finalize」
三份状态（home 文件 + PG 元数据行）。单测在前两份上运行本适配器，与第三份逐字段比较（时间、digest 与绑定环境的 fingerprint 按规则
归一），并在每个持久化步骤之间注入中断后重放，结果相同。

## 5. 只读打开：WAL sidecar

- helper `openSqliteForRead(path)`：库文件旁有 `-wal` 时只读打开（不触碰他人未 checkpoint 的 WAL）；没有 `-wal` 时以
  `{ readwrite: true, create: false }` 打开且不执行任何写语句，让 SQLite 自行创建 / 回收 sidecar。语义与 `db/integrity.ts:32-48`
  的 `allowWalSidecarCreation` 一致；`quickCheckDbFile` 默认改为同一判据。
- 迁移以下读路径：转换快照 `migration/legacy/sqliteSnapshot.ts:7`；源读取 `migration/sqliteSourceReader.ts:66`；
  `migration/auditSourceEvidence.ts:26`；`migration/freeze/backup.ts:168`；启动分类 `epochSwitch/bootAdmission.ts:99`；epoch-2 启动
  `databaseProviderRuntime.ts:596,611`；`unpublishedInstallation.ts:24`；`databaseOperationalAdapter.ts:59`；
  `sqlite/readonlySqliteDatabase.ts:17`；`doctorDiagnostics.ts:250,350`；`providerBackupScheduler.ts:334`；
  `sqlite/systemBackupManifest.ts:81`；`sqlite/systemProviderRestore.ts:219,728`；`migration/target/admission.ts:48`；
  `migration/target/connection.ts:91`；`sqliteMigrationSafetyBackup.ts:76`；`bootstrap/epochMigration.ts:498,658`；
  `bootstrap/epochMigrationEntry.ts:71`；`migration/legacy/backupManifest.ts:73`。本进程刚生成、确定非 WAL 的副本（如
  `VACUUM INTO` 产物）可保留只读，但须列入守卫白名单并写明理由。
- 守卫：源码文本断言 `packages/backend/src` 内 `new Database(…, { readonly: true })` 只出现在 helper 与白名单位置。

## 6. `doctor` 与提示

`database provider` 一项在 epoch-1 安装上报告识别出的源版本、下一次 `start` / `migrate` 将自动升级（或 `autoEpochMigration: false`
时的人工命令）；PG 另报 RFC-349 遗留操作状态、将分配的库名、建库权限（`rolcreatedb` 或目标已存在）；v0.18.18 / v0.18.19 PG 源报告
将走桥接。存在未收尾 / 失败的自动会话时报告其阶段与下一步。不再出现 `ENOENT database-generation.json`。

## 7. 测试

### 7.1 发布版登记表

`packages/backend/tests/fixtures/release-upgrade/releases.json`，由 `scripts/release-upgrade/registry.ts --write` 从 git tag 生成并入库，
每个已发布 tag 一行：

- `epoch1.sqlite`：该发布版写入 `__drizzle_migrations` 的**逐条收据**（`created_at` 即 folderMillis、`hash`），由该 tag 的
  `_journal.json` 与该 tag 的 SQL 字节按 drizzle 规则计算。
- `epoch1.postgresql`：该发布版 PG 序列的收据（baselineId、合同 / plan 摘要）；v0.18.18 / v0.18.19 指向 §3.8 的原始基线；无 PG 为 `null`。
- `epoch2.history`：该发布版的 epoch-2 history 版本，或 `null`。
- `releasedSql`：该 tag 的 SQL 字节与当前冻结字节不同的迁移（已知 `0111`：v0.17.11、v0.18.0、v0.18.10 的哈希为 `8f7584ec…510d97`，
  冻结文件为 `3d99826a…6b3ed7`，见 `migration/epoch1/journalAliases.ts:17`），字节另存 `fixtures/release-upgrade/released-sql/<sha256>.sql`。
- `buildKey`：上述收据与字节的摘要；`buildKey` 相同的发布版产出逐字节相同的库，矩阵只构建一次（有证据的等价复用）。
- `binaries`：各平台产物来源与 SHA-256：`release-asset`、`retained-asset`（§7.7 的长期留存）、`ci-artifact` 或 `tag-build`
  （证据等级依次降低，须注明）。
- `l2`：`gate`（发版门集合）与 `nightly` 覆盖；无法驱动的版本写 `unsupported: <原因>`，须经用户确认。

### 7.2 种子账本与映射预言

- **种子**：`fixtures/release-upgrade/seeds/epoch1/<NNNN_tag>.json` 为该迁移应用**之后**插入的行（canonical logical value），附可选
  内容文件；`seeds/epoch2/<history 版本>.json` 同理。迁移规则：只追加、不改写已发布部分；行引用一致、语义合理（旧时间点以终态历史
  为主，在途状态只出现在当时代码会产生的形态里）。
- **映射预言**：`fixtures/release-upgrade/mapping-oracle.json`，按源表（与 `sourcePhase`）声明行处置与去向：`converted` / `preserved`
  （目标表、键映射、保值列 / 投影）、`archived`（归档字节、摘要与键）、`metadata`（迁移记录）、`history-only`。内容依据
  RFC-395 `table-mapping.md` 编写，**不得**由被测转换器的输出生成；个别种子行可在 `expect` 中覆盖。
- **构建** `buildReleaseHome(release, variant)`：
  - **epoch-1 SQLite**：按登记收据逐条应用迁移（字节不同的用 `released-sql/`），每条迁移后插入对应种子；`__drizzle_migrations`
    与登记收据逐行相等；无 pointer。
  - **epoch-1 PostgreSQL（原生）**：v0.18.18 起。按该版本 PG 基线所对应的 SQLite 位置构建 SQLite 库，用该版本的合同把行装入其 PG
    基线（v0.18.18 / v0.18.19 用 §3.8 的原始基线字节；之后的版本用冻结节点与 `migration/legacy/logicalDatabaseRestore.ts`），再逐个
    PG 版本应用并插入相应种子；PG 收据与登记相等。RFC-349 一键迁移形态的 manifest 与 v1 指针绑定源 / 目标环境 fingerprint，不能在
    别的数据库里重放，由 L2 用真实二进制覆盖，§4 的等价单测以录制夹具覆盖收尾逻辑。
  - **epoch-2**（v0.19.3 起）：以该发布版的 history 版本安装（`installHistoryHead` 支持安装给定版本，`schema/history/apply.ts:164-168`），
    插入 epoch-2 种子，写 `installed` 角色的 v2 指针与元数据；SQLite 与 PostgreSQL 各一。
- 编写工具 `scripts/release-upgrade/seed-ledger.ts`：`derive` 把真实录制数据投影到某条迁移当时的列上生成草稿；`check` 构建全部发布版
  并报告覆盖缺口。

### 7.3 L1 矩阵（每个 PR）

对登记表中**每个发布版**（按 `buildKey` 去重）× provider（SQLite 全部；PostgreSQL 为 v0.18.18 起的 epoch-1 版本与全部 epoch-2 版本）：

1. `buildReleaseHome` 构建；
2. **epoch-1**：在测试进程内调用与 `db migration auto` 相同的编排（复用进程内缓存），到 `verified` 为止；随即在 daemon 启动**之前**做
   §7.4 的严格核对（S1～S3）；
3. **epoch-2**：不调用编排；以 daemon 的数据库准备入口应用原生 history 前滚，随即做 §7.4 的 E1～E2；
4. 以子进程运行源码 daemon `start`（mock runtime），做 §7.4 的业务投影核对（A1），再用迁移来的工作流新建任务跑到 `done`，重启一次，
   `doctor` 通过；epoch-2 另断言没有新建任何 epoch 转换操作、history 已到头。

文件按发布版区间分片（`release-upgrade-matrix-<区间>.test.ts`），由既有后端分片执行器分摊；PostgreSQL 变体随 ubuntu 分片的
`AW_TEST_POSTGRESQL_URL` 运行，每个用例独立数据库。`start → 子进程` 的完整入口路径另由 `rfc398-start-auto-upgrade.test.ts` 覆盖；
夜间工作流把整个矩阵切换为全部经 `start` 子进程执行。

### 7.4 核对

严格核对在 daemon 写入之前完成；启动后的 API 核对允许种子声明的运行变化（如重启后在途任务状态的既定变化）。

| 代号 | 适用 | 判据 |
| --- | --- | --- |
| S1 回执 | epoch-1 | `pre-upgrade` 阶段：每张表读入行数与键 = 构建时的源库；`current` 阶段（补迁移之后）：按种子 `expect` 与独立的迁移效果预言（如 `0034_rfc066_task_repos.sql:59` 由 tasks 生成 task_repos）给出的清单、键与计数；unclassified = 0；blocked = 0；restrictions 与预言一致。预期不得由被测转换器的输出生成 |
| S2 去向 | epoch-1 全部源行 | 批量读取目标元数据：`aw_meta_migration_unit_sources`（键范围、行数、键摘要）与 `aw_meta_migration_row_dispositions`（逐行处置）；对构建的源行独立重算键摘要并与之核对；每行处置等于映射预言；`converted` / `preserved` 的目标行存在，`archived` 的归档字节与摘要匹配，`metadata` 的迁移记录存在。`db migration trace` 只用于抽样与失败诊断（逐行 replay 每次都要遍历转换，`conversion/trace.ts:39`） |
| S3 值 | epoch-1 保值列 | 映射预言声明的保值列 / 投影按目标键逐列比较（经 codec 归一）；不以旧合同的 KEEP 标签为准（如 `agents` 已关系化、`clarify_rounds` 已拆分） |
| E1 history | epoch-2 | 实际应用区间（旧 history 版本, 候选 head] 的每个版本都有 history 收据；其中 `data-transform` 边（`schema/history/apply.ts:114,130`）有对应的转换回执；安装版本及之前的边不要求回执 |
| E2 值 | epoch-2 | 未被任何边改动的表逐行逐列相等；被改动的表按该边种子声明的预期比较 |
| A1 业务投影 | 全部 | 用户与授权、代理、技能（字节摘要）、MCP、插件、工作流（定义摘要、版本）、任务（主体、状态、名称、输入、仓库挂载）、node run（标识、状态、输出值与类型）、评审（文档与版本、决定）、反问（题目、答案、草稿）、记忆、定时任务、工作组、数字员工与 Case、事件源与规则、用量：种子 `expect` 与升级后 HTTP API 的投影逐项相等 |

### 7.5 守卫与反证

- **覆盖**：每个发布版构建后，该版本 schema 中**每一张表**至少一行；豁免只允许迁移元数据表与该版本代码从不写入的退役表，逐条写原因，
  清单经用户确认。epoch-2：head 的每张表有种子；每个 history 版本都有种子文件（可为空）并被矩阵执行。映射预言覆盖每个源表。
- **映射**：登记表每一行都映射到实际执行的 L1 用例（去重后的构建）；有 linux-x86_64 产物的版本映射到 L2 夜间分片。
- **反证**（用例内负对照）：①从别名表去掉 `0111` 旧哈希后，v0.17.11～v0.18.10 的构建必须识别失败；②helper 退回纯只读打开后，
  去 sidecar 的构建必须失败；③关闭触发（人工模式）后 `start` 必须以现有指引拒绝；④删掉任一非豁免表的种子后覆盖守卫必须失败；
  ⑤去掉 §3.8 的桥接登记后 v0.18.18 / v0.18.19 PG 构建必须识别失败。

### 7.6 回归与单元用例

| 用例 | 锁定内容 |
| --- | --- |
| `rfc398-wal-sidecar-open.test.ts` | §5 每个读路径在「WAL 库无 sidecar」上成功且源字节不变；守卫白名单 |
| `rfc398-auto-upgrade-policy.test.ts` | §2.1 触发、§2.3 状态折叠、§2.5 评估、§2.4 F 的失败分类决策表 |
| `rfc398-auto-upgrade-resume-<point>.test.ts`（每个中断点一个文件，PG 为 `…-postgresql-<point>`；`rfc398-split-test-coverage.test.ts` 要求每点恰好一个文件，见 §11） | 真实子进程，分别 SIGKILL 子进程 / 父进程 / 两者后再次 `start`，三组预期：① 未形成撤回承诺的中断（intent 后、发现后、plan 中、blocked 后处理可确认项再启动、冻结后、转换后、等待重新批准时、activated 后、verified 后、持久化 `v3-source-changed` 之后）——续做到 `completed`，`source-changed` 在同一操作内进入新 run、不追加 verify-failed；② 负向探测结果尚未发布就中断——允许重新校验，成功即 `completed`；③ 已有撤回承诺（负向产物已发布而 journal 未引用、已引用而 `journal.failure` 为空、journal 已记验收失败而 `verify-failed` 未写、`verify-failed` 已写而撤回未做、撤回进行中）——第二次健康探测故意成功，也不得再调用 verify，只能完成撤回并以 `failed` 收尾。全程只有一个操作、PG 不重复建库 |
| `rfc398-start-auto-upgrade{,-barriers,-takeover,-signals,-retry}.test.ts`（按场景拆分，见 §11） | 子进程 `start`：自动完成并启动；阻塞时退出 1 且源不变；人工模式与今天一致；五个屏障——P 已死而 C 尚未接管、C 接管进行中、C 已释放锁而 `active.json` 未删、「N 已读到无 active → C 登记并完成委托 → 杀 P → 恢复 N」分别固定在 C 接管前与接管后（后者 N 取锁抛 `DaemonLockHeldError`）——第二个 `start` 都只等待、拿不到会话执行权、不拉起第二个 auto；接管停在 run 返回与 verify 之间仍做完；校验失败自动撤回并拒绝重试，`--retry` 开新会话并分配新库名 |
| `rfc398-postgresql-provisioning.test.ts` | 分配账本与库名（超长、特殊字符、跨会话不复用）；libc / ICU 源与 template0 provider 不同时建库属性与源一致；复用；非空拒绝；无 CREATEDB 角色输出的语句可执行；新 run 经 `nextTargetLocation` 在计划前得到新库且 journal 的 profileRef、实际库与目标 generation 一致；「校验失败撤回 → 修复 → 同环境 `--retry` 成功」 |
| `rfc398-profile-ref.test.ts` | §3.6 全部校验点；`databaseName` 替换 URL 路径并保留查询参数；整链用例 |
| `rfc398-rfc349-finalize.test.ts` | §4 三个分支与 v0.19.2 / v0.18.19 产物等价；逐步中断后重放；CLI `status / finalize` 可用且不写 v2 指针 |
| `rfc398-postgresql-bridge-<tag>.test.ts`（每个发布版一个文件，见 §11） | §3.8：两版原始基线构建；保留归档非空；切到 PG 后由旧 daemon 形态新建的 node run（`lineage_slot_path_json` 为 NULL）桥接后仍为 NULL；逐表行数与逻辑摘要相等、转换成功；桥接后 `trace --replay` 成功；SQLite 约束不成立的行按行阻塞；桥接登记缺失时识别失败 |
| `rfc398-doctor-epoch1.test.ts` | §6 输出 |
| `rfc398-release-registry.test.ts` | 登记表内部一致性、收据重建、`buildKey` 去重、映射守卫 |

### 7.7 L2 真实旧二进制（发版门 + 夜间）

- 工具 `scripts/release-upgrade/`：`scenario.ts`（经 HTTP API 造数：用户与资料、代理、工作流、技能、MCP、定时任务、工作组、记忆、
  业务工作流任务并分别停在 `done`、`failed`、`canceled`、`awaiting_review`、`awaiting_human`；按版本族处理 API 差异）、`verify.ts`
  （按登记表取旧二进制并校验 SHA-256、造数、关停、用候选二进制 `start`、验收）、`record.ts`（产出 §4 的等价夹具与 §7.2 `derive`
  的输入）。runtime 用仓内编译的 stub。
- 变体：SQLite 常规；SQLite 去 `-wal/-shm`；PG 一键迁移后不 finalize、旧 daemon 在 PG 上再写一轮（用户生产形态）；v0.18.18 / v0.18.19
  的 PG 一键迁移实例（§3.8）；PG 受限角色（期望退出并给出语句，按语句建库后再 `start` 成功）；逐级链（更老版本 → 上一发布版 → 候选）。
- 验收：关停前在旧二进制上取一组 API 投影，升级后在候选上取同一组逐项比较；批准迁移前挂起的评审后任务跑到 `done`；回答挂起的反问后
  任务继续；新任务 `done`；重启后健康；`doctor` 通过。
- **发版工作流**（`release.yml` 改造）：`build` 不再直接上传到 release，而是上传为本次运行的 workflow artifact；新增 `upgrade-gate`
  （ubuntu-latest：SQLite + PostgreSQL 服务，全部变体；macos-latest 与 windows-latest：SQLite 变体）以这些 artifact 为候选、以登记表
  `gate` 集合为旧版本，并检查「低于本 tag 的最高发布版」已在登记表且有种子覆盖；`publish`（needs `build`、`upgrade-gate`）才把
  artifact 上传为 release 资产（`--clobber`）并取消草稿。已公开 release 的重跑同样只在门通过后由 `publish` 替换资产。
- **夜间**：`release-upgrade-nightly.yml`（定时 + 手动）：从 `main` 构建候选；linux 上按登记表全部有产物的版本分片执行（PG 变体覆盖
  全部带 PG 的版本），macOS / Windows 跑 `gate` 集合；手动触发可指定候选 SHA 或候选产物。
- **已撤下版本的产物留存**：v0.19.3 的 Release 资产已不存在；同提交主 CI run 41157876045 的 `agent-workflow-{ubuntu,macos,windows}-latest`
  （提交 `d7b5d9da6`，2027-01-29 过期）经 SHA-256 登记后，复制到一个**不公开的草稿 release**（例如 `upgrade-fixture-binaries`）长期留存，
  登记为 `retained-asset`（需用户确认这一 GitHub 操作）；未获同意或留存失效时退回 `tag-build`（`git archive v0.19.3` 后以 Bun 1.4.3
  执行 `bun run build:binary`）并在证据里注明等级。
- **反证**（AC-7）：以 v0.19.3 产物作候选手动触发：断言各变体的旧库造数阶段成功、候选确实已启动，失败签名分别为
  `This is an epoch-1 installation`（SQLite 常规）、`unable to open database file`（去 sidecar）、`Finish or roll back RFC-349 operation`
  （PG 一键迁移）；取得产物失败不计为反证成功。

### 7.8 预算

L1 矩阵按发布版区间分片，单分片 ≤ 4 分钟；超出时增加分片或补充去重证据，不降低覆盖。L2 发版门每平台 ≤ 30 分钟；夜间 linux 分片并行。

### 7.9 既有用例调整

`e2e/rfc319-ops-doctor-and-migrate.spec.ts` OPS-015 改为在 `autoEpochMigration: false` 下锁人工流程，另加自动模式用例；
`upgrade-rolling.test.ts` 的冻结点保留（锁早期 schema），转换改走 §2.4 编排。

## 8. 失败模式

| 场景 | 行为 |
| --- | --- |
| 任一阶段进程被杀 / 断电 | 下次 `start` 续做同一会话（§2.4），转换按 chunk 幂等（RFC-395 §3） |
| 父进程被杀、子进程仍在转换 | 子进程接管锁做完；新 `start` 不论接管与否都等待其结束（§2.2） |
| 计划有阻塞项 | 退出 1，逐项输出；源与指针不变；处理后再启动对同一操作重新计划 |
| PG 建库权限不足 / 目标被占 | 退出 1，输出语句或原因；建库 / 腾挪后再启动继续；也可改用 §3.1 显式变量 |
| 校验失败 | 先记决定、再首写前撤回，拒绝自动重试，`--retry` 以新库名重新开始（§2.6、§3.2） |
| 切换完成后 daemon 启动失败 | 会话已 `completed`，再次 `start` 直接以 epoch 2 启动；源库、scratch 与切换备份保留 |
| 转换耗时长 | 期间没有 HTTP 监听，健康检查失败属预期；日志持续输出进度；文档说明大库升级应在维护窗口进行 |

## 9. 文档

- `docs/release-upgrade-rollback.md`：升级默认自动；人工模式；PG 派生库、scratch 保留与 DBA 语句；v0.18.18 / v0.18.19 PG 的桥接；校验失败与
  `--retry`；回到旧版本；发版登记与门。
- `README.md` / `README.zh-CN.md` 的升级段落。
- `docs/dev-gotchas.md`：WAL 库缺 sidecar 时 `{ readonly: true }` 打不开；「冻结链造空库」证明不了真实升级；发布后改写已发布迁移或基线
  导致收据与冻结链不一致（0111、v0.18.18 / v0.18.19 PG 基线）。
- `CLAUDE.md` §发版：新增迁移 / schema history 版本须同时补种子与映射预言；升级门不通过不公开。

## 10. 设计门处置

| 轮次 | 意见 | 处置 |
| --- | --- | --- |
| r1 F1（P1） | HEAD 的 RFC-349 runner 写 v2 指针、按 epoch-2 解析合同 | §4 epoch-1 收尾适配器；r2 N6 补全 |
| r1 F2（P1） | 派生 profileRef 过不了 domain / journal / 入参校验 | §3.6（r2：resolved） |
| r1 F3（P1） | 自动意图写得太晚 | §2.3 身份先行与追加式记录（r2：resolved） |
| r1 F4（P1） | 冻结后重新批准不能回到 plan | §2.4 E（r2：resolved） |
| r1 F5（P1） | activated 后崩溃绕过 verify | §2.1 第 2 条、§2.4 G / H（r2：resolved） |
| r1 F6（P1） | L1 未兑现每个已发布版本 + 全表数据 | §7.2–§7.5；r2 N1、N7 补全 |
| r1 F7（P1） | 只按条数重放冻结链 | §7.1 逐条收据与发布字节（r2：resolved） |
| r1 F8（P1） | epoch-2 不能套用 epoch-1 夹具 | §7.2 / §7.3；r2 N7 补全（E1、E2） |
| r1 F9（P1） | v0.19.3 产物无法从 Release 取得 | §7.1 / §7.7；r2 N9 补全 |
| r1 F10（P2） | 删除 scratch 破坏追溯重放 | §3.5（r2：resolved） |
| r1 F11（P2） | 建库语句表达不了 ICU / builtin | §3.3（r2：resolved） |
| r1 F12（P2） | 父进程被杀后的生命周期 | §2.2；r2 N2 补全 |
| r2 N1（P1） | v0.18.18 / v0.18.19 PG 基线不在冻结链 | §3.8 桥接（本机复现：v0.19.0 / v0.19.2 拒启、v0.19.3 未知指纹）；§7.1、§7.2、§7.5⑤、§7.6、§7.7 |
| r2 N2（P1） | 接管前的抢锁窗口；quiesce 逐调用放锁 | §2.2 会话锁借用、启动租约先读 `active.json`；§7.6 屏障用例 |
| r2 N3（P1） | 校验失败的决定写在撤回之后 | §2.6 先记决定再撤回；§2.4 B（r3 起 `rollback-decided` 并入 `verify-failed`，见 R3-4） |
| r2 N4（P1） | `--retry` 复用同名库被旧目标 / scratch 阻塞 | §3.2 跨会话分配账本、库名永不复用 |
| r2 N5（P1） | PG 新 run 目标准备太晚 | §2.4 F 注入 `nextTargetLocation`、按结构化失败分类 |
| r2 N6（P1） | 收尾适配器缺首写刷新与 finalized 重放 | §4 第 1、2 步与逐步中断等价测试 |
| r2 N7（P1） | V1–V3 未按 epoch / 阶段 / 处置拆分 | §7.2 映射预言；§7.4 S1–S3、E1–E2、A1；严格核对在写入前 |
| r2 N8（P1） | 重跑 release 会在过门前替换公开资产 | §7.7 build 只出 artifact，`publish` 过门后上传 |
| r2 N9（P2） | v0.19.3 产物留存未闭合 | §7.7 草稿 release 留存（待用户确认）与 `tag-build` 兜底；反证判据（r3：resolved） |
| r3 R3-1（P1） | 装载进 SQLite@0223 会被触发器改写原值 | §3.8 装载协议：去触发器、清空迁移插入行、按原合同原值装载、原样重建触发器、catalog 精确相等；§7.6 NULL lineage 回归 |
| r3 R3-2（P1） | 桥接视图不满足 PG 归档合成合同 | §3.8 读取视图：归档表行装回副本、走 SQLite 归档路径、桥接回执约束归档内容；原始合同接入归档验真与 artifact reader；§7.6 归档非空与重放用例 |
| r3 R3-3（P1） | 接管时锁文件暂缺，新 start 可抢锁 | §2.2 以存活的 `active.json` 为等待依据、原子 rename 接管、先放锁后删 `active.json`；§7.6 三个屏障 |
| r3 R3-4（P1） | 校验失败到撤回决定之间两个恢复状态未定义 | §2.3 `verify-failed` 即撤回承诺；§2.4 B 补记缺失记录、绝不重进 verify；§2.6 第 3 条；§7.6 两类边界与「第二次探测成功」 |
| r3 R3-5（P2） | S1 计数基准、E1 回执范围不准 | §7.4 S1 分阶段预期、E1 只核对实际应用区间与 data-transform 边（r4：resolved） |
| r4 R4-1（P1） | 预读 `active.json` 与取锁之间仍可出现第二个执行者 | §2.2「取锁即复核」唯一协议：取锁后复核、非所有者释放并等待；C 只在锁 PID 已死或锁不存在时接管；§7.6 第四个屏障 |
| r4 R4-2（P1） | 负向验收产物先于 `journal.failure` 落盘的窗口 | §2.4 B 以当前 run 任何已落盘负向验收结果为承诺；§2.6 第 1、3 条；§7.6 新增两个中断点（r5：resolved；R4-1 同） |
| r5 R5-1（P1） | B 把所有 `journal.failure` 当成验收失败 | §2.4 B 只认 `v3-acceptance-failed` / `health-failed` 与已发布负向产物；其他失败按 E / F 续做；§7.6 第①组 `source-changed` 反向用例 |
| r5 R5-2（P2） | 取锁抛错路径不进升级等待 | §2.2 取锁失败时先读 `active.json`；§7.6 屏障拆成接管前 / 后 |
| r5 R5-3（P2） | §7.6 预期把正常恢复也写成撤回 | §7.6 三组预期 |
| r6 | 确认轮 | **PASS**：R5-1～R5-3 resolved，无新意见（2026-10-31） |

## 11. 集中验证发现与处置（T13，2026-10-31）

集中验证首次以真实旧二进制（L2）和全部 L1 矩阵执行本 RFC 的用例。下表只列**改变了生产行为**或**改变了用例判据**的发现；纯夹具修正见各用例文件顶部注释。

| 来源 | 发现 | 处置 |
| --- | --- | --- |
| L2 v0.19.2 SQLite（真实旧二进制造数） | **任何带文件系统技能的真实安装都在校验阶段被拒**（`v3-validation-failed`，`skills.managed_path` / `skill_versions.files_path` 报 `size-changed`）。转换回执记录旧 `path\0bytes\0` 哈希与文件大小之和，而内容清点把技能目录观测为 `skill-tree-manifest@1` 清单字节，二者永不相等。RFC-395 的用例只覆盖数据库存储的技能，未经真实冻结清点 | 生产修复：`platform/content/migration/skillContent.ts` 的技能树回执改为携带清单字节的大小与摘要（与 `freezeInventory` 的 `directory-tree` / `database-tree` 观测同一定义）；回归 `rfc395-v3-content-inventory.test.ts`「filesystem skill trees …」经真实转换器与真实冻结清点，已验证去掉修复即红 |
| PG 用例 | 受限角色建库被拒时抛裸 `PostgresError`（Bun.SQL 的 SQLSTATE 在 `errno`，代码比较的是 `code`），拿不到给 DBA 的两条建库语句；`42P04` 并发建库、`3D000` 统计已删库同样失效 | 生产修复：`postgresqlProvisioning.ts` 统一经 `platform/persistence/capabilities.ts` 导出的 `postgresqlSqlState` 判定；纯函数回归 + 源码断言 |
| L2 v0.19.2 PostgreSQL（真实一键迁移后的 PG 源） | **任何有普通用户的 v0.18.18–v0.19.2 安装都无法升级**：这些版本给每个新普通用户写入 `users:presence` 授权，而其合同（PG 0038 / SQLite 0262 之前）把 `user_permission_grants.permission` 标为 `json-text`；候选按该历史标签解码源行，读源与 PG 离线副本回读校验都报 `logical database codec rejected invalid JSON`。`73d7e1f04` 只修了 epoch-1 启动路径 | 生产修复：`SupportedSourceManifest.codecCorrections` 取自冻结历史的 V9 `logicalCodecs`（不硬编码），`withLogicalCodecCorrections` 只在读取 / 离线副本校验时改用更正后的 codec，合同与摘要不变；PG / SQLite 读源与 `offlineSourceUpgrade` 三处接入。回归 `rfc398-epoch1-codec-corrections.test.ts`（双引擎，含离线副本），已验证去掉修复即红 |
| L1 矩阵（v0.x 已提交的技能删除） | 启动恢复拒绝已提交的旧名删除操作（`skill-legacy-upgrade-requires-conversion`），升级后的实例起不来 | 生产修复：`skillCatalogBootAdapter.ts` 只对 `delete` + `rollforward` 放行旧名身份，仍校验库中技能不存在、旧根 / 规范根均不存在、回收站路径绑定操作；其他旧名操作照旧拒绝。回归 `rfc398-skill-delete-recovery.test.ts` |
| L2 投影核对 | 定时任务 `launchPayload.repoUrl` 在 epoch 2 由 `integration/scheduled-payload` 规则改写为 `cachedRepoId`（`StartTask` 合同本就接受二选一），URL 落在缓存仓库行；逐字段比较把它误判为数据丢失 | 判据修正：`verify.ts` `applyDocumentedConversions` 经候选 `/api/cached-repos` 证明 `cachedRepoId` 解析到同一 URL 后才以新形态比较，解析不到或字段被丢仍按数据丢失失败；单测覆盖三种情形 |
| L2 造数工具 | 记忆创建接口在所有版本都回 `{ memory }`，造数在第一个版本就失败——L2 工具链此前从未端到端执行 | 工具修复 `lib/client.ts` |
| `rfc398-auto-upgrade-resume`「等待重新批准时」 | 冻结前插一行普通业务数据不改变 `approvalDigest`，用例永远等不到 `awaiting-approval` | 判据修正：改为改变批准摘要绑定的启动升级效果（内置 runtime 行继承的二进制路径），三种 SIGKILL 均验证续做完成 |
| 合成 epoch-1 PG 源 | 缺少 daemon 启动时写入的 RFC-341 家族切换四行，校验 required seeds 失败；`schema_migrations` 每个冻结版本插一行与主键冲突（真实安装只有一行） | 夹具修正：启动行取自已捕获的真实 v0.19.2 安装 dump；`schema_migrations` 只写安装版本一行 |
| RFC-349 finalize 等价 | 夹具恢复依赖本机 `psql`（开发机与 CI 应用通道都不保证存在） | 夹具修正：进程内解码 `COPY` 文本格式重放 |
| `/health` 数据库身份 e2e | OPS-015 请求不存在的 `/api/health` | 用例修正为 `/health`（§2.7） |
| L2 工具（旧二进制自身缺陷与既有产品政策） | v0.18.18–v0.19.2 的一键迁移以只读方式打开 SQLite，无 sidecar 时失败（S4 同族）；它们写入的 `users:presence` 又被自己的一键迁移拒绝；v0.18.18 / v0.18.19 在 PG 上建任务报 `foreign-legacy-actor-projection`，v0.19.2 在 PG 上对自己的人工门任务报 `ownerless task mutation refused durable owner`；v0.16.x 的 seatbelt 沙箱清洗 runtime 环境并拒绝读取整个 app home；v0.18.10 在 control shutdown 时直接断开连接；pre-RFC-200 版本的挂起门按 RFC-395 必然被 `v2-run-null-nonce` 拒绝；pre-v0.17.0 任务快照的代理引用按 RFC-223 隔离，回答反问后无法重跑代理 | 场景工具只为旧二进制补齐空闲连接留下的干净 sidecar、把普通用户放到 PG 实况轮创建、按精确错误签名记录旧版 PG 任务缺陷（其他错误照旧失败）、shim 及其设置与桩状态放到 app home 之外、接受关停时的连接断开（仍以进程优雅退出为准）、无 nonce 版本不留挂起门、pre-v0.17.0 不留挂起反问，每项都以具体原因记入 `unavailable`，候选侧断言不放宽 |
| L2 投影（已发布的转换效果） | 旧版工作流定义 `$schema_version` 4 / 6 在候选上为 7；0188（RFC-312）为存量 user / manager 补 `users:presence` | `applyDocumentedConversions`：定义经公开的纯函数格式迁移后逐字比较；presence 仅对早于 0188 的源且只接受这一个键；单测覆盖接受与拒绝 |
| L2 v0.18.19 PostgreSQL（真实旧二进制在 PG 上原生建的反问任务） | **v0.18.18 / v0.18.19 在 PG 上原生创建的任务，升级后任何续做 / 重试都失败**（`iso-setup-failed`）。这两版的 PG 没有 SQLite 0210 触发器，`node_runs.lineage_slot_path_json` 恒为 NULL（RFC-359 W6 自 v0.19.0 起才为新行补齐，见 `buildNodeRunMintRecord.ts` `nodeRunLineageColumns` 注释），旧 runtime 经 `run ?? intent ?? task` 回落，把任务路径记在该续做槽的每个 effect 上。候选的重跑行继承上一行的 lineage，继承到 NULL 时才派生节点路径——于是开出新的 operation family、generation 从 0 起，与旧 effect 撞 `(task_id, operation_key, operation_generation)` 唯一键 | 生产修复（转换侧，只改 legacy 行）：`task-execution/infrastructure/migration/run/legacyLineage.ts` 新增按 `(任务, 续做槽)` 收集 effect 路径的 lookup；源 lineage 为 NULL 且该槽 effect 只记录了一个路径时，目标 `lineage_slot_path_json` 取该路径（即旧 runtime 实际使用的路径），并在 run 证据里记 `v2-run-legacy-lineage-materialized`；无 effect 或路径不一致时保持 NULL。映射预言把该列由「逐字保留」改为声明的投影，S3 在 `runProjection` 中独立实现同一规则。调度器、反问与任务重试的重跑本就继承上一行的 lineage；唯一不继承的评审 reject / iterate 重跑改为沿用被替换行的续做槽与 lineage（实现门 r2～r4，最终处置见 §12.3）。回归 `rfc398-legacy-run-lineage.test.ts` 取真实 v0.18.19 捕获的行：经真实 `buildNodeRunMintRecord` / `nodeRunLineageColumns` / `operationFamilyKey` 证明转换后重跑落回旧 family（两种 effect 的 family 逐字相等），并经真实评审决定、effect 观察者与账本（双引擎）证明 reject 后的重跑沿用转换后的路径、隔离 effect 落在同一 family 的第 1 代；去掉任一修复即红。L2 v0.18.19 PG 复跑：迁移来的两个挂起反问与两个挂起评审均续做至 `done` |
| PG L1 矩阵（首次端到端跑到预言） | 构建器逐字执行已发布 PG 迁移的 `.sql` 文本：0024（RFC-372 light clarify）按逻辑名删除外键，而 0022 建的是 63 字节内的物理名；0030 的 `json_valid(...)` CHECK 依赖 runtime 连接的 `search_path`。已发布 migrator 本就按前一版计划解析退休外键的物理名（`postgresqlUpgradeStatementSql`，与 v0.19.2 逐字相同）且连接带 `search_path=agent_workflow,public` | 夹具修正：构建器先证明步骤语句渲染后与已发布 `.sql` 字节相等，再按已发布 migrator 的方式逐条执行（同一解析函数、同一 `search_path`、核对 contract 行推进） |
| PG L1 矩阵 | 种子 0246 的 `clarify_mindmap_sessions.round_id` 指向不存在的反问轮次；SQLite 种子构建只在发布版最终快照查外键，而 0248 删表掩盖了它 | 种子修正：改指 0031 回填、贯穿全部版本存在的轮次及其所属任务；覆盖账本重新生成 |
| PG L1 矩阵 | 构建器把 0219 未重放的任务聚合头（只有头、没有事件）在恢复后直接写入 PG。v0.18.18–v0.19.2 的一键迁移都以同一条 `committed-event-head` 不变式拒绝这种形状，真实 PG 源不可能含有它；候选的离线副本同样拒绝 | 夹具修正：PG 构建不再写入这些头；PG 期望快照取自构建结果，预言与源一致 |
| PG L1 矩阵 | PG 目标快照的 BIGINT 以字符串、BOOLEAN 以 true/false 返回，而 S2/S3 预言按 SQLite 物理形态比较（`keyCell` 会把整数串编码成 text） | 判据修正：PG 目标快照（以及原生 epoch-2 构建的 before 快照）按目录类型转成 SQLite 物理形态（BIGINT→整数、BOOLEAN→0/1）；epoch-1 源快照保持原样，供源检查比对 PG 文本渲染 |
| §7.8 预算 | 本机负载 35–85 时 PG L1 单例 213–324 s，超过 240 s 预算 | 不放宽预算；本机以放大预算的临时包装确认功能结果（6 个 PG 例全过），预算以 CI 计时为准 |
| 主 CI（提交 `cc81d09c4`，run 41287820486） | ①PG L1 的 v0.18.19、v0.19.0 例以 53300 `sorry, too many clients already` 失败：CI 的 PostgreSQL 用默认 `max_connections=100`，本机测试库是 400。Bun.SQL 的池在第一次查询时就建满 `max` 条连接，于是每个迁移 runtime（源 / 目标 / scratch / 启动探测）的在线池与迁移池各占 `poolMax`（缺省 16）条，而迁移工作每库同一时刻只占一个会话（预留跟踪的最高值为 1）；规划阶段源与 scratch 同时打开，升级本身就占约 60 条，生产上共享的 PostgreSQL 有别的客户端时会同样拒绝升级。测试夹具另有三个各 16 条的池一直开到用例结束，总峰值 112。②WAL 读路径用例与 L1 反证 2 假定只读打开缺 sidecar 的 WAL 库必失败：macOS 版 Bun 用系统 SQLite（3.51，拒绝），Linux／Windows 版内置 SQLite（3.53）能打开，但会在只读句柄旁留下 `-wal/-shm`；同一差异使 v0.19.3 反证在 Linux／Windows 上的签名不同。③gitleaks 把种子里合成的 64 位十六进制占位值（`token` / `token_hash` 列）判为 `generic-api-key`。④后端分片 24/36、36/36 撞 15 分钟上限被取消：`rfc398-auto-upgrade-resume`（63 例约 26 分钟）与 `rfc398-start-auto-upgrade`（约 6.5 分钟）各是一个文件，Bun 按文件分片；`rfc398-postgresql-bridge` 两个发布版合计 4.6 分钟，所在分片 13.4 分钟 | ①产品修复：`postgresqlRuntimeFor` 的池上限取 `min(poolMax, 4)`（`EPOCH_MIGRATION_POOL_MAX`），启动探测用单连接池；夹具在升级前关闭构建与反证用的 runtime。`rfc398-migration-pool-footprint.test.ts` 锁定上限与真实连接数（去掉上限即红：真实库 32 条）；本机 100 连接的库上 6 个 PG L1 例全过。②负对照按平台断言：macOS 必须拒绝；其他平台若能读，必须留下 sidecar（生产 helper 读后不留），读不了则不得新建。`NEGATIVE_SIGNATURES` 的去 sidecar 签名按平台取值，运维手册表格同步。③`.gitleaksignore` 按指纹豁免该提交的 5 处（JSON 不能写行内 allow）。④拆文件、覆盖不减：每个中断点一个 resume 文件、`start` 按场景五个文件、桥接每个发布版一个文件；`rfc398-split-test-coverage.test.ts` 要求每个单元恰好一个以其命名的文件；T19f 账本两条随调用点移到 helper |
| 主 CI（提交 `109ca2f81`，run 41293473768） | 修复后除三个分片撞 15 分钟上限被取消外全部通过。本 RFC 让每次后端测试多出约 105 runner-分钟（36 片合计 275 → 380 分钟，中位数 7.4 → 10.4），Bun 的 `--shard` 按文件名轮转分配，长套件扎堆 | 提交 `fe076d714`：ubuntu 后端步骤加 `--timings=.github/backend-test-timings.json`（由该 run 分片日志汇总的逐文件耗时），按总时长均衡；分片数与 15 分钟预算不变，`root-test-entrypoint` 锁定 |
| 首次真实夜间（`cc81d09c4`，release-upgrade-nightly 41287876705） | ①**Windows 上任何 SQLite 自动升级都失败**（v0.18.10、v0.18.18…）：离线副本阶段 `EPERM: operation not permitted, fsync`。`freeze/artifacts.ts` 的 `syncSourceDirectory` 与 epoch-switch 文件仓库（`fileJournal.ts` 的 `putFile` / `get`）以只读句柄 fsync，而 Windows 的 FlushFileBuffers 要求可写句柄（同仓 `logicalDatabaseArtifact.ts` 早已按此处理）。②**v0.2.0 带缓存仓库的真实安装无法升级**：v0.2.0 以明文存仓库 URL、没有 `secret.key`（v0.5.0 才有），冻结链把 URL 转成遗留托管形态，启动升级要用密钥重新封存，而 RFC-395 的密钥提供方从不建密钥，拒绝为 `v2-boot-url-key-missing`。③v0.15.0 / v0.15.1 的造数任务失败（stub 退出 3：提示词缺 RFC-200 nonce）：这两版铸行时生成 nonce、解析与提示词构建也认 nonce，但 runner 到 v0.16.0 才把它传进提示词；登记表的 `nonce` 探测（按文件名与注释）把它们误判为带 nonce。④Windows 按 tag 构建旧版时 `tar -C <C:\…>` 被 MSYS GNU tar 拒绝。⑤保留的 v0.19.3 产物在草稿 release 中，只读 token 看不到草稿（release not found）。⑥L1 `start` 入口的 PG 例同样撞 53300（与上一行同因）。⑦v0.18.13–v0.18.15 的造数在 `PATCH /api/auth/me/profile` 得到 422：这三版有该路由，但严格 schema 没有 `gitName`（v0.18.16 才加）。⑧v0.19.0 / v0.19.1 在 PG 实况轮里旧版自己的人工门任务报 `ownerless task mutation refused durable owner`，与已记录的 v0.19.2 同一缺陷 | ①产品修复：两处改用 `flushSourceFile` / `flushEpochFile`——Windows 开 `r+`，无法以可写方式打开（只读属性）的文件跳过 flush，POSIX 保持只读句柄；`rfc398-windows-file-flush.test.ts` 以注入的 open 断言两种平台的打开方式与容忍范围。②用户裁决（2026-11-01）：活的 app home 在没有 `secret.key` 且全部已编码 URL 都是遗留托管形态时，迁移在首次采集时按 daemon 首次启动的方式（`ensureSecretKey`：32 字节随机、0600）建密钥，此后各阶段与重试复用同一把；记一条 WARN 与操作产物 `boot-url-key/created.json`。含封存 URL 却无密钥、备份与托管源保持原拒绝 / 原行为；`rfc398-legacy-url-key.test.ts`。③登记表拆出 `promptNonce`（`git grep envelopeNonce`，排除 schema 与铸行文件），runtime shim 的传输按它取；挂起门仍按 `nonce`；`releases.json` 重新生成，只增加该字段（v0.1.0–v0.15.1 为 false）。④解包改为在归档目录内 `tar -xf -`，不传路径。⑤用户裁决：只给夜间 `verify` 作业 `contents: write`（另带 `actions: read`），该作业不发布；用例锁定。⑥由上一行的池上限修复。⑦登记表增加 `profileGitName`（schema `user.ts` 是否含 `gitName:`），造数只对接受它的版本发送；⑧`OLD_POSTGRESQL_TASK_DEFECTS` 补 v0.19.0 / v0.19.1（以及代码路径同 v0.19.2、实况轮被下载失败遮住的 v0.19.3），仍只容忍这一条精确文本，用例逐条在该版源码中核对；⑦⑧均为工具对旧版的适配，候选侧断言不变 |
| 主 CI（提交 `fe076d714` / `ec5df7fc8`，run 41301089649 / 41303615394） | 23～25 片仍在 15 分钟处被取消。`fe076d714` 的耗时文件是汇总各用例 `[x ms]` 得到的，漏了模块加载与 `beforeAll` 等钩子（`rfc395-v1-golden` 记 1.7 s、实跑约 29 s）；Bun 带 `--timings` 时保持路径顺序、按记录耗时切连续段，路径相邻且被低估约一倍的 RFC-395 用例全挤进这三片 | 提交 `57103c231`：耗时改为整文件墙钟（两次 run 全部分片日志相邻 `##[group]` 行的时间差，均值，约 360 分钟）；36 片均衡后最长仍约 11.5 分钟、同片两次 run 速度差 0.73～1.29 倍，照 ci.yml「加 runner、不动预算」扩到 44 片（均值约 8.2、最长约 9.5 分钟）；每片以 `--update-timings` 把本片实测写进 `$RUNNER_TEMP` 下的新文件并上传 artifact，供以后刷新；`root-test-entrypoint` 以 `rfc395-v1-golden` ≥ 10 s 锁住「整文件墙钟」 |
| 第二次真实夜间（`ec5df7fc8`，release-upgrade-nightly 41303628365） | 87 个作业 86 过，只有 Windows `verify` 失败：①**Windows 上从 epoch-1 发布版（v0.18.10、v0.18.18、v0.18.19、v0.19.2）升级全部失败**：`EINVAL: invalid argument, link …\plans\sha256:<hex>.json.<uuid>.tmp`。RFC-395 的操作产物以摘要命名（`plans/sha256:<hex>.json|md`、`acknowledgements/sha256:<hex>.json`），Windows 上冒号表示 NTFS 备用数据流：临时文件被开成名为 `sha256` 的文件的一个流，发布用的 `link` 必然失败；v0.19.3 已是 epoch 2、不写计划文件，所以通过。②v0.1.0、v0.10.0、v0.16.3 按 tag 构建时 `bun install --frozen-lockfile` 报 lockfile had changes：这些 tag 早于 RFC-254 的 `.gitattributes`，`git archive` 按 Windows runner 的 `core.autocrlf=true` 把 `bun.lock` 转成 CRLF | ①产品修复：叶子模块 `platform/persistence/migration/artifactFileName.ts` 的 `epochArtifactFileName` 在 Windows 上把文件名中的 NTFS 保留字符（`<>:"|?*`）映射为 `-`，逻辑名与摘要不变；文件 journal 的 `writeOnce` / `readArtifact` 与本地内容寻址产物的存取直接经它定位（运行期不触达 `migration/run/**`，`rfc395-v3-dormancy` 照旧），离线侧 `epochArtifactPath` / `epochArtifactPathFor` 与 `status` 的审阅提示同源。POSIX 文件名逐字节不变，既有操作目录（含旧版留下的待批计划）照常读取；Windows 上旧名从未写成功，无存量需要迁移。`rfc398-windows-artifact-names.test.ts`：映射规则、Windows 规则下 journal 的写入 / 回读 / 写一次冲突、宿主规则保持旧名，以及一次带确认项的完整切换在 Windows 文件名规则下全部产物无保留字符。②`tagSourceArchive` 以 `git -c core.autocrlf=false -c core.eol=lf archive` 取提交字节；工具用例在 `core.autocrlf=true` 的临时仓库中先复现 CRLF，再断言修复后逐字节一致 |
| 第三次真实夜间（`80b715e95`，release-upgrade-nightly 41363751171，手动触发） | 87 个作业 86 过。Windows `verify` 上 v0.18.10、v0.18.18、v0.18.19、v0.19.2 的 sqlite 与 sqlite-no-sidecar 全部通过（上一行 ① 的修复生效），v0.19.3 两个变体通过；只剩 v0.1.0、v0.10.0、v0.16.3 的 tag 构建仍以 `bun install --frozen-lockfile` 的 lockfile had changes 失败，LF 归档没有改变结果。本机用 Bun 1.3.13 复现：v0.16.3 的 LF 归档与 `core.autocrlf=true` 归档（`bun.lock` 含 1814 个 CR）都能通过 frozen install，上一行 ② 的 CRLF 归因不成立 | `f33e6b19f`：tag 构建的一次性目录改到 `realpathSync.native` 展开后的长路径下（windows-latest 的 `os.tmpdir()` 是 8.3 短名 `C:\Users\RUNNER~1\…`，见 dev-gotchas）；frozen install 报 lockfile had changes 时在一次性目录里以 `bun install --lockfile-only --ignore-scripts` 重新生成，把增删行与构建目录附在错误里（`lockfileDrift` / `explainLockfileRefusal`）；更正 `tagSourceArchive` 注释、工具用例注释与 dev-gotchas 条目（按提交字节取源码保留）。工具用例：漂移报告与长路径接线 |
| 第四次真实夜间（`f33e6b19f`，release-upgrade-nightly 41367335740） | 87 个作业 86 过。三个 tag 的 frozen install 在长路径下全部通过（6 次构建）；与上一次唯一不同的变量是构建目录由短名改为长名，据此确认短名路径是被拒原因。随后这些 tag 自带的 `scripts/build-binary.ts` 在 `bun build --compile` 写出 `dist\agent-workflow-win32-x86_64.exe` 后，对不带 `.exe` 的 `--outfile` 做 `statSync` 取大小，报 ENOENT 退出 1，并跳过脚本自带的 `version` 冒烟（Bun 在 Windows 上给 `--outfile` 补 `.exe`，这些版本从未在 Windows 上构建过） | `595418fc5`：只在 Windows 上、错误恰为 `build failed: ENOENT … stat '<dist>\agent-workflow-win32-x86_64'` 且 `.exe` 已生成时接受编译产物，由验证器补跑被跳过的 `version` 冒烟（`isPreWindowsOutfileStat`）；其他构建失败照旧失败，历史源码与编译命令不改。工具用例：正反例与接线锁 |
| 第五次真实夜间（`595418fc5`，release-upgrade-nightly 41374764084） | 87 个作业全部通过：Linux 80 个版本作业；macOS / Windows gate 集合 8 个版本 × sqlite / sqlite-no-sidecar 全部通过，Windows 含 tag 构建的 v0.1.0、v0.10.0、v0.16.3 | 无需处置；AC-1、AC-7 以此关闭 |

## 12. 实现门处置（r1，2026-10-31）

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| P1-1 | PG 新 run 先退休旧目标再替换 journal，中间进程死亡后自动续做先为旧 run 准备已退休目标，永久拒绝 | `autoUpgrade.ts` D 段：journal 已持久化 `source-changed` 时跳过当前 run 的准备，直接进入 new-run（`nextTargetLocation` 为下一 run 准备）；`retireIfUnwritten` 本身幂等。回归见 `rfc398-auto-upgrade-policy.test.ts`，去掉修复即红 |
| P1-2 | 发布门只信覆盖账本本身，缺表或种子被删而账本未更新都能通过 | preflight 对前一发布版的构建用当前种子实际重建（枚举该版 schema 全部表），提交账本须与重建结果逐表相等，再要求每表有行或已批准豁免；单测覆盖整表条目缺失、种子删除账本未改、缺行、未批准豁免，并对最新登记版做一次真实重建 |
| P1-3 | S3 保值预言取自生产 reader 的解码结果 | `captureSource()` 的保值 / 投影 / 归档期望改取独立重建的种子行（reader 只提供顺序）；仅「待执行的已发布迁移所生成」的时间戳与随机值按 `sqlNormalization.ts` 的显式规则归一（时间落在构建 / 升级区间、随机值格式精确），种子值与已应用迁移的值逐字比较；新增负对照 `release-upgrade-matrix-negative-values.test.ts`：reader 与目标同步损坏一个保值字段、键与行数不变时 S3 必红 |
| P2-4 | 派生目标被占后设置显式目标变量无效 | `allocate()`：尚无 provisioned 回执的派生分配在显式变量出现时追加新的显式分配（旧名留账不复用），已 provisioned 的位置不迁移；PG 回归覆盖被占 → 设变量 → 续做 → 绑定后换库被拒 |
| P2-5 | 夜间没有经 `start` 的 L1 入口模式 | `AW_RELEASE_UPGRADE_MODE=start` 时每个 L1 build/provider 经真实 `start` 拉起 `db migration auto` 子进程完成升级（核对子进程委托、会话完成、journal verified），在 daemon 首次业务写入前跑同一套 S1–S3 / E1–E2，再做 API 验收；默认模式不变。`release-upgrade-nightly.yml` 新增 `l1-start` 作业（57 SQLite + 6 PostgreSQL，经既有 PG 服务脚本），工作流形状断言随之扩展；本机 57 个 SQLite 文件两种模式均通过 |
| P2-6 | `status` 不列保留库 | 自动操作的 status 视图增加 `retainedDatabases`（库名、大小、用途、run），CLI 与自动组合均接线；真实 PG 整链用例断言 `status --json` |
| P2-7 | 同会话多 run 时 doctor 报第一个旧目标 | 诊断按 journal 当前 run 选目标、否则取该会话最新分配；PG 单测覆盖两目标共存 |
| P2-8 | finalize 等价缺「迁移后未首写」状态 | 用 v0.19.2、v0.18.19 官方二进制补录 `-unwritten` before/after（`record.ts import-finalize --state unwritten`），等价与中断重放用例覆盖两种状态 |
| P3-9 | README 指向不存在的 `/api/health` | 改为 `/health` |

### 12.1 实现门 r2（2026-10-31）

r1 的 9 项逐项复核为 FIXED。r2 新增 1 项：

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| r2-P1 | §11 的 legacy lineage 只覆盖「继承上一行」的重跑；评审 reject / iterate（`collaboration/infrastructure/review.ts` 的铸行）不传 `inheritFrom`，新行仍按任务路径 + 节点帧派生，开出新 family、generation 0，与旧 effect 撞唯一键 | 先后试过铸行边界复用与 effect 代际地板，均与既有约束冲突；最终处置为评审重跑沿用被替换行的续做槽与 lineage，见 §12.3 |

### 12.2 实现门 r3（2026-10-31，只审 r2 处置）

r3 确认唯一插入点成立、回归能识别修复被移除，另报：

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| r3-P1 | 首版按 `(任务, 续做槽)` 取最近一行的 lineage；续做槽键可被显式交给别的节点，普通任务的重跑会借到另一节点的 lineage | 铸行边界方案整体撤回，见 §12.3 |

### 12.3 实现门 r4（2026-10-31）与最终处置

r4 指出铸行边界的第二版仍有 3 项 P1（workflow 同步后普通数据沿用旧 revision、synthetic / wrapper 帧的行混入、用例覆盖不到 iteration / shard）。按「只认裸任务路径」收窄后（用户此时要求不再派 Codex，由本会话自审），全量后端用例又暴露两条既有设计约束：RFC-369 AC-1 / RFC-144 源码锁要求铸行 program **只 insert、不读同帧旧行**（`rfc144-stale-replay-regression`、`rfc369-workgroup-mint-receipt` 按 SQL 锁定），任何铸行边界读取都与之冲突；而在 effect 账本上抬代际地板也不可行——`prepareAndAcquire` 要求每个 family 的代际连续（新 family 必须从 0 起），同一 operation key 下根本容不下第二个 family。

**最终处置**：铸行 program 保持原样（只 insert）。重跑语义统一到既有约定——调度器、反问重跑与任务重试 API 都经 `inheritFrom` 沿用上一行的续做槽与 lineage；唯一不这样做的评审 reject / iterate 重跑（`collaboration/infrastructure/review.ts`）现在通过身份覆写沿用被替换行的 `continuationSlotKey` 与 `lineageSlotPathJson`（其余字段的「不继承」不变；人工门铸行请求 `HumanGateNodeRunMintRequest` 的身份覆写类型随之补上这两个可选字段，底层铸行本就接受）。于是转换物化后的 v0.18.x 行在所有重跑路径上都落回旧 family；普通数据被替换行记录的正是同一续做槽的派生值。双引擎回归经真实 `submitReviewDecision('rejected')`、本地 effect 观察者与账本：转换行 reject 后重跑沿用裸任务路径、隔离 effect 落在同一 family 的第 0 / 1 代；普通数据重跑沿用被替换行的派生路径。去掉 review.ts 的改动即红（重跑拿到节点路径）。
