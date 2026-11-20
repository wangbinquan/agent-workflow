# RFC-518 设计：托管实现迁出组合层（一）

## 1. 现状（HEAD，源码实读）

RFC-515 门的例外清单剩 27 个文件，全是 RFC-370 的托管实现。按“是否取本模块别的组合文件”分两类：

| 模块（`packages/backend/src/modules/` 下） | 迁走的文件（`composition/` 下，行数）                                                                                                                                                                                     | 消费方                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `development-automation`                   | `crewstationEvidence`（81）、`crewstationEvidenceStaging`（118）、`crewstationVerification`（128）、`crewstationWorkspace`（247）、`taskImageEvidence`（48）、`taskImageVerification`（225）、`taskImageWorkspace`（228） | bootstrap 的 `crewstation.ts`、`crewstationMaintenance.ts`、`workspaceTaskImage.ts`；互相 |
| `digital-employee`                         | `crewstationContent`（140）                                                                                                                                                                                               | 模块根转出                                                                                |
| `event-center`                             | `taskImageObserver`（46）                                                                                                                                                                                                 | 模块根转出                                                                                |
| `integration`                              | `crewstationDevelopmentAdapters`（153）、`taskImageDevelopmentAdapter`（172）                                                                                                                                             | bootstrap 的 `crewstation.ts`、`workspaceTaskImage.ts`                                    |
| `intent`                                   | `crewstationScratch`（34）                                                                                                                                                                                                | bootstrap 的 `crewstationMaintenance.ts`                                                  |
| `resource-catalog`                         | `crewstationArtifacts`（78）、`crewstationNativePlugin`（43）、`taskImagePlugin`（280）                                                                                                                                   | bootstrap 的 `crewstation.ts`、`crewstationMaintenance.ts`、`workspaceTaskImage.ts`       |
| `runtime-management`                       | `crewstationSystemAgentMaterial`（139）、`taskImageMaterial`（40）                                                                                                                                                        | bootstrap 的 `runFamilyProviders.ts`、`workspaceTaskImage.ts`                             |
| `source-control`                           | `crewstationWorkspace`（268）、`taskImageIsolation`（111）、`taskImageRepositoryEffects`（311）、`taskImageUploads`（166）、`taskImageWorkspace`（540）                                                                   | bootstrap 的 `crewstation.ts`、`crewstationMaintenance.ts`、`workspaceTaskImage.ts`；互相 |
| `system-operations`                        | `crewstationDatabaseRestore`（104）                                                                                                                                                                                       | bootstrap 的 `deployment.ts`；留下的 `crewstationDeployment.ts`                           |

留在组合层的 4 个：intent `crewstationArtifacts`（取 `./apply` 的类型）、resource-catalog `crewstationMcpDiagnostics`（取 `./mcpDiagnostics`
等三个组合文件的装配函数）、runtime-management `crewstationRuntimeManagement`（取 `./runtimeManagement`）、system-operations
`crewstationDeployment`（取 `./applicationConfiguration`）。它们迁入 infrastructure 会形成 infrastructure → composition 的边，要先拆开装配与
实现。

迁走的 23 个里，只有两处取组合层：digital-employee `crewstationContent` 与 source-control `crewstationWorkspace` 取本模块
`composition/required-ports` 的端口类型（collaboration 的 infrastructure 已有同样的取法）；其余只取本模块的
application / domain / ports / infrastructure、platform 与他模块 public，以及同批迁走的兄弟文件。

钉着旧路径的锁：RFC-515 门的例外清单；`rfc376-structural-guards` 的跨 context 文件对账本
（`crewstationEvidence`、`crewstationContent`、`crewstationNativePlugin` 三条）与 `composition-forbidden-import-files` 清单（12 条，全在本
批）；`rfc294-review-offered-edge-dag` 的三条 `from:`；18 个用例从旧路径 import；两个用例按旧路径读 source-control `crewstationWorkspace.ts`
的原文。`rfc416` / `rfc417` 里写着 `composition/crewstationSystemAgentMaterial` 的是伪造的负对照（证明“取组合层”会被认出），与文件在不在无
关，不改。

## 2. 机制与落位

### D1 原样归 infrastructure

- 23 个文件从 `modules/<模块>/composition/<文件>.ts` 迁到 `modules/<模块>/infrastructure/crewstation/<文件>.ts`，文件名不变（目标目录里没有
  同名文件）。
- 内容逐字不变，只重算相对 import：按旧位置解析出目标，再按新位置写出相对路径（`../application/…` →
  `../../application/…`，`../infrastructure/crewstation/…` → `./…`，同批迁走的兄弟仍是 `./…`，`./required-ports` →
  `../../composition/required-ports`）。`@/` 开头的 import 不动。

