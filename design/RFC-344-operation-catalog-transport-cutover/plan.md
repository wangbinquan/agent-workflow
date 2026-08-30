# RFC-344 实施计划 — OperationCatalog 与 transport cutover

状态：Approved / Implementation candidate（2026-08-30）；D1～D10、完整实施与提交上库已获批准，等待 canonical/publication 与
published exact-SHA hosted closeout。

Current-source pin：`fa244b0319581efc6aad3f3f216b917278fc17f7`。

## 0. 批准与完成口径

- [x] 已确认 RFC-341/W3、RFC-342/P0-A、RFC-343/P0-B 的 exact-SHA hosted/scheduled closeout；
- [x] 已按 RFC-294 §3.2 启动 W4 current-source 调研并建立独立 successor；
- [x] 用户明确批准 RFC-344 D1～D10、完整实施与提交上库；
- [x] RFC-294 的目标裁决与本 RFC 不冲突；compatibility HTTP debt 明确保留给 W4-B/C/E；
- [ ] AC-1～AC-12、published exact SHA、Main CI 与定时 workflows 全绿后，RFC-344/W4-A 才能 Done。

本 RFC 允许多个小 cohort commit，但不允许用中间基础设施提交提前宣称 W4-A 完成。每个 cohort 都采用 exact-path staging、独立
rollback point 与 shared-main publication critical section。

## 1. Baseline

| 指标/事实                          | current |                                                               本 RFC exit |
| ---------------------------------- | ------: | ------------------------------------------------------------------------: |
| HTTP declared routes               |     472 | 全部有 stable operation identity；共享/目标 cohort 无 legacy handler debt |
| MCP tools                          |      52 |  52/52 属 direct、parameterized、composite 或 local-introspection binding |
| RFC-329 no-tool exemption leaves   |     380 |                         保留 exact、只按真实产品 surface 变化；不要求归零 |
| MCP 约覆盖 route leaves            |      92 |                 全部经 catalog operation dependency，不经 HTTP dispatcher |
| `AppDeps` consumer files           | 53 → 48 |                             本 RFC cohort 只减不增；剩余逐条保留 W4 owner |
| route→DB edges                     |      15 |                                   本 RFC不冒领归零；仅 pilot route 不新增 |
| transport→DB edges                 |       2 |                                    本 RFC不冒领 W4-B；目标 binding 不新增 |
| `mountApiRoutes` 内 assembly calls | 14 → 13 |                       完整 W4-D 前可仍为 13，但每进程只执行一套 REST root |
| backend value SCC                  |   4 → 3 | 删除包含 `mcp/dispatch.ts`/`mcp/server.ts`/`server.ts` 的一组；其余不回归 |
| services→routes edge               |   1 → 0 |                                        API docs 已改读 catalog projection |

数字来自 current `architecture/current-report.json`、`architecture/e2e-endpoint-coverage.json`、RFC-329 ledger 与生产源码；实现开始前
fresh fetch 后重新采集，漂移只更新 source census，不静默改裁决。

## 2. 任务

### T0 — RFC / current-source（Approved candidate complete）

- [x] 对照 RFC-294 W4-A/W4-D 与 current RouteMeta/MCP/API docs/AppDeps composition；
- [x] 读取 RFC-329 route/tool/exemption guard，区分 inventory 与 production binding；
- [x] 分类 direct、parameterized、composite 与 local-introspection MCP tools；
- [x] 选择 identity-access user HTTP/CLI 与 development mission/config/activity HTTP 作为 pilot；
- [x] 写 proposal/design/plan、`design/plan.md` 索引与 `STATE.md` In Progress 状态；
- [x] 获得用户对 D1～D10、完整实施与提交上库的明确批准。

### T1 — Neutral contracts 与 catalog self-check

**前置**：用户批准。

