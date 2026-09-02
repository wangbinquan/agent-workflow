# RFC-345 — Resource Catalog 与 ResourcePackage 合同归位（RFC-294 W4-C）

- 状态：**Done（2026-09-02）**；D1～D10 已获用户明确批准，AC-1～AC-12 全部满足（hosted closeout 取证见 `plan.md §7.6`）
- current-source pin：`625017c084db2f7eb6c9ec34c87eba41ffaf04cd`（`HEAD=origin/main`；RFC-344 published
  implementation candidate，hosted closeout 尚待完成）
- 前置：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W0-R / W3、
  [RFC-271](../RFC-271-resource-config-package/proposal.md)、
  [RFC-324](../RFC-324-graded-resource-grants/proposal.md)、
  [RFC-344](../RFC-344-operation-catalog-transport-cutover/proposal.md)
- 归属：RFC-294 W4-C；不领取 W4-B、完整 W4-D、W4-E、W5、W6 或 W4-E6 MCP diagnostics
- 实现许可：用户已批准 RFC-345 范围内的功能保持迁移；commit/push 仍需另行授权

## 1. 摘要

当前“资源”相关能力已经有成熟功能，但所有权仍横向散落：

- 经典六类资源（agent / skill / MCP / plugin / workflow / workgroup）的列表、详情、写入与引用规则分布在
  `services/*.ts`；
- `services/resourceAcl.ts` 同时承担纯访问判定、15 类 Drizzle table registry、grant 查询、资源 ACL 读写与
  transfer/name collision 处理；`ACL_TABLES` 被 package、Intent、引用解析和 CLI 直接读取；
- Intent 有两套几乎相同的“六类可见资源”装载：一套给 session selector，一套给 dump/closure；
- task execution、Intent apply、schedule/webhook trigger、memory scope 都直接拼装资源表/ACL/service，但它们需要的字段与
  事务职责完全不同；
- ResourcePackage 已经具备 inspect/preview/commit、durable journal、receipt 与七类资源 apply 能力，但 application
  contract 仍表现为一个直接 deep-import 七类 writer 的 `bundle/apply.ts`；
- RFC-344 已建立 transport-neutral OperationCatalog，但未迁移这些 resource use cases，兼容 operation debt 明确留给
  W4-C。

本 RFC 建立 `modules/resource-catalog` bounded context：core 只拥有 resource ref/revision/access/catalog 机制，经典六类
aggregate 仍各自拥有 typed command/query，不建通用 CRUD；跨模块只导出四个按 consumer 命名、字段闭合的 participant。
`resource-catalog/package` 提供 Inspect/Preview/Apply/Receipt application contract，并把现有七类 package mutation 变为七个
typed participant。现有 BundleApply 生命周期继续运行，直到 W6 的 AtomicApply successor 获批后才切 admission owner。

这是一项功能保持的所有权与依赖方向迁移：不新增资源类型、端点、字段、权限档位、package 格式或用户流程。

## 2. Current-source 结论

### 2.1 四个 roster 已经分叉，不能再用“资源类型全集”代称

current shared schema 给出四个不同闭集：

| roster                  | current 数量 | 成员/用途                                           |
| ----------------------- | -----------: | --------------------------------------------------- |
| `ACL_RESOURCE_TYPES`    |           15 | 带 owner / visibility / ACL revision 的资源类型     |
| `GRANT_RESOURCE_TYPES`  |           16 | 上述 15 类 + 独立成员制语义的 `scheduled_task`      |
| `BUNDLE_RESOURCE_TYPES` |            7 | 经典六类 + `capability_template`                    |
| `INTENT_RESOURCE_TYPES` |            6 | agent / skill / MCP / plugin / workflow / workgroup |

事实源位于 `packages/shared/src/schemas/resourceAcl.ts:23-60,73-86,112-120,141-158`。因此 RFC-294 W4-C
计划里“当前 13 个 resource kind”与“package 六类 participant”已经漂移；selector/Intent 仍是六类则仍然准确。

### 2.2 ACL 纯判定已经抽出，但 infrastructure registry 仍向外暴露

