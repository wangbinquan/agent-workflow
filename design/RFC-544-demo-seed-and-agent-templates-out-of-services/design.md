# RFC-544 技术设计

## 1. 现状（HEAD `c953ac2d1`，源码实读）

- `services/demoSeed.ts`：只 import `@agent-workflow/shared`、`@/auth/systemIdentity`、三个模块 public（code-capability `public/types`、
  resource-catalog 与 system-operations 的 `public/participants`）与 `@/util/log`；唯一调用方 `bootstrap/daemonApplication.ts:825` 动态
  import `seedDemoContent`。
- `services/digitalEmployeeAgentTemplates.ts`：旧版模板 ID、合并的全部 ID、计划分析者 ID、工具展示表与 `digitalEmployeeAgentToolPresentation`、
  旧版 8 个模板定义、旧版到 V2 的 `digitalEmployeeBuiltinAgentSuccessorId`、包着 V2 配置的 `digitalEmployeeBuiltinToolConfiguration`（纯数据与
  纯函数），以及 `ensureDigitalEmployeeAgentTemplates` / `listDigitalEmployeeAgentTemplates`（经 digital-employee 的模板目录参与者读写，碰撞时抛
  `ConflictError`）。它 import development-automation `public/participants` 的 V2 定义与 digital-employee `public/participants` 的参与者类型。
  调用方：`bootstrap/daemonApplication.ts`（启动对齐）、`bootstrap/daemonHttpComposition.ts`（列出）、`bootstrap/daemonModules/digitalEmployee.ts`
  （其余五个名字）。
- development-automation `public/participants.ts`（210 行）：转出证据暂存的两个断言，并**声明** V2 的模板 ID、模板接口、8 个模板定义、
  流水线分类器的缺省类别与 `developmentBuiltinAgentConfigurationV2`；这些名字在生产代码里只被上面那个 services 文件使用。
- bootstrap 不深引任何模块的 application / domain（全仓 0 处），只取 public 与 composition。digital-employee 不 import development-automation，
  development-automation 已 import digital-employee 的 public。

## 2. 机制与落位

### D1 演示种子归 bootstrap

- `services/demoSeed.ts` 原样迁为 `bootstrap/demoSeed.ts`（全用 `@/` 绝对 import，内容不变）；`daemonApplication.ts` 的动态 import 改为
  `./demoSeed`。

### D2 代理模板归 development-automation

- owner 取 development-automation 而不是 plan 记的 digital-employee（W4-E9）：模板是开发数字员工的内置代理，V2 定义本来就在
  development-automation；放进 digital-employee 要新增 digital-employee → development-automation 的边，而现在只有反方向的边。
- 分层（proposal C10）：
  - `domain/developmentAgentTemplatesV2.ts`：`public/participants.ts` 里 V2 的声明逐字迁入（模板 ID、接口、模板定义、分类器缺省类别、
    `developmentBuiltinAgentConfigurationV2`）。
  - `domain/legacyDigitalEmployeeAgentTemplates.ts`：旧版模板 ID、合并的全部 ID、计划分析者 ID、工具展示、旧版 8 个模板定义、升级映射与
    工具配置（从 services 文件逐字迁入，V2 名字改取同层的 V2 文件）。
  - `application/digitalEmployeeAgentTemplates.ts`：两个用例与它们私有的存储形态还原、内容签名与单行对齐（逐字迁入），模板目录参与者类型
    仍取 digital-employee 的 public。
- `public/participants.ts` 只转出：证据暂存的两个断言照旧，另转出 bootstrap 用到的六个名字（两个用例、合并的全部 ID、升级映射、工具配置与
  工具展示）。V2 的名字不再从 public 转出——迁入后它们在本模块之外没有生产使用方，留在 public 只会成为没人消费的公开符号；测试改从
  domain 取。
- 不成环：domain 与 application 都不取本模块的 `public/participants.ts`（转出方向只有 public → domain / application）。若 application 仍从
  public 取 V2 而 public 又从 application 转出，模块求值时会在两个文件之间成环，顶层用到 V2 ID 的常量会落进暂时性死区。

### D3 用例与锁

- 新增 `tests/rfc544-demo-seed-and-agent-templates-out-of-services-boundary.test.ts`，登记 guard-manifest：① `services/` 没有这两个文件，迁入的
  四个文件在位且声明了各自的名字；② bootstrap 取这些名字只经 development-automation 的 public，`public/participants.ts` 不声明、只转出，
  development-automation 的 domain / application 不取本模块的 `public/participants`，digital-employee 不取 development-automation；③ 行为：
  合并的全部 ID 是旧版加 V2 各 8 个、升级映射逐个落到同位的 V2、工具配置只给分类器、public 转出的名字与 domain / application 的是同一份；
  ④ 带负对照。
- 随改：16 个用例的 import 路径；`rfc474-entry-adapter-bootstrap-assembly` 读首启示例源码的路径；`rfc476` / `rfc477` 负对照里“仍在
  `services/` 的兄弟文件”改用 `services/gitSubmodule.ts`；`rfc471` 的正对照把已不在 public 声明的 `developmentBuiltinAgentConfigurationV2` 换成
  转出的名字。

## 3. 清单（退出门）

| 原位置                                                     | 之后                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `services/demoSeed.ts`                                     | `bootstrap/demoSeed.ts`                                                                                                  |
| `services/digitalEmployeeAgentTemplates.ts`                | development-automation `domain/legacyDigitalEmployeeAgentTemplates.ts` 与 `application/digitalEmployeeAgentTemplates.ts` |
| development-automation `public/participants.ts` 的 V2 声明 | 同模块 `domain/developmentAgentTemplatesV2.ts`；public 只转出                                                            |

## 4. 用例

- ① ～ ④ 见 D3；既有用例覆盖对齐与碰撞（`digital-employee-agent-template-reconcile`）、V2 合同（`rfc318-minimal-digital-employee-tool-contracts`）、
  首启示例（`rfc307-demo-seed`、`rfc395-demo-template-only`）与组合接线。

## 5. 失败模式

- **模块内成环**：见 D2 最后一条；RFC-544 用例钉 domain / application 不取本模块 public。
- **漏转出**：bootstrap 取不到名字时类型检查即失败；RFC-544 用例另钉 public 转出的名字与 domain / application 的是同一份。
- **钉旧路径的用例漏改**：按旧路径的字符串形态在全部用例里搜，随改清单见 D3。

## 6. 取舍（可推翻）

1. **owner 取 development-automation**：理由见 D2；偏离 plan §4.7 的 “W4-E9” 标注。
2. **V2 数据一并迁出 public**：不迁就只能把新名字放进别的 public 文件或让 application 反取 public（成环）；迁出后 public 只转出，符合
   “public 是合同”的方向。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：按内容分层落位（数据与纯函数进 domain，用例进 application，编排归 bootstrap）。**C11**：development-automation 的 public 只转出，
  新增六个名字都有 bootstrap 消费，V2 的五个名字不再公开。**C12**：RFC-544 用例覆盖。**C13**：减速带计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：§4.7 “其余”一族第二步（2 个文件，`services/` 6 → 4）。
- **留下**：`services/codeRoundContract.ts`（W4-E8）与 git 一族 3 个文件（W5，与 `util/git.ts` 一并设计）。
