# RFC-349 实施计划 — 数据库 Provider、PostgreSQL 一键迁移与 Schema Contract

状态：Approved / In Progress。用户已于 2026-08-31 批准 `proposal.md §5 D1～D14`，并授权完整生产实现、commit 与 push。

## 1. 实施原则

1. 先建 schema/consumer/behavior oracle，再动 provider；不能以“能连接 PostgreSQL”替代功能等价。
2. SQLite 始终是默认、每个 wave 都保持可运行；PostgreSQL 在全能力/运维/迁移 gate 完成前不出现在正式可选 Settings 中。
3. 每个 bounded context 同时交付 application port、SQLite adapter、PostgreSQL adapter、caller cutover 和旧入口归零，不留永久双源。
4. 不建新的 global repository、generic SQL port、generic transaction 或 provider service locator。
5. SQLite→PostgreSQL 只在明确维护模式中单写迁移；V1 不双写、不 CDC、不用“最终一致”掩盖漏数据。
6. source SQLite 不原地删表；六张 legacy 表先归档对账，只从 PostgreSQL active target 省略。
7. 其余 178 张 source parity table 默认完整迁移；新增 omit candidate 必须先更新 proposal allowlist 并获批。
8. 迁移状态、checkpoint 和 pointer 不依赖正在搬迁的业务库，所有 phase 可 crash/restart 验证。
9. 一次完整 local gate 只针对稳定 candidate 跑一次；最终整仓真值以 exact-SHA hosted CI/scheduled workflows 为准。
10. shared `main` 只在短 publication critical section 做 exact-path stage/commit/push，保留所有并行 owner 当前内容。

## 2. 当前授权边界

用户已授权 T1～T11 的完整生产实现、commit 与 push。授权严格限于 RFC-349：双 provider、one-click migration、schema contract、
首批六表 archive/target omit、Settings/CLI 与验收证据；不扩张为 embedded PostgreSQL、双写/零停机、多 daemon 或其他 RFC 的能力。

shared `main` 上仍只提交 RFC-349 自有路径；与 RFC-345 或其他 session 重叠的完整文件必须保留对方当前内容并先取得稳定 ownership/
publication handoff。未经 proposal 更新与用户追加批准，不得把第七张表加入 omit allowlist。

## 3. source-lock 与 live census

T1 开工前 fresh fetch/sync，并从当时 committed source 重采；下面是 Draft source pin 的起点，不是永久目标：

| ID  | Draft source pin `3f6b854e3` 事实                     | T1 产物/门                                          |
| --- | ----------------------------------------------------- | --------------------------------------------------- |
| S1  | 184 个 `sqliteTable(...)`                             | exact logical table census；unknown/duplicate=0     |
| S2  | 222 个 SQLite `.sql` migration                        | immutable SQLite history digest；不得翻写           |
| S3  | `schema.ts` 7,506 行                                  | generated owner/schema manifest；不再靠单文件目测   |
| S4  | 约 343 个 production TS 文件提及 `DbClient`           | exact file/symbol/owner/consumer cohort ledger      |
| S5  | 约 93 个 production TS 文件提及 `dbTxSync`            | atomic-use-case ledger；public/application target=0 |
| S6  | Bun SQLite sync driver + Drizzle Bun SQLite           | SQLite adapter baseline/behavior oracle             |
| S7  | 没有 PostgreSQL provider/config/schema/migration      | PostgreSQL adapter 与 dual-dialect gates            |
| S8  | backup/restore/doctor/start/maintenance 均绑定 SQLite | provider-operation matrix；所有格子有 owner         |
| S9  | RFC-310 已锁六张 legacy 表零生产消费者                | live re-scan + archive/drop-proof 十项              |
| S10 | RFC-345 仍 Approved/In Progress                       | overlap path/owner 协调；不覆盖其当前 cutover       |

T1 生成报告必须把表按 bounded context、prefix、consumer、row estimate、bytes、PK/FK、retention 与 disposition 展开；不能只保留 184
这个总数。若 live source 不是 184，先更新 RFC source facts，再继续实现。

## 4. 总任务图