- `services/resourceAccessPolicy.ts` 已是 187 行、无 DB 的纯访问判定层；
- `services/resourceAcl.ts:101-118` 为兼容旧入口 re-export 纯判定；
- `services/resourceAcl.ts:161-181` 的 `ACL_TABLES` 直接绑定 15 张 Drizzle 表；current source 中除定义文件外还有
  13 个文件直接 import 它；
- `resourceAcl.ts` 总计 1,064 行，还包含 grants、visible projection、ACL GET/PUT 与 owner/name 处理，无法作为跨模块 public
  contract。

这说明迁移不需要重写访问规则，而需要把纯 policy、SQLite adapter、ACL application use case 与 compatibility facade 分层。

### 2.3 Intent 的两份 catalog 是同一横向 query 的两个投影

- `services/intent/resourceCatalog.ts:43-62` 并行调用六个 `list* + filterVisibleRows`，返回 selector label；
- `services/intent/dumpBuilder.ts:162-188` 再做一次相同六路装载，只是后续需要按 id 建 Map 并展开 closure。

两者应消费同一个 actor-filtered `ResourceCatalogQuery`。dump 需要的完整资源详情/内容仍由六个 typed QueryService 或专用
dump participant 提供，不能把详情塞进 `ResourceSummary`。

### 2.4 四个跨模块 consumer 的字段并不相同

- task execution：workflow/agent/workgroup launch target，以及 agent closure 中 skill/MCP/plugin 的 frozen injection facts；
- Intent apply：经典六类 create/update plan、expected revision 与逐类 commit receipt；
- integration trigger：schedule 的 workflow/agent/workgroup target，以及 webhook 的 workflow/digital-employee launch target；
- memory：只有 agent/workflow scope 的 visible/edit verdict，不需要资源内容 snapshot。

它们不能共享一个 `load<TSnapshot>(ref)` 或 `ResourceService`。本 RFC只提供四个 purpose-specific participant，并保持每个现有
consumer 的成功/失败与返回字段。

### 2.5 ResourcePackage 已是七类业务事务，W4-C 只归位合同

- `services/resourcePackage/commit.ts:268-345` 完成 preview token/replay/decision/secret/human mapping 后构造 provider，调用
  `applyResourceBundle`；
- `services/bundle/apply.ts:680-740,745-880` 直接 prepare/commit 经典六类与 `capability_template`；
- `services/bundle/provider.ts` 已有场景 provider、idempotency/serialization 与同事务 hooks；
- RFC-271 的 durable journal、exact revision、stable import id、preview/receipt 与 roll-forward 行为已有生产回归。

因此本 RFC 不重写 engine，也不把 package 缩回六类；它建立七个 exact mutation participant，并用 adapter 让现有 engine 先消费
这些合同。W6 才决定何时把 BundleApply/Intent apply 迁到统一 AtomicApply admission owner。

## 3. 目标

1. 建立 `modules/resource-catalog/{domain,application,public,infrastructure,composition}`，按 RFC-294 形成 feature-first
   bounded context；
2. core 拥有 15 类 resource ref/revision/access 机制，但只为经典六类提供横向 selector summary；
3. 经典六类完整 List/Get/Filter/Create/Update/Delete 保持六套 typed contract 与不变量，public DTO 不暴露 DB row；
4. `ACL_TABLES` 只存在 SQLite infrastructure；旧 `services/resourceAcl.ts` 在迁移期只作兼容 facade；
5. 用 `TaskExecutionResourceSnapshotInTx`、`IntentApplyResourceParticipantInTx`、
   `IntegrationTriggerResourceSnapshotInTx`、`ResourceScopeAuthorizationInTx` 替换 named consumer 的 deep import；
