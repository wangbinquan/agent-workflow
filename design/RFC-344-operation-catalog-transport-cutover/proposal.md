# RFC-344 — OperationCatalog 与 transport cutover（RFC-294 W4-A）

- 状态：Done（2026-08-30；D1～D10、AC-1～AC-12、canonical 与 exact-SHA hosted closeout 已完成）
- 开工 source pin：`fa244b0319581efc6aad3f3f216b917278fc17f7`
- core cutover / stabilization：`1f6edeb3d0399bf89a957e50d1643fd3dcf9c6cc` →
  `4e49626a3c6fc499ba0dd71642bb262a42283526`
- architecture convergence / hosted repairs：`593e760dbc4ba4ddac5dd7ec3831b2181f4b4c86` →
  `765de8b5ff6d61c72cd126fe62172ce761fa9638` → `107596c430f29a0fbcfee83ad93f7d6eaacbb993` →
  `baeb34431bb00470b2ca036fa103071afa440f7f`
- final canonical snapshot / source digest：`249a0d3f71dcc193cf18f1d7fb1663b79c2a88f5` /
  `sha256:0ff3f9655ff5f6c38bd5a922111dc96f586a64993ae4860248a2d8e3b3b0d3ad`
- published implementation exact SHA / Main CI：`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` /
  `33298828254`（terminal success）
- 前置：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W0-R/W3、
  [RFC-329](../RFC-329-mcp-gate-surface-completion/proposal.md)、
  [RFC-341](../RFC-341-lifecycle-committed-events-collaboration-commands/proposal.md)
- 归属：RFC-294 W4-A；只领取 W4-D 的“移除 MCP 第二套 Hono”交叉退出项，不领取 W4-B/C/E 或完整 W4-D
- 授权边界：用户已明确批准 D1～D10、完整实施与提交上库；在 AC-12 闭合前仍不得标记 Done

## 1. 摘要

当前 HTTP、MCP、CLI 与 API docs 没有共同的 application operation 单一事实源：

- 472 条已声明 HTTP route 由 `RouteMeta` 保存 method/path/permissions/public reason/token access/summary，但没有稳定
  `operationId`、exact input/output codec、public error 闭集或 transport-neutral invoke；
- 52 个 MCP tool 自己保存 schema、权限与 handler，通过 `mcp/dispatch.ts` 再挂一套完整 Hono app；
- RFC-329 已精确登记 380 条“无 MCP tool”route leaf，并证明现有 tool 大约覆盖其余 92 条 route leaf，但它只是一张动态调用后
  推导出的对照账，不是生产 binding；
- `services/apiDocs.ts` 分别读取 route registry 与 `ALL_TOOLS`，形成现存唯一 `services → routes` 边；
- `mountApiRoutes` 内仍有 14 次 module/store composition，并因 REST app 与 MCP 私有 app 被执行两次；
- 53 个 route/MCP 文件仍消费全局 `AppDeps`；当前 backend value SCC 之一恰为
  `mcp/dispatch.ts ↔ mcp/server.ts ↔ server.ts`。

本 RFC 建立 closed `OperationCatalog`：每个业务 operation 由模块提供 typed command/query、exact codecs、admission 与 public error
闭集；HTTP/MCP/CLI binding 只投影协议字段并调用同一 invoke。MCP 的 direct、参数化、composite 与仅提供 catalog introspection 的
local 四种真实形状分别建模，全部移除对第二套 Hono 的依赖。RouteMeta 与 API docs 从 operation/binding projection 读取，不能再由
docs 反向 import route/tool registry。

这是一项 transport/application seam 的功能保持迁移，不增加端点、工具、权限、角色、产品流程或 wire 字段。

## 2. Current-source 结论

### 2.1 已有可复用资产

- `routes/registry.ts` 已提供统一 HTTP 注册入口、permissions AND、`publicReason`、`tokenAccess` 与启动自检；
- identity-access 已有 branded `CommandContext` / `QueryContext` / `IdempotentCommandContext` 与可信 context factory；
- `platform/errors/publicError.ts` 已有 closed public error DTO 与未知错误降为 `internal-error` 的基础实现；
- RFC-329 已给出 route/tool/exemption 的 exact inventory 与 unknown/stale 双向检查；
- RFC-341 已给出 committed fact、durable delivery 与 transport projection 的成熟范例；
- user-access 已有 public commands/queries，适合作为 HTTP/CLI 同 operation pilot。

### 2.2 仍未解决的结构问题

1. `RouteMeta`、MCP tool、CLI command 与 API docs 各自声明一部分相同事实，无法静态证明同一业务操作的权限、schema、handler 与错误
   映射一致。