### D2 消费方

- **模块根转出**：bootstrap 用到的名字由模块根 `composition.ts` 从新位置照旧名转出——development-automation 9 个、integration 2 个、intent
  1 个、resource-catalog 3 个、runtime-management 2 个、source-control 2 个、system-operations 1 个；digital-employee 与 event-center 的模块
  根本来就转出，只改路径。
- **bootstrap**：五个文件里的 20 条 `@/modules/<模块>/composition/<文件>` import 改为 `@/modules/<模块>/composition`，名字不变；bootstrap 对
  模块 infrastructure 的深引用仍是 0。
- **模块内**：同批迁走的兄弟之间不变；`system-operations/composition/crewstationDeployment.ts` 改从
  `../infrastructure/crewstation/crewstationDatabaseRestore` 取。

### D3 锁与计数

- RFC-515 门的例外清单删这 23 条（27 → 4），清单长度断言随改。
- `rfc376-structural-guards`：跨 context 文件对账本里三条随路径改名（排序随之调整），`composition-forbidden-import-files` 清单清
  空；`rfc294-review-offered-edge-dag` 的三条 `from:` 随路径改名。
- `architecture/counts.json`：`composition-forbidden-import-files` 12 → 0；九个模块的 `composition-control-flow-*` 上限收紧到实测（数字随实
  现提交写入，理由按既有格式写明本 RFC）。
- 18 个用例改从新路径 import，两个读原文的用例改读新路径；guard-manifest 登记 RFC-518 用例。

## 3. 清单（退出门）

- 新位置：上表 23 个文件都在 `infrastructure/crewstation/` 下，导出的名字与 HEAD 逐个相同。
- 旧位置：23 个旧路径都不存在；RFC-515 门的例外清单恰是 §1 的 4 个（组合层里另有只做装配、本就不在例外清单里的 `crewstation*` / `taskImage*`
  文件，不受影响）。
- 入口：bootstrap 经模块根取这些名字，模块根的转出与新位置的导出是同一个对象。

## 4. 用例

新增 `packages/backend/tests/rfc518-hosted-implementations-out-of-composition-boundary.test.ts`，登记 guard-manifest：

- ① 23 个文件只在新位置、旧位置不存在，新位置的导出名字逐个钉住；RFC-515 门的例外清单恰是 §1 的 4 个。
- ② 全部生产文件里没有 import 指向 23 个旧路径；bootstrap 不深引用任何模块的 infrastructure；模块根转出的名字与新位置导出的是同一个对象（逐
  名比对）。
- ③ 23 个新位置文件不取任何组合文件，例外只有两处本模块 `required-ports` 的类型 import（逐条钉住）；带负对照（取组合文件、取别的模块的组合文
  件、取 required-ports 的值都会被认出）。
- 行为由既有的 RFC-370 用例覆盖：它们改从新路径 import，跑的就是迁移后的代码。

## 5. 失败模式

- **走样**：按 HEAD 原文生成，按词法单元比对（只允许相对 import 的字符串不同）。
- **漏改钉路径的锁**：已按每个旧路径的文件名全仓搜（§1）；正则写法另搜。
- **模块根转出撞名**：转出前逐名检查模块根已有的导出；`tsc` 复核。

## 6. 取舍（可推翻）

1. **文件名不变**：目录名已说明 CrewStation，但改名会让钉名字的锁与 git 历史都更难追；保持原名，只换目录。
2. **bootstrap 经模块根取**：RFC-294 design §3 不许 bootstrap 深引用模块 infrastructure，现状是 0，保持为 0；模块根转出是既有做法。
3. **两处 `required-ports` 类型 import 保留**：它们是本模块托管适配器实现本模块必需端口，collaboration 的 infrastructure 已有同样的取法；改
   成 application 端口要动端口的归属，不在本步。
4. **4 个文件留给后继**：它们调用本模块的组合助手，整体搬进 infrastructure 会形成 infrastructure → composition 的边。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：托管适配器实现按 design §2 落各模块 `infrastructure/crewstation/`；组合层不再承载这 23 个实现。
- **C11**：public 不变。
- **C12**：RFC-518 用例覆盖全部生产文件与全部模块的 `composition/`；RFC-515 门覆盖全模块。
- **C13**：计数不升，触及的上限收紧到实测；`composition-forbidden-import-files` 归零。

## 8. 本步承担的演进与留下的债

- **承担**：S10 的 RFC-370 余项第一步：例外清单 27 → 4，`composition-forbidden-import-files` 12 → 0。
- **留下**：余下 4 个文件（另立后继，拆开装配与实现）；两处本模块 `required-ports` 的类型 import；各模块组合层里装配期的选择分支按 S10 的分
  支上限处理。
