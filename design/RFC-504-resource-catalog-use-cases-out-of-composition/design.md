# RFC-504 设计：资源目录的内建工作流、资源包暂存、任务房协作、意图上下文授权与 MCP 测试失效迁出 composition

## 1. 现状（HEAD `d0bcbd1c8`，源码实读）

resource-catalog 组合层控制流（F13 口径，按语法树计数）实测 92 行：RFC-370 余项 72 行（`taskImagePlugin.ts` 35、
`crewstationMcpDiagnostics.ts` 25、`crewstationArtifacts.ts` 8、`crewstationNativePlugin.ts` 4）；其余 20 行在 9 个文件里，本 RFC 的五个文件
15 行（`builtinWorkflowCatalog.ts` 3、`intentContextAuthorization.ts` 2、`mcpOperations.ts` 1、`resourcePackageOperations.ts` 7、
`workgroupTaskRoom.ts` 2），另有 `resourceAcl.ts` 1、`resourcePackageMaintenance.ts` 2、`skillContentBinding.ts` 1、`skillVersionCommit.ts` 1
（非目标）。九个文件都不在 `composition-forbidden-import-files` 里。

**`composition/builtinWorkflowCatalog.ts`，56 行**：第 1～13 行 import——platform 的 `PersistenceDb` 类型、`@/auth/systemIdentity` 的
`SYSTEM_USER_ID`、本模块 infrastructure 的 `getWorkflow` 与 `broadcastWorkflowCreated`（`legacy/workflow`）、`runResourceCatalogTransaction`、
`createWorkflowMutationParticipant`、`workflowDetailOf`，以及 shared 的规范 JSON、迁移、布局与 schema。第 20～56 行
`composeBuiltinWorkflowCatalog(db)` 返回 `{ ensure }`：读已有行（第 23 行）、按规范布局解析期望的定义（第 24～26 行）；已有时比对内建标记、
系统 owner、名字与规范 JSON，不符就抛 `builtin-workflow-content-conflict:<id>`（第 27～35 行）；缺失时在资源目录事务里以系统身份经工作流写入
参与者建行（第 37～51 行，写入的是迁移到最新版本后再布局的定义，比对用的是未迁移的那份）并广播（第 52 行）。文件里没有装配。

**`composition/intentContextAuthorization.ts`，53 行**：第 1～8 行 import（identity-access `public/participants` 的 `DirectAuthenticatedAuthority`
类型、application 的会话工厂、本模块 public 的类型、infrastructure 的读端口工厂与事务类型）；第 10～13 行
`IntentContextResourceAuthorityPair`；第 15～20 行工厂接口；第 22～31 行私有的 `currentAuthorityResolver(pair)`：`resolve(authority)` 核对传入的
就是这次的 `pair.authority`，不是就抛 `foreign-intent-context-resource-authority`（第 25～27 行），否则交出 `pair.actor`；第 41～53 行
`composeIntentContextResourceAuthorizationFactory()` 把它与 infrastructure 的读端口接到 application 的
`createIntentContextResourceAuthorizationSession` 上。它实现的 `IntentContextCurrentAuthorityResolver` 声明在
`application/participants/intentContextResourceAuthorization.ts` 第 20～22 行。

**`composition/mcpOperations.ts`，125 行**：第 78～92 行 `mcpAclRuntimeTestLifecycle()` 实现 infrastructure `resourceAclRepository.ts` 第 26 行
的 `ResourceAclMutationLifecycle`：`afterWriteInTransaction` 只对 `change.type === 'mcp'` 的变更（第 81 行）在同一事务里调 infrastructure 的
`transitionMcpAclRuntimeTests`（第 82～88 行，`mcpRuntimeTestTransitions.ts` 第 99 行）。其余是 MCP 目录的两个装配入口与它们的依赖接口。

