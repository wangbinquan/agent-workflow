# RFC-621 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **裁定一：`SYSTEM_USER_ID` 归 shared**。它是跨层、跨 context 的中性常量：资源 ACL 的 owner 取值（shared 的 workflow / workgroup / plugin schema 注释与
  bundle payload 都写着 `'__system__'`）、框架自发写入的主体 id；读者遍布十个模块的 application / infrastructure / inbound 与 bootstrap。放进 identity-access 的
  public 也能走通，但 domain 层不能取模块 public，而 shared 是所有层都可取的中性值来处。新文件 `packages/shared/src/systemIdentity.ts`，index 导出。
- **裁定二：`auth/actor.ts` 不再转出**。转出是一跳旧地址；读者改为直接取 shared，`SYSTEM_USER_ID` 只有一处来处。
- **裁定三：守护进程令牌文件归 `platform/crypto/`**。它与 RFC-620 的密钥文件同类（随机值、权限 600 的本机文件），唯一的生产读者是 bootstrap；放进 identity-access
  会让 bootstrap 深引模块内部。原样迁移，文件头加一行来由。
- **偏离项**：无。

## 1. 改动

- 新增 `packages/shared/src/systemIdentity.ts`，`packages/shared/src/index.ts` 加一行导出。
- `S/auth/token.ts` → `S/platform/crypto/tokenFile.ts`（逐字）；`S/auth/systemIdentity.ts` 删除；`S/auth/actor.ts` 删去 `export { SYSTEM_USER_ID } from './systemIdentity'`。
- 读者按语法树改写（58 个文件，先在对照导出上演练）：
  - 取 `auth/token` 的模块说明符（含命名空间 import）改为 `@/platform/crypto/tokenFile`；
  - 从 `auth/actor` / `auth/systemIdentity` 取 `SYSTEM_USER_ID` 的 import 去掉这个名字（剩下的只有类型时改成 `import type`，空了就删掉），并入文件里已有的
    `@agent-workflow/shared` 值 import，没有就新增一条；`T/users-cli.test.ts` 的动态 `import('../src/auth/systemIdentity')` 改为 `import('@agent-workflow/shared')`。
- identity-access 的 `composition.ts`、`application/operationContext.ts`、`application/legacyActorProjection.ts` 各自声明了一份
  `const SYSTEM_USER_ID = '__system__'`（此前它们不能取 legacy 的 `auth/`），改取 shared 的同一个常量（集中验证第一轮由 RFC-621 用例 ③ 查出）。
  迁移与种子数据里的字面量（`seedPresence`、identity-access 的 schema 种子、技能迁移规则）按“迁移冻结当时的值”保留；另有三处运行时代码用字面量或不同名的
  本地常量（collaboration 的自动派发审计主体、task-execution 的 `OWNERLESS_SYSTEM_USER_ID` 与提交推送的 owner 比较），不是同名重复声明，留给后继。
- 账本与锁：架构报告的旧文件 owner 表删两行；`T/auth-session.test.ts` 按路径读令牌文件、锁 `tokenAuth` 不复活的那条改指新位置；
  `architecture/counts.json`：`legacy-horizontal-files` 44 → 42。

## 2. 用例

- 新增 `T/rfc621-system-identity-and-token-file-boundary.test.ts`，登记 guard-manifest：
  1. 两个旧文件不在；`@agent-workflow/shared` 的 `SYSTEM_USER_ID` 为 `'__system__'`，shared 的 `systemIdentity.ts` 只声明一处；令牌文件只取 node 内置、三个函数都在。
  2. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件再经任何写法取两个旧位置（按语法树取模块说明符，语料下限 3,000）。
  3. backend 生产代码里没有文件声明或转出 `SYSTEM_USER_ID`（`auth/actor.ts` 的转出删去后，来处只剩 shared）。
  4. 负对照：别名、相对路径、动态 import 与 `mock.module` 都认得出，字符串里的路径与同前缀的 `auth/tokenRedaction` 不算；转出与重新声明都认得出，近似名不算。
- 原用例照旧覆盖行为（`auth-token` 的令牌文件、`rfc394-start-sequence` 的启动序列、各模块按 `SYSTEM_USER_ID` 判 built-in 的用例）。

## 3. 失败模式

- **旧位置复活或再被取**：RFC-621 用例 ①② 红，计数超过 max。
- **又在 backend 里声明或转出一份 `SYSTEM_USER_ID`**：RFC-621 用例 ③ 红。

## 4. 对 RFC-294 刷新后规则的对账

- **design §2.2**：legacy 横向目录逐族清空。**C12**：RFC-621 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。
