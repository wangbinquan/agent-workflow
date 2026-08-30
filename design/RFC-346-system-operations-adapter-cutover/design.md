# RFC-346 技术设计：System Operations 管理编排与 adapter cutover

配套：`proposal.md`（D1～D12）· `plan.md`（实施 DAG）

- 状态：Done（2026-08-30；实现、canonical、AC-1～AC-12 与 exact-SHA hosted closeout 已完成）
- 开工 source pin：`625017c084db2f7eb6c9ec34c87eba41ffaf04cd`
- additive / CLI implementation：`4a1c739351f27847ffb3554869e7f613ab8e1eef` →
  `ce7d9fbf541208b00b9d52d221058f0387a15ae3` → `4c349cf068d38f6842469ba565b4aedd6961b41c`
- descriptor / alias cutover：`572d01e0c50b3d8401bf9a317c317b5fd4b5b008`
- final hosted contract repair：`dffe9bc836d87a2433153a3b2e8a8efc8cf17b95`
- final functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`
- canonical source digest：`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`

## 1. 设计结论

`system-operations` 是无业务事实表的 administration orchestration context。它只回答六个 use case：请求 backup、规划本地
restore、暂存 restore、取消暂存、执行本地 cold restore、查询 recovery status。它不拥有 snapshot/swap/lock/migration/tar/worker
机制，也不读取 task/workflow/resource/credential 表。

目标调用链：

```text
HTTP binding ─┐
              ├─ exact context ─> system-operations application
local CLI  ───┘                         │
                                        ├─ AdminBackupCoordinatorPort
                                        └─ AdminRestoreCoordinatorPort
                                                   │
                                  bootstrap-composed legacy platform adapter
                                                   │
                    services/backup|restore|pendingRestore (W9/W9-E debt)
```

Boot pending apply 不是上图的一条在线 use case：

```text
cli/start acquireLock
  -> platform legacy applyPendingRestoreIfAny
  -> openDb
  -> normal bootstrap
```

该顺序在 RFC-346 中只锁定、不迁移。

## 2. Source inventory 与污染边界

### 2.1 Baseline 与 committed evidence

下表记录开工 source pin 的兼容性 oracle；最终实现事实取上述 RFC-346 commits 及其 containing exact SHA `7ede76a8`。实施过程中
RFC-344/345/347 的并发产物只在 owner 明确交还的 shared paths 上原样共存，未由 RFC-346 回退或代交其独占路径。

| 类别                        | Exact paths                                                                                                  | 判定                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| HTTP inbound                | `routes/backup.ts`, `routes/restore.ts`                                                                      | 4 compatibility leaves；2 个 AppDeps consumers               |
| CLI inbound                 | `cli/backup.ts`, `cli/restore.ts`                                                                            | 重复拼接 open/plan/stage/lock/activate 流程                  |
| Boot inbound                | `cli/start.ts`                                                                                               | pending apply 的唯一正确时序 owner，W9-E 前保留              |
| Backup mechanism            | `services/backup.ts`, `backupManifest.ts`, `backupVacuumWorker.ts`, `backupScheduler.ts`, `rawDbSnapshot.ts` | platform persistence/background + future module participants |
| Restore mechanism           | `services/restore.ts`, `pendingRestore.ts`, `worktreeBackup.ts`                                              | physical generation debt；含跨事实 owner 的 legacy repair    |
| Compatibility audit         | `cli/rfc295-downgrade-audit.ts`, `services/rfc295DowngradeAudit.ts`                                          | RFC-295 专用 read-only rollback gate                         |
| Recovery/task services      | `services/recovery.ts`, `recoveryBreaker.ts`                                                                 | task-execution facts；不整体迁入 system-operations           |
| Existing operation platform | `platform/operations/*`, `routes/operationRoute.ts`, `routes/operationAuthority.ts`                          | RFC-344 owner；其 hosted closeout 前只读                     |

### 2.2 Current debt identities

| Debt                           | Current id/path                         | RFC-346 owner/remove point                                |
| ------------------------------ | --------------------------------------- | --------------------------------------------------------- |
| backup HTTP compatibility      | `legacy-http.post-backup.v1`            | T4 → alias；primary system descriptor                     |
| restore status compatibility   | `legacy-http.read-restore-pending.v1`   | T4 → alias                                                |
| restore cancel compatibility   | `legacy-http.delete-restore-pending.v1` | T4 → alias                                                |
| restore stage compatibility    | `legacy-http.post-restore.v1`           | T4 → alias                                                |
| backup route AppDeps           | `routes/backup.ts`                      | T4 consumer-zero                                          |
| restore route AppDeps          | `routes/restore.ts`                     | T4 consumer-zero                                          |
| legacy backup/restore services | paths above                             | W9/W9-E, not deleted here                                 |
| direct RFC-295 SQLite scanner  | exact CLI/service                       | retained compatibility; W9-E or explicit release decision |

## 3. Module layout

```text
packages/backend/src/modules/system-operations/
├── domain/
│   ├── backup.ts
│   └── recovery.ts
├── application/
│   ├── systemOperations.ts
│   └── ports/
│       ├── adminBackupCoordinator.ts
│       └── adminRestoreCoordinator.ts
├── public/
│   ├── commands.ts
│   ├── queries.ts
│   ├── types.ts
│   └── operations.ts
├── infrastructure/
│   ├── legacyPlatformRecoveryAdapter.ts
│   └── restoreArtifactIngress.ts
└── composition.ts
```

约束：

- `domain` 与 `public` 不 import DB/FS/Hono/CLI/legacy services；
- `application` 只 import本模块 domain/public 与 consumer-owned ports；
- `infrastructure/legacyPlatformRecoveryAdapter.ts` 是唯一允许 import legacy backup/restore mechanism 的模块路径，并登记
  `removeWave=W9-E`；`restoreArtifactIngress.ts` 只在 inbound composition 前置处理受控临时文件/ref registry，不被 application import；
- `composition.ts` 只实例化 handler/adapter，不实现 branch/DTO translation；
- route 与 CLI 只 import `public/*` 或 composition-produced typed handles，不 deep import infrastructure。

## 4. Domain/public types

```ts
declare const restoreArtifactRefBrand: unique symbol
export interface RestoreArtifactRef {
  readonly [restoreArtifactRefBrand]: 'restore-artifact-ref'
}

export type RestoreDirection = 'same' | 'forward' | 'downgrade'

export interface BackupResultView {
  /** Existing admin-facing wire projection; not accepted back as a capability. */
  readonly path: string
  readonly sizeBytes: number
  readonly contents: {
    readonly workflows: number
    readonly skills: number
    readonly db: boolean
    readonly config: boolean
  }
}