**`composition/resourcePackageOperations.ts`，227 行**：第 26～62 行导出围栏、三种执行输入与它们的私有联合；第 69～76 行
`ResourcePackageExecutionAdapter`；第 78～103 行 `ResourcePackageTransport`；第 105～113 行组合结果与依赖接口；第 115～221 行
`composeResourcePackageOperationsFromAdapters(deps)`：取 id（`deps.id ?? ulid`，第 118 行）、两张内存表与可打包种类（第 119～121 行）、
`stage` / `take`（第 123～133 行，取不到就抛）、执行端口三个方法各自核对暂存的种类（第 135～154 行）、建应用与操作描述符（第 155～162 行）、
传输的五个方法（第 163～214 行：按名字查本人的资源；三种暂存，apply 的幂等键是预览令牌的 `sha256Hex`；导出前的可打包检查；导出包取走
一次）；第 223～227 行 `composeResourcePackageOperations` 原样转交。暂存句柄、导出包 id 与应用的 `ids.next` 都取同一个 `nextId`。

**`composition/workgroupTaskRoom.ts`，101 行**：第 24～32 行 `composeWorkgroupTaskRoom`（装配）；第 35～47 行
`composeWorkgroupTaskRoomActiveUsers`：经传入的用户目录查人、筛出 `active` 的 id；第 54～61 行 `WorkgroupTaskRoomWorkflowCreation`（另存为时
取的工作流 create 操作的结构投影）；第 68～101 行 `composeWorkgroupTaskRoomDynamicWorkflow`：`validateGenerated` 做触发上下文预检、按当前
库存的通用校验与按当前代理池的动态工作流校验，有 error 级问题就抛 `ConflictError('dw-generated-def-stale', …)`（第 84～90 行）；`create` 把
另存请求以 JSON 提交递给工作流目录的 create 操作。它们实现的 `WorkgroupTaskRoomActiveUserDirectory` 与
`WorkgroupTaskRoomDynamicWorkflowOperations` 声明在 `infrastructure/workgroupTaskRoom.ts` 第 50～67 行，只取 shared 的 `WorkflowDefinition`
与本模块 public 的 `WorkgroupOperationContext`；方法的调用在 `infrastructure/workgroupTaskRoomCommands.ts`。

使用方：

- bootstrap：`daemonModules/digitalEmployee.ts` 第 83、190 行取并调用 `composeBuiltinWorkflowCatalog`；`daemonHttpComposition.ts` 第 53～57、
  345～351 行取并调用任务房的三个装配；`daemonModules/intent.ts` 第 24、89 行取意图上下文授权工厂、`daemonModules/resourceCatalog.ts` 取
  `composeMcpCatalog` 与 `mcpAclRuntimeTestLifecycle`（两处都不改）。resource-catalog 的 `composition.ts` 已有转出 infrastructure 工厂的先例
  （`createMcpRuntimeTestEventRetentionPhase`）。`composition/postgresqlResourcePackageCatalog.ts` 第 23～28 行从 `./resourcePackageOperations`
  取 `composeResourcePackageOperations` 与 `ResourcePackageExecutionAdapter` 等类型。
- 用例：`helpers/productionPerformanceApplication.ts` 第 46～49、185 行取 `composeWorkgroupTaskRoomActiveUsers`；`helpers/workgroupTaskRoom.ts`
  第 16～19 行从 infrastructure 取 `WorkgroupTaskRoomDynamicWorkflowOperations` 类型；`rfc238-mcp-runtime-test-transitions` 第 10 行从
  `composition/mcpOperations` 取 `mcpAclRuntimeTestLifecycle`；其余只取装配入口与组合结果类型。
