# RFC-494 技术设计

## 1. 现状（HEAD `4df065e73`，源码实读）

development-automation `composition/employeeTypePackage.ts`（5,478 行）按顺序是：

- 第 37～1872 行：开发员工的工具合同表（`WorkContract`、`ToolImplementation`、各合同的输入输出字段与样例）、执行合同登记
  （`developmentExecutionContractRegistrations`）、隐式代理合同声明（`developmentImplicitAgentContractDeclarations`）、角色与几个运行时 schema；
- 第 1873～3091 行：`runtimePackage`——包语义（描述符、工作范围解析与摘要、合同样例校验等），只在本文件里用；
- 第 3092～3114 行：`developmentEmployeeTypePackage`（`EmployeeTypePackageRegistration`）：把 `runtimePackage` 与旧程序升级包成 JSON 进出的
  登记对象；bootstrap 的 `daemonModules/digitalEmployee.ts`、`daemonModules/integration.ts` 把它交给 digital-employee；
- 第 3115 行起：`mergeRequestLifecycleDescriptor`、七个上下文 schema 与内部的反应 / 调用 schema、`developmentEmployeeRuntimeCodec`（第 3806～5464
  行）与 `mergeRequestLifecycleRuntimeCodec`。

全文件没有 `await`（两处命中在字符串里），不取库、文件系统与进程。它取 shared、zod、`@/util/gitRef`、本模块 domain 的
`mergeRequestLifecycle`，以及两个其他模块的 `public/types`：执行合同登记按 execution-contract 的 `ExecutionContractRegistration` /
`ExecutionContractField` 定型并用它的结果端口与脚本输入常量；运行时编解码器实现 digital-employee 的 `EmployeeTypeContextCodec`、
`EmployeeTypeReactionCodec`、`EmployeeTypeCollaborationCodec`，并用它的平台工作项 slotRef 常量。另取两个同样不做 IO 的文件：

- `composition/digitalEmployeeToolContractsV2.ts`（1,013 行）：`developmentWorkContractsV2`、`developmentExecutionContractRegistrationsV2`；取
  execution-contract 的 `public/types`、本模块 domain 的 `digitalEmployeeToolContractsV2`（合同 id 与 schema）与 application 的工具结果投影。
- `composition/legacyDevelopmentProgramUpgrade.ts`（179 行）：`upgradeLegacyDevelopmentProgram`，把已退役的 v1 合同程序升级成兼容包装的
  **源码文本**（文件里的 `node:fs`、`node:child_process` 在模板字符串里，是生成的脚本，不是本文件的 import）。

工具结果投影 `application/digitalEmployeeToolContractProjectionV2.ts`（589 行，取 `@/util/hash` 与 `@/util/platformExec`）已在 application。

使用方：迁出的名字被生产 4 个文件（development-automation 的 `graphDeliveryBridge`、`digitalEmployeePlatformWorkItems`、
`employeeCaseDetailProjection`、`graphDeliveryLifecycle`）、用例 18 个与测试 helper 1 个取；e2e 只取登记对象。登记对象的使用方（bootstrap 两处、
`graphDeliveryLifecycle`、用例与 e2e）位置不变。

## 2. 机制与落位

### D1 落 application，不落 domain

RFC-294 design §3 的矩阵：module `domain` 只能取 shared 中性值对象与本模块 domain，**其他模块的任何文件都不行**；module `application` 可以
取本模块 domain / ports 与其他模块受控 public 的精确入口。development-automation 的 `rfc310-architecture-lock` 把 domain 这一条落成了门
（domain 只许 `zod`、`@/util/hash`、shared 与本模块 domain）。这批内容按 execution-contract 与 digital-employee 的 public 合同定型（§1），
所以整体落 application；本模块自己的合同 id、schema 与 MR 生命周期判定早已在 domain（`domain/digitalEmployeeToolContractsV2.ts`、
`domain/mergeRequestLifecycle.ts`），迁出的文件照旧取它们。

### D2 合同与编解码 → `application/employeeTypePackage.ts`

`composition/employeeTypePackage.ts` 第 3092～3114 行以外的全部内容原样迁入。为让留在 composition 的登记对象取得到，给 `runtimePackage`、
`WorkContract`、`ToolImplementation` 加上 `export`（只加关键字，不改名、不改体）。

### D3 两个依赖文件一起归 application

- `composition/digitalEmployeeToolContractsV2.ts` → `application/digitalEmployeeToolContractRegistrationsV2.ts`（domain 已有同名的
  `digitalEmployeeToolContractsV2.ts`，放的是合同 id 与 schema；新名说明它是执行合同登记）。
- `composition/legacyDevelopmentProgramUpgrade.ts` → `application/legacyDevelopmentProgramUpgrade.ts`。
- 工具结果投影已在 application，不动；合同登记与它同层互取。