| 任务        | 内容                                                                                                   | 依赖       | Draft 状态           |
| ----------- | ------------------------------------------------------------------------------------------------------ | ---------- | -------------------- |
| RFC-349-T0  | proposal/design/plan、RFC index、STATE；只读 source audit                                              | —          | Done（仅 RFC Draft） |
| RFC-349-T1  | 用户批准 D1～D14；fresh source-lock、owner/index/remote/candidate-gate audit                           | T0         | In Progress          |
| RFC-349-T2  | 184-table schema/consumer contract、双 provider behavior oracle、旧实现 red targets                    | T1         | Pending              |
| RFC-349-T3  | provider config/runtime/factory、PostgreSQL pool/health/timeout、generation pointer skeleton           | T2         | Pending              |
| RFC-349-T4  | 双 dialect schema、PostgreSQL baseline/forward migrations、codec/constraint projector                  | T2–T3      | Pending              |
| RFC-349-T5  | 全业务 application port + SQLite/PostgreSQL adapter cohort cutover；旧 DB surface 归零                 | T3–T4      | Pending              |
| RFC-349-T6  | backup/restore/doctor/maintenance/start/runtime provider matrix cutover                                | T4–T5      | Pending              |
| RFC-349-T7  | durable one-click migration engine：preflight/freeze/backup/copy/verify/cutover/rollback               | T4–T6      | Pending              |
| RFC-349-T8  | 六张 legacy 表 logical archive + target omit；schema count/report gate                                 | T2、T4、T7 | Pending              |
| RFC-349-T9  | system-operations command/query、Settings/CLI/status/progress/cancel/resume/finalize                   | T7–T8      | Pending              |
| RFC-349-T10 | dual-provider full regression、fault/mutation、large migration、100-client soak、三平台 compiled smoke | T3–T9      | Pending              |
| RFC-349-T11 | exact publication、remote/hosted exact-SHA、canonical/provenance/RFC-294/STATE closeout                | T10        | Pending              |

关键路径：

```text
T0 -> approval/T1 -> census+oracle/T2 -> runtime/T3 -> schema/T4
                                           |             |
                                           +------> port cutover/T5 -> ops/T6
                                                              |          |
                                                              +-----> migration/T7
                                                                         |
                                                          archive omit/T8 + UI/CLI/T9
                                                                         |
                                                                    evidence/T10
                                                                         |
                                                                   publication/T11
```

## 5. T0 — RFC Draft（本轮）

- 对拍 RFC-294/RFC-310/RFC-338/RFC-346 与 current source；
- 明确 server 外置、SQLite 默认、V1 maintenance window、无双写；
- 固定 D1～D14、AC-1～AC-15；
- 记录 184/222/343/93/7,506 source facts；
- 将六张零生产消费者 legacy table 列为唯一初始 omit candidate；
- 定义 application/transaction 修订、schema contract、operation phases、rollback horizon 与 evidence；
- 更新 RFC index 与 STATE 为 Draft；
- 只做 Markdown/link/diff/status 核验，不写生产代码、不提交。

退出：五个文档路径一致，index 空，用户可逐项批准或修改裁决。

## 6. T1 — 批准与稳定 baseline

- 用户逐项批准/修改 D1～D14；把批准日期与原文回填 proposal；
- fresh fetch，核对 `main`/`origin/main`、shared dirty/index、active RFC owners；
- 重采 S1～S10，保存 exact commands、source SHA、generated fixture/digests；
- 收齐 RFC-345 与任何重叠 consumer 的 stable ownership handoff；未完成不覆盖；
- 建 production consumer 分类规则：static import、Drizzle symbol、raw SQL string、dynamic table roster、route/MCP/CLI、worker、restore、doctor；
- 建 PostgreSQL supported-version/driver/API spike，只证明 capability，不接 production caller；
- 验证 compiled binary 在没有 `psql/pg_dump/postgres` 时能加载 client adapter；
- 更新实施 allowlist、dependency DAG、full-gate owner 和 publication order。

退出：source-lock 无 stale 数字；所有裁决获批；没有未归属重叠 WIP；旧 SQLite behavior baseline 可复现。