- 按路径或文本钉着这几个文件、断言要迁走的内容的锁：
  - `architecture/rfc401-resource-write-participants` 第 104 行把 `composition/builtinWorkflowCatalog.ts` 的 `composeBuiltinWorkflowCatalog`
    列为必须经工作流写入参与者的场景（第 228～229 行找不到文件时跳过，改钉后不能留空）；
  - `rfc345-intent-context-resource-authorization` 第 37～38 行要求组合文件含 `authority !== pair.authority` 与错误串；
  - `rfc345-resource-catalog-contracts` 第 2113～2114 行要求 `mcpOperations.ts` 含 `transitionMcpAclRuntimeTests(` 与
    `export function mcpAclRuntimeTestLifecycle(`；
  - `rfc345-resource-acl-facade-retirement` 第 647 行要求 `resourcePackageOperations.ts` 含 `return deps.resources.findOwnedIdsByName({`；
  - `rfc231-private-copy` 第 469～474 行要求 `workgroupTaskRoom.ts` 含 `input.workflows.invoke(authority as never`；
  - `rfc345-workgroup-task-room-provider` 第 116～117 行要求 infrastructure 的 `workgroupTaskRoom.ts` 含 `findActiveUserIds` 与
    `validateGenerated`（端口接口的方法名）；
  - `architecture/rfc390-neutral-http-binding` 第 34～35 行把任务房的两个 `compose…` 名字列为 HTTP 独占的工厂；
  - `rfc305-architecture-lock` 第 383、387 行两条边（`intentContextAuthorization.ts`、`resourcePackageOperations.ts` → identity-access
    `public/participants`）。

  其余读这几个文件的文本锁断言的是留下的装配或不迁的名字：`rfc345-resource-catalog-contracts` 第 1093～1096、1810～1818 行，
  `rfc349-resource-catalog-postgresql-adapters` 第 33～36、115～118 行，`rfc345-resource-acl-facade-retirement` 第 646 行，
  `rfc345-workgroup-task-room-provider` 第 47、76、114～115 行，`rfc359-w4-d16-adapters` 第 351～357 行（中立文件清单），
  `architecture/rfc380-daemon-module-bundles` 的名字表。

- 同名声明：`ResourcePackageExportFence` 另有 `composition/resourcePackageExecution.ts`（私有）、`routes/resourcePackages.ts` 与前端
  `api/resourcePackages.ts` 各一份；`ResourcePackageExecutionAdapter` 与三种执行输入另有 `composition/resourcePackageExecution.ts` 一份（输入
  不带 `kind`）；`IntentContextResourceAuthorityPair` 另有 intent 的 `application/ports/intentPersistence.ts` 一份。清单里的其余名字在全部
  生产文件、用例与 e2e 里没有别的顶层同名声明；新文件路径与五个新工厂名都未被占用。
- `rfc294-review-module-layer-rules` 只禁 domain / application / engine 取 `@/db/schema`、infrastructure 与适配器 / 厂商包（`ulid` 是厂商包）；
  application 取 identity-access `public/participants` 的类型、`@/util/errors` 与 `@/util/hash` 有先例（RFC-502）。

## 2. 机制与落位

### D1 用例落 application，IO 落 infrastructure

资源包暂存、任务房的两个端口实现与意图上下文的授权核对都只经传入的端口工作，没有 IO：落 `application/`。内建工作流目录读写数据库并广播，
ACL 测试失效在事务里转移行：落 `infrastructure/`。RFC-294 design §3 的 `application/adapters` 是“本域实现他域 consumer-owned required SPI”，
这里实现的都是本模块自己的端口，落 `application/` 本身。

### D2 新位置

- **`application/package/stagedExecution.ts`**（新）：第 26～103 行的类型（导出围栏、三种执行输入与私有联合、执行适配器、传输）原样迁入；
  `createResourcePackageStagedExecution(deps)` 取 `{ execution, resources, id }`（`id` 必填），函数体是原第 119～154 行与第 163～214 行，返回
  `{ execution, transport }`；`nextId` 改为取 `deps.id`，其余逐字。
- **`application/workgroups/taskRoomCollaborators.ts`**（新）：第 35～47 行与第 54～101 行原样迁入为 `createWorkgroupTaskRoomActiveUsers`、
  `WorkgroupTaskRoomWorkflowCreation`、`createWorkgroupTaskRoomDynamicWorkflow`；import 按新目录改写。