文件内容逐字不变，只加头注、改 import 的相对路径。三个新文件都不取 infrastructure、composition 与 IO 包，不执行 FS / 进程 / 网络 effect
（RFC-294 常驻规则 2；旧程序升级里的 `node:fs` 与 `node:child_process` 在它生成的源码文本里，按语法树认边的模块分层门不把它当 import）。

### D4 composition 只留登记对象

`composition/employeeTypePackage.ts` 只剩 `developmentEmployeeTypePackage`，从 `../application/employeeTypePackage` 取 `runtimePackage` 与两个
类型，从 `../application/legacyDevelopmentProgramUpgrade` 取升级函数。登记对象没有循环、`switch`、`try` 与 `throw`。bootstrap 只经模块的
composition 进入模块（R1），它要接线的三个值（`developmentEmployeeRuntimeCodec`、`developmentExecutionContractRegistrations`、
`developmentImplicitAgentContractDeclarations`）由这个文件转出给它（与 RFC-492 的 `composition/runtimeDrivers.ts` 同形），bootstrap 的 import
不变；模块内的代码与用例从 application 取。

### D5 使用方与账本

- 迁出名字的 import 逐个改到新位置（别名与相对写法保持原样）；同时取登记对象与迁出名字的拆成两条。
- 读这几个文件源码的锁随内容改指（按 RFC-493 的教训：按文件名本身、路径片段与代码里的字符串字面量全仓扫，含 e2e 与其他包）；e2e 注释里
  指向旧文件的两处引用一并更正。
- `composition-control-flow-development-automation` 收紧到实测；`commons-debt.json` 里指向 `employeeTypePackage.ts:1412-1436` 的锚点按内容在新
  文件里重新定位。
- RFC-310 的 OS 依赖清单（`design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json`）逐条登记了取
  digital-employee 与 execution-contract 的外部文件：取 execution-contract `public/types` 的两条随文件改指 application；composition 的登记对象
  仍取 digital-employee 的 `public/types`，application 的新文件再添一条。

## 3. 清单（退出门）

迁出后旧位置不声明、不转出：

- `application/employeeTypePackage.ts`：`developmentExecutionContractRegistrations`、`developmentImplicitAgentContractDeclarations`、
  `mergeRequestLifecycleDescriptor`、`issueHandlingContextSchema`、`mergeRequestContextSchema`、`changeCandidateContextSchema`、
  `pipelineContextSchema`、`problemSetContextSchema`、`reviewResolutionContextSchema`、`approvalContextSchema`、`developmentEmployeeRuntimeCodec`、
  `mergeRequestLifecycleRuntimeCodec`，以及新交出的 `runtimePackage`、`WorkContract`、`ToolImplementation`（15 个）。
- `application/digitalEmployeeToolContractRegistrationsV2.ts`：`developmentWorkContractsV2`、`developmentExecutionContractRegistrationsV2`。
- `application/legacyDevelopmentProgramUpgrade.ts`：`upgradeLegacyDevelopmentProgram`。

`composition/employeeTypePackage.ts` 只交出 `developmentEmployeeTypePackage` 与给 bootstrap 的三个转出（D4）；迁走的两个文件删除。

## 4. 用例

新增 `rfc494-development-employee-type-package-out-of-composition-boundary`（AST，带负对照，登记 guard-manifest；文件名带 `boundary`，
守卫普查按文件名认守卫）：

- ① 清单里每个名字在全部生产文件里只在表里的新文件声明。
- ② `composition/employeeTypePackage.ts` 交出的恰好是登记对象与给 bootstrap 的三个转出、不声明清单里的名字；迁走的两个文件不存在。
- ③ 全部生产文件、用例与 e2e 都不从旧位置取清单里的名字（import / export-from / type-only / 动态 import 的解构，带负对照；登记对象照常
  可取）；只有 bootstrap 的装配根经 composition 取那三个转出。
- ④ 三个新文件的依赖面是闭集：zod、shared、`@/util/gitRef`、其他模块 public 的精确入口与本模块 domain / application；没有 `async` /
  `await` 与 `process` / `Bun` 全局（带负对照：越界 import、动态 import 与进程全局都认出，模板字符串里的 import 文本不算）。

另外依赖现有用例原样跑作逐字迁移的对拍：员工类型包与运行时编解码（`digital-employee-type-package-drift`、`rfc318-*`、`rfc336-*`、
`rfc396-mr-*`、`rfc310-*` 等）、执行合同登记与 e2e 的开发类型引用（`e2e-development-type-ref`）；RFC-294 的模块分层门与
development-automation 的 `rfc310-architecture-lock` 覆盖新文件的落层。

## 5. 失败模式

- 迁移漏掉一处被登记对象或别处取用的内部名字：`tsc` 报未声明；用例 ① ② 钉住每个名字的唯一位置。
- 读旧文件源码的锁在内容迁走后静默变空：按 RFC-493 的扫法逐条看断言的对象，改指新文件。
- 落层越过模块锁：`rfc310-architecture-lock` 与 RFC-294 的模块分层门在集中验证里跑，用例 ④ 钉住新文件的依赖面。
- e2e 从 backend 直接取这些名字：一并改指，Playwright 的 e2e 在 CI 上覆盖。