export interface RestorePlanView {
  readonly direction: RestoreDirection
  readonly backupKind: string | null
  readonly backupMigrationCreatedAt: number | null
  readonly binaryMigrationCreatedAt: number
}

export interface RecoveryStatusView {
  readonly pending: null | {
    readonly requestedAt: number
    readonly stagedBytes: number | null
    readonly noMigrate: boolean
    readonly skipIntegrityCheck: boolean
  }
  readonly failed: ReadonlyArray<{
    readonly failedAt: number | null
    readonly error: string | null
    /** Kept only for the existing admin wire; never accepted as input. */
    readonly dir: string
  }>
}
```

`path` / `dir` 是当前管理员可见 wire 的 compatibility projection，不是 coordinator capability，不能作为后续 command input。所有 effect
输入只使用 branded ref。`RestoreArtifactRef` 由 composition-owned ingress 为本次调用建立，并在完成后 release；它的作用是让
application contract 不携带平台路径。既有显示 path/dir 只由 output mapper 透传，不回流为后续 command input。

## 5. Application contracts

### 5.1 Commands/queries

```ts
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'

export interface RequestBackupCommand {
  execute(
    ctx: CommandContext | LocalSystemOperationContext,
    input: { includeWorktrees: boolean },
  ): Promise<BackupResultView>
}

export interface PlanLocalRestoreQuery {
  execute(
    ctx: LocalSystemOperationContext,
    input: { artifactRef: RestoreArtifactRef; skipIntegrityCheck: boolean },
  ): Promise<RestorePlanView>
}

export interface StageRestoreCommand {
  execute(
    ctx: CommandContext | LocalSystemOperationContext,
    input: {
      artifactRef: RestoreArtifactRef
      noSafetyBackup: boolean
      noMigrate: boolean
      skipIntegrityCheck: boolean
    },
  ): Promise<{ direction: RestoreDirection }>
}

export interface CancelStagedRestoreCommand {
  execute(ctx: CommandContext): { cleared: boolean }
}