## 7. T2 — Schema/consumer contract 与先红门

### T2-A table census

- 从 committed SQLite schema AST 生成 184-table roster；
- 逐表登记 owner/disposition/migration key/columns/constraints/index/retention；
- 扫描 production reader/writer/background/restore/diagnostic/dynamic SQL；
- 将检测不到的 raw/dynamic source 纳入显式 allowlist，不能默认为零 consumer；
- 输出 human report 与 canonical machine manifest；二者同 digest；
- extra/missing/duplicate/ownerless/stale source mutation 必红。

### T2-B behavior oracle

- 抽取 provider-neutral fixtures 和 command/query receipts；
- 锁 SQLite 现有成功、冲突、stale、not-found、排序、pagination、nullable/default、event ordering；
- 对 CAS/lease/fence/outbox/apply/event delivery 建 concurrency oracle；
- PostgreSQL adapter 尚未实现时 target cases 按预期红，不用 mock 假绿。

### T2-C architecture gate

- 建 `DbClient`、`@/db/schema`、`dbTxSync`、`bun:sqlite`、raw SQL current ledger；
- 新 public/application import 立即红；
- 每个 cohort 的 approved high-water 只能下降；
- provider-specific type 不得进入 shared/module public API；
- RFC-294 §4.3 amendment test 先红：公共 command Promise、无 escaped transaction scope。

退出：184 张表和所有 DB consumer 可精确回答“谁拥有、谁读、谁写、为何保留”；PostgreSQL target oracle 尚未冒领通过。

## 8. T3 — Provider runtime 与 generation fence

- 新增 backwards-compatible `DatabaseConfig` discriminated union 与 defaults/draft/save/discard tests；
- 建 provider factory，只在 bootstrap 按 verified generation pointer 选择；
- SQLite runtime 保持现有 open/migrate/integrity/telemetry 行为；
- PostgreSQL runtime 实现 lazy pool、connect/statement/idle timeout、readiness、graceful drain；
- connection URL 只从 env/secret source 注入，所有 DTO/log/error/manifest redaction tests；
- 建 external operation state store 与 generation pointer atomic write/readback/doctor；
- 建 target advisory-lock adapter、appHome/source generation fence、stale owner CAS；
- 建 live-write generation marker，所有 provider write transaction 必须校验 generation；
- pool unavailable 时 fail closed，不回退到 SQLite 或单连接 shadow path。

退出：SQLite zero-config regression 绿；PostgreSQL runtime 真实连接/timeout/close 绿；业务 caller 尚未公开切换 provider。

## 9. T4 — 双 dialect schema 与 migration history

### T4-A physical schemas

- 拆出 logical contract；SQLite `sqliteTable` 与 PostgreSQL `pgTable` 分开投影；
- PostgreSQL 使用固定 application schema + metadata schema；
- column codec、default、identity、collation、index/check/FK/unique 逐项对账；
- `KEEP/DEFER` 两边完整，六张 `ARCHIVE_THEN_OMIT` 只有 SQLite source + archive contract；
- 将单个 7,506 行 global schema 按 owner/projector 拆分，但不制造跨模块 table import；
- generated aggregate 只供 migration/platform adapter，业务模块只见自己 adapter 的 slice。

### T4-B migration histories

- 锁住 222 条 SQLite history immutable digests；
- 新建独立 PostgreSQL baseline/forward migration history；
- fresh install、upgrade、logical restore、SQLite migration 四种路径分开测试；
- bulk bootstrap 由 contract 生成 table/PK → copy → constraints/index validate phases；
- 不 replay SQLite SQL，不要求 superuser，不使用不可审计的 global constraint disable；
- schema drift/partial migration/corrupt metadata fail closed。

### T4-C codec

- integer/bigint、boolean、JSON text、canonical JSON、blob、null、timestamp、enum、opaque ref round-trip；
- SQLite dirty dynamic type exact table/key failure；
- 无 stable migration key 的表阻断并先补前置 migration；
- sequence/identity next value、collation/unique/order behavior oracle；
- chunk canonical encode/hash 可流式执行且 memory bounded。

