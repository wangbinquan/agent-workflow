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

全文件没有 `await`（两处命中在字符串里），不取库、文件系统与进程。它取 shared、zod、digital-employee 与 execution-contract 的 `public/types`、
`@/util/gitRef`、本模块 domain 的 `mergeRequestLifecycle`，以及三个同样是纯函数的文件：

- `composition/digitalEmployeeToolContractsV2.ts`（1,013 行）：`developmentWorkContractsV2`、`developmentExecutionContractRegistrationsV2`；取
  execution-contract 的 `public/types`、本模块 domain 的 `digitalEmployeeToolContractsV2`（合同 id 与 schema）与下面的投影。
- `application/digitalEmployeeToolContractProjectionV2.ts`（589 行）：`projectDevelopmentToolInputV2`、`projectDevelopmentToolResultV2`；取 shared、
  zod、`@/util/hash`、`@/util/platformExec`（`isLexicallyInsideForHost`，词法路径判断）与 domain 的合同。
- `composition/legacyDevelopmentProgramUpgrade.ts`（179 行）：`upgradeLegacyDevelopmentProgram`，把已退役的 v1 合同程序升级成兼容包装的
  **源码文本**（文件里的 `node:fs`、`node:child_process` 在模板字符串里，是生成的脚本，不是本文件的 import）。

使用方：迁出的名字被生产 4 个文件（development-automation 的 `graphDeliveryBridge`、`digitalEmployeePlatformWorkItems`、
`employeeCaseDetailProjection`、`graphDeliveryLifecycle`）、用例约 30 个与 e2e 若干个取；登记对象被 bootstrap 两处、`graphDeliveryLifecycle`、
用例与 e2e 共 33 处取，位置不变。

## 2. 机制与落位

### D1 合同与编解码 → `domain/employeeTypePackage.ts`

`composition/employeeTypePackage.ts` 第 3092～3114 行以外的全部内容原样迁入。为让留在 composition 的登记对象取得到，给 `runtimePackage`、
`WorkContract`、`ToolImplementation` 加上 `export`（只加关键字，不改名、不改体）。

### D2 三个依赖文件一起归 domain

- `composition/digitalEmployeeToolContractsV2.ts` → `domain/digitalEmployeeToolContractRegistrationsV2.ts`（domain 已有同名的
  `digitalEmployeeToolContractsV2.ts`，放的是合同 id 与 schema；新名说明它是执行合同登记）。
- `application/digitalEmployeeToolContractProjectionV2.ts` → `domain/digitalEmployeeToolContractProjectionV2.ts`：它是纯投影与校验；留在
  application 会让 domain 反过来取 application。
- `composition/legacyDevelopmentProgramUpgrade.ts` → `domain/legacyDevelopmentProgramUpgrade.ts`。

文件内容逐字不变，只改 import 的相对路径。domain 取其他 context 的 `public/types`、`@/util/hash`、`@/util/gitRef`、`@/util/platformExec`
都不触 RFC-294 的模块分层门（domain 不取 fs / 进程、hono / drizzle / sqlite、`src/{db,ws,routes,server}` 与任何 infrastructure）。

### D3 composition 只留登记对象

`composition/employeeTypePackage.ts` 只剩 `developmentEmployeeTypePackage`，从 `../domain/employeeTypePackage` 取 `runtimePackage` 与两个类型，从
`../domain/legacyDevelopmentProgramUpgrade` 取升级函数。登记对象没有循环、`switch`、`try` 与 `throw`。

### D4 使用方与账本

- 迁出名字的 import 逐个改到新位置（别名与相对写法保持原样）；同时取登记对象与迁出名字的拆成两条。
- 读这几个文件源码的锁随内容改指（按 RFC-493 的教训：按文件名本身、路径片段与代码里的字符串字面量全仓扫，含 e2e 与其他包）。
- `composition-control-flow-development-automation` 收紧到实测；`commons-debt.json` 里指向 `employeeTypePackage.ts:1412-1436` 的锚点按内容在新
  文件里重新定位。

