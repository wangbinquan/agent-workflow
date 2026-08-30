# RFC-346 — System Operations 管理编排与 adapter cutover（RFC-294 W4-E7）

状态：Approved / In Progress（D1～D12 已于 2026-08-30 获用户明确批准；已授权实现、提交与 push）

Source pin：`625017c084db2f7eb6c9ec34c87eba41ffaf04cd`

并发边界：RFC-344 / W4-A 与 RFC-345 / W4-C 正由其他 session 落地。本 RFC 在 RFC-344 hosted closeout 前只允许新增
`modules/system-operations` 合同、legacy platform adapter、CLI composition 与专项测试；不修改 RFC-345 路径，也不提前修改
`server.ts`、`routes/{backup,restore}.ts`、`platform/operations/*` 或 canonical architecture payload。

## 1. 摘要

当前 backup、restore 与 recovery diagnostics 的用户能力已经存在，但管理编排散落在 REST route、CLI 和 `services/*`：

- `POST /api/backup` 直接从 `AppDeps` 取得 DB/secret box，再调用 credential sealing 与 `createBackup`；
- restore 的三条 HTTP route 自己处理 multipart、临时文件、migration assets、stage marker 与错误映射；
- `agent-workflow backup` / `restore` 分别自行开库、解析 flag、获取 daemon lock 并调用相同 legacy services；
- boot-time pending restore 仍由 `cli/start.ts` 在 `openDb` 前直接调用 `applyPendingRestoreIfAny`；
- RFC-295 downgrade audit 是有意保留的只读、一次性兼容命令，直接开 SQLite 并扫描 workflow/task compatibility；
- canonical classifier 目前因 `/backup|restore|maintenance|doctor|migrate/` 的宽正则，把 maintenance/doctor/migrate 也归到
  `system-operations`，与 RFC-294 已裁决的边界不一致。

本 RFC 建立无业务事实表的 `modules/system-operations`：只拥有 admin backup/restore/recovery diagnostic 的 typed
command/query 与 operation descriptors；所有 DB、文件、lock、tar、migration、worker 与物理 swap 继续由 platform/legacy mechanism
adapter 承担。REST 与 CLI 逐步调用同一 application handler，四条 HTTP compatibility adapter 在 RFC-344 收口后切为
descriptor-backed operation；当前 backup/restore wire、CLI flags/文本/退出码、Settings 流程与 boot apply 顺序全部保持。

这只是 RFC-294 W4-E7 的管理编排 cutover，不实现 W9-E 的 physical restore generation protocol。

## 2. Current-source 事实

### 2.1 现有入口

| Surface                       | 当前实现                                              | 当前问题                                                                         |
| ----------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/backup`            | `routes/backup.ts:10-30`                              | route 直接消费 `AppDeps.db/secretBox`、credential sealing 与 `services/backup`   |
| `GET /api/restore/pending`    | `routes/restore.ts:31-43`                             | route 直接读 pending/failed restore 文件状态                                     |
| `DELETE /api/restore/pending` | `routes/restore.ts:45-57`                             | route 直接执行 clear                                                             |
| `POST /api/restore`           | `routes/restore.ts:60-113`                            | route 内含 multipart、FS 临时路径、migration resolution、validation、stage       |
| `agent-workflow backup`       | `cli/backup.ts:15-43`                                 | CLI 自行开库、sealing、调用 backup mechanism 并格式化输出                        |
| `agent-workflow restore`      | `cli/restore.ts:22-129`                               | CLI 自行 plan/stage/lock/cold-activate 并格式化输出                              |
| boot pending apply            | `cli/start.ts` + `services/pendingRestore.ts:173-249` | 必须保留在 acquire-lock 后、openDb 前；不是普通在线 command                      |
| RFC-295 downgrade audit       | `cli/rfc295-downgrade-audit.ts:38-75`                 | 有意直读旧 schema 的 rollback compatibility gate；不应长成 generic audit service |

RFC-344 current catalog 为四条 HTTP route 自动生成以下 compatibility identities：

- `legacy-http.post-backup.v1`
- `legacy-http.read-restore-pending.v1`
- `legacy-http.delete-restore-pending.v1`
- `legacy-http.post-restore.v1`

它们当前均为 `implementation='compatibility'` / `legacyHttpAdapter=true`，不能被误报成 bounded-context descriptor 已落。

### 2.2 机制与跨域事实

- `services/backup.ts#createBackup` 同时进行 SQLite snapshot、config/skills、workflow YAML 与可选 worktree capture；它是当前行为
  mechanism，不是 `system-operations` 可拥有的业务数据模型。