- [x] 新增 RFC-294 closed descriptor union、stable operation id 与 versioned exact codec contracts；
- [x] 新增 HTTP/direct MCP/parameterized MCP/composite MCP/local-introspection contracts；identity CLI 直接持 typed descriptor；
- [x] bootstrap 收集并 freeze catalog，不导出 generic runtime service locator；
- [x] duplicate/unknown/stale/kind-context mismatch/publicReason/idempotency/selector/dependency 自检；
- [x] 采集 472 route、52 tool、380 exemption 的 exact inventory；
- [x] 每条未迁 route 生成 stable `legacy-http.*` + `legacyHttpAdapter` debt，禁止 prefix/default/group exemption；
- [x] source locks 与 negative fixtures 覆盖“类型存在但未接生产入口”。

**退出门**：catalog 可在零业务切换下完整描述 current surface；新增未登记 route/tool 或假 operation 会红；生产行为不变。

**回滚**：整批删除 additive contracts/catalog；无 schema/wire 变化。

### T2 — Public error 与 projection kernel

- [x] 把现有 closed public error category 接到 descriptor declared subset；
- [x] 建同一 handler 经 HTTP/direct operation 的 404/409/410/412 exact status/body golden；
- [x] undeclared category 变为 contract violation，由既有 error boundary 外投 `internal-error`；
- [x] descriptor input/output codec 在 invoke 前后各校验一次；
- [x] HTTP decode/encode 与 MCP operation-input projection 不含 DB/业务 branch；CLI 只做 argv/presentation。

**退出门**：相同 operation/input 的 success DTO 或 public error code/details 相同；private cause 不进入 wire。

### T3 — Identity-access HTTP/CLI pilot

- [x] 为现有 user public commands/queries 建 descriptors；
- [x] HTTP user routes 改收 binding handles，并保持现有 endpoint/status/body；
- [x] `cli/user.ts` 改走相同 operation handles；first-admin 保持显式 bootstrap-only participant；
- [x] route/CLI 不再自行重组 identity-access legacy service；composition 只在各自 process edge；
- [x] existing HTTP/CLI corpus + descriptor codec/error/parity source locks；
- [x] target deep import 与 `AppDeps` consumer 账本递减。

**退出门**：user HTTP/CLI 同一 handler/codec/error contract；用户功能与输出零变化。

**回滚**：整个 user cohort 回到旧 binding；不能双 handler active。

### T4 — Development mission/config/activity HTTP pilot

- [x] 从 current route inline/deep imports 提取最窄 public operation contracts；
- [x] 为 mission/config/activity current endpoints 建 descriptor/binding；
- [x] route 只 decode/call/encode，不 import module infrastructure/domain/engine/composition；
- [x] 保持 mission effect/recovery/worker 与 existing wire；不领取 W4-E8/W5 完成；
- [x] existing current success/error/ordering corpus继续覆盖；top-level codec 与 source locks锁住新边界。

**退出门**：目标 route 只依赖 module exact public operation + transport concerns；现有产品流程零变化。

### T5 — MCP direct operations

- [x] 以 RFC-329 mapping 为 characterization，把 direct read tools 切到 binding-scoped operation handles；
- [x] direct mutation tools 同步切换，继续执行同一 route gate/handler/audit snapshot；
- [x] RFC-247/RFC-329 corpus + RFC-344 error golden锁 same-handler parity；
- [x] direct tool 不再构造 URL/method 或调用 dispatcher；
- [x] business tool legacy HTTP dispatch debt 已归零，compatibility route debt不冒充 W4-B 完成。

**退出门**：所有 direct tools 只经 catalog invoke；HTTP/MCP handler identity 可由 source lock 证明。

### T6 — Parameterized / composite MCP

- [x] `resource_read/resource_write` 使用 closed selector→operation table；
- [x] selector union、case table、RFC-329 route leaves 三向穷尽；
- [x] `watch_task` 等 composite tools 显式 dependencies、binding-scoped typed handles 与 progress/audit；
- [x] `describe_resource` / `describe_capabilities` 作为无业务 route 的 local-introspection binding；
- [x] undeclared dependency access、wildcard/default URL fallback mutation 会红；
- [x] replay/cancel/progress/aggregation 行为保持。

**退出门**：52/52 tools 有生产 binding；MCP handler 对 Hono dispatcher 的调用=0。

### T7 — RouteMeta/docs derivation 与 duplicate root extinction

