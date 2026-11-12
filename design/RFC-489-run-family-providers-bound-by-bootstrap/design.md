# RFC-489 技术设计

落在 task-execution（运行族的根与本机调用）、runtime-management（运行时管理的装配、材料定义）与 bootstrap（绑定）。按 RFC-294 design
§3.1：task-execution → runtime-management 只经 `public/` 或 task-execution 自有、由 bootstrap 绑定的提供者；跨模块的装配归 bootstrap，
各模块的 composition 只装自己。

## 1. 现状（HEAD `ca08a9365`，源码实读）

task-execution → runtime-management 的 18 个内部文件对（三份精确账本：`rfc328-architecture-guards`、`rfc376-structural-guards` 的
`cross-context-internal-file-pairs`、`rfc294-architecture-preflight`），按用途分五组：

1. **运行时管理的两个根**（6 对）：
   - `composition/localRuntimeManagement.ts`：建诊断目标（RM `composition/runtimeDiagnosticTargets`）、建本机探测族、建本机效果（RM
     `infrastructure/local/runtimeManagementEffects` 的 `createLocalRuntimeManagementEffects`），再 `bindRuntimeManagement`（RM
     `composition/runtimeManagement`），并把探测回执钩子恢复成效果自己的。`bootstrap/standalone.ts:126` 选它，`deploymentProfile.ts:161`
     用它的类型声明选择项，`daemonModules/observation.ts:116` 调用。
   - `composition/crewstationRuntimeManagement.ts`：托管探测（task-execution `infrastructure/crewstation/runtimeSmokeRunFamily.ts` 的
     `createHostedRuntimeSmokeProbe`）配 RM 的托管内容、托管效果与 `composeRuntimeManagement`。`composition/crewstationExecution.ts:144`
     放进 selections，`bootstrap/crewstation.ts:308` 摊入。
   - runtime-management 的本机效果已有自己的探测端口：`smoke: { run(request) }`（`infrastructure/local/runtimeManagementEffects.ts:26-27`）。
2. **本机探测族的根**（3 对）：`composition/localRuntimeSmokeRunFamily.ts` 把 RM 的材料工作区、材料定义与协议绑定（RM
   `infrastructure/local/agentProtocol` 的 `bindNativeAgentProtocol`）交给 `createLocalRuntimeSmokeRunFamily`，诊断目标的类型取 RM
   composition 的函数类型。探测族（`infrastructure/local/runtimeSmokeRunFamily.ts`）在打开时取驱动（:39），编译时用材料定义建编译器（:80），
   协议用 `bindProtocol(driver)`（:103），运行证据的钩子直接给驱动（:107）。RM 的材料定义（`infrastructure/local/localAgentMaterialDefinition.ts:34-64`）
   给出的 `protocol` 与 `evidenceHooks` 正是 `bindNativeAgentProtocol(getRuntimeDriver(kind))` 与 `getRuntimeDriver(kind)`；系统代理族与任务
   代理族都直接用它（`systemAgentRunFamily.ts:78/83`、`taskAgentRunFamily.ts:140/145`）。
3. **系统代理的两个根**（4 对）：`composition/localSystemAgentRunFamily.ts`（RM 的运行时绑定、留存内容、材料定义）；
   `composition/crewstationSystemAgentRunFamily.ts`（给了夹具退回本机族，否则托管族配 RM 的托管内容与运行时绑定）。
   `bootstrap/standalone.ts:127` 与 `crewstationExecution.ts:143` 选它们，`observation.ts:51` 调用。
4. **本机任务代理的根**（2 对，另有指向 resource-catalog 1 对、source-control 2 对）：`composition/localTaskAgentRunFamily.ts` 把 RM 的
   运行时绑定、材料工作区、材料定义，RC 的材料引用，SC 的工作区内容与 git 观测交给 `createLocalTaskAgentRunFamily`；它自己的部分是绑定
   适配（`composeLocalTaskAgentRunFamilyFor`）、配置冻结（`freezeBinaryConfig`）与产出校验。经 `composition/localTaskRunSelection.ts:99`
   进入 `bootstrap/standalone.ts:112`。
