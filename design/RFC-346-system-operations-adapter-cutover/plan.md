# RFC-346 实施计划：System Operations 管理编排与 adapter cutover

状态：Done（2026-08-30；T0～T6、AC-1～AC-12、canonical 与 exact-SHA hosted closeout 已完成）

- 开工 source pin：`625017c084db2f7eb6c9ec34c87eba41ffaf04cd`
- additive / CLI implementation：`4a1c739351f27847ffb3554869e7f613ab8e1eef` →
  `ce7d9fbf541208b00b9d52d221058f0387a15ae3` → `4c349cf068d38f6842469ba565b4aedd6961b41c`
- descriptor / alias cutover：`572d01e0c50b3d8401bf9a317c317b5fd4b5b008`
- hosted contract repair：`dffe9bc836d87a2433153a3b2e8a8efc8cf17b95`
- final functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`
- canonical source digest：`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`

## 0. 执行纪律

- RFC-344 / W4-A 与 RFC-345 / W4-C 由其他 session 落地；本 RFC不改、不提交其 owned files。
- D1～D12、实现、提交与 push 已于 2026-08-30 获用户明确批准。
- 批准后也分 Cohort A/B：RFC-344 hosted closeout 前只做 additive module/legacy adapter/CLI；HTTP/catalog/root/canonical 等待 closeout。
- 每次开工、提交、push 前 fetch + compare `origin/main...main`；只在现有 shared `main`，不用 branch/worktree/stash/rebase/reset。
- Git publication 使用精确 path allowlist，index 非空或出现未知 staged path即停。
- 生产改动必须带测试；最终只认 published exact-SHA GitHub Actions。

## 1. Dependency DAG

```text
T0 current pin + D1-D12 approval
  -> T1 public contracts/domain/ports
      -> T2 application + legacy platform adapters
          -> T3 CLI cutover + parity

RFC-344 hosted closeout + T2
  -> T4 catalog alias + HTTP descriptor/root cutover
      -> T5 canonical exact ownership/debt closeout
          -> T6 publication + exact-SHA hosted closeout