6. Intent selector 与 dump 共用一份 actor-filtered catalog query；
7. `resource-catalog/package` 导出 Inspect/Preview/Apply/Receipt operation 与 query contract，保留既有 REST/CLI wire；
8. ResourcePackage apply 使用七个逐类 mutation participant；`capability_template` writer 仍由其现有 owner 提供 participant；
9. 与 RFC-344 的 OperationCatalog 对接：目标 route/CLI/MCP binding 调 module public operation，不新增第二套 handler registry；
10. 以 characterization、contract、source-lock 与 published exact-SHA hosted CI 证明产品功能保持。

## 4. 非目标

- 不把 15 类 ACL resource 都纳入横向 selector，也不把 16 类 grant target 当成同一种 aggregate；
- 不把 capability template、development config/adapter、integration 或 digital-employee 的 writer 转交 resource-catalog；
- 不创建 `switch(resourceType)` universal CRUD、detail union、generic repository、generic raw snapshot loader 或 runtime service locator；
- 不改变 ACL 的 `none/read/write/own` 结果、owner/visibility/grant 功能、既有 404/403/409 行为或权限点；
- 不改变 ResourcePackage zip/manifest/bundle/preview/decision/receipt wire，不新增或删除可打包类型；
- 不迁移或改写 BundleApply/Intent apply durable lifecycle，不领取 RFC-294 W6 AtomicApply；
- 不实现 MCP runtime diagnostics；它仍属 W4-E6；
- 不修改 DB schema、migration、resource data、server bootstrap、route registry 或 MCP root；
- 不顺带增加安全加固、竞态终检、写点 census 或新的能力限制；只保持本 RFC明确涉及的功能合同。

## 5. 已批准裁决

### D1 — 四个 roster 独立建模并由 shared 常量派生

ACL=15、grant=16、package=7、Intent/selector=6。禁止从一个 roster cast/扩散成另一个 roster；转换只能走具名 narrowing
function。RFC-345 同步修正 RFC-294 W4-C 的 13/6 陈旧数字。

### D2 — Resource Catalog 统一机制，不统一 aggregate writer

`resource-catalog/core` 拥有 ref/revision/access/catalog envelope；经典六类在同 bounded context 下仍是六个 aggregate submodule。
其余九类 ACL resource 的 writer 留在 current owner，只向需要的场景提供 exact participant。

### D3 — 横向 catalog 只返回经典六类最小 summary

`ResourceSummary` 固定为 `{ ref, kind, name, description, revision, visibilityHint }`；`description` 保留现有 Intent selector/dump
文案需要，`visibilityHint` 只作展示。这里相对 RFC-294 原五字段示意明确增加 `description`：current
`mountSuggestions.candidates` 对外返回该字段，删掉会构成 wire 收缩。query 支持 actor-filtered list/get 与 SQLite
pagination/filter；它不是写入授权或完整详情入口。

### D4 — ACL policy、application 与 SQLite registry 分层，行为不变

现有 `resourceAccessPolicy.ts` 的纯 verdict 迁入 core domain；grant/ACL GET/PUT/owner transfer 成为 application use case；
`ACL_TABLES`、Drizzle columns 与 row mapping 只在 infrastructure。旧 import path 暂作薄 facade，按 consumer cohort 归零，不能继续
持有业务分支。

### D5 — 四个 named participant 各自使用 closed request/result union

- task execution：只返回 launch/injection/call closure 所需 frozen facts；
- Intent apply：只接受经典六类 versioned changeset plan，返回逐 operation receipt；
- integration trigger：只覆盖现存 schedule/webhook launch kind 与其 frozen target fields；
- memory scope：只回答 agent/workflow scope 的 visible/edit verdict。

禁止泛型 snapshot、DB row、`unknown` payload 或调用者自选 purpose。各 participant 保持 current consumer 的错误码与展示行为。

### D6 — 经典六类 command/query 逐类落位，迁移按 cohort

每类有自己的 public commands/queries/types 和 internal repository/mapper；create/update/delete 不共享 mutation switch。route/CLI/MCP
在对应 contract 完成后按一类一刀切换，旧 service 同名 facade 只转接参数/结果，consumer=0 后删除。

### D7 — ResourcePackage 当前分母是七类 participant