- `services/restore.ts#restoreBackup` 当前包含 DB/config/skills swap、migration、worktree reconstruction，并直接挂起 non-terminal task；
  这些是 W9-E generation protocol 必须重新分解的 legacy mechanism，本 RFC不重写。
- `services/pendingRestore.ts` 持有外置 marker/failed quarantine 与 boot apply；在线 Stage/Query/Cancel 可经 coordinator port，
  boot apply 仍由 bootstrap 调 platform mechanism。
- `services/backupScheduler.ts`、RFC-338 maintenance worker、disk reclaim、retention、task limits、workspace GC 与 public readiness
  均不属于本 RFC；定时/后台生命周期归 platform/background 或各事实 owner。
- `services/recovery.ts` 的 task recovery events/counters 不是 system-operations 数据。只有 restore operation 自己的 safe status/diagnostic
  projection 进入本模块。

### 2.3 量化基线

| 指标                                 |        Source pin current |                      RFC-346 exit |
| ------------------------------------ | ------------------------: | --------------------------------: |
| System Operations HTTP leaves        |                         4 |          4，method/path/wire 不变 |
| 其中 `legacyHttpAdapter=true`        |                         4 |                                 0 |
| E7-owned `AppDeps` consumer          | 2（backup/restore route） |            0；全仓 48 → 46 或更低 |
| 用户 CLI                             |       2（backup/restore） | 2，调用 typed application handler |
| RFC-295 compatibility CLI            |                         1 |     1，显式 sunset ledger，仍只读 |
| 新 schema / migration                |                         0 |                                 0 |
| physical restore generation protocol |                         0 |                    0，继续归 W9-E |

## 3. 目标

1. 新建 `modules/system-operations`，只暴露 backup/restore/recovery diagnostics 的 typed commands、queries、types 与 operation
   descriptors。
2. 让 REST 与 CLI 复用同一 application handler；transport 只 decode/call/encode，不持有 DB、FS、lock 或 migration branch。
3. 以 consumer-owned、purpose-specific coordinator ports 隔开 application 与现有 backup/restore mechanism；不得暴露 `DbClient`、
   effect-authorizing absolute path、participant registry、callback 或通用 repository；现有 path/dir 只允许作为 output-only wire 投影。
4. 在不改变 wire 的前提下，把四条 HTTP route 从 RFC-344 compatibility projection 切为 descriptor-backed operations，并为现有
   `legacy-http.*` identity 提供一对一、可审计 alias。
5. 把 RFC-295 downgrade audit 固定为一次性 compatibility command；不将 workflow/task scanner 提升成 system-operations public port。
6. 修正 E7 的 architecture owner/ledger，使 maintenance、doctor aggregate、migrate、db compact、public readiness、task recovery 不再被
   `system-operations` 宽吞。
7. 明确把 physical restore、module participants、daemon generation、worker fencing 与 post-swap repair 转交 W9-E。

## 4. 非目标

- 不实现 RFC-294 W9-E 的 daemon generation、module `BackupExport/RestoreParticipant` registry、ingress drain、worker/outbox/apply
  fence、atomic generation switch 或 post-swap forward repair。
- 不改 `createBackup` / `restoreBackup` 的现有数据内容、顺序或恢复算法；只在其外建立 adapter。
- 不把 maintenance、retention、disk reclaim、DB compact、migration、health/readiness、task limits、workspace GC、task recovery events
  收进 system-operations。
- 不增加 route、MCP tool、CLI command、schema、migration、配置字段或前端页面。
- 不改变现有 `backup:run` route gate、CLI 本地运行模型、REST status/body、CLI flag/output/exit code。
- 不删除 `services/{backup,backupManifest,backupScheduler,backupVacuumWorker,restore,pendingRestore}.ts`；其 mechanism/worker consumer
  在 W9/W9-E 前仍是有账 debt。
- 不替 RFC-344 或 RFC-345 完成、提交或发布任何文件。

## 5. 待批准裁决

### D1 — E7 只拥有管理编排，不拥有运维杂项