5. **本机调用**（3 对）：`infrastructure/local/agentInvocation.ts:19-24` 取 RM infrastructure 的 `bindNativeAgentMaterialReference`、
   `createLocalAgentMaterialEvidence` 与两个类型，:51-55 建材料引用与运行证据。调用方：本机三族共用的准备
   （`local/agentInvocationPreparation.ts`）、只供契约用例的 `local/nativeTaskAgentRun.ts`（:108 另取 `bindNativeAgentProtocol`）、一族的
   `services/systemAgentRun.ts:329` 与 `services/runtimeSmoke.ts:166`（一族自己有这两项的包装：`services/runtime/index.ts` 的
   `getNativeAgentMaterialReference`、`bindNativeAgentMaterialEvidence`）。

提供者类型：`infrastructure/local/nativeRunFamilyProviders.ts` 已声明 `NativeMaterialDefinitions`、`NativeMaterialWorkspaces`、
`NativeSystemAgentContents`、`NativeDiagnosticTargets` 等，多数只用 RM `public/` 的类型；`NativeProtocolBinding` 的参数是一族的
`RuntimeDriver`。

## 2. 机制与落位

**D1 运行时管理归 runtime-management 自己装配**

- RM 新增 `composition/localRuntimeManagement.ts` 的 `composeLocalRuntimeManagement`：逐字迁自原根（诊断目标、效果、绑定、探测回执钩子的
  恢复），输入去掉 `observations`（runtime-management 不认识 task-execution 的观测），加 `smoke(targets)`——返回 RM 效果自有的探测端口。
- RM `composition/crewstationRuntimeManagement.ts` 增 `composeCrewStationRuntimeManagement`：托管效果加 `composeRuntimeManagement`，探测由
  输入交入。
- task-execution 保留两个探测族：本机的根改为接收提供者（D3），诊断目标的类型改用自有的 `NativeDiagnosticTargets`；托管探测经 composition
  交出。
- bootstrap 配对：部署档案的 `runtimeManagement` 选择项改用 bootstrap 声明的选择签名（RM 的输入去掉 `smoke`、加 `observations`）。
  standalone 用 RM 的装配配本机探测族；CrewStation 由 bootstrap 用 `execution.hostedAgents` 建（托管探测配 RM 托管内容，交给 RM 的托管
  装配），`crewstationExecution` 不再产出这一项。

**D2 本机探测族的协议与运行证据取自材料定义**：与另两族一致，不再自己取驱动、另做协议绑定；`NativeProtocolBinding` 删除。唯一的差别是
未登记的协议改在编译时报错（原在打开时）——协议是校验过的 `RuntimeKind`，观察不到。

**D3 运行族的根只装 task-execution 自己的部分**

- 本机系统代理、托管系统代理、本机任务代理与本机探测的根改为「输入 + 提供者」：其他模块的实现作为带类型的提供者（task-execution 自有，
  放在 `nativeRunFamilyProviders.ts` 或对应根的旁边）交入；根里保留绑定适配、配置冻结、产出校验与夹具选择。
- bootstrap 新增运行族的提供者绑定（一个文件）：从 RM、RC、SC 的 composition 取实现，组出各族的提供者，交给 standalone 与 CrewStation 的
  选择，也供用例取用（用例与生产走同一份绑定）。
- `composeLocalTaskRunSelection` 的输入收任务代理族的提供者，由 bootstrap 交入。

**D4 本机调用的材料引用与运行证据由材料定义提供**

- `NativeMaterialDefinition` 的 `evidenceHooks` 换成 `evidence(scope)` 与 `materialReference(plan)`；RM 的 `selectLocalAgentMaterialDefinition`
  实现它们（`createLocalAgentMaterialEvidence({ hooks: driver, scope })`、`bindNativeAgentMaterialReference(plan)`），与原调用逐字相同。
- `bindNativeAgentInvocation` 的输入以 `evidence` 与 `materialReference` 取代 `evidenceHooks` 与 `evidenceScope`；材料引用照旧惰性求值。
- 调用方：本机三族的准备经材料定义交入；只供契约用例的 `nativeTaskAgentRun` 收材料定义（用例的 helper 交 RM 的）；一族的两个运行器用
  一族自己的包装。