退出：两个空 provider 的 logical schema contract 等价；六张 omit 表差异是唯一批准的 business-table absence；所有 extra diff 红。

## 10. T5 — Application port/adapter cutover

### 10.1 每个 cohort 的原子交付模板

1. 锁当前 application behavior 与 SQL/result characterization；
2. 定义 consumer-owned repository/query/atomic port；
3. 把 transaction callback 改成同步 pure decision + Promise port result；
4. 实现 SQLite adapter，原 behavior 全绿；
5. 实现 PostgreSQL adapter，同一 oracle 全绿；
6. bootstrap 显式注入当前 provider adapter；
7. transport/scheduler/worker 只调 public command/query；
8. 删除旧 direct DB composition/caller；
9. exact ledger 水位下降，禁止新 compatibility consumer；
10. targeted concurrency/fault gate 后才领下一个 cohort。

### 10.2 建议 cohort

| cohort | 主要 owner/能力                                               | 额外门                                           |
| ------ | ------------------------------------------------------------- | ------------------------------------------------ |
| C0     | platform metadata、config/system-operations 基础 stores       | generation/boot/schema fence                     |
| C1     | identity-access、users、ACL/resource-catalog                  | RFC-345 ownership稳定；authority/revision oracle |
| C2     | workflow/task-execution/collaboration/human-gate              | claim/fence/effect/continuation/event 原子性     |
| C3     | scheduler/webhook/code-host/integration/event-center          | lease/outbox/idempotency/delivery ordering       |
| C4     | intent/memory/knowledge-evolution/resource apply              | journal prepared/committed recovery              |
| C5     | digital-employee/development-automation                       | saga/attempt/effect/upload retention             |
| C6     | remaining admin/read-model/diagnostic/compatibility consumers | exact global ledger target=approved infra only   |

具体顺序以 T1 live DAG 为准。某 cohort 与活跃 RFC shared file 重叠时，只暂停该重叠 cutover并协调 owner，不通过 alternate index、stash、
reset 或另一个 worktree 绕过。

### 10.3 完成门

- business/application/public 的 `DbClient`、schema、raw SQL、generic tx consumer=0；
- SQLite `dbTxSync` 只在批准 infrastructure adapter/test allowlist；
- PostgreSQL adapter 不 import SQLite schema/mechanism；
- 同一 full behavior suite 在两 provider 绿；
- provider selection 后无 SQLite fallback；
- 所有写都经过 generation fence，第一笔 target live write marker 与业务 mutation 同事务。

退出前不得把 PostgreSQL provider 暴露给普通用户。

## 11. T6 — Provider-aware operations

### T6-A boot/start/shutdown

- boot 先解析 pointer/manifest，再选择 provider；
- provider-specific migration/integrity/readiness 通过后才 mount business app；
- shutdown 先关 admission/worker，再 drain pool/connection；
- pointer/manifest drift、half-cutover、target unavailable 的 CLI/日志指令 deterministic。

### T6-B backup/restore

- versioned logical artifact + per-table chunk/digest；
- SQLite raw snapshot 作为 provider extra；PostgreSQL native dump 只记 operator extra；
- 两 provider 导出同一 logical contract，可 restore 到空 SQLite/PostgreSQL target；
- legacy archive 与 active database payload 分开；普通 restore 不复活六张 legacy 表；
- pre-restore safety generation、crash recovery、artifact corruption、wrong source digest 门。

### T6-C doctor/maintenance

- SQLite quick_check/PRAGMA/WAL/VACUUM 只进 SQLite adapter；
- PostgreSQL pool/schema/constraint/lock/statement health 只进 PostgreSQL adapter；
- RFC-338 closed job catalog 改调用 owner ports；相同 retention result oracle，两边 mechanism 不同；
- maintenance Worker 在 PostgreSQL 不打开 `db.sqlite`，也不占满 foreground pool；
- provider matrix 中每格有实现、not-applicable 理由或 gate，不能 silent no-op。

