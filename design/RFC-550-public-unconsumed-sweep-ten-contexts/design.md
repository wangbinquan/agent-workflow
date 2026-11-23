# RFC-550 技术设计

落在十个 bounded context（system-operations、digital-employee、resource-catalog、integration、development-automation、code-capability、
event-center、memory、execution-contract、runtime-management）的 `public/` 面及其内部各层，另改 `architecture/counts.json` 与新增一个 RFC-550
用例。数字取 HEAD `85c36f1c0` 的架构报告（`unconsumedPublicSymbols`）。不改行为。

## 1. 撤出规则（沿用 RFC-480）

对架构报告判为“未消费”的每个 public 符号（没有模块外生产 import、没有模块外生产消费方、没有被其他 public 符号的签名引用）：

| 情形                                           | 个数 | 做法                                                           |
| ---------------------------------------------- | ---- | -------------------------------------------------------------- |
| 转出（`export { x } from '…'`）                | 22   | 删掉转出；经 public 取用它的本模块文件与用例改取定义处         |
| 直接声明在 public 文件里、没有任何使用方       | —    | 删除声明（同一文件里还被别的导出用到的，按下一行处理）         |
| 直接声明在 public 文件里、只有本模块或用例在用 | 49   | 按内容（C10）挪进模块内部对应的层，使用方改取新位置；落位见 §2 |

只被用例经 public 取用的生产代码留在模块内部、用例改取定义处；只为用例存在的辅助挪到 `tests/helpers/`。撤出会让“只被同一文件其他导出的
签名引用”的符号变成未消费，按“撤出 → 复采 → 再撤”迭代到这十个 context 为 0。

## 2. 直接声明在 public 的落位（按内容）

| 原位置                                                    | 声明                                                                                           | 去处（按函数体 / 类型取的依赖定层）             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| code-capability `public/queries`                          | `CodeMatrixQuery`、`CodeMetricsQuery`、`CodeRoundAttemptsQuery`、`CodeWorkItemProjectionQuery` | `application/ports`（应用用例的查询端口）       |
| code-capability `public/queries`                          | `StageGraph`                                                                                   | 按使用方定（只有用例在用）                      |
| digital-employee `public/events`                          | 两个事件观察构造函数及其引用、事件源与事件类型常量                                             | `application`（取 event-center 的 public 类型） |
| digital-employee `public/types`                           | `normalizeDispatchRouteDefinitionsJson`、`WORKSPACE_FAILURE_CLASSES`                           | `domain`                                        |
| event-center `public/commands`、`queries`、`participants` | 四个模块端口                                                                                   | `application/ports`                             |
| integration `public/events`                               | 代码平台事件的观察构造函数、事件源与事件类型                                                   | `application`                                   |
| integration `public/participants`                         | `MrTerminalControl`、`WorkStartReceipt`                                                        | `application/ports`                             |
| resource-catalog `public/operations`                      | 五个目录模块接口                                                                               | `application`                                   |
| resource-catalog `public/participants`                    | `McpProbeRunner`、`McpProbeStore`；两个技能迁移回执                                            | `application/ports`；回执按使用方定             |
| resource-catalog `public/types`                           | 资源包写入的准备与回执（`preparedPackageMutation` 一族）                                       | `application/package`                           |
| system-operations `public/operations`                     | 两个操作描述工厂                                                                               | `application`                                   |
| system-operations `public/types`                          | 十个 zod 合同                                                                                  | `application`                                   |

实施时按实际依赖与使用方核对，落位与表不同的在 plan 的集中验证里逐条说明。public 文件撤空的整个删除，取它的命名空间断言改为断言文件不在。

## 3. 门与用例

- `architecture/counts.json`：十个 context 的 `unconsumed-public-symbols-*` 上限降到 0（理由改为“RFC-550 清零”），source-control 的上限 9 → 8
  （RFC-548 撤出 `invalidateRepositoryWorkspaceFacetCaches` 之后的实测）。
- 新增 `tests/rfc550-public-unconsumed-sweep-lock.test.ts`，登记 guard-manifest：① 逐名清单
  `tests/fixtures/rfc550-withdrawn-public-symbols.json`（以 `85c36f1c0` 的导出为基准）里的名字不再从对应 public 文件导出；② 架构报告的这十个
  context 未消费计数为 0；③ 带负对照（清单里的名字重新导出即被认出）。
- 随改：经 public 取这些名字的本模块文件与用例改取新位置；断言 public 导出清单的用例随改。

## 4. 失败模式

- **撤出后别的模块编译不过**：未消费即没有模块外生产使用方，`tsc` 会认出遗漏；用例改取定义处。
- **连锁变成未消费**：迭代复采到 0。
- **挪进内部后层次不对**：按函数体与类型取的依赖定层；`tests/architecture` 的分层与 DAG 守卫照跑。

## 5. 取舍（可推翻）

1. **只做十个 context**：identity-access 与 source-control 的未消费符号多是凭据与身份面的端口，单独一步更好核对。
2. **删除优于保留转出**：没有模块外读者的转出只会让 public 面变大，不留兼容转出。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：挪进内部的按内容定层。**C11**：模块 public 只减不增。**C12**：RFC-550 用例覆盖。**C13**：未消费计数 88 → 17（十个 context 归零），
  其余计数不升。

## 7. 本步承担的演进与留下的债

- **承担**：S9 第 3 项在十个 context 上完成。
- **留下**：identity-access 与 source-control 的未消费符号；S9 的 public 类型污染清单与跨 context 内部文件对。
