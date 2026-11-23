# RFC-552 技术设计

落在架构检测器（`tests/architecture/rfc294Gates.ts` 的 `publicSurfaceViolations`）、knowledge-evolution 与 identity-access 的 public / composition
面、bootstrap 的两处取用，另改 `rfc294-architecture-preflight` 的偏差清单、`architecture/counts.json` 与新增一个 RFC-552 用例。数字取 HEAD
`08d67376d`。不改行为。

## 1. 判据：豁免只为操作描述工厂而设

现状：`publicSurfaceViolations` 遍历 public 根时整个跳过 `moduleLocation(...).rest === 'public/operations'` 的根。改为：

1. `public/operations` 的根照常遍历。
2. 在 `public/operations` 里，从 `@/platform/operations/contracts` 取的类型（Query / Command / IdempotentCommand operation descriptor、
   `OperationAlias`、`VersionedExactCodec` 等）是操作合同本身，不记“forbidden type import”，也不往里遍历（design §3.2 的“操作描述”）。
3. 描述工厂跳过：根是函数（声明或 const 初始化的箭头 / 函数表达式），且函数体里调用了 `defineQueryOperation`、`defineCommandOperation`、
   `defineIdempotentCommandOperation` 之一——它的返回值就是描述，`invoke` 是可执行成员（RFC-344 的理由，原注释保留并改写）。
4. 其余 public 入口的规则不变（`@/platform/operations/contracts` 在别的入口里仍按原规则计）。

候选导出上实测：收窄后多出的偏差只剩借这个入口导出的非描述构件（§2、§3），描述合同与描述工厂不再计入。

## 2. 收口

| 构件                                                                                  | 现状                                                       | 做法                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| knowledge-evolution 的五个运维函数（播种、provenance 修复、决策回滚、reconcile 两个） | 经 `public/operations` 转出，只有 bootstrap 在用           | 改从 `composition.ts` 转出，bootstrap 的两处取用（含动态 import）改取 composition；`public/operations.ts` 撤空删除 |
| identity-access `OwnerIdentityQueries`                                                | 经 `public/operations` 转出，task-execution 的基础设施在用 | 改从 `public/queries` 转出（它是查询端口），使用方改 import                                                        |

knowledge-evolution `public/operations.ts` 的头注释说 system-operations 的 composition 与 `cli/start.ts` 也在用，实测已不成立（消费方只有
bootstrap），随文件删除。

## 3. 收窄后显形的旧债

| 偏差                                                                                                      | 消费方                                | 后继                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| identity-access `OidcProviderRepository`（`Partial`）及其实现类的转出                                     | `auth/oidc/providers.ts`（遗留）      | `auth/oidc` 的 provider 管理迁入 identity-access（W9-D）       |
| source-control `RepositoryCredentialSealingMutation`（`Partial`）、`RepositoryWorkspaceStore`（`object`） | `services/repoCredentials.ts`（遗留） | `services/repoCredentials.ts` 迁入 source-control（W9-D / W5） |

它们本来就在 public 面上，只是被整体豁免挡住；逐条登记进 `PUBLIC_SURFACE_DEBT`（写明出处与后继），`public-surface-deviations` 的上限随之
写明“判据收窄后显形”，不把它们塞回豁免（RFC-480 的教训）。

## 4. 门与用例

- `rfc294-architecture-preflight` 的 `PUBLIC_SURFACE_DEBT` 按实测增删（§3 的条目加入；knowledge-evolution 的条目随函数撤出 public 消失）。
- `architecture/counts.json`：`public-surface-deviations` 按实测更新并写明来由。
- 新增 `tests/rfc552-public-operations-exemption-lock.test.ts`，登记 guard-manifest：① 全部模块 `public/operations` 的导出逐名清单
  （分类：描述合同 / 描述工厂 / 句柄合同 / 带后继的旧债），新导出不在清单即红；② 判据的三条（合同类型 import 不计、描述工厂跳过、其余照常
  检查）各有 fixture 与负对照；③ knowledge-evolution 的 `public/operations.ts` 不在、bootstrap 从 composition 取运维函数；`OwnerIdentityQueries`
  在 `public/queries`、不在 `public/operations`。
- 随改：读这些位置的源码锁（`rfc305` 的 identity-access 导出清单、`rfc353` 一族的 knowledge-evolution 入口断言等，集中验证首轮先跑读源码
  文本的用例）。

## 5. 失败模式

- **判据把描述工厂误判为普通函数**：fixture 覆盖声明与 const 两种写法；漏判会多出偏差、`rfc294-architecture-preflight` 红。
- **判据把非描述函数误放过**：只看函数体里有没有 `define*Operation` 调用；负对照覆盖不调用它的函数。
- **bootstrap 的动态 import 改错路径**：运行期才报错；集中验证跑启动相关用例。

## 6. 取舍（可推翻）

1. **旧债入账而不是在本 RFC 迁遗留实现**：两处遗留实现各自是一步迁移，混进来会让判据收窄这一步难以核对；入账后由各自的后继清偿。
2. **按函数体里的 `define*Operation` 调用认描述工厂**：比按名字认可靠；描述都经这三个工厂构造（RFC-344），这是操作模型的实际约定。
3. **knowledge-evolution 的运维函数走 composition 而不是 `public/commands`**：消费方只有 bootstrap，composition 本就是 bootstrap 的装配入口；
   放进 `public/commands` 会把函数类型的参数带进受检的 public 面。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：运维函数归 composition（装配入口）、查询端口归 `public/queries`。**C11**：public 只减不增（knowledge-evolution 少一个入口、
  identity-access 的一个导出换到正确的入口）。**C12**：RFC-552 用例覆盖。**C13**：`public-surface-deviations` 因判据收窄显形而变化，逐条
  入账并写明来由；其余计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S9 第 1 项的检测器部分完成（不再整体豁免 `public/operations`）；knowledge-evolution 的运维函数与 identity-access 的查询端口
  归位。
- **留下**：§3 的两组旧债（随遗留实现迁入模块清偿）；S9 的类型污染清单其余条目与跨 context 内部文件对。