`system-operations` 的产品面严格限定为 admin backup、restore、recovery status/diagnostics。Maintenance、doctor 聚合、migrate、
DB compact、health/readiness、task/workspace cleanup 均排除。

### D2 — Public surface 使用四类 command、两类 query

- commands：`RequestBackup`、`StageRestore`、`CancelStagedRestore`、`ActivateLocalRestore`；
- queries：`PlanLocalRestore`、`GetRecoveryStatus`；
- HTTP 只绑定前三个在线 command 与 status query；cold activate/plan 只供本地 CLI composition；
- RFC-294 草图中的 `GetRecoveryOperationDiagnostics` 不另造无 consumer 的 query，现有 failed-restore diagnostics 继续作为
  `GetRecoveryStatus.failed` 的同一 projection；新增独立诊断 surface 需另行呈批；
- 不提供 `RunMaintenance`、`RunDoctor`、`QueryAnySystemState` 或任意字符串 operation switch。

### D3 — Application 只消费窄 coordinator ports

拆为 `AdminBackupCoordinatorPort` 与 `AdminRestoreCoordinatorPort`。它们只接 ingress-minted artifact ref、closed options 与
safe receipts；不返回 DB、可回传为 effect input 的 absolute path、raw participant registry、callback 或 process handle。为保持既有
wire，receipt 可带明确标记为 output-only 的 backup path / failed restore dir 显示投影，但 application 与后续 command 不得消费它们。

### D4 — Legacy mechanism 先包 adapter，不在 W4-E7 重写 restore

RFC-213 已上线的 snapshot/stage/lock/swap/migration/worktree 行为全部作为 compatibility oracle。W4-E7 先用 bootstrap-composed
legacy adapter 调现有 services；W9-E 再以 generation coordinator + module participants 替换 adapter internals。

### D5 — Wire 与 CLI 完全兼容

四条 REST method/path、输入、响应字段、状态码不变；Settings 仍显示 backup path/size、上传后显示 staged、pending/failed banner 与
cancel 流程不变。CLI backup/restore 的 flags、输出文本与退出码保持；本 RFC只改变调用归属。

### D6 — HTTP 与本地 CLI 使用不同的 exact context，不伪装成同一入口

HTTP descriptor 消费 RFC-344/identity-access 已铸造的 direct command/query context；本地 cold restore/backup CLI 使用
bootstrap-local admin context。两者复用 application handler，但不让 CLI 构造 Actor，也不让 HTTP 取得 daemon lock/path。

### D7 — Multipart/path 在 inbound/platform adapter 消化

HTTP upload 与 CLI tarball path 先由 composition-owned artifact ingress 转成 opaque `RestoreArtifactRef`，再调用 command。Ingress
不是 application required port；它在 handler 之前运行，并在本次 composition 内保存 ref 到 managed artifact 的映射。Public DTO 不携带
`File`、absolute staging path 或 raw bytes；既有 HTTP/CLI 显示路径只作为 output-only admin projection，不成为 effect input。

### D8 — RFC-344 identity 采用显式一对一 alias

四个现有 `legacy-http.*` identity 保留为 exact alias，primary descriptor id 改为：

- `system-operations.request-backup.v1`
- `system-operations.get-recovery-status.v1`
- `system-operations.cancel-staged-restore.v1`
- `system-operations.stage-restore.v1`

Alias 只能一对一、同 kind、同 binding、同 codec major；unknown/stale/chain/cycle/one-to-many 必红。RFC-344 hosted closeout 前不改
catalog/route/root 文件。

### D9 — Boot apply 不经在线 command

`applyPendingRestoreIfAny` 继续在 acquire-lock 后、openDb 前由 bootstrap 调 platform mechanism。它不经过 Hono、OperationCatalog 或
需要已打开 DB 的 application command；W9-E 才改变其 generation protocol。

### D10 — RFC-295 audit 保持 explicit compatibility + sunset ledger

`agent-workflow downgrade-audit rfc-295` 保持当前只读 direct SQLite path、稳定报告与零写入测试。Ledger 标记 owner=RFC-295
compatibility、removeWave=W9-E-or-explicit-release-decision；本 RFC不删除、不泛化，也不让它成为任意跨域审计 port。

### D11 — Canonical owner 改为 exact mapping