export interface ActivateLocalRestoreCommand {
  execute(
    ctx: LocalSystemOperationContext,
    input: {
      artifactRef: RestoreArtifactRef
      noSafetyBackup: boolean
      noMigrate: boolean
      skipIntegrityCheck: boolean
    },
  ): Promise<LocalRestoreReceipt>
}

export interface GetRecoveryStatusQuery {
  execute(ctx: QueryContext): RecoveryStatusView
}
```

最终实现不保留可递归的 module-private authority alias：可执行 command/query 直接消费 identity-access exact `CommandContext` /
`QueryContext`，`public/types.ts` 只导出 DTO、codec、branded artifact ref 与 bootstrap-local context。Handler 不读取 role/permission 集合，
route registration 继续声明 `backup:run`；`LocalSystemOperationContext` 只由 CLI bootstrap composition 铸造，不进入 HTTP/MCP。

### 5.2 Coordinator ports

```ts
export interface AdminBackupCoordinatorPort {
  request(input: { readonly includeWorktrees: boolean }): Promise<BackupCoordinatorReceipt>
}

export interface AdminRestoreCoordinatorPort {
  plan(input: RestorePlanRequest): Promise<RestoreCoordinatorPlan>
  stage(input: RestoreStageRequest): Promise<RestoreCoordinatorStageReceipt>
  status(): RestoreCoordinatorStatus
  cancel(): RestoreCancelReceipt
  activateLocal(input: RestoreActivationRequest): Promise<RestoreActivationReceipt>
}
```

Port 禁止项：`DbClient`、SQLite row/table、可作为 effect input 的 absolute path、`File`/raw stream、participant registry、callback、
Hono context、daemon/process handle、task/worktree id list。为维持 wire，receipt 只允许携带显式 tainted/output-only 的 legacy display
path/dir；application 只能把它复制到 view，不能再传回 port。Legacy adapter 可以在最后一跳解析经 ingress registry 验证的 branded ref
与内部路径；application 永远不能。

Artifact ingress 是 inbound/platform capability，不是 application required port：

```ts
export interface RestoreArtifactIngressHandle {
  ingestHttpUpload(input: unknown): Promise<RestoreArtifactRef>
  ingestLocalPath(input: string): Promise<RestoreArtifactRef>
  release(ref: RestoreArtifactRef): void
}
```

它只由 bootstrap composition 交给 HTTP/CLI adapter，内部持有 ref → managed artifact 的 registry；application 不 import 该接口，外部 wire
也没有 `RestoreArtifactRef` 字段。

### 5.3 Operation descriptors（Cohort B）

本节合同只在 RFC-344 published closeout 后、基于重新 pin 的 catalog API 落代码。Cohort A 不创建 `public/operations.ts`，也不 import
`platform/operations/*`，从而不与 RFC-344 的 candidate contract 并行耦合。

HTTP primary ids：

| Operation id                                 | kind    | HTTP binding                  | Context               |
| -------------------------------------------- | ------- | ----------------------------- | --------------------- |
| `system-operations.request-backup.v1`        | command | `POST /api/backup`            | authenticated command |
| `system-operations.get-recovery-status.v1`   | query   | `GET /api/restore/pending`    | authenticated query   |
| `system-operations.cancel-staged-restore.v1` | command | `DELETE /api/restore/pending` | authenticated command |
| `system-operations.stage-restore.v1`         | command | `POST /api/restore`           | authenticated command |

CLI plan/activate 只使用 typed application handle；不为了本地命令伪造 HTTP binding 或 current Actor。若后续需要把 local CLI 纳入 catalog，
必须使用 `bootstrap-admin` exact descriptor，不能复用 authenticated descriptor。

### 5.4 Legacy operation alias

RFC-344 已把 `legacy-http.*` 视为 stable identity。T4 在 RFC-344 closeout 后增加最小 alias contract：

```ts
interface OperationAlias {
  readonly alias: OperationId
  readonly target: OperationId
  readonly removeAfter: 'explicit-consumer-zero-decision'
}
```

自检必须证明：

1. alias 与 target 都存在且 kind 相同；
2. alias 只能一跳，不允许 chain/cycle；
3. 每个 alias 只指向一个 target，每个 HTTP binding 仍只有一个 primary；
4. alias 不能另带 handler/codec/admission；invoke 总是 target 的同一 handler；
5. duplicate/unknown/stale/wrong-kind/one-to-many mutation fixtures 必红。

API docs/RouteMeta 使用 primary id，catalog lookup 可解析 alias；四条 route 的 `legacyHttpAdapter` 归零。

## 6. Legacy platform adapter

### 6.1 Backup

Adapter 的 current implementation 顺序保持：

```text
requestBackup
  -> existing credential preparation exactly once
  -> createBackup({ db, includeWorktrees }) exactly once
  -> map BackupResult to BackupCoordinatorReceipt
```

DB、secret box、Paths 与 legacy services 只存在于 adapter composition。Scheduled backup 继续从 background service 调 `createBackup`，不经
admin command；因此 `services/backup.ts` 在 RFC-346 exit 仍有合法 W9 consumer，不能删除或冒称 consumer-zero。

### 6.2 Online stage/status/cancel

```text
HTTP multipart / CLI tarball
  -> composition-owned RestoreArtifactIngressHandle
  -> runtime-minted RestoreArtifactRef
  -> validateBackupForStage
  -> stagePendingRestore
  -> return opaque operation ref + established direction/message
```

`GET` 调 `readPendingRestore + listFailedRestores`，`DELETE` 调 `clearPendingRestore`。Legacy display `dir` 只在 output mapper 出现；cancel
不能接 path/dir，始终针对当前 pending operation。

### 6.3 Local plan/activate

CLI 仍负责 flag/usage/text/exit-code projection。Application/adapter 负责：

- plan 与 downgrade refusal；
- stage-depth validation；
- live daemon pid refusal；
- daemon lock acquire/release 包围 cold `restoreBackup`；
- legacy restore receipt mapping。

`--dry-run` 与无 `--yes/--stage` 是 read-only plan，不因 daemon running 拒绝；`--stage` 可在 daemon running 时执行；`--yes` 必须持 lock。
这些 current branches 全部用 golden + fault tests 锁住。

### 6.4 Boot apply

RFC-346 不经 module application 重接 boot apply。唯一允许的变化是 bootstrap 将 direct function 包装为 platform adapter handle，调用顺序与
错误行为不变；默认不改 `cli/start.ts`，避免和 W9-E 混线。

## 7. RFC-295 compatibility audit

`downgrade-audit rfc-295` 的目的不是通用 recovery diagnostic，而是旧版本回退前扫描 RFC-295 新数据形状。它必须能在当前 application
模块尚未装配、DB 不迁移的条件下读取旧 schema，因此保留 direct readonly SQLite：

```text
cli/rfc295-downgrade-audit.ts
  -> readonly Database(path)
  -> exact workflows + live/resumable task projection
  -> pure auditRfc295Downgrade
  -> stable report / exit status
```

RFC-346 只新增 ledger/source guard：

- exact command/subcommand/path；
- open mode readonly；
- zero mutation；
- no generic table/query parameter；
- no import from `modules/system-operations/public`；
- sunset 只能由 W9-E 或显式 release decision 执行。

## 8. Canonical architecture 修正

Current `targetContextFor()` 的宽正则会把 maintenance/doctor/migrate 全算作 system-operations。RFC-346 改成 exact override + fallback：

1. `modules/system-operations/**` 固定归 system-operations；
2. 本 RFC列出的 legacy backup/restore compatibility paths 以 exact ledger 归 E7/W9-E；
3. `platform/background/**` 与 maintenance scheduler/worker 归 platform/background mechanism；
4. task/worktree cleanup 由 task-execution/source-control owner ledger 决定；
5. `doctor` 是 CLI aggregate presenter，不构成一个 mega context；各 check 依赖自己的 typed query 或 explicit compatibility；
6. `migrate` / `db compact` 是 platform persistence/bootstrap mechanism，不进入 system-operations public surface。

这项修正只改变目标归因/ledger，不借机移动 RFC-338 或其他 owner 的代码。Canonical regenerated payload 必须记录 source digest 和 exact
denominator delta，不能只手改 JSON。

## 9. HTTP/CLI wire fidelity

### 9.1 HTTP

| Route                         | 必须保持                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- |
| `POST /api/backup`            | `{path,sizeBytes,contents}`、既有 status/error                              |
| `GET /api/restore/pending`    | `{pending,failed}` 的所有字段、null/empty 顺序                              |
| `DELETE /api/restore/pending` | `{cleared}`                                                                 |
| `POST /api/restore`           | multipart field `file`、400 文案类别、`{status:'staged',direction,message}` |

Operation input/output codecs用 strict schema；multipart `File` 不进入 codec，ingress 后只传 `RestoreArtifactRef`。Route mapper 对 multipart parse/缺
field 保持现有 400 wire。

### 9.2 CLI

- `backup [--include-worktrees]`；
- `restore <tarball> [--yes] [--stage] [--dry-run] [--no-safety-backup] [--no-migrate] [--skip-integrity-check]`；
- usage、plan、downgrade refusal、staged、running-daemon refusal、lock-race、complete 与 error 前缀逐行 golden；
- `main.ts` 的 exit status映射不变。

## 10. Composition 与 concurrency

### Cohort A：RFC-344 closeout 前可实施

- 新增 domain/types/commands/queries、application handlers、两条 coordinator ports、legacy adapter 与 composition-owned artifact ingress；
- 不创建 `public/operations.ts`，不 import 或修改 `platform/operations/*`；
- 新增 `tests/rfc346-system-operations-contracts.test.ts`、adapter/CLI parity tests；
- 修改 `cli/backup.ts`、`cli/restore.ts` 只能在确认没有其他 session owner 后进行；
- 不改 `routes/*`、`server.ts`、`platform/operations/*`、canonical payload 或 RFC-345 路径。

### Cohort B：RFC-344 closeout 后

开工前 fetch、同步、re-pin：

- 增加 catalog alias contract/negative fixtures；
- composition 在 `createApp/mountApiRoutes` 构造一次 system-operations module；
- 四条 route 切 descriptor-backed binding；
- `AppDeps` consumer 2→0；
- 更新 exact canonical owner/alias/debt ledger 与 payload。

RFC-344 如果在 closeout 期间改变 catalog contract，Cohort B 必须更新 RFC-346 exact design 并重新呈批差异；不能把旧草案直接套到新
catalog。

## 11. Failure model 与回滚

| Failure                                     | 行为                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| backup preparation/snapshot 失败            | 保持现有 error mapping；不返回成功 ref                                           |
| multipart parse/缺 file                     | 现有 400 wire                                                                    |
| restore validation/downgrade/integrity 失败 | 不写 pending；release ingested artifact；现有 400/CLI error                      |
| 已有 pending restore                        | 保持 existing conflict 文案/状态；不得覆盖                                       |
| daemon running + cold activate              | refusal；stage 仍可用                                                            |
| lock race                                   | refusal；不执行 restore                                                          |
| post-swap failure                           | 仍由 legacy `RestorePostSwapError` fail-closed；RFC-346 不降级处理               |
| alias invalid                               | startup/guard failure，不能 fallback legacy second handler                       |
| adapter throw after effect                  | 不重试/双执行；沿 existing caller result，W9-E 才引入 durable operation protocol |

回滚顺序：

1. HTTP binding可切回 compatibility route，但只允许同一 legacy service handler；不保留双 handler/shadow effect；
2. CLI 可切回 legacy adapter entry，public module保留 additive；
3. schema 为零，无数据回滚；
4. alias 只有在 primary binding 已回退后删除；
5. 已 stage/已 swap restore 继续按 existing forward behavior，不能以代码回退还原物理 generation。

## 12. 测试策略

### 12.1 Contract/architecture

- exact public export allowlist；
- strict input/output codec、unknown field reject；
- module source禁止 DB/FS/Hono/Actor/path/legacy service（唯一 infrastructure adapter exception exact）；
- port field/type taint：无 DbClient/path/callback/registry/business row；
- operation primary/alias closure negative matrix；
- four-route exact leaf set、legacy adapter 4→0、AppDeps E7 consumer 2→0；
- exact canonical owner mapping；maintenance/doctor/migrate negative fixtures。

### 12.2 Behavior parity

- 既有 RFC-213 backup/restore/pending/route/boot tests 原样通过；
- route old-vs-new success/error/status/body golden；
- CLI old-vs-new flags/output/status golden；
- credential preparation/createBackup exactly once；
- stage artifact cleanup、pending conflict、cancel idempotence、failed quarantine projection；
- dry-run daemon-running、stage daemon-running、cold lock refusal/race；
- boot source lock保持 pending apply before openDb；
- RFC-295 readonly/zero-write/report exact。

### 12.3 Hosted evidence

本仓以 GitHub Actions 为唯一权威门禁。发布后按 exact SHA 检查 Main CI 与适用 scheduled workflows；queued/cancelled/ancestor-only 不算
RFC-346 通过。若另一个 session 的 containing SHA 覆盖候选，须证明 RFC-346 commit 是其祖先且该 run 对应完整干净 checkout。

## 13. 实施影响清单

预计 owned paths：

```text
design/RFC-346-system-operations-adapter-cutover/**
packages/backend/src/modules/system-operations/**
packages/backend/tests/rfc346-*.test.ts
packages/backend/src/cli/backup.ts
packages/backend/src/cli/restore.ts
packages/backend/src/routes/backup.ts                 # Cohort B only
packages/backend/src/routes/restore.ts                # Cohort B only
packages/backend/src/server.ts                        # Cohort B only
packages/backend/src/platform/operations/*            # alias minimum, Cohort B only
packages/backend/tests/rfc344-operation-catalog.test.ts # alias matrix, Cohort B only
packages/backend/tests/architecture/rfc294Canonical.ts # exact ownership, Cohort B only
architecture/*.json                                   # generated exact payload, Cohort B only
STATE.md
design/plan.md
design/RFC-294-backend-layered-target-architecture/plan.md
```

任何实际提交前重新生成 exact allowlist；不得 broad-stage，且不得代交 RFC-344/345 的并发 WIP。

## 14. 实际落地与机器证据

最终 production topology：

```text
HTTP descriptor binding ─┐
                         ├─ exact public command/query ─> one system-operations application instance
bootstrap-local CLI ─────┘                                      │
                                                               ├─ AdminBackupCoordinatorPort
                                                               └─ AdminRestoreCoordinatorPort
                                                                          │
                                                         one legacy platform adapter
                                                                          │
                                            backup / restore / pendingRestore mechanisms (W9/W9-E)
```

落地结果与设计裁决逐项一致：

- 四个 primary descriptors 与四个 `legacy-http.*` data-only aliases 进入同一 frozen catalog；alias 只一跳、一对一、同 kind、同 major，
  且不持有 handler/codec/admission；
- `createApp` bootstrap 只 composition 一次 module；backup/restore routes 只消费 public handles，`AppDeps`、DB/FS/Paths/migration
  resolver/legacy service deep import 在这两条 route 上归零；
- CLI composition 上提 `main.ts` bootstrap；`backup.ts` / `restore.ts` 只保留 argv 与 output/exit projection；
- artifact ingress 运行时提供与 actual ref 一致的 operation codec，multipart `File` 与 local path 不进入 public DTO；
- exact owner mapping 与 source locks 排除 maintenance/doctor/migrate/db compact/readiness/GC，并把 physical restore compatibility debt
  精确留给 W9-E；
- authority-bearing contract 只存在于 executable `public/commands.ts` / `public/queries.ts`，`public/types.ts` 无
  `RequestAuthority`、`CommandContext` 或 `QueryContext` alias leakage。

Canonical final source digest 为
`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`。RFC-346 source/test commits 均为
`7ede76a88649f9c3f5501eef47106631e89f24c1` 的祖先；该 clean-checkout exact SHA 的权威 hosted evidence：

| Workflow             | Run           | 结果                  |
| -------------------- | ------------- | --------------------- |
| Main CI              | `33317698270` | `COMPLETED / SUCCESS` |
| e2e-full-nightly     | `33317736186` | `COMPLETED / SUCCESS` |
| e2e-webkit-nightly   | `33317732124` | `COMPLETED / SUCCESS` |
| evidence scenarios   | `33317735982` | `COMPLETED / SUCCESS` |
| git protocols E2E    | `33317735272` | `COMPLETED / SUCCESS` |
| integration OpenCode | `33317735322` | `COMPLETED / SUCCESS` |
| maintenance soak     | `33317735048` | `COMPLETED / SUCCESS` |
| visual regression    | `33317735095` | `COMPLETED / SUCCESS` |
| Windows platform     | `33317734896` | `COMPLETED / SUCCESS` |

Main CI 的 backend 8/8、三平台 Playwright 与 required rollup 全绿；8 个 scheduled workflows 的 completed suites 均
`failed=[]` / `unfinished=[]`。因此 AC-1～AC-12 已闭合，RFC-346 只关闭 RFC-294 W4-E7；W9-E physical generation protocol 与
其他 W4 子波仍按各自 successor 推进。