2. MCP 通过 URL/method 调第二套 Hono 来“复用”HTTP，实际复用的是 transport stack，不是 application use case；它也导致 module
   composition 重复与三文件初始化环。
3. `resource_read/resource_write` 是按 closed discriminant 选择多条 route 的参数化工具；`watch_task` 等工具是多 operation
   orchestration。把所有 tool 强行伪装成一条 route 会丢失真实语义。
4. user-access 的 HTTP 与 CLI 仍各自构造依赖/调用 legacy service；development mission/config/activity route 仍深导入 application、
   infrastructure、domain、engine 与 composition。
5. RFC-329 的 380 条 exemption 只回答“为什么没有 MCP tool”，不能回答“由哪个 operation、codec 与 handler 拥有”。

## 3. 目标

- 建立 stable、closed、启动时自检的 `OperationCatalog`，operation id 成为 HTTP/MCP/CLI/docs 的共同 join key；
- authenticated command/query 统一走可信 context factory；credential auth、verified ingress、bootstrap admin、public liveness 保持
  RFC-294 定义的 exact context kind，不伪装成普通 Actor；
- shared HTTP/MCP operation 使用同一个 invoke、input/output codec、public error set 与 permissions AND；
- 参数化 MCP tool 使用 closed selector 显式映射 exact operation ids；composite tool 显式列出并调用 typed operation dependencies；
- API docs、RouteMeta 与 MCP presentation 统一登记到 operation/binding projection；descriptor-backed surface 的 codec/admission 只声明
  一次，兼容 surface 的既有 schema 在同一 catalog 闭包中校验；unknown operation/binding/schema/error fail closed；
- 移除 MCP 私有 Hono app、`mcp/dispatch.ts` 与对应 backend SCC；每个模块只在进程 bootstrap 装配一次；
- 把 user-access HTTP/CLI 以及 development mission/config/activity inbound surface 接入 catalog；
- 保持所有现有 REST/MCP/CLI 输入、输出、状态码、工具名、progress/audit 与用户流程。

## 4. 非目标

- 不在本 RFC 完成 15 个 route→DB vertical slices、Resource Catalog 或全部 bounded-context writer 归位；它们仍属 W4-B/C/E。
- 不把 53 个 `AppDeps` consumer 一次归零；只收缩本 RFC 已切 cohort，并给剩余 consumer 保留 exact W4 owner。
- 不新增通用 service locator、字符串 `invoke(operationId, any)` 或可供业务模块任意调用的 generic invoker。
- 不改变 REST/MCP/CLI 公共 wire，不新增或删除 route/tool，不改变权限点、角色或 admission 结果。
- 不扩展 public error 产品语义；只把现有 404/409/410/412 与 generic public codes 做 exact 映射。
- 不修改 DB schema，不引入 migration，不改变 committed-event、worker 或 scheduler 生命周期。

## 5. 待批准裁决

### D1 — Catalog 是 bootstrap 收集的闭集，不是运行时 service locator

operation descriptor 由 owning module 的 public application surface 提供，bootstrap 只收集、校验、冻结。业务代码只能静态依赖 typed
handler/participant，不能持有 catalog 后按字符串查找并跨域调用。

### D2 — 沿用 RFC-294 的 closed descriptor union

descriptor 至少区分 command、idempotent command、query、credential authentication、verified ingress、bootstrap admin 与 public
liveness；每一支固定自己的 context kind、versioned exact input/output codecs、public error codes 与 invoke 签名。普通 command 不得
通过 cast 调用 idempotent/ingress/bootstrap handler。

### D3 — MCP binding 如实区分 direct、parameterized、composite、local introspection

- direct：一个 tool case 绑定一个 operation；若 HTTP 也暴露该 operation，两端调用同一个 invoke；
- parameterized：由 closed discriminant resolver 选择 exact operation id，所有 case 在启动时穷尽；禁止保存 URL 字符串；
- composite：tool 自己只做 MCP progress/aggregation/orchestration，依赖列表是 closed operation ids，并通过 typed handles 调用；禁止
  回落到 HTTP dispatch。
- local introspection：只用于 `describe_resource` / `describe_capabilities` 读取已冻结 catalog/actor projection，不访问业务 route；不得
  借此创建绕过 catalog 的本地业务 handler。

RFC-329 的 exemption 继续说明“为何没有 MCP tool”，不再承担 binding 事实源。

### D4 — Descriptor 拥有共享语义，binding 只拥有协议投影