退出：fresh/upgrade/backup/restore/doctor/maintenance/start/stop 在两个 provider 完整可用。

## 12. T7 — 一键迁移 engine

### T7-A operation control plane

- closed phase codec、manifest chain digest、checkpoint、owner lease/fence；
- idempotent start、duplicate request、stale takeover、late write、resume/cancel；
- operation state 独立于 source/target business DB；
- status projection 在业务 admission closed 时仍可读取。

### T7-B preflight/freeze/backup

- target version/permission/schema/encoding/collation/capacity/latency probe；
- source integrity/schema/codec/space/active-operation probe；
- writer admission close、HTTP/MCP/worker/scheduler/outbox/apply/maintenance drain；
- source generation high-water/fence 与 raw SQLite safety backup；
- 任一超时/失败重开 SQLite 或保持明确 maintenance 状态，不继续 copy。

### T7-C prepare/copy

- target baseline table/PK phase；
- per-table keyset chunk、canonical codec、COPY/bounded batch、transaction/checkpoint；
- bounded Worker/stream/backpressure/RSS；
- per-chunk source/target digest immediate verify；
- disconnect/retry/crash 不 duplicate/skip；
- source generation 一旦变化立即 fail closed。

### T7-D verify/cutover

- final constraints/index/sequence；
- table/root digests与业务 invariants；
- target read-only live runtime/representative queries；
- pointer atomic switch、boot composition、health；
- admission open、generation marker、late source writer rejection；
- pre-write rollback、post-write refusal、reverse migration requirement。

退出：从一次 Settings/CLI action 可自动完成；所有 phase crash/resume 后结果与 uninterrupted run 相同。

## 13. T8 — 六表归档与 schema 收缩

### T8-A live drop-proof

逐表重新证明十项：reader/writer/background/restore/migration/admin/FK-dynamic/user-capability/archive/approval。固定 allowlist：

1. `code_mr_leases`
2. `code_produced_mrs`
3. `code_artifacts`
4. `code_work_observations`
5. `code_fix_attempts`
6. `code_publish_intents`

任一项不为零/不满足就把该表退回 `DEFER` 并呈批；不得为了保持“六张”修改 consumer 或隐藏依赖。

### T8-B archive

- 每表 schema version、canonical row、stable order、chunk/root digest；
- row count、key min/max/coverage、blob bytes；
- legacy inspect/export command/query；
- artifact corruption/missing chunk/duplicate row mutation；
- archive receipt 与 source/operation/schema digest绑定；
- source SQLite/raw backup 保留，不执行 source `DROP TABLE`。

### T8-C target omit 与计数

- PostgreSQL baseline 不创建已通过 drop-proof 的六表；
- copy planner 对六表只 archive，不写 target；
- target schema presence mutation 必红；
- 其余表任一 absence mutation 必红；
- 报告分别给 logical active、archive-only、provider metadata、ORM metadata，不用含糊总数；
- 如果仅六表通过，source parity set=178；physical total 另报。

默认 SQLite 安装的 physical legacy 表不随本 RFC 自动破坏性 drop；若未来要压缩 active SQLite 文件，必须有同等级归档/回滚裁决，
不得借 PostgreSQL migration 顺手执行。

## 14. T9 — Settings/CLI 与用户旅程

- system-operations 定义唯一 migration command/query/status DTO；
- Settings/CLI 只做 adapter，same-command/same-receipt architecture gate；
- connection config 显示所有约束和 field errors，secret永不回显；
- preflight estimate、维护窗口、表分类/六表 archive 影响明确；
- progress 展示 phase/table/chunk/rows/bytes/ETA/checkpoint/error；
- resume/cancel/rollback/finalize 按服务器 capability/eligibility，不用 UI 自己猜；
- rollback horizon 与 first live write 醒目，不承诺永久一键回退；
- 390px、keyboard/focus、zh-CN/en-US、loading/empty/error/reload；
- 迁移 maintenance 中 status 页面/CLI 可用，业务页显示一致的只读维护状态；
- E2E 覆盖一次 click、duplicate click、reload/resume、failure、cutover、不可回滚、receipt/archive download。