- **`application/workgroups/ports.ts`**：`WorkgroupTaskRoomActiveUserDirectory` 与 `WorkgroupTaskRoomDynamicWorkflowOperations` 从
  `infrastructure/workgroupTaskRoom.ts` 第 50～67 行原样迁入；infrastructure 改从这里取类型。
- **`application/participants/intentContextResourceAuthorization.ts`**：第 10～13 行的 `IntentContextResourceAuthorityPair` 与第 22～31 行的
  解析器迁入，解析器改名为导出的 `createIntentContextCurrentAuthorityResolver`，放在它实现的接口旁边；函数体逐字。
- **`infrastructure/builtinWorkflowCatalog.ts`**（新）：第 15～56 行原样迁入为 `createBuiltinWorkflowCatalog(db)`；import 按新目录改写。
- **`infrastructure/mcpRuntimeTestTransitions.ts`**：第 74～92 行的 `mcpAclRuntimeTestLifecycle` 原样迁入（名字不变），类型从同目录的
  `resourceAclRepository.ts` 取。

### D3 composition 只装配

- 删除 `composition/builtinWorkflowCatalog.ts`；resource-catalog 的 `composition.ts` 转出 `createBuiltinWorkflowCatalog`；bootstrap
  `daemonModules/digitalEmployee.ts` 改从 `@/modules/resource-catalog/composition` 取，调用改名，参数不变。
- `composition/resourcePackageOperations.ts`：留依赖接口、组合结果类型与两个装配入口，转出执行适配器与传输类型（给
  `postgresqlResourcePackageCatalog.ts` 与用例）；`composeResourcePackageOperationsFromAdapters` 只做 `const nextId = deps.id ?? ulid`、建暂存、
  建应用（`ids` 仍是同一个 `nextId`）与操作描述符、交出四项。
- `composition/workgroupTaskRoom.ts`：`composeWorkgroupTaskRoom` 不变；转出两个 `create…` 工厂；`daemonHttpComposition.ts` 与用例的辅助改取新
  名字。
- `composition/intentContextAuthorization.ts`：工厂与工厂接口留下，改取 application 的授权对类型与解析器；不再取 identity-access。
- `composition/mcpOperations.ts`：转出 infrastructure 的 `mcpAclRuntimeTestLifecycle`，bootstrap 与用例的 import 不变。

### D4 锁与账本

- 改钉：`rfc401` 的场景改为 `infrastructure/builtinWorkflowCatalog.ts` 的 `createBuiltinWorkflowCatalog`；`rfc345-intent-context-resource-authorization`
  改读 application 文件的核对，并断言组合文件不再含它；`rfc345-resource-catalog-contracts` 的两条改读 infrastructure 文件，并断言组合文件
  转出它；`rfc345-resource-acl-facade-retirement` 的查找一条改读暂存文件；`rfc231-private-copy` 改读任务房的 application 文件；
  `rfc345-workgroup-task-room-provider` 的两个方法名改读 application 的端口文件；`rfc390` 的两个名字换新名字；`rfc305` 的两条边改钉新文件
  （上下文对不变）。
- 改 import：`helpers/workgroupTaskRoom.ts` 从 application 的端口文件取类型，`helpers/productionPerformanceApplication.ts` 取新名字。
- `architecture/counts.json`：`composition-control-flow-resource-catalog` 92 → 实测（预计 77）。`guard-manifest.json` 登记 RFC-504 用例。
- 不改：只取装配入口与组合结果类型的用例；`design/` 里的历史记述。

## 3. 清单（退出门）

