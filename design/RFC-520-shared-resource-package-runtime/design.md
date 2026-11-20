# RFC-520 设计：资源包装配共用一个模块工厂

## 1. 现状（HEAD，源码实读）

| 位置（`packages/backend/src/bootstrap/` 下）                  | 手写的装配                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandBootstraps.ts` 的 `composePackageCommandBootstrap`    | `actorsByAuthority` 弱引用表与 `authorityResolver`；`composePostgresqlResourcePackageProvider`（本机 MCP 事务生命周期、能力模板变更属主、本机插件安装器）；`composePostgresqlResourcePackageCatalog`（执行适配器里新建原子 apply）；本地身份交出命令 / 查询上下文时登记行为人 |
| `daemonHttpComposition.ts` 的 `composeResourcePackageBinding` | `packageActorsByAuthority` 弱引用表与内联解析器；provider（模块的 MCP 事务生命周期、能力模板变更属主、部署选择的技能 / 插件工件属主）；原子 apply；catalog；`commandContextFor` 交出 HTTP 命令上下文时登记行为人                                                              |

两处的解析器逐字相同：按授权取行为人，取不到抛 `foreign-resource-package-authority`。把 CLI 命令根（`commandBootstraps.ts`）调用的模块工厂逐
个与 daemon 侧比对：身份访问运行时、用户操作、MCP 事务生命周期与诊断都已是同一个模块工厂，只有资源包这张图是两处并行手写。

钉着旧装配原文的锁：`rfc349-postgresql-resource-package-bootstrap` 断言 `commandBootstraps.ts` 里有
`composePostgresqlResourcePackageCatalog(` 与 `createResourcePackageAtomicApplyOperations(` 的调用，并断言
`postgresqlResourcePackageCatalog.ts` 里没有 `fallback`、`no-op` 等字样；其余用例直接调这几个工厂搭夹具，不受影响。

## 2. 机制与落位

### D1 授权登记归 application

- **`resource-catalog/application/participants/resourceAuthorityRegistry.ts`**（新）：`createResourceAuthorityRegistry()` 返回
  `{ resolver, register(authority, actor) }`。`resolver` 是 `ResourceCurrentAuthorityResolver`（同目录 `resourceAuthorization.ts` 的端口类
  型），解析逻辑与两处 HEAD 的解析器逐字相同；弱引用表是每个工厂实例一张。

### D2 模块工厂

- **`composeResourcePackageRuntime(input)`**（`resource-catalog/composition/postgresqlResourcePackageCatalog.ts` 新增）：输入是
  `composePostgresqlResourcePackageProvider` 的输入去掉 `authorityResolver`、加上 `box`（按联合分配，保留“托管工件属主 / 本机插件安装器”二选
  一）；新建授权登记，依次装 provider、原子 apply 与 catalog（执行适配器取同一个原子 apply），返回
  `{ provider, atomicApply, catalog, registerAuthority }`。能力模板变更属主与 MCP 事务生命周期仍由 bootstrap 装好传入（前者属
  code-capability，组合层不取他模块的组合文件）。
- 组合层没有循环、`try` 与 `throw`；不出现 `fallback` / `no-op` 字样。

### D3 bootstrap 共用

- `composePackageCommandBootstrap`：删去手写的表、解析器、provider 与 catalog，改调 `composeResourcePackageRuntime`；本地身份交出上下文时调
  `registerAuthority`。
- `composeResourcePackageBinding`：同上；`applyActivity` 取工厂返回的 `atomicApply`，`commandContextFor` 调 `registerAuthority`。
- 构造次序的差别（CLI 在执行适配器里新建原子 apply、daemon 先建后传）不影响行为：两个工厂都只存入参、不做 effect。

### D4 锁与账本

- `rfc349-postgresql-resource-package-bootstrap`：CLI 一条改为断言 `composeResourcePackageRuntime(` 与仍由 bootstrap 装的两个属主，旧的两条
  调用改为不得出现；组合文件一条随新函数补 `registerAuthority`。
- guard-manifest 登记 RFC-520 用例；`counts.json` 不变。

## 3. 清单（退出门）

- `bootstrap/commandBootstraps.ts` 与 `bootstrap/daemonHttpComposition.ts` 都调 `composeResourcePackageRuntime`，都不调四个资源包工厂；生产
  代码里四个工厂只在 resource-catalog 内被调用（`composeResourcePackageRuntime` 与它们彼此之间）。
- `createResourceAuthorityRegistry` 只在 application 声明，是 `foreign-resource-package-authority` 在生产代码里唯一的出处。

## 4. 用例

新增 `packages/backend/tests/rfc520-shared-resource-package-runtime-boundary.test.ts`，登记 guard-manifest：

- ① 全部生产文件（下限 3,000）里四个资源包工厂的调用方只在 resource-catalog；两处 bootstrap 各调一次
  `composeResourcePackageRuntime`；`foreign-resource-package-authority` 只出现在 application 的登记里；带负对照。
- ② 行为：未登记的授权以原错误拒绝；登记过的授权解析出登记的行为人；两个工厂实例的登记互不相通；`composeResourcePackageRuntime` 交出的
  catalog 与原子 apply 来自同一次装配（执行适配器拿到的就是交出的原子 apply）。
- 资源包 apply 的端到端行为由既有的 RFC-349 / RFC-359 用例覆盖（CLI 与 daemon 路由用例经 bootstrap 走新工厂）。

## 5. 失败模式

- **登记丢失**：两处原来在交出上下文时写表，改为调 `registerAuthority`；用例 ② 与既有的包命令 / 路由用例覆盖。
- **按原文钉住的锁**：已按每个被删的调用全仓搜（§1）。

## 6. 取舍（可推翻）

1. **工厂放进已有的组合文件**：`postgresqlResourcePackageCatalog.ts` 已是资源包 provider / catalog 的装配入口；新函数只装配。
2. **两个属主仍由 bootstrap 传入**：能力模板变更属主属 code-capability，MCP 事务生命周期 daemon 侧是模块的共享对象；工厂不替它们选实现。
3. **登记按工厂实例隔离**：与两处 HEAD 一样，每个装配一张表，不做进程级共享。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：授权登记（含拒绝）落 application；组合层只装配。
- **C11**：public 不变。
- **C12**：RFC-520 用例读全部生产文件；RFC-515 门覆盖全模块。
- **C13**：计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 2 项：CLI 命令根与 daemon HTTP 不再并行手写资源包装配图（plan 记载的唯一一处，本 RFC 复核后没有第二处）。
- **留下**：S12 的其余各项（适配器工厂回落 50 / 14 / 1 处、导入期单例、模块级可变单例、直接定时器、按本地工厂签名定型的槽位）另立后继。