移除“名字含 maintenance/doctor/migrate 就属于 system-operations”的事实用途。E7 exact inventory 只包含本 RFC列出的 module、route、CLI
和 legacy adapter；maintenance/background 与业务 owner 按 RFC-294 现行裁决记录，避免用宽正则伪造迁移 credit。

### D12 — 并发分段

RFC-344 hosted closeout 前只实施 T1～T3 的 additive module/adapter/CLI cohort；T4 HTTP descriptor、alias、`server.ts` composition 与
canonical regeneration 必须等待 RFC-344 发布，并在开工前重新 pin exact SHA。RFC-345 路径全程不触碰。

## 6. 用户故事

- 作为管理员，我从 Settings 运行 backup、上传 restore 包、查看/取消 pending restore，看到的结果和错误与现在完全一致。
- 作为本机运维者，我继续使用 `agent-workflow backup`、`restore --dry-run|--stage|--yes`；命令行为不变，但不再各自拼接一套业务流程。
- 作为后续 W9-E 实现者，我可以只替换 platform coordinator adapter，而不用再次改 REST/CLI 产品面。
- 作为架构维护者，我可以从 exact ledger 看到 system-operations 真正拥有的四条 HTTP leaf、两个 CLI use case 与 W9 debt，
  不再把所有 maintenance/doctor/migrate 文件误算进来。

## 7. 验收标准

- **AC-1**：`modules/system-operations` 存在真实 production consumer；public surface 只有 D2 的 commands/queries/types/operations，
  无 DB、FS、Hono、Actor、path、callback、registry 或业务 row。
- **AC-2**：四条 HTTP route 均为 descriptor-backed primary operation，`legacyHttpAdapter 4→0`；四个 legacy identities 只作为一对一 alias，
  alias negative matrix 全绿。
- **AC-3**：四条 HTTP method/path、request/response/status/error wire 与 source pin oracle 逐项相等；Settings backup/restore 流程无需改动。
- **AC-4**：`routes/backup.ts` 与 `routes/restore.ts` 不再 import `AppDeps`、DB、FS、Paths、migration resolver 或 legacy services；
  E7-owned `AppDeps` consumers `2→0`。
- **AC-5**：CLI backup/restore 调 typed system-operations application；所有既有 flags、输出和退出码 golden 相等，cold lock 竞争与 stage 行为不变。
- **AC-6**：backup route/CLI 的 credential preparation、snapshot 与 receipt 各执行一次；无 shadow/double backup、无两套 handler。
- **AC-7**：boot pending apply 的 source order仍为 acquire-lock → pending apply → openDb；本 RFC不把它接进在线 command/catalog。
- **AC-8**：`createBackup`、`restoreBackup`、pending marker、scheduled backup 与 restore direct task/fusion/memory debt 全部有唯一 W9/W9-E owner；
  本 RFC不宣称 mechanism consumer-zero。
- **AC-9**：RFC-295 downgrade audit 仍只读、无 ignore/force、报告 wire 不变，并有 exact sunset ledger；system-operations public imports=0。
- **AC-10**：maintenance、doctor aggregate、migrate、db compact、health/readiness、task limits/workspace GC 不进入 system-operations
  public/module inventory；canonical exact mapping 和负向 fixture 锁定。
- **AC-11**：无 schema/migration/config/route/tool 增删；RFC-213 backup/restore、admin route、frontend、binary CLI 与 boot restore 全部既有回归保持。
- **AC-12**：published exact SHA 的 Main CI 与适用 scheduled workflows terminal success；RFC-346 三件套、STATE、index 与 canonical provenance
  指向同一发布事实后才可标 Done。

## 8. 能力影响

本 RFC 是内部归位，不增加、删除或收缩用户能力：

- REST/CLI/Settings surface 不变；
- backup 内容、restore plan/stage/cold apply、pending/failed status 与 cancel 不变；
- route gate、CLI 本地运行方式、错误/退出码不变；
- boot restore、scheduled backup、doctor 与 RFC-295 audit 继续存在；
- physical restore correctness 不由本 RFC重新声明，现有 RFC-213 行为先完整保留。

## 9. 批准记录与边界

2026-08-30，用户明确批准 D1～D12，并授权实施与 push。授权只覆盖 `plan.md` T1～T6；不授权 W9-E physical restore、
maintenance/background 归位或新产品能力。RFC-344 hosted closeout 前只允许 D12 指定的 additive/CLI cohort。