## 6. 取舍（可推翻）

1. **落 application，不落 domain**：S10 的范围写“合同 schema 与 codec 归 domain”，但 design §3 的矩阵不许 domain 取其他模块的任何文件，
   这批内容又按 execution-contract 与 digital-employee 的 public 合同定型。要进 domain，得先给它们另立本模块自己的类型、再在 application
   里做一层适配——那是改写，不是本步的目标，也会失去逐字对拍的证据。其中只依赖 zod 与 shared 的上下文 schema 与工作范围规则，以后可以
   再分进 domain（§8）。
2. **整块迁入，不拆**：5.4k 行的合同文件照原样进 application；按合同 / schema / 编解码再拆是可读性重构，不是本步的目标，且会失去逐字
   对拍的证据。
3. **投影不动**：它本来就在 application，被合同登记取，迁过来后同层互取。
4. **登记对象留在 composition**：它把包语义适配成 digital-employee 的登记端口（JSON 进出），是装配；bootstrap 取它的位置不变。
5. **工具合同登记改名**：domain 里已有同名文件（合同 id 与 schema），新名按内容（执行合同登记）区分，不合并两个关注点。
6. **组合层分支上限**：本步只把 `composition-control-flow-development-automation` 收紧到实测；S10 要求的各模块上限（经用户确认）在 S10 收口时
   定，按授权由本会话决定并记为已批准。

实施中的细化（都在本 RFC 范围内）：

1. **落点从 domain 改为 application**（集中验证时）：落档时按 S10 的字面写了 domain，并把投影也迁进 domain；第一轮集中验证里
   `rfc310-architecture-lock` 报 domain 不纯——取 digital-employee 与 execution-contract 的 `public/types`、`@/util/gitRef`、`@/util/platformExec`，
   旧程序升级的模板文本也被它按正则认成 `node:fs`。按取舍 1 改落 application，投影留在原处，RFC 目录名随之由
   `…-into-domain` 更正为 `…-out-of-composition`（RFC 索引与 `STATE.md` 的链接同步）。
2. **bootstrap 仍经 composition 取**：按名字批量改 import 时，bootstrap 的 `daemonModules/digitalEmployee.ts` 也被改成直取模块内的文件——那是
   R1 的越界边（bootstrap 只经模块的 composition 进入模块）。改为由 `composition/employeeTypePackage.ts` 转出 bootstrap 要接线的三个值，
   bootstrap 的文件恢复原样（D4）。
3. **读源码的登记与锁改指新文件**：架构报告的受管字段面（`catalogVisibility: 'internal'` 的落点）、RFC-284 进程启动点棘轮里旧程序
   升级的条目（生成的包装器源码里有 `spawnSync`）、RFC-317 平台工作项 slotRef 的类型包一侧、RFC-323 的否定锁（类型包不含
   `purpose: 'requirement-source'`，内容迁走后会静默变空）；`commons-debt.json` 的锚点按内容重新定位（行号恰好不变）；e2e
   `rfc319-de-case-and-wizard.spec.ts` 注释里指向旧文件名与旧行号的两处引用改指新文件。
4. **早已存在的同名项**：`mergeRequestContextSchema`（`composition/digitalEmployeeWorkspace.ts` 里另有一份，S10 后继步骤处理）与
   `WorkContract`、`ToolImplementation`（digital-employee 的 domain 模型里各有一个同名类型）在 RFC-494 用例 ① 里逐个钉住。
5. **集中验证补上的两处登记**：RFC-494 用例的文件名起初没有守卫普查认的词（`architecture/census.ts` 的 `GUARD_FILE_NAME_PATTERN`），
   guard-manifest 登了它、磁盘普查却不认，RFC-317 的三本守卫账本因此报差一条；按 RFC-488～493 的写法改名为 `…-boundary.test.ts`。
   RFC-310 的 OS 依赖清单按文件登记外部边，迁移后差三条，按 D5 改指（`rfc310-digital-employee-os-architecture` 钉住）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是合同、规则与编解码，落 application（矩阵许它取其他模块 public 的精确入口，domain 不许）；composition 只留装配；不新增
  用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-494 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import（语料下限在 guard-manifest 写明），另读 composition 的
  登记文件与三个新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第一步——全仓最大的 composition 文件只剩装配，另两个依赖文件迁出；
  `composition-control-flow-development-automation` 660 → 491。
- **留下**：`application/employeeTypePackage.ts` 仍是 5.4k 行的一整块，其中只依赖 zod 与 shared 的上下文 schema 与工作范围规则可以再分进
  domain，按 execution-contract / digital-employee 合同定型的执行合同登记与运行时编解码器留在 application；`mergeRequestContextSchema` 在
  `composition/digitalEmployeeWorkspace.ts` 另有一份；development-automation `composition/` 的其余 S10 范围（工作项用例、工作区策略、mission /
  config 操作、交付桥）由后继步骤承接。
