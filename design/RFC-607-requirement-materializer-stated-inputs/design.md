# RFC-607 技术设计

记号：`S/` = `packages/backend/src/`，`DA/` = `S/modules/development-automation/`，`T/` = `packages/backend/tests/`。数字取 HEAD `01306b9ce`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - application 的需求物化用例 `DA/application/requirementMaterializer.ts` 改入参。
  - 本机兼容物化器（物理目录形式的需求源 + 文件文档写入）迁为 `T/helpers/legacyRequirementMaterializer.ts`。
  - 只做转出的 `DA/infrastructure/requirementMaterializer.ts` 删去；唯一的生产使用方 `DA/infrastructure/childMissionParticipant.ts` 改从 application 取类型。
- **裁定一：需求源是物化用例的必填端口**。
  - 唯一的生产装配（`composeDevelopmentAutomation`）一直给它，RFC-597 起装配入参的 `requirementSource` 必填。
  - “没接上”在 application 里只剩三处运行期失败，与 RFC-603 删去的 `*-not-wired` 同类。
  - 删去后，外部渠道发问在问题集没有适配器绑定时仍给出 `requirement-source-not-wired`：那是绑定缺失（`adapterBindingRef === null`），失败码与行为不变。
- **裁定二：文档读取只经证据端口**。
  - `documents?` 覆盖在生产上从未给过，只为让两个用例注入假的文档读取。按 RFC-598 删去同类覆盖的做法删去，物化器一律读 `evidence.documents`。
  - 两个用例改由 helper 把假的文档读取作为证据端口自己的 `documents` 交给物化器（委托其余成员的代理）。
- **裁定三：本机兼容物化器是只供用例的兼容入口**。
  - 它把物理目录形式的需求源（`sinkPath`）包成选定形式，并默认文件文档写入。生产代码不调用它，按 RFC-584 的做法迁入 `tests/helpers/`。
  - 用例不给需求源时，helper 给调用即抛出带名字错误的替身：选定的物化器要求必填。
- **偏离项**：无。

## 1. 改动

| 位置                                                       | 改动                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DA/application/requirementMaterializer.ts`                | `RequirementMaterializerDeps.source` 必填、删去 `documents`；删去三处 `source === undefined` 的分支；文档读取取 `evidence.documents` |
| `DA/infrastructure/local/legacyRequirementMaterializer.ts` | 迁为 `T/helpers/legacyRequirementMaterializer.ts`（import 改为路径别名；没给需求源时给抛错替身；`documents` 选项经证据端口代理交出） |
| `DA/infrastructure/requirementMaterializer.ts`             | 删去                                                                                                                                 |
| `DA/infrastructure/childMissionParticipant.ts`             | `RequirementMaterializer` 类型改从 application 取                                                                                    |
| 6 个用例 / helper 文件                                     | 物化器改从 helper 取，常量与类型改从 application 取                                                                                  |

## 2. 用例

- 新增 `T/rfc607-requirement-materializer-stated-inputs-boundary.test.ts`，登记 guard-manifest：
  1. **入参**：`RequirementMaterializerDeps` 的 `source` 必填、没有 `documents`。编译期断言加 AST，判据带负对照。
  2. **application**：不再判断需求源缺席、不再读文档覆盖；绑定缺失的失败照旧。
  3. **迁出**：`src/` 里没有兼容物化器，也没有文件调用它；兼容的转出文件已删去。扫描文件数有下限。
- 行为：原用例经 helper 照旧覆盖物化、外部源与文档读取，断言不变。
- 计数：预计都不变（兼容物化器原本经类型 import 可达，不在“不可达生产文件”里）。

## 3. 失败模式

- **有人把需求源改回可选，或加回文档覆盖**：`tsc` 与 RFC-607 用例 ① 红。
- **有人在 `src/` 里重新放一个兼容物化器并调用它**：RFC-607 用例 ③ 红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：需求源由 bootstrap 经装配交入。
- **C12**：RFC-607 用例读源码，调用方由 `tsc` 全量核对。
- **C13**：计数不升。

## 5. 留下的

- launch 的 `uploadAdmission?`：子任务启动不收上传，是有意的用例差异。它要按用例拆成两种启动入参，另议。