`ResourcePackageApplyTx` 明确包含 agent、skill、MCP、plugin、workflow、workgroup、capability-template 七个 participant，以及
package event/audit/receipt capability。每个 participant 接受本 aggregate 的 exact versioned package mutation；不得合并成
`apply(kind,payload)`。capability-template aggregate/writer ownership不转移，只提供 package participant implementation。

### D8 — W4-C 适配现有 BundleApply，W6 才切 AtomicApply owner

Inspect/Preview/Apply/Receipt 先成为 resource-catalog/package 的 application/public contract；现有 BundleApply lifecycle 通过 adapter
消费 `ResourcePackageApplyTx`。本 RFC 不合并 Intent journal，不替换 claim/converger，不新造 apply engine。

### D9 — 与 RFC-344 分两段并行

core/public contracts、SQLite adapters、Intent catalog 与 named participants 可在 RFC-344 hosted closeout 前独立实施；涉及
OperationCatalog descriptor/binding 或删除 compatibility operation debt 的 cohort，必须先等待 RFC-344 hosted closeout，并 re-pin
到其最终 exact SHA。
本 RFC 不编辑 `server.ts`、route registry、MCP root 或 architecture canonical 生成物。

### D10 — 零 schema/wire/产品能力变化，以 current behavior 作 oracle

不增加 migration。REST/MCP/CLI path、body/result/status、package bytes、preview/decision/replay、ACL verdict、task launch、Intent、trigger
与 memory scope 用户行为保持。最终只有 published exact SHA 的 Main CI 与项目要求的定时 workflows 全部 terminal success 才可
关闭 RFC-345/W4-C。

## 6. 验收标准

- **AC-1**：四个 roster 分别由 shared canonical constants 派生，15/16/7/6 exact census 与 unknown/stale guard 全绿；
- **AC-2**：`ResourceCatalogQuery` 只返回 classic-six `ResourceSummary`；public type 不含 Drizzle row、secret/config/definition/body；
- **AC-3**：Intent selector 与 dump 的六路 `list* + filterVisibleRows` 复制归零，二者消费同一 query；既有排序、label、closure 与
  hidden-count 结果保持；
- **AC-4**：`ACL_TABLES` 仅在 resource-catalog SQLite infrastructure 可见；外部 consumer 不再 import；旧 facade 只转接 public
  contract；
- **AC-5**：四个 named consumer 分别只依赖自己的 participant，request/result 字段有 closed ledger；generic service/snapshot
  mutation 使 guard 变红；
- **AC-6**：经典六类的完整 query/command 各自 typed；route/CLI/MCP 不接 DB row 或 universal mutation switch；
- **AC-7**：ResourcePackage Inspect/Preview/Apply/Receipt 由 module public surface 导出，REST/CLI 调同一 application operation；
- **AC-8**：package participant exact 为 7/7，`capability_template` 与经典六类均覆盖 create/update/reuse/overwrite 当前路径；少一类或
  fallback/default branch 会被 type/contract test 拒绝；
- **AC-9**：ResourcePackage 既有 stable import id、preview baseline、decision translation、secret/human mapping、durable replay、receipt 与
  roll-forward corpus不改判；Intent apply lifecycle 不迁移；
- **AC-10**：RFC-344 descriptor-backed cohort 只在其 hosted closeout 的最终 published baseline 上切换；目标 compatibility
  operation debt 归零，但
  `server.ts`/registry/MCP root 不由本 RFC改写；
- **AC-11**：无 schema migration、无新增/删除 route/tool/CLI command、无公共 wire 与 ACL 结果变化；
- **AC-12**：source-lock、focused regression 与 published exact-SHA Main CI/定时 workflows 全部 terminal success；只关闭 RFC-294 W4-C，
  不倒签 W4-B/D/E、W5 或 W6。

## 7. 批准口径

用户已于 2026-08-30 明确批准 D1～D10 与生产实施。该批准只授权 RFC-345 范围内的功能保持迁移；commit/push 仍需遵守共享 main
的 publication critical section并取得单独授权，并在 RFC-344 hosted closeout 后重新同步、re-pin 与复核 operation binding 冲突面。
