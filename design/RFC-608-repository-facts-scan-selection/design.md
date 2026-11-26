# RFC-608 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `e7fae1424`。
生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：`DA/infrastructure/repositoryFactsCollector.ts`（与采集器、它的扫描类型在一起）。
- **裁定**：
  - 扫描方式取决于所选工作区效果的实现能力：卷选择有树操作，能在文件旁边扫；本机选择没有，就在进程内扫。这是 infrastructure 的实现选择。
  - 选择函数直接给出两种扫描之一，不再用 `undefined` 让采集器回落；采集器的签名不变（`scan` 仍可选，进程内扫描仍是它的默认）。
  - composition 只把工作区效果交给选择函数，没有分支。
- **偏离项**：无。

## 1. 改动

| 位置                                            | 改动                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DA/infrastructure/repositoryFactsCollector.ts` | 新增 `repositoryFactsScanFor(workspace)`：无树操作时返回 `scanRepositoryFacts`，否则返回经树操作运行 `repository-facts-scan` 的扫描 |
| `DA/composition.ts`                             | 改调 `repositoryFactsScanFor(deps.automationWorkspaceEffects)`                                                                      |
| `DA/composition/repositoryFactsScanner.ts`      | 删去                                                                                                                                |
| `T/rfc598-…-boundary.test.ts`                   | 钉住的调用名随之改                                                                                                                  |
| `architecture/counts.json`                      | `composition-control-flow-development-automation` 1 → 0                                                                             |

## 2. 用例

- 新增 `T/rfc608-repository-facts-scan-selection-boundary.test.ts`，登记 guard-manifest：
  1. **选择**：没有树操作的效果得到进程内扫描本身。有树操作时，扫描经树操作运行 `repository-facts-scan`，根是给定路径，返回树操作的结果。
  2. **落位**：`composition/` 里不再有 `repositoryFactsScanner.ts`；composition 把工作区效果交给 `repositoryFactsScanFor`。
- 计数：`composition-control-flow-development-automation` 1 → 0，其余不变。

## 3. 失败模式

- **有人把选择放回 composition**：计数回到 1 超过 max，结构门红；RFC-608 用例 ② 红。
- **选择给错扫描方式**：RFC-608 用例 ① 红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：composition 只装配。**C12**：RFC-608 用例跑选择函数并读源码。**C13**：计数降、不升。
