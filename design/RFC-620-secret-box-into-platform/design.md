# RFC-620 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：`S/auth/secretBox.ts` 拆成
  - `S/platform/contracts/secretBox.ts`：`SecretBox` 接口（`seal(plaintext): string`、`unseal(packed): string`），中性合同；
  - `S/platform/crypto/secretBox.ts`：`ensureSecretKey`、`createSecretBox`、`createSecretBoxFromKey` 与常量，逐字迁移，只把接口声明换成
    `import type { SecretBox } from '../contracts/secretBox'`。
- **裁定一：归 platform，不归 identity-access**。它被 source-control、integration、resource-catalog、development-automation 与 bootstrap 共用，是中性机制；
  放进 identity-access 要么让其余模块新开跨 context 内部文件对，要么让 identity-access 的 public 交出一个与认证无关的加密原语。
- **裁定二：合同与实现分开**。design §3：application 只取本模块与 `platform/contracts`，不取 platform 实现。三个 application 文件只要类型，合同落
  `platform/contracts` 后它们不再碰实现；实现文件不转出类型，同一个名字只有一个来处。
- **裁定三：新目录 `platform/crypto/`**。现有 platform 目录里没有同类机制（`contracts/hash.ts` 只是无副作用的摘要函数）；密钥文件的读写是 FS effect，
  不宜进 `contracts`。
- **偏离项**：无。

## 1. 改动

- 拆分迁移（§0），`S/auth/secretBox.ts` 删除。
- 读者改指（按语法树改写，只认模块说明符）：只取类型的 import 改取 `@/platform/contracts/secretBox`（`import type`）；取值的改取
  `@/platform/crypto/secretBox`；`createSecretBoxFromKey, type SecretBox` 这类混合 import 拆成两条。
- 账本：架构报告的旧文件 owner 表删 `auth/secretBox.ts`；`architecture/commons-manifest.json` 的 `at-rest-sealing-kernel` 改指两个新文件、owner 改为
  platform；`architecture/counts.json`：`legacy-horizontal-files` 45 → 44。

## 2. 用例

- 新增 `T/rfc620-secret-box-into-platform-boundary.test.ts`，登记 guard-manifest：
  1. 旧位置不在，合同与实现在新位置；合同只声明接口、不取任何东西；实现只取 node 内置与合同。
  2. backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts`、`tests` 里没有文件再经任何写法取旧位置（按语法树取模块说明符，语料下限 3,000）。
  3. 模块 application 层不取 `platform/crypto/secretBox`；从 `platform/crypto/secretBox` 只取值、不取类型（类型一律取合同）。
  4. 负对照：别名、相对路径与 `mock.module` 都认得出，字符串里的路径不算；application 取实现、从实现取类型都认得出。
- 原用例照旧覆盖行为（`secret-box` 的加解密与密钥文件、各模块用 `createSecretBoxFromKey` 的用例）。

## 3. 失败模式

- **有人把类型放回实现文件、application 改取实现**：RFC-620 用例 ③ 红。
- **旧位置复活或再被取**：RFC-620 用例 ①② 红，计数超过 max。

## 4. 对 RFC-294 刷新后规则的对账

- **design §3**：application 只取 `platform/contracts`。**C12**：RFC-620 用例扫全部源码与用例，带语料下限与负对照。**C13**：计数降、不升。