permissions AND、`publicReason`、input/output codecs、public error set 与 invoke 只在 descriptor 声明。HTTP binding 只补
method/path/token access/codec projection；MCP binding 只补 tool name、purpose、progress/audit projection；CLI binding 只补命令名、
flag/TTY projection 与退出码映射。

### D5 — RouteMeta、MCP presentation 与 API docs 同源投影

descriptor-backed route 的 `RouteMeta` 由 descriptor + HTTP binding 投影。尚待 W4-B/C/E 下沉 use case 的兼容 route 由
`registerRoute` 同步生成 stable `legacy-http.*` declaration、handler binding 与显式 `legacyHttpAdapter` debt；不能伪装成已迁移
descriptor。`ALL_TOOLS` 在兼容期继续拥有既有 MCP presentation schema/title，但同一模块必须把 schema、permissions 与 exact operation
binding 一次登记进 frozen catalog，启动自检对依赖/admission 双向闭合。API docs 只读 catalog projection，删除
`services/apiDocs.ts → routes/registry.ts|mcp/tools.ts` 反向边。

### D6 — Context 只能由对应可信 factory 铸造

HTTP/MCP/CLI direct current-user surface 共享 identity-access context factory。schedule/webhook/call/code-host、maintenance/outbox/apply
与 public liveness 继续使用 RFC-294 已指定的 exact context/capability，不由 binding 猜角色、复制 permissions 或构造 Actor。

### D7 — 迁移允许 legacy HTTP adapter，但 debt 必须 exact 且由后续 vertical slice 归零

为避免把 W4-B/C/E 的 472 条 use case 迁移偷进本 RFC，未切 route 可暂留现有 handler；每条都必须有 stable operation id、exact
method/path、`implementation='compatibility'` 与 `legacyHttpAdapter=true`，unknown/stale/duplicate projection 均红。owner/remove wave 仍由
RFC-294 W4-B/C/E 的逐域清单承担；不能另抄一份会漂移的 472 行 owner 表。RFC-344 Done 要求 shared tool 的 HTTP dispatch=0、所有 tool
binding 闭合、目标 pilot descriptor 化；不冒领所有兼容 HTTP adapter 归零。

### D8 — 首批纵切固定为 user-access 与 development inbound

user-access 的 HTTP/CLI 绑定复用现有 identity-access public commands/queries；development mission/config/activity 先补齐最窄 public
operations，再让现有 HTTP binding 调用它们。route/CLI 不再 deep import 对应 module infrastructure/composition。本裁决不领取这些域的
完整 W4-E writer/participant cutover。

### D9 — 第二套 Hono 只在全部 MCP binding 切完后删除

迁移中保持单一 active path；最后一个 tool 离开 HTTP dispatcher 后，同一提交删除 MCP 私有 Hono、`mcp/dispatch.ts` 与 lazy mount，
并证明 REST app 仍是唯一 route table。该项只关闭 W4-D 的 duplicate-root residual，完整 AppDeps/root contraction 仍待后续 wave。

### D10 — 回滚按 cohort，禁止长期双跑

每个 cohort 是一次可逆 cutover：切换前以现有 REST/MCP/CLI 行为作 oracle，切换后只有 catalog path active。若需回滚，整 cohort 回到旧
binding；不得保留两个 handler 同时执行、shadow mutation 或双 module instance。最后删除第二 Hono 后只 forward-fix，不复活第二套
composition root。

## 6. 验收标准

- **AC-1**：operation id、descriptor kind、codec、handler、public errors 与 bindings 构成启动时双向闭集；duplicate、unknown、stale、
  kind/context mismatch 均拒绝启动或在 guard 中失败。
- **AC-2**：所有 52 个现有 MCP tools 均落入 direct/parameterized/composite/local-introspection 一类；所有业务 tool case 有 exact
  operation dependency，不再以 URL/method 调 Hono。
- **AC-3**：所有共享 HTTP/MCP operation 对同一 actor/input 调同一 registered handler chain；success DTO 与既有 error status/body 相同，
  404/409/410/412 golden 全覆盖；descriptor invoke 另对 undeclared public error category fail closed。
- **AC-4**：`resource_read/resource_write` 的 closed selector 穷尽，`watch_task` 等 composite tool 保持 progress/audit/聚合行为且不隐藏
  undeclared operation dependency。
- **AC-5**：descriptor-backed `RouteMeta` 与 codec/admission 同源；兼容 MCP schema/permissions 和 exact operation binding 一次登记到 catalog；
  API docs 只读 catalog projection，手写第二份 docs/permission 事实或漏 binding 的 mutation 会红。
