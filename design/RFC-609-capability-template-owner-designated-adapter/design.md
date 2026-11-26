# RFC-609 技术设计

记号：`S/` = `packages/backend/src/`，`CC/` = `S/modules/code-capability/`，`RC/` = `S/modules/resource-catalog/`，`T/` = `packages/backend/tests/`。
数字取 HEAD `03008a73a`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 合同：`RC/application/ports/capabilityTemplatePackageOwner.ts`，经 `RC/composition/required-ports.ts` 交出。
  - 指定 adapter：`CC/application/adapters/resource-catalog-adapter.ts`。
- **裁定一：合同是资源目录的 required 端口**。资源包的 PostgreSQL 事务调用能力模板的 owner-native 一支，由别的 context 实现。
  - 合同引用的类型（`ResourcePackageArtifactContext`、`CapabilityTemplatePackageMutation`、`ResourceRequestContext`、`PersistenceTx`）都已在 application、
    public 或 platform。
  - 因此合同可以落在 application 端口，infrastructure 只引用它。
- **裁定二：名字去掉引擎前缀**。接口改名 `CapabilityTemplatePackageMutationOwner`：
  - 它的参数都是中立类型（事务是 `PersistenceTx`），只是目前只有 PostgreSQL 的资源包事务调用它。
  - 实现方的指定 adapter 在 application 层，RFC-349 的 provider 切换锁（`rfc349-provider-cutover`）不许 application 层按名字取引擎专属的符号；
    集中验证时这条锁认出了沿用旧名的初版。
  - 实现工厂 `createPostgresqlCapabilityTemplatePackageMutationOwner` 在 infrastructure、引擎命名文件里，名字不变。
  - 新文件名不带引擎前缀，provider 命名文件的账本（`rfc359-w5-t17`）不增。
- **裁定三：事务类型用平台的**。`PostgresqlResourceCatalogTransaction` 就是 `PersistenceTx`；归属方直接取平台类型，不再经资源目录。
- **偏离项**：无。

## 1. 改动

| 位置                                                                                                                     | 改动                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `RC/application/ports/capabilityTemplatePackageOwner.ts`                                                                 | 新增：合同接口（自参与方文件迁来，改名 `CapabilityTemplatePackageMutationOwner`，事务参数写成 `PersistenceTx`） |
| `RC/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts`                                   | 删去接口声明，改从端口 `import type`（新名）                                                                    |
| `RC/composition/postgresqlResourcePackageCatalog.ts`                                                                     | 改从端口 `import type`                                                                                          |
| `RC/composition/required-ports.ts`                                                                                       | 交出合同类型                                                                                                    |
| `CC/application/adapters/resource-catalog-adapter.ts`                                                                    | 新增：只以 `import type` 取 required-ports 并转出                                                               |
| `CC/infrastructure/postgresqlCapabilityTemplatePackageMutationOwner.ts`                                                  | 合同改从 adapter 取，事务类型改为 `PersistenceTx`                                                               |
| `architecture/counts.json`、`T/architecture/rfc376-structural-guards.test.ts`、`T/rfc294-architecture-preflight.test.ts` | 跨 context 内部文件对删去这 2 条，4 → 2                                                                         |

## 2. 用例

- 新增 `T/rfc609-capability-template-owner-designated-adapter-boundary.test.ts`，登记 guard-manifest：
  1. 归属方不 import resource-catalog 的任何文件，合同取自指定 adapter，事务类型取自平台。
  2. 指定 adapter 只以 `import type` 取 required-ports，自己只转出类型。
  3. 合同声明在 application 端口，参与方文件不再声明、改从端口取，required-ports 交出它。
  4. 架构门在真实语料上没有从 code-capability 出发的跨 context 内部文件对（语料下限 3,000）。
  5. 编译期：归属方工厂的返回值就是 required-ports 交出的合同。
  6. 负对照：①② 的判据喂伪造源码，原来的两条 import、取值的 adapter、转出值都被认出。
- 原用例照旧覆盖资源包事务里能力模板一支的行为（`rfc359-w12/w13/w14/w15/w28` 等一致性用例、`rfc349` 的 PostgreSQL 适配器锁）；
  `rfc349-resource-catalog-postgresql-adapters` 对参与方文件的文本锁随改名改认新名。

## 3. 失败模式

- **有人把合同挪回 infrastructure，或归属方重新直接 import 资源目录的内部文件**：RFC-609 用例与 RFC-376 的精确基线红，计数超过 max。
- **adapter 改取值或取别的入口**：RFC-609 用例红；RFC-376 的判据也会把它记成一条文件对。

## 4. 对 RFC-294 刷新后规则的对账

- **C5（跨 context 只经 exact 合同）**：实现方经指定 adapter 只取 required-ports 的类型。
- **C12**：RFC-609 用例在全部生产文件上跑架构门，带语料下限；判据带负对照。
- **C13**：计数降，三处清单同步收紧。

## 5. 记下的：兼容岛物理并入的约束（W4-E8，另立）

- RFC-294 design §8 的终态是 code-capability 并入 development-automation 后删除。
- 报告（`architectureReport.ts`）与表归属（`tableOwnership.ts`）早已把它算作 development-automation。余下的只是物理目录。
- 物理并入碰到持久化身份：
  - 表的 owner `code-capability` 与 `code-capability/history` 进入逻辑契约（`logicalContract.ts` 的 `ownerContext` 与 `retention.owner`）。
  - schema 名册、转换规则与迁移探针都按它记。
  - RFC-395 的贡献约定（`rfc395-explicit-schema-contributions`）按 owner 首段定位 `modules/<owner>/infrastructure/persistence/schema.ts`。
- 物理并入因此只有两条路：
  - 改 owner：契约变化，要按 RFC-398 立 schema 历史版本、种子与映射预言。
  - 改贡献约定：让一个模块承载两个持久化 owner。
- 两条都超出本 RFC，另立。
