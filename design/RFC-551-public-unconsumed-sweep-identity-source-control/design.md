# RFC-551 技术设计

落在 identity-access 与 source-control 两个 bounded context 的 `public/` 面及其内部各层，另改架构报告的类型形状遍历
（`tests/architecture/architectureReport.ts`）、`architecture/counts.json` 与新增一个 RFC-551 用例。数字取 HEAD `bb34878c7` 的架构报告。
不改行为。

## 1. 判据修正：类的构造参数属性

`collectNodeShape` 遍历类声明时只看属性声明、方法与调用签名；构造函数没有名字，被直接跳过。于是
`constructor(readonly kind: UserAccessErrorKind, …)` 这种参数属性虽然是实例成员，它的类型不进 public 类的形状，只经它引用的
public 类型被判为未消费。修正：遍历构造函数的参数，`ts.isParameterPropertyDeclaration` 为真且没有 `private` / `protected` 修饰的，
按同名字段走 `collectTypeShape`（与属性声明一致）；普通构造参数不是实例成员，不进形状。

候选导出上实测：变化只有两个错误类多出字段（`UserAccessError` 的 `code` / `details` / `kind`，`RepositoryTransportCredentialError` 的
`code` / `kind`）与两个 `ErrorKind` 多出 public 引用；两个 context 的未消费计数各少 1；public 类型偏差、门与其余计数不变。

## 2. 撤出与落位（沿用 RFC-480 / RFC-550）

| 原位置                                                      | 名字                                                                                           | 做法                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| identity-access `public/commands`                           | `SyncOidcProfile`（转出）                                                                      | 删转出，组合根改取 `application/commands/syncOidcProfile`                        |
| identity-access `public/events`                             | `IdentityAccessEventSink`                                                                      | 进 `application/ports/identityAccessEventSink.ts`                                |
| identity-access `public/operations`                         | `createIdentityUserOperations`                                                                 | 连同它的依赖接口、私有 schema 与助手进 `application/userOperationDescriptors.ts` |
| identity-access `public/operations`                         | `OidcIdentityOperations`、`OidcIdentityProfileAccess`、`OWNER_IDENTITY_SQL_BATCH_SIZE`（转出） | 删转出，使用方改取定义处                                                         |
| identity-access `public/queries`                            | `GetUserGitCommitIdentity`、`requireUserAccess`（转出）                                        | 删转出，使用方改取定义处                                                         |
| source-control `public/commands`、`queries`、`participants` | 本人凭据的命令 / 查询端口、凭据选择参与者                                                      | 进 `application/ports/repositoryTransportCredentials.ts`                         |
| source-control `public/participants`                        | 提交候选与发布两个参与者                                                                       | 进 `application/ports/repositoryCommit.ts`                                       |
| source-control `public/participants`                        | 仓库端点发现参与者                                                                             | 进 `application/ports/repositoryEndpointDiscovery.ts`                            |
| source-control `public/queries`                             | `repoRelForcedPaths`（转出 platform）                                                          | 删转出                                                                           |

`IdentityUserOperations`（cli 与路由在用）留在 `public/operations`，它的输入类型照旧由输入 schema 推导，schema 随工厂进 application、public
以 type-only import 取用（与 RFC-550 的 system-operations 相同）。撤出会连锁（例：`AuthorityRevisionChanged` 只被事件接收端口的签名引用），
按“撤出 → 复采 → 再撤”迭代到 0；public 文件撤空的整个删除。实施时按实际依赖与使用方核对，落位与表不同的在 plan 的集中验证里逐条说明。

## 3. 门与用例

- `architecture/counts.json`：identity-access 与 source-control 的 `unconsumed-public-symbols-*` 上限降到 0（理由“RFC-551 清零”）。
- 新增 `tests/rfc551-public-unconsumed-sweep-lock.test.ts`，登记 guard-manifest：① 撤空的 public 文件不在、全仓零 import；② 逐名清单
  `tests/fixtures/rfc551-withdrawn-public-symbols.json`（以 `bb34878c7` 的导出为基准）里的名字不再从对应 public 文件导出、值也不在运行时
  命名空间里；③ 挪进内部的声明在新位置导出、不在本模块任一 public 文件里；④ 判据修正的回归（fixture：只经 public 类的构造参数属性引用的
  类型算作被消费；private / protected 参数属性与普通构造参数不算，负对照）；⑤ 两个 context 的减速带上限为 0（实测由
  `rfc376-structural-guards` 的计数门对全仓每个 context 做）。
- 随改：`rfc305-architecture-lock` 的 identity-access public 文件与导出清单；经 public 取这些名字的本模块文件与用例改取新位置；按 RFC-480 /
  RFC-550 的经验先查按文件记的清单（OS 架构清单、commons 内核清单、开放 Record 清单、偏差清单、跨上下文边清单）。

## 4. 失败模式

- **撤出后编译不过**：未消费即没有模块外生产使用方，`tsc` 认出遗漏；用例改取定义处。
- **判据修正让别的计数变化**：候选导出上已实测只影响上面四个条目；集中验证再对照一次。
- **读旧位置的文本断言**：`tsc` 看不见，集中验证首轮先跑读源码文本的用例。

## 5. 取舍（可推翻）

1. **先修判据、不挪两个 `ErrorKind`**：它们是 public 错误类的一部分；照报告挪进内部会让 public 类引用内部类型（RFC-480 的教训）。
2. **只遍历非 private / protected 的参数属性**：它们才是 public 实例类型的成员；普通构造参数只是构造签名，不进实例形状。
3. **删除优于保留转出**：没有模块外读者的转出只会让 public 面变大，不留兼容转出。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：挪进内部的按内容定层（端口进 `application/ports`，描述工厂进 application）。**C11**：模块 public 只减不增。**C12**：RFC-551 用例
  覆盖。**C13**：未消费计数 17 → 0，其余计数不升。

## 7. 本步承担的演进与留下的债

- **承担**：S9 第 3 项完成（全仓未消费 public 符号为 0、全部减速带上限为 0）；判据的构造参数属性盲区修正。
- **留下**：S9 的 public 类型污染清单、`public/operations` 豁免收窄与跨 context 内部文件对。