- [x] `registerOperationRoute` 从 descriptor + HTTP binding 派生 RouteMeta；legacy route 显式登记 compatibility projection；
- [x] MCP tool presentation/permissions 与 exact binding 一次登记，catalog 校验 admission/dependency closure；
- [x] API docs 直接读 frozen catalog projection，`services → routes` edge=0；
- [x] 删除 MCP private Hono/lazy `mountApiRoutes`/`mcp/dispatch.ts`；
- [x] 删除三文件 SCC，development automation/identity composition 每 daemon 一次；
- [x] legacy tool HTTP dispatch debt=0，unknown/stale binding=0；
- [x] 保留 380 条 HTTP-only reason ledger，不凭空新增 MCP surface。

**退出门**：RFC-344 AC-1～AC-11 全部成立；W4-D 只关闭 duplicate-root residual，53 个 AppDeps 全量归零仍未宣称。

**回滚**：删除 private Hono 前按 cohort 回滚；删除后只 forward-fix。

### T8 — Publication / hosted closeout

- [x] backend typecheck、exact ESLint 与 architecture read-only report 已绿；最终 Prettier/diff-check 在 source freeze 后重跑；
- [ ] 按用户约定不把本地 Bun test/E2E/full gate 当最终依据；
- [ ] canonical generator 只在 publication critical section、全 source 稳定后由单一 owner运行；
- [ ] exact-stage，核对 staged allowlist/diff/message/真实 co-author trailers；
- [ ] 用户授权后 commit/push，fresh fetch 验证 `HEAD=origin/main` 与 divergence 0/0；
- [ ] 跟踪 published exact SHA 的 Main CI、三平台 E2E 与项目要求的定时 workflows；
- [ ] 全部 terminal success 后更新 RFC-344 三件套、RFC-294 W4-A、`design/plan.md`、`STATE.md` 为 Done。

## 3. 预计源码范围

最终 exact allowlist 在每个 cohort 开工前按 fresh source 固定；当前预计只涉及：

- neutral contracts/catalog/bootstrap：`packages/backend/src/platform/operations/**`、新的 bootstrap catalog composition；
- HTTP binding/registry/docs：`packages/backend/src/routes/**`、`packages/backend/src/services/apiDocs.ts`、`packages/backend/src/server.ts`；
- MCP：`packages/backend/src/mcp/tools.ts`、`packages/backend/src/mcp/server.ts`、最终删除
  `packages/backend/src/mcp/dispatch.ts`；
- identity pilot：`packages/backend/src/modules/identity-access/public/**`、`packages/backend/src/routes/users.ts`、
  `packages/backend/src/cli/user.ts`；
- development pilot：`packages/backend/src/modules/development-automation/public/**`、
  `packages/backend/src/routes/developmentConfig.ts`、`developmentMissions.ts` 及 activity owning route；
- focused contracts/parity/source-lock/census tests。

任何 schema/migration、worker/committed-event、architecture JSON、其他 bounded-context implementation 文件都不是默认 allowlist；若实现
证据要求扩面，先回报精确路径与原因。

## 4. 冲突面与并发纪律

- `server.ts`、route registry、MCP tools/server、API docs、identity/development public entrypoints 是本 RFC 的高冲突面；
- architecture canonical JSON 只在 source 全提交后的单 owner publication 临界区生成，开发阶段不手改；
- 共享 `design/plan.md` / `STATE.md` 与 RFC-294 plan 在 closeout 前先协调；
- shared index 非空、remote advance、blocking dirty path 或 overlapping edit 均停止 Git mutation并协调，不使用 stash/reset/rebase/worktree；
- 每个 session 只 exact-stage owned paths，不运行并发 commit/push。

## 5. W4 后续关系

- RFC-344 Done 只关闭 W4-A 与 W4-D duplicate-root residual；
- W4-E0 可信 current/delegated context 全域切换可在本 RFC catalog 基础上另立 successor；
- W4-B 继续负责 15 个 route→DB vertical slices；
- W4-C 负责 Resource Catalog；
- W4-D 后续继续收缩 53 个 `AppDeps` consumer 与 bootstrap composition；
- W4-E 各 bounded context 仍逐域呈批，不因 operation id 或 descriptor 存在而自动 Done。