T3 and RFC-344 closeout may run in parallel.
RFC-345 is independent and never a file dependency.
```

## 2. T0 — Baseline、决策与 ownership lock

**前置**：无。

- [x] 用户明确批准 proposal D1～D12；
- [x] fetch 后记录 source SHA、`origin/main...main`、status、cached paths；
- [x] 确认 RFC-346 编号/路径唯一；
- [x] 记录四条 HTTP compatibility ids、2 个 AppDeps consumers、2 个 CLI、1 个 RFC-295 compatibility command；
- [x] 锁 current REST/CLI success/error/status/body/exit-code fixtures；
- [x] 记录 RFC-344/345 session 的 owned files 与禁止改动面；
- [x] 建 exact RFC-346 source/debt ledger，不把 maintenance/doctor/migrate 宽归类当事实。

**退出门**：D1～D12 已批；candidate baseline 可复跑；无生产修改。

## 3. T1 — Additive domain/public contracts/ports（Cohort A）

**前置**：T0。

- [x] 新建 `modules/system-operations/domain/{backup,recovery}.ts`；
- [x] 新建 `public/{commands,queries,types}.ts`，仅导出 D2 exact surface；`public/operations.ts` 明确留 T4；
- [x] 新建 `application/ports/{adminBackupCoordinator,adminRestoreCoordinator}.ts`；
- [x] 建 command/query input/output strict codecs；本批不定义 operation descriptor、不 import `platform/operations/*`；
- [x] 定义 HTTP current authority 与 bootstrap-local context 的 closed usage；
- [x] tests 锁 export allowlist、codec、DTO/port taint 与 fake coordinator behavior；
- [x] source guard：domain/public/application 不得 import DB/FS/Hono/CLI/Actor/Paths/legacy services。

**Owned files**：只新增 `modules/system-operations/**` 与 `tests/rfc346-system-operations-contracts.test.ts`。

**退出门**：contracts 有 fake consumer 且测试可执行；production wiring 仍为零；RFC-344/345 文件零改动。

**回滚**：删除 additive module/tests；无 runtime/schema 影响。

## 4. T2 — Application handlers 与 legacy platform adapters（Cohort A）

**前置**：T1。

- [x] 实现 request/plan/stage/cancel/activate/status application handlers；
- [x] 新建唯一 `legacyPlatformRecoveryAdapter`，封装现有 backup/restore/pending mechanism；
- [x] 新建 composition-owned artifact ingress + runtime registry；HTTP upload / CLI path 只产生可校验、可 release 的 opaque ref，
      ingress 不成为 application required port；
- [x] backup 顺序锁 credential preparation → exactly-one createBackup；
- [x] restore artifact ingress 只向 application 返回 branded ref；`noSafetyBackup/noMigrate/skipIntegrityCheck` 全量透传，
      display path/dir 不作为 effect input；
- [x] status/cancel 不接受 arbitrary path；pending operation 由 adapter current state 决定；
- [x] cold activate 保留 pid/lock/plan/restore/finally release 顺序；
- [x] adapter exception ledger 标 `removeWave=W9-E`；scheduled backup、boot apply 与 legacy mechanism consumer保持；
- [x] fault/mutation tests 覆盖 preparation fail、validation fail、pending conflict、lock race、post-swap throw、artifact release。

**Owned files**：`modules/system-operations/**`、`tests/rfc346-system-operations-adapter.test.ts`。

**退出门**：application 可由 fake/legacy adapter执行全部 use case；无 route/server/catalog 改动；无 double effect。

**回滚**：移除 adapter wiring；legacy services 未改、可继续工作。

## 5. T3 — CLI typed cutover 与 RFC-295 sunset ledger（Cohort A）

**前置**：T2；确认 CLI files 无其他 session owner。

- [x] `cli/backup.ts` 改由 local system-operations composition 执行；
- [x] `cli/restore.ts` 只保留 argv decode + output/exit projection，plan/stage/activate 走 typed handler；
- [x] `main.ts` command names与 exit mapping保持；无必要不修改；
- [x] old-vs-new golden 覆盖全部 flags、usage、plan/refusal/stage/lock/complete/error；
- [x] `downgrade-audit rfc-295` 保持 direct readonly SQLite；新增 exact compatibility/sunset ledger 与 zero-write guard；
- [x] 证明 CLI 不构造 current Actor，HTTP context 不进入 local cold restore；
- [x] 既有 RFC-213/RFC-295 tests 保持。

**冲突面**：`cli/backup.ts`、`cli/restore.ts`；若另 session 正修改同一文件则停并协调，不另造替代入口。

**退出门**：2/2 CLI 调 typed application；输出/exit wire无差异；RFC-295 behavior无差异；HTTP仍可保持 compatibility。

**回滚**：CLI binding切回 legacy adapter；module保持 additive；无数据回滚。

## 6. T4 — RFC-344 后的 operation alias 与 HTTP descriptor cutover（Cohort B）

**前置**：T2 + RFC-344 published exact SHA 的 Main CI/要求的 scheduled workflows terminal success。

- [x] fetch/sync并 re-pin RFC-344 current catalog source；合同变化已按 published exact public contract重新对齐；
- [x] 新建 `public/operations.ts` 与四个 primary descriptor，使用 RFC-344 exact contract；
- [x] 增最小 `OperationAlias`，一跳/一对一/same-kind/same-major/no-handler；
- [x] alias duplicate/unknown/stale/cycle/chain/wrong-kind/one-to-many 全部负向；
- [x] 4 个 `legacy-http.*` 显式 alias 到 4 个 `system-operations.*.v1` primary descriptors；
- [x] `routes/backup.ts` / `routes/restore.ts` 改用 `registerOperationRoute` 与 system-operations typed handles；
- [x] multipart parse/缺 field继续由 inbound mapper保留 exact 400；artifact ingress 后 descriptor只见 ref；
- [x] `createApp/mountApiRoutes` 只 composition 一次 module，HTTP/MCP 不重复；
- [x] route 不再 import AppDeps/DB/FS/Paths/migration resolver/legacy services；
- [x] 4 route old-vs-new golden + catalog startup closure；
- [x] `legacyHttpAdapter` for exact four `4→0`，E7 AppDeps consumer `2→0`。

**冲突面**：`platform/operations/*`、`routes/{backup,restore}.ts`、`server.ts`、RFC-344 catalog tests。进入短文件 ownership window；
RFC-344 session仍在写则等待，不并发落这些文件。

**退出门**：四条 HTTP primary descriptor production-bound；aliases只解析到同一 handler；无 second handler/root；wire parity全绿。

**回滚**：一次性把 binding切回 compatibility；禁止同时保留 descriptor与legacy effect handler。

## 7. T5 — Canonical ownership、debt transfer 与架构门

**前置**：T3 + T4。

- [x] `targetContextFor` 对 system-operations 改 exact mapping；宽 `maintenance|doctor|migrate` 归类不再作为事实；
- [x] maintenance/background、task/workspace cleanup、doctor aggregate、migrate/db compact 各回真实 owner/机制层；
- [x] 注册 module public surfaces、required ports、authority type-only edge、production consumers；
- [x] 注册四条 alias、四条 primary descriptor、AppDeps/legacy adapter归零结果；
- [x] legacy backup/restore/pending/scheduler/worker/boot apply/cross-domain restore mechanics 转交 W9/W9-E exact ids；
- [x] RFC-295 direct scanner 登记 exact compatibility/sunset；
- [x] architecture write 后核对全部 generated payload、denominator delta、source digest 与 foreign keys；
- [x] negative mutation：给 system-operations 加 RunMaintenance/DB/path/callback/registry、把 doctor/migrate归入模块、删 W9 debt 任一项均红。

**退出门**：canonical/live source双向相等；只领取 W4-E7 admin adapter credit，不领取 W9-E、maintenance或整个 W4 credit。

## 8. T6 — 文档、publication 与 hosted closeout

**前置**：T5。

- [x] proposal/design/plan 勾选实际完成项并更新 source/behavior/canonical/published SHA 分栏；
- [x] RFC-294 W4-E7、`design/plan.md`、`STATE.md` 的共享 closeout 已明确交回协调 session；因其含 RFC-347 foreign hunks，
      RFC-346 own docs-only commit 不 stage这三条共享路径；
- [x] publication 前 fetch/compare、确认 shared index empty、exact-stage owned allowlist、检查 staged diff/path；
- [x] commit message与 trailers描述所有 material content/contributors；
- [x] push 前再次 fetch/compare，安全同步；push后验证 remote ancestry；
- [x] published exact SHA `7ede76a8` 的 Main CI 与 8 个 scheduled workflows全部 terminal success；
- [x] hosted failures按 owning test/path修复；最终候选内容与 evidence已更新；
- [x] canonical provenance 与 RFC-owning docs最终指向同一发布事实，RFC-346 标 Done。

**退出门**：local/remote exact sync；hosted exact-SHA全绿；无已知未登记 E7 debt；RFC-346只关闭 RFC-294 W4-E7。

## 9. Acceptance checklist

- [x] AC-1 exact module/public/port boundary
- [x] AC-2 four descriptor primary + four one-to-one aliases; legacy adapter 4→0
- [x] AC-3 HTTP/Settings wire parity
- [x] AC-4 route AppDeps/DB/FS/service imports 2→0
- [x] AC-5 CLI behavior parity
- [x] AC-6 exactly-one backup preparation/effect
- [x] AC-7 boot pending apply order unchanged
- [x] AC-8 W9/W9-E legacy mechanism debt complete
- [x] AC-9 RFC-295 readonly compatibility + sunset ledger
- [x] AC-10 maintenance/doctor/migrate/GC/readiness exclusions
- [x] AC-11 zero schema/config/surface change + existing regression suites
- [x] AC-12 published exact-SHA hosted closeout

## 10. Planned implementation allowlist

### RFC draft only

```text
design/RFC-346-system-operations-adapter-cutover/proposal.md
design/RFC-346-system-operations-adapter-cutover/design.md
design/RFC-346-system-operations-adapter-cutover/plan.md
STATE.md
design/plan.md
design/RFC-294-backend-layered-target-architecture/plan.md
```

### Production Cohort A

```text
packages/backend/src/modules/system-operations/**
packages/backend/src/cli/backup.ts
packages/backend/src/cli/restore.ts
packages/backend/tests/rfc346-*.test.ts
```

### Production Cohort B

```text
packages/backend/src/routes/backup.ts
packages/backend/src/routes/restore.ts
packages/backend/src/server.ts
packages/backend/src/platform/operations/catalog.ts
packages/backend/src/platform/operations/contracts.ts
packages/backend/tests/rfc344-operation-catalog.test.ts
packages/backend/tests/architecture/rfc294Canonical.ts
architecture/*.json
```

每次提交前把 glob 展开为 exact path list；未实际修改的文件不进入 allowlist。共享 docs/canonical files 若含 344/345 的并发输出，必须
原样保留并在 handoff 明示，绝不为拆提交回退其 hunks。

## 11. 用户批准记录

- [x] D1 E7只拥有 backup/restore/recovery diagnostic 管理编排
- [x] D2 四类 command、两类 query exact surface
- [x] D3 两个窄 coordinator ports；artifact ingress 是 composition-owned inbound/platform capability
- [x] D4 legacy mechanism adapter-first，W9-E再替换
- [x] D5 REST/CLI/Settings wire完全兼容
- [x] D6 HTTP current context 与 CLI local context分离
- [x] D7 multipart/path 在 inbound/platform adapter 消化
- [x] D8 四个 legacy operation ids一对一 alias到 primary descriptors
- [x] D9 boot pending apply不经在线 command
- [x] D10 RFC-295 direct readonly audit保持 + sunset ledger
- [x] D11 canonical exact owner mapping，排除 maintenance/doctor/migrate宽吞
- [x] D12 RFC-344 closeout前后分 Cohort A/B；RFC-345路径零触碰

## 12. Hosted evidence

最终 functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`。RFC-346 implementation / repair commits 均为其
祖先；以下 9 条 clean-checkout workflows 全部 `COMPLETED / SUCCESS`：

| Workflow             | Run           |
| -------------------- | ------------- |
| Main CI              | `33317698270` |
| e2e-full-nightly     | `33317736186` |
| e2e-webkit-nightly   | `33317732124` |
| evidence scenarios   | `33317735982` |
| git protocols E2E    | `33317735272` |
| integration OpenCode | `33317735322` |
| maintenance soak     | `33317735048` |
| visual regression    | `33317735095` |
| Windows platform     | `33317734896` |

Main CI backend 8/8、三平台 Playwright、required rollup 全绿；scheduled suites `failed=[]` / `unfinished=[]`。因此 T6 与
AC-12 已闭合。RFC-346 只关闭 RFC-294 W4-E7，不关闭 W9-E 或其他 W4 子波。