退出：管理员不用手工执行建表/copy SQL/改 pointer；外部 PostgreSQL 与 env 配置仍是明确前置。

## 15. T10 — 完整验证

### T10-A functional

- SQLite full regression；
- PostgreSQL full regression；
- provider behavior oracle 全量 diff；
- fresh/upgrade/backup/restore/doctor/maintenance；
- Settings/CLI/API/E2E；
- architecture/canonical/schema/provenance gates。

### T10-B migration data matrix

- empty/minimal/full-seed/large production-shaped source；
- 184-table census、178 parity candidate、六表 archive；
- bigint/JSON/blob/null/collation/sequence/FK/cycle；
- table/chunk/root/business invariant mutations；
- cross-provider logical backup/restore。

### T10-C fault matrix

- every phase before/after checkpoint crash；
- process kill/restart、duplicate owner、stale lease、late receipt；
- target disconnect/timeout/deadlock/constraint/storage failure；
- manifest/chunk/pointer corruption；
- freeze/drain timeout；
- cutover crash、health fail、rollback race、first-write fence；
- cancellation at every allowed/forbidden phase。

### T10-D scale/compiled

- 100-client + full-seed SQLite/PostgreSQL normal-runtime soak；
- large migration 同时保持 status HTTP/WS event-loop responsiveness；
- report rows/bytes/duration/throughput/peak RSS/pool wait/status p95/max/event-loop gap/retry/error；
- Linux/macOS/Windows compiled binary 外连真实 PostgreSQL；
- 二进制环境移除/隐藏 `psql/pg_dump/postgres` 后 migration/runtime 仍绿；
- native runner-specific behavior 用对应 hosted runner，不以单平台替代。

退出：failed=[]、unfinished=[]；没有 retry-only、cancelled 或 unrelated containing run 冒充 exact candidate success。

## 16. T11 — Publication 与正式 closeout

### T11-A implementation publication

- fresh fetch，核对 main/origin、shared dirty/index/owners；
- 复用稳定 candidate 的成功 full gate，不因 unrelated HEAD 移动重跑；
- exact-path stage，核对 complete staged path/diff/message/contributors；
- commit message 添加所有实际 AI material contributor 的标准 `Co-Authored-By` trailer；
- push 前再次 fetch/sync，push 后 fresh fetch 验证 HEAD=origin/main、0/0、index；
- 只认 exact implementation SHA 的 Main CI + 所有适用 scheduled workflows terminal success。

### T11-B docs/canonical closeout

- verification report 固定 source/target/schema/artifact/implementation SHA；
- schema/canonical/provenance projector 与 committed artifact一致；
- RFC-294 §4.3 amendment 和实际 W9 子波次状态如实投影；
- proposal/design/plan、RFC index、STATE 更新 Done；
- 不倒签 RFC-294 全部完成，不覆盖 RFC-345/其他 owner 的在途事实；
- shared docs 若混有并行 WIP，收齐 ownership 后一次完整保留提交。

正式 Done 必须同时满足：生产实现已发布、remote ancestry 精确、exact-SHA hosted gates 全绿、自有 docs 与 shared status 已发布。

## 17. 批准检查表

实施前由用户确认：

- [x] D1 SQLite 默认，PostgreSQL server 外置
- [x] D2 Settings/CLI 同一个 durable one-click operation
- [x] D3 V1 自动维护窗口，不承诺零停机
- [x] D4 closed phases、single owner、resume/idempotency
- [x] D5 first-live-write 前后不同 rollback 语义
- [x] D6 RFC-294 transaction contract 修订
- [x] D7 双 dialect/双 migration history/单逻辑 contract
- [x] D8 schema 三态，不设目标表数
- [x] D9 首批只归档省略六张 legacy 表
- [x] D10 provider-neutral logical artifact
- [x] D11 strict data + business invariant verification
- [x] D12 provider-specific operations
- [x] D13 本 RFC 不冒领 multi-daemon
- [x] D14 exact dual-provider/migration/compiled/hosted evidence

任一项修改都先回填 proposal/design/plan，再决定是否授权实现。
