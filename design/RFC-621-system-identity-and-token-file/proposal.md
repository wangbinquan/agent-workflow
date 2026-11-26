# RFC-621 `auth/` 的两个中性原语离开 legacy 目录：`SYSTEM_USER_ID` 归 shared，守护进程令牌文件归 `platform/crypto`（RFC-294 W9-D 余项）

- **状态**：Done（2026-11-26，`72d97076b`）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。凭据相邻的文件按 RFC-294 plan
  “只审功能地单独处理”，本 RFC 只搬位置、不改行为。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W9-D；接 [RFC-620](../RFC-620-secret-box-into-platform/proposal.md)。

## 1. 背景

`auth/` 里有两个与认证主体（`Actor`）无关的小原语：

| 文件                     | 内容                                                                                               | 读者                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth/systemIdentity.ts` | `SYSTEM_USER_ID = '__system__'`：框架 built-in 的 owner、框架自发写入的主体 id                     | 约 54 个文件，经它或经 `auth/actor.ts` 的转出取；shared 的 ACL schema 注释里一直写着这个值 |
| `auth/token.ts`          | 守护进程令牌文件：`generateToken`、`ensureTokenFile`、`rotateTokenFile`（32 字节随机值，权限 600） | 唯一的生产读者 `bootstrap/daemonStart.ts`，另有用例                                        |

## 2. 目标

- **G1**：`SYSTEM_USER_ID` 迁入 `@agent-workflow/shared`（新文件 `systemIdentity.ts`，index 导出），`auth/actor.ts` 不再转出它，读者一次改指；
  守护进程令牌文件原样迁入 `platform/crypto/tokenFile.ts`。旧位置不留转出。
- **G2**：`legacy-horizontal-files` 44 → 42；owner 表与按路径读这些文件的源码锁随之改。

## 3. 非目标

- 令牌格式、文件位置与权限、`SYSTEM_USER_ID` 的取值或任何行为的改动。
- 前端仍按字面量比较 `'__system__'`，不在本 RFC 改。
- `auth/` 其余文件（`actor`、认证运行时、OIDC 一族、`passwords`、`tokenRedaction` 等，另立）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：两个旧文件不在；shared 声明并导出 `SYSTEM_USER_ID`；令牌文件在 `platform/crypto/` 且只取 node 内置；没有文件再取两个旧位置。
- **AC-2**：`SYSTEM_USER_ID` 只有 shared 一处来处：`auth/actor.ts` 不再转出，backend 生产代码里没有第二处声明。
- **AC-3**：`legacy-horizontal-files` 为 42，max 降到 42；新增 RFC-621 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