| 新位置（`modules/resource-catalog/`）                            | 声明并交出                                                                                                                                                                                                                                               | 只声明不交出                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `application/package/stagedExecution.ts`（新）                   | `ResourcePackageExportFence`、`ResourcePackageInspectExecutionInput`、`ResourcePackageApplyExecutionInput`、`ResourcePackageExportExecutionInput`、`ResourcePackageExecutionAdapter`、`ResourcePackageTransport`、`createResourcePackageStagedExecution` | `StagedResourcePackageInput` |
| `application/workgroups/taskRoomCollaborators.ts`（新）          | `createWorkgroupTaskRoomActiveUsers`、`WorkgroupTaskRoomWorkflowCreation`、`createWorkgroupTaskRoomDynamicWorkflow`                                                                                                                                      | —                            |
| `application/workgroups/ports.ts`                                | `WorkgroupTaskRoomActiveUserDirectory`、`WorkgroupTaskRoomDynamicWorkflowOperations`                                                                                                                                                                     | —                            |
| `application/participants/intentContextResourceAuthorization.ts` | `IntentContextResourceAuthorityPair`、`createIntentContextCurrentAuthorityResolver`                                                                                                                                                                      | —                            |
| `infrastructure/builtinWorkflowCatalog.ts`（新）                 | `createBuiltinWorkflowCatalog`                                                                                                                                                                                                                           | —                            |
| `infrastructure/mcpRuntimeTestTransitions.ts`                    | `mcpAclRuntimeTestLifecycle`                                                                                                                                                                                                                             | —                            |

同名类型原样钉住（不改）：`ResourcePackageExportFence` 在 `composition/resourcePackageExecution.ts`、`routes/resourcePackages.ts` 与前端
`api/resourcePackages.ts`；`ResourcePackageExecutionAdapter` 与三种执行输入在 `composition/resourcePackageExecution.ts`；
`IntentContextResourceAuthorityPair` 在 intent 的 `application/ports/intentPersistence.ts`。

允许的形状：`composition/builtinWorkflowCatalog.ts` 不存在；改名前的 `composeBuiltinWorkflowCatalog`、`composeWorkgroupTaskRoomActiveUsers`、
`composeWorkgroupTaskRoomDynamicWorkflow` 与私有的 `currentAuthorityResolver` 没有声明；`intentContextAuthorization.ts`、`mcpOperations.ts`、
`resourcePackageOperations.ts`、`workgroupTaskRoom.ts` 没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现（后三者另有
转出）；resource-catalog 的 `composition.ts` 转出 `createBuiltinWorkflowCatalog`，bootstrap 只经它取、调用一次；任务房的两个工厂只在
`daemonHttpComposition.ts` 里各调用一次。

## 4. 用例