- **AC-6**：user-access HTTP/CLI 与 development mission/config/activity HTTP 已接同一 typed operation；目标 route/CLI 对 module
  infrastructure/composition deep import=0。
- **AC-7**：MCP 私有 Hono app、`mcp/dispatch.ts` 与 `mcp/dispatch ↔ mcp/server ↔ server` SCC=0；REST route table 只装配一次。
- **AC-8**：本 RFC cohort 的 `AppDeps` consumer 只减不增；全局剩余量与 owner 明确，不能把未切 consumer 算作 W4-D Done。
- **AC-9**：472 条 current HTTP route、52 个 tools、380 条 no-tool exemption 的 inventory 均有 unknown/stale 双向门；RFC-344
  closeout 时 legacy tool HTTP dispatch=0，每条兼容 HTTP adapter 都显式标债并留给 W4-B/C/E。
- **AC-10**：REST/MCP/CLI 的公共 wire、工具名、端点、权限结果、progress/audit 与用户流程零非预期变化；无 schema migration。
- **AC-11**：每个 cohort 有 fresh/replay/error/parity 回归；source-lock 能对 legacy dispatcher、duplicate metadata、untyped generic
  invoker 和 route deep import 的复辟变红。
- **AC-12**：最终 published exact SHA 的 Main CI 与项目要求的定时 workflows 全部 terminal success，才可把 RFC-344 与 RFC-294
  W4-A 标为 Done。

## 7. 批准后的交付边界

已按 [plan.md](./plan.md) 的 T1～T8 实施 production candidate。中间提交可以标记某 cohort cutover 完成，但在 AC-1～AC-12 全部满足前，
RFC-344 保持 In Progress；不得用“catalog 类型已存在”“RFC-329 inventory 已绿”或“source 已 push”替代 W4-A hosted exit。

## 8. 落地与关闭记录

2026-08-30，RFC-344 已按批准范围完整落地并关闭：

- `1f6edeb3d0399bf89a957e50d1643fd3dcf9c6cc` 建立并接入 closed `OperationCatalog`，472 条 current HTTP route
  获得 stable operation identity，52/52 MCP tools 全部进入 direct、parameterized、composite 或 local-introspection binding；
  `resource_read/resource_write` 使用 closed selector，composite tool 显式声明 typed dependencies。
- identity-access user HTTP/CLI 与 development mission/config/activity 已切到 exact public operation contracts；descriptor-backed
  RouteMeta、MCP presentation 与 API docs 从同一 frozen projection 读取。compatibility HTTP adapter 继续逐 leaf 显式标债并交给
  W4-B/C/E，不因本 RFC 完成而冒领归零。
- MCP private Hono、`mcp/dispatch.ts`、lazy duplicate `mountApiRoutes` 与对应三文件 SCC 已删除；REST root 是唯一 route table，
  MCP 不再把业务调用重新编码为 URL/method 后进入第二套 transport stack。
- `4e49626a3c6fc499ba0dd71642bb262a42283526`、`765de8b5ff6d61c72cd126fe62172ce761fa9638`、
  `107596c430f29a0fbcfee83ad93f7d6eaacbb993` 与 `baeb34431bb00470b2ca036fa103071afa440f7f` 闭合了 catalog
  唯一性、descriptor consumer、bootstrap handoff、public-surface 与 hosted architecture source locks；最后一条 RFC-305 consumer ledger
  漂移由 `c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` 修正为 executable `queries.ts` owner。
- final canonical snapshot 为 `249a0d3f71dcc193cf18f1d7fb1663b79c2a88f5`，source digest 为
  `sha256:0ff3f9655ff5f6c38bd5a922111dc96f586a64993ae4860248a2d8e3b3b0d3ad`；final test-only consumer ledger
  修复不改变 production source digest。
- exact SHA `c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` 的 Main CI `33298828254` terminal success：static、
  typecheck/lint/format、build、frontend、backend 8/8 与 Ubuntu/macOS/Windows Playwright 全绿。相同 SHA 的 8 个定时 workflow
  也全部 terminal success：e2e-full `33298851279`、e2e-webkit `33298852761`、evidence `33298851076`、git-protocols
  `33298851691`、integration-opencode `33298851086`、maintenance-soak `33298851934`、visual `33298851050`、
  windows-platform `33298851033`。

RFC-344 据此只关闭 RFC-294 W4-A 与 W4-D 的 duplicate-root residual。W4-B、W4-C、其余 W4-D/AppDeps contraction、W4-E
各 bounded-context cutover 仍按独立 successor 与授权门推进。