## 3. 清单（退出门）

迁出后旧位置不声明、不转出：

- `domain/employeeTypePackage.ts`：`developmentExecutionContractRegistrations`、`developmentImplicitAgentContractDeclarations`、
  `mergeRequestLifecycleDescriptor`、`issueHandlingContextSchema`、`mergeRequestContextSchema`、`changeCandidateContextSchema`、`pipelineContextSchema`、
  `problemSetContextSchema`、`reviewResolutionContextSchema`、`approvalContextSchema`、`developmentEmployeeRuntimeCodec`、
  `mergeRequestLifecycleRuntimeCodec`，以及新交出的 `runtimePackage`、`WorkContract`、`ToolImplementation`（15 个）。
- `domain/digitalEmployeeToolContractRegistrationsV2.ts`：`developmentWorkContractsV2`、`developmentExecutionContractRegistrationsV2`。
- `domain/digitalEmployeeToolContractProjectionV2.ts`：`projectDevelopmentToolInputV2`、`projectDevelopmentToolResultV2`。
- `domain/legacyDevelopmentProgramUpgrade.ts`：`upgradeLegacyDevelopmentProgram`。

`composition/employeeTypePackage.ts` 只交出 `developmentEmployeeTypePackage`；三个旧文件删除。

## 4. 用例

新增 `rfc494-development-employee-type-package-domain-boundary`（AST，带负对照，登记 guard-manifest）：

- ① 清单里每个名字在全部生产文件里只在表里的新文件声明。
- ② `composition/employeeTypePackage.ts` 只交出登记对象、不声明清单里的名字；三个旧文件不存在。
- ③ 全部生产文件、用例与 e2e 都不从旧位置取清单里的名字（import / export-from / type-only / 动态 import 的解构，带负对照；登记对象照常
  可取）。
- ④ 四个新文件不取 infrastructure、application、composition、IO 包与进程全局，没有 `async` / `await`。

另外依赖现有用例原样跑作逐字迁移的对拍：员工类型包与运行时编解码（`digital-employee-type-package-drift`、`rfc318-*`、`rfc336-*`、
`rfc396-mr-*`、`rfc310-*` 等）、执行合同登记与 e2e 的开发类型引用（`e2e-development-type-ref`）；RFC-294 的模块分层门覆盖新文件。

## 5. 失败模式

- 迁移漏掉一处被登记对象或别处取用的内部名字：`tsc` 报未声明；用例 ① ② 钉住每个名字的唯一位置。
- 读旧文件源码的锁在内容迁走后静默变空：按 RFC-493 的扫法逐条看断言的对象，改指新文件。
- e2e 从 backend 直接取这些名字：一并改指，Playwright 的 e2e 在 CI 上覆盖。

## 6. 取舍（可推翻）

1. **四个文件整块迁入，不拆**：5.4k 行的合同文件照原样进 domain；按合同 / schema / 编解码再拆是可读性重构，不是本步的目标，且会失去逐字
   对拍的证据。
2. **投影从 application 迁入 domain**：它是纯的投影与校验，被合同登记取；留在 application 会让 domain 反向依赖 application。
3. **登记对象留在 composition**：它把 domain 的包语义适配成 digital-employee 的登记端口（JSON 进出），是装配；bootstrap 取它的位置不变。
4. **工具合同登记改名**：domain 里已有同名文件（合同 id 与 schema），新名按内容（执行合同登记）区分，不合并两个关注点。
5. **组合层分支上限**：本步只把 `composition-control-flow-development-automation` 收紧到实测；S10 要求的各模块上限（经用户确认）在 S10 收口时
   定，按授权由本会话决定并记为已批准。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是合同、规则与编解码，落 domain；composition 只留装配；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-494 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明与 import（语料下限在 guard-manifest 写明），另读旧的 composition 文件
  与四个新文件；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。