新增 `packages/backend/tests/rfc504-resource-catalog-use-cases-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新位置声明（§3 列的同名类型钉在原处）；改名前的
  四个名字没有声明；每个新文件恰好声明、交出清单列的名字，两个既有文件交出清单列的名字。
- ② `composition/builtinWorkflowCatalog.ts` 不存在；四个组合文件没有控制流语句、各自从新位置取实现与转出；resource-catalog 的 `composition.ts`
  转出 `createBuiltinWorkflowCatalog`，bootstrap 只从 `@/modules/resource-catalog/composition` 取、调用一次；任务房的两个工厂只在
  `daemonHttpComposition.ts` 各调用一次；带负对照。
- ③ 全部生产文件、用例与 e2e 不从删除的位置取任何东西：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都认，
  带负对照。
- ④ application 的两个新文件与两个既有文件新增部分的依赖面是闭集：只取 `@agent-workflow/shared`、`@/auth/actor`、`@/util/errors`、
  `@/util/hash`、identity-access 的 `public` 类型与本模块 domain / application / public；不取 infrastructure、composition、IO 与厂商包，不用
  进程全局；infrastructure 的新文件不取 composition；带负对照。

行为由现有用例对拍：内建工作流经 `rfc401` 的场景锁与数字员工的内建资源用例；资源包暂存经 `rfc271-package-upload-bounds`、
`rfc359-w12-resource-package-commit-provider`、`rfc359-w13-resource-package-apply-conformance` 等；任务房经
`rfc167-dynamic-workflow-engine`（复核与另存）与 `rfc345-workgroup-task-room-provider`；意图上下文授权经 `rfc345-intent-context-resource-authorization`
与意图的各条 turn 用例；MCP 的 ACL 测试失效经 `rfc238-mcp-runtime-test-transitions`。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；资源包暂存的 id 从 `deps.id ?? ulid` 换成装配传入的同一个 `nextId`，应用的 `ids.next` 仍取它。
- **暂存作用域**：两张内存表仍随每次装配新建，一份组合结果一份；句柄只能取一次的语义不变。
- **遗留引用**：删除文件后由 `tsc` 与 RFC-504 用例 ③ 覆盖；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍
  （RFC-503 的教训：`design/` 里的 JSON 清单也会按路径钉文件）。
- **锁静默变空**：`rfc401` 的场景找不到文件时跳过，改钉后由 RFC-504 用例断言新文件里的函数确实经工作流写入参与者；`rfc390` 的名字表换新
  名字；`rfc305` 的两条边改钉新文件。

## 6. 取舍（可推翻）

1. **五个文件一个 RFC**：同一个模块、同一种形状（用例或 IO 写在 composition），清单与用例按文件逐项列；`resourceAcl.ts` 规模大、被
   infrastructure 反向取用，单独立 RFC。
2. **内建工作流目录进 infrastructure、删除组合文件**：它读写数据库并广播，没有装配可留；bootstrap 不能直接取 infrastructure，经
   `composition.ts` 转出（同文件已有先例）。
3. **资源包的类型随暂存进 application**：执行适配器与传输是 application 的用例要实现与交出的接口，组合文件转出给现有使用方；
   `composition/resourcePackageExecution.ts` 那份私有的输入类型不在本步合并（§8）。
4. **任务房的端口接口进 application**：实现在 application，接口不能留在 infrastructure（application 不取 infrastructure）；infrastructure
   改取它们（RFC-502 的工具连接 store 同样处理）。
5. **解析器放进它实现的接口所在的文件**：只有一个函数，与会话工厂同属意图上下文授权；组合文件留工厂、改取它。
6. **MCP 的 ACL 测试失效并入 `mcpRuntimeTestTransitions.ts`**：它只是那里的转移函数的一个生命周期包装，同属运行时测试的事务内转移；名字不变、
   组合文件转出，bootstrap 不改。
7. **工厂改名为 `create…`**：`compose…` 留给装配（RFC-501～503 同样处理）；`mcpAclRuntimeTestLifecycle` 本就不带前缀，不改。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是三组用例与两处 IO，分别落 application 与 infrastructure；一个组合文件删除，余下四处只装配、没有控制流；不新增用例入口
  （bootstrap 照旧各取一份）。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-504 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import，另读四个组合文件、resource-catalog `composition.ts`、bootstrap
  的两个文件与新位置；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-resource-catalog` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 resource-catalog 的第一步——内建工作流目录、资源包暂存、任务房协作、意图上下文授权核对与 MCP 的 ACL 测试失效离开
  `composition/`，一个组合文件删除；组合层控制流 92 → 实测。
- **留下**：`resourceAcl.ts`（带缓存与按数据库句柄的读写、被五个 infrastructure 文件反向取用、两个零调用方的事务内函数被文本锁留着）另立；
  `resourcePackageMaintenance.ts` 的装配期冲突守卫（bootstrap 另有同一判据）随 S10 收口的登记清单；`skillContentBinding.ts` 与
  `skillVersionCommit.ts` 的缺省选择随 S12；`composition/resourcePackageExecution.ts` 里私有的执行输入、围栏与执行适配器接口和
  `routes/resourcePackages.ts` 的围栏副本另立合并；`composeResourcePackageOperations` 只原样转交，随 S10 收口；`taskImage*` / `crewstation*`
  待 RFC-370 余项。
