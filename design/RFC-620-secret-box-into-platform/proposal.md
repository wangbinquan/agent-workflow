# RFC-620 静态加密盒归 platform：合同进 `platform/contracts`，实现进 `platform/crypto`（RFC-294 W9-D 余项）

- **状态**：Done（2026-11-26，`3fc01a40a`）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。凭据相邻的文件按 RFC-294 plan
  “只审功能地单独处理”，本 RFC 只搬位置、不改行为。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W9-D；design §2.2（`util/` 中的通用原语归 `platform/`、`auth/` 归 identity-access）、
  design §3 的层次矩阵（application 只取 `platform/contracts`）。接 [RFC-619](../RFC-619-util-emptied/proposal.md)。

## 1. 背景

`auth/secretBox.ts`（69 行）是 AES-256-GCM 的静态加密盒：`SecretBox` 接口（`seal` / `unseal`），以及读取或创建守护进程密钥文件的
`ensureSecretKey`、`createSecretBox`、`createSecretBoxFromKey`。它只取 node 内置。读者分布：

| 读者                                    | 取什么                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| 四个模块的 application（3 个文件）      | 只取 `type SecretBox`                                           |
| 四个模块的 infrastructure / composition | 绝大多数只取类型，`integration` 一处取 `createSecretBoxFromKey` |
| bootstrap（13 个文件）                  | 类型与 `createSecretBox` / `createSecretBoxFromKey`             |
| `auth/oidc/providers.ts`                | 只取类型                                                        |
| 用例（约 100 个文件）                   | 绝大多数取 `createSecretBoxFromKey`                             |

owner 表把它记作 identity-access，但它是被四个 context 共用的中性机制：放进 identity-access，其余三个模块就要新开跨 context 内部文件对（有门禁的计数）；
而 design §3 规定 application 只取 `platform/contracts`，类型与实现放在一起，application 就得取 platform 的实现文件。

## 2. 目标

- **G1**：`SecretBox` 接口迁入 `platform/contracts/secretBox.ts`；密钥文件与 AES-GCM 实现原样迁入 `platform/crypto/secretBox.ts`（取合同里的类型）。
  读者一次改指：只取类型的改取合同，取实现的改取 `platform/crypto`，混合 import 拆成两条；旧位置不留转出。
- **G2**：`legacy-horizontal-files` 45 → 44；owner 表、commons 内核清单随之改。

## 3. 非目标

- 加密格式、密钥文件位置与权限、任何行为的改动。
- `auth/` 其余文件（`actor`、令牌、OIDC 一族等，另立）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`auth/secretBox.ts` 不在；合同与实现在新位置；没有文件再取旧位置；只取类型的读者都取合同，application 层不取 `platform/crypto`。
- **AC-2**：实现逐字迁移（只把接口声明换成取合同），既有加解密用例照旧通过。
- **AC-3**：`legacy-horizontal-files` 为 44，max 降到 44；新增 RFC-620 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
