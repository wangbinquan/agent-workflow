# RFC-513 设计：代码能力与资源目录组合层余下的 throw 迁出 composition

## 1. 现状（HEAD，源码实读）

| 文件                                                         | 内容（HEAD 行）                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `code-capability/composition/historyQueries.ts`              | `composeCodeHistoryQueries` 的 `history` 缺省值（45～52）：`rows` / `find` 两个操作都抛 `CodeHistoryReadError(…)` |
| `resource-catalog/composition/resourcePackageMaintenance.ts` | `composeResourcePackageApplyMaintenance` 里恢复产物端口与恢复效果工厂同时给出时的核对（53～58）                   |

F13 口径：code-capability 组合层 2 行（第 47、50 行的 `throw`），resource-catalog 的这个文件 2 行（第 53 行的 `if`、第 58 行的 `throw`）。

读这两个组合文件的用例：`rfc349-resource-package-maintenance` 读 `resourcePackageMaintenance.ts` 原文、只断言恢复场景、活动追踪与带版本的产物恢
复三处装配仍在（不受影响）；`architecture/rfc395-a6-atomic-apply` 读它、只拒绝生命周期写入与按错误回退的编解码（不受影响）；
`rfc395-history-readonly` 从 `historyQueries.ts` 出发算运行时 import 闭包、要求不载入转换器、源读取器与执行器（新文件只取本模块的 domain 与端
口）；按错误串断言的 `rfc395-history-response-parity` 与 `rfc370-resource-package-recovery-effects` 经装配入口对拍。

## 2. 机制与落位

### D1 归 application

- **`code-capability/application/unboundHistoryReader.ts`**（新）：`createUnboundCodeHistoryReader(): CodeHistoryReader` 返回 HEAD 第 45～51
  行的对象字面量（逐字），取 `../domain/codeHistoryPackage` 的 `CodeHistoryReadError` 与 `./ports/historyReader` 的类型。
- **`resource-catalog/application/resourcePackageMaintenance.ts`**（增）：`requireExclusiveRecoverySelection(input)`，入参是装配入口的
  `artifacts` 与 `recoveryEffectsFactory` 两项，函数体是 HEAD 第 53～58 行逐字；恢复效果工厂的类型取本模块的
  `./package/recoveryContentEffects`。

### D2 composition 只装配

- `composeCodeHistoryQueries` 的 `history` 缺省值改为 `createUnboundCodeHistoryReader()`（缺省值仍在每次未给 `history` 的调用时求值，与 HEAD
  每次新建对象字面量一致）；不再取 `CodeHistoryReadError`。
- `composeResourcePackageApplyMaintenance` 在原位置（建活动登记与日志之后、选效果工厂之前）调用 `requireExclusiveRecoverySelection(input)`。

### D3 锁与账本

- `architecture/counts.json`：`composition-control-flow-code-capability` 2 → 0，`composition-control-flow-resource-catalog` 77 → 75（按实测）。
  `guard-manifest.json` 登记 RFC-513 用例（`assertsAbsence: true`，“不存在”写成 `toEqual([])` 的字面形态）。
- 迁移前按路径扫用例里的 `readFileSync` 与按语料计数的账本：见 §1；两个模块都没有类似 `rfc423` 的 throw 账本。

## 3. 清单（退出门）

| 位置                                                               | 声明并交出                          |
| ------------------------------------------------------------------ | ----------------------------------- |
| `code-capability/application/unboundHistoryReader.ts`（新）        | `createUnboundCodeHistoryReader`    |
| `resource-catalog/application/resourcePackageMaintenance.ts`（增） | `requireExclusiveRecoverySelection` |

允许的形状：code-capability 组合层没有控制流、不构造错误；`resourcePackageMaintenance.ts`（组合层）没有 `if` / `throw`、不构造错误。

## 4. 用例

新增 `packages/backend/tests/rfc513-code-history-and-package-recovery-throws-out-of-composition-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字。
- ② code-capability 组合层的文件没有控制流、不构造错误；`resourcePackageMaintenance.ts` 同样；两个名字在生产代码里只被各自的组合文件调用一次，
  实参钉住；带负对照。
- ③ 新文件的依赖面是闭集（import 逐条钉住），不用进程全局；增名字的 application 文件不取 infrastructure 与 composition；带负对照。
- ④ 行为：未绑定读取器的两个操作以原文错误拒绝；互斥核对在两项都给时抛原文错误，产物端口为 `null` / 缺省或只给其一时放行。

## 5. 失败模式

- **走样**：按 HEAD 原行切片生成，用词法单元比对复核。
- **缺省值的求值时机**：仍是参数缺省值，每次未给 `history` 时求值。
- **读原文的锁与按语料计数的账本**：已预查（§1、D3）。

## 6. 取舍（可推翻）

1. **未绑定读取器单独成文件**：它是端口的一个实现（空对象），不属于查询工厂，也不该进端口文件。
2. **互斥核对并入 `application/resourcePackageMaintenance.ts`**：它声明恢复产物端口，核对与它同属维护装配的输入。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是空读取器与装配期核对，落 application；组合文件只装配与选择。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-513 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读两个组合文件与新位置。
- **C13**：两项计数收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 code-capability 与 resource-catalog 的收口：两个模块组合层里 RFC-370 之外不再有 `try` / `throw`。
- **留下**：task-execution 组合层的运行时绑定与引擎（`taskEngineApplication.ts` 的驱动入口与端口构造、`digitalEmployeeExecution.ts` 的取消、
  本地配置桥等，含余下的三个 `throw`）另立后继；各模块的装配期选择按 S10 的分支上限处理；`crewstation*` / `taskImage*` 待 RFC-370 余项；S10 的
  全模块门另立。