## 3. 账本与计数

- 三份精确账本销去 21 对：task-execution → runtime-management 18 对，本机任务代理根指向 RC 的 1 对、SC 的 2 对；
  `cross-context-internal-file-pairs` 43 → 22，`counts.json` 收紧到实测（C13）。
- 跨 context import：task-execution 指向 RM、RC、SC composition 与 infrastructure 的边删去；bootstrap 指向各模块 composition 的边增加
  （装配根的允许形状）；runtime-management 的新装配是模块内边。
- public surface 不增（RM 的新导出在 `composition/`）；越 DAG 的值边与 offered 文件对不升；`R1`、`R2` 不增（一族改用自己已有的包装）。
- 减速带 60 项不升；task-execution composition 的控制流计数随根的形状核对。

## 4. 用例

`rfc489-run-family-providers-boundary`（AST，带负对照）：

1. task-execution 的全部生产文件（语料下限 700）对 runtime-management 只取 `public/`，本机任务代理根不取 RC、SC 的 composition；相对路径、
   `@/` 别名、re-export、动态 import 与 type-only 都认。
2. 运行时管理的两个装配只在 RM composition 声明一次；task-execution 里不出现 `bindRuntimeManagement`、`composeRuntimeManagement`、
   `createLocalRuntimeManagementEffects`、`createCrewStationRuntimeManagementEffects`。
3. 本机探测族不出现 `getRuntimeDriver`、`bindProtocol`；`NativeProtocolBinding` 不再声明。
4. `agentInvocation.ts` 不取 RM 的 `infrastructure/`；材料定义的成员集合钉住。
5. bootstrap 的提供者绑定：standalone 与 CrewStation 的选择取它；部署档案的选择签名在 bootstrap 声明。
6. 行为对拍：RM 材料定义的运行证据与材料引用等于原构造；探测族拿到的协议与运行证据钩子等于原来的；运行时管理装配（含探测回执钩子的
   恢复）与原来一致。

既有用例按新装配改指，断言意图不变：三份精确账本；`rfc422`（声明位置、根不含入口记号、入口的 import 规则）；`rfc380` 的工厂清单；
调用这些根的用例与 helper（取 bootstrap 的绑定）；读这些文件文本的用例（`rfc143`、`rfc370-node-run-prompt-bindings`、
`opencode-spawn-pwd-env`、`rfc108` 等）。

## 5. 失败模式

- 遗漏：task-execution 仍取 RM 内部 → 第 1 条与三份账本红。
- 行为偏移：提供者接错、探测族的协议或运行证据变了、探测回执钩子没恢复 → 第 6 条与运行时管理、各运行族的既有用例红。
- 装配漏传：提供者是必填，`tsc` 报缺。

## 6. 取舍（可推翻）与实施中的细化

细化：（实施中补。）

取舍：

- **跨模块的绑定放 bootstrap，各根保留自己的部分**：根里有 task-execution 自己的逻辑（绑定适配、配置冻结、产出校验、夹具选择），整根挪进
  bootstrap 会把这些也带走；只把其他模块的实现改成提供者，根仍是 task-execution 的装配。
- **运行时管理的装配归 runtime-management**：那是 runtime-management 装它自己（效果、应用、绑定），task-execution 只该交探测族。
- **探测族改用材料定义**：另两族已经这样做，材料定义给出的协议与运行证据钩子与手工构造相同，删掉一个只为这一族存在的提供者。
- **本 RFC 不碰 task-execution 对一族的其余使用**：它们需要 task-execution 自有的驱动端口，形状另议（下一步）；本 RFC 只清跨模块的内部对。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：运行时管理的装配在 runtime-management 的 composition；运行族的根在 task-execution 的 composition、只装自己；跨模块的提供者绑定
  在 bootstrap；本机调用只用 RM `public/` 的类型。
- **C11**：public surface 不增。
- **C12**：RFC-489 用例覆盖 task-execution 全部生产文件（≥700）、RM 的两个装配、本机探测族与本机调用、bootstrap 的绑定，以及对拍。
- **C13**：`cross-context-internal-file-pairs` 收紧到实测；触及的减速带收紧到实测。
