# RFC-392 统一测试入口：删除 `server.ts` 的 SQLite 测试路径，HTTP 组合迁入 `bootstrap/`（RFC-294 S2b）

- **状态**：Done（2026-10-21：`64dd81e8d`，主 CI `39660260202` 49/49 全绿；windows-platform 与 maintenance-soak 红归因 runner 变慢，见 `docs/audit-backlog.md`，
  后继证据：包含本提交的 `a1a37759e` 上 windows-platform `39681863726`、maintenance-soak `39681863659` 均 success）。2026-10-21 落档并派发 Codex 实施；RFC-391 的后继 CI `39638881400` 已确认 macOS。用户 2026-10-20「按你推荐继续推进」：
  由本会话设计、交 Codex 实施并审核，免设计门与实现门；规则取舍由本会话按推荐决定，见 §6）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b「移除 `deps.x ?? composeX(...)` 形态的测试回退」；
  design §10「测试经工厂图注入实例 port」）；前置 [RFC-390](../RFC-390-neutral-http-binding/proposal.md)、[RFC-391](../RFC-391-neutral-daemon-graph/proposal.md)
- **基线**：HEAD `b1799e6bc`（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：
  - `bootstrap/`：HTTP 组合 `composeProviderAppComposition`、开发用途根；
  - `server.ts`：只剩 provider 无关挂载表与请求管线；
  - 测试只经一个入口 `tests/helpers/providerHttpApplication.ts` 进入应用图。

## 1. 背景

RFC-391 之后，生产只有一张应用图（`bootstrap/daemonApplication.ts`），PostgreSQL 的测试 lane 也经它的 `unstarted` 相位装应用。
SQLite 测试 lane 仍走 `server.ts` 里一条生产已无调用者的路径，约 660 行：

- `composeSqliteApplicationDeps`：12 个 `deps.x ?? composeDaemonX(...)` 模块组回退，外加 12 个其他默认；
- `composeSqliteAppDeps`、`createApp(AppDeps)`；
- `AppDeps`：85 个字段，其中 24 个只在这里；
- `SqliteAppComposition`。

于是两条测试 lane 用两套装配，SQLite lane 与生产在多处不同：

- 身份事件与在线投影是空操作；
- 驱动释放收尾用 SQLite 专属函数；
- 不做托管选择准入；
- 21 个直接 `createApp` 的用例不做未启动期初始化。

RFC-294 要求「测试经工厂图注入实例 port」，并移除这类回退。

`composeProviderAppComposition` 留在 `server.ts`，原因只是这条测试路径还在用它。路径删除后，它与开发用途根可以迁入 `bootstrap/`，
`server.ts` 只剩 RFC-294 design §10.2 所说的「provider 无关挂载表」。

## 2. 目标

- **G1 一个测试入口**：`tests/helpers/providerHttpApplication.ts` 的两条 lane 合成一次 `composeDaemonApplication(…, { kind: 'unstarted', scope })` 调用。
  - 经 scope / topology / WS scope 间接使用它的约 212 个测试文件不改；
  - 直接 `createApp` 的约 23 个用例改走同一入口。
- **G2 删除测试路径**：`composeSqliteApplicationDeps`、`composeSqliteAppDeps`、`createApp(AppDeps)`、`SqliteAppComposition`、`AppDeps`
  及只为它们存在的类型、字段与导入。
- **G3 测试接缝收拢**：应用图的测试专用输入统一收进一个 `testSeams` 对象（原有 7 个 + 本 RFC 新增 3 个），生产从不传入（结构锁）。
  图与模块组里只服务测试的默认值、无人传入的死接缝一并删除。
- **G4 HTTP 组合迁入 `bootstrap/`**：
  - `composeProviderAppComposition` 及其私有助手迁入独立的 `bootstrap/` 文件（不并进应用图文件）；
  - `composeDevelopmentPurposeRoot` 迁入 `bootstrap/`；
  - 开发用途类型迁入 development-automation 的 composition（`cli/start.ts` 需要它，又不得导入 `bootstrap/`）。

## 3. 非目标

- 入口根瘦身、`StartOptions` 类型化、`cli/` ↔ `bootstrap/` 互依：S2c。
- 改变任何生产行为、路由面或 API。
- 安全相关改动。

## 4. 用户可见变化

无。只改测试的装配方式与代码落位。SQLite 测试 lane 从此与生产同图，所以若干测试会观察到与生产一致的行为：真实身份事件、托管选择准入、
未启动期初始化等。

## 5. 验收标准

- **AC-1 一份装配**（结构锁）：
  - 被删符号不存在；
  - `server.ts` 不调用任何模块组工厂、无 `deps.x ??` 回退、不含 HTTP 组合函数；
  - 测试入口只调用一次 `composeDaemonApplication`；
  - 生产（会话图）调用应用图时不传 `testSeams`。
- **AC-2 行为**：既有双引擎 HTTP 用例全部通过，不改断言意图；路由面一致性守卫（双 lane）照常通过；本 RFC 改写的用例保持原断言意图。
- **AC-3 账本**：
  - commons-debt 双向精确；
  - RFC-380 / 390 / 391 守卫、t19b / t19c / t19f、void-promise、适配器下限、`BOOTSTRAP_FILES`、guard-manifest 同提交修订；
  - TP-08（`AppDeps` 上帝对象）销账；
  - `architecture/counts.json` 不升。
- **AC-4 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、windows-platform、e2e 三平台）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **新增三个测试接缝，并把全部测试输入收进 `testSeams`**：
   - `codeHostFetch`：rfc269、rfc321 用来替身外部代码托管请求，转发到仓库凭据组与 HTTP 的 `codeHostRuntime`；
   - `webhookTerminalControl`：rfc300 用，转发到集成组已支持的 adapter；
   - `systemOperations`：rfc370-m3、rfc370-v3 用，覆盖核心组的系统运维实例。

   这符合 RFC-294「测试经工厂图注入实例 port」，并保留这些用例的原意。结构锁保证生产不传。
2. **`rfc370-m2-inventory-read-content`**：托管库存读取只在 PostgreSQL 跑（托管部署只跑 PostgreSQL）；SQLite 改为断言该托管选择被拒绝，准入覆盖不丢。
3. **TP-08 销账**按账本既有约定；约定表达不了后继 RFC 时，做保持双向精确的最小扩展。
4. **开发用途类型落在 development-automation 的 composition**：`cli/start.ts`、模块组与应用图都已导入它，不新增边；函数本身迁入 `bootstrap/`。
5. **一并删除死接缝与测试默认值**：模块组里只为测试路径存在或无人传入的接缝；应用图里只服务测试的默认（`log`、配置绑定、`sourceWriteWindow` 等）
   改为必填，生产本就总是传入。
6. **应用图不交出 `ComposedAppDeps`**：用到它的两处断言改写为对挂载后路由与核心组的断言。
7. **一个 RFC、两组顺序任务**（先统一入口并删测试路径，再迁 HTTP 组合）、一次集中验证：两组有 16 个测试文件重叠，并共用 RFC-380 / 390 守卫。
8. **部署形态默认改为必填**（审核补正）：`server.ts` 里两处 `?? 'standalone'`（请求管线的 `deploymentMode`、`createComposedApp` 取
   `executionAuthority?.mode`）原样保留会让 AC-1 需要白名单。应用图本就总是传入执行权，两处改为必填输入；RFC-376 的
   `deployment-mode-branch-sites` 随之 8 → 6，`architecture/counts.json` 同步下调。生产行为不变。
9. **偏离项**：无。
