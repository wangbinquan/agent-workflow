# RFC-617 util/ 的六个通用原语原样归 platform（RFC-294 W9-D 余项）

- **状态**：In Progress（2026-11-26）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W9-D（legacy 横向目录归位）；design §2.2“`util/` 中的通用原语归
  `platform/`”。接 [RFC-575](../RFC-575-util-errors-hash-log-into-platform/proposal.md)（errors / hash / log 归 platform）与 RFC-593（util/git 归 source-control）。

## 1. 背景

`util/` 是横向目录，`legacy-horizontal-files` 余 53 个文件，其中 `util/` 9 个。六个模块（resource-catalog、runtime-management、source-control、
task-execution、development-automation、digital-employee 等）与 platform 自己直接取其中六个通用原语：

| 文件              | 内容                                        | 读者                                                     |
| ----------------- | ------------------------------------------- | -------------------------------------------------------- |
| `redact.ts`       | 持久化与日志前的文本脱敏                    | 四个模块、`auth/`、`services/`                           |
| `safePath.ts`     | 路径越界防护（词法 + realpath 双查）        | 五个模块、platform                                       |
| `fileTrust.ts`    | 敏感文件的私密性、种类与同一对象核对        | 五个模块                                                 |
| `win32Acl.ts`     | Windows 下的私密性核对（`fileTrust` 用）    | `fileTrust`                                              |
| `gitRef.ts`       | 业务身份到 Git ref 安全分量的映射（纯函数） | development-automation、digital-employee、source-control |
| `gitHardening.ts` | git 子进程的加固参数                        | source-control、platform 的 git 运行器（RFC-591）        |

它们都只依赖 node 内置、shared 与 platform。

## 2. 目标

- **G1**：六个文件**原样**迁入 platform（只改两条模块内相对路径与一处注释），读者一次改指，旧位置不留转出；别处指向旧路径的注释随之改指。
- **G2**：`legacy-horizontal-files` 53 → 47（max 同步降）；各处钉着旧路径的账本与源码锁随之改指。
- **G3**：`util/` 只剩 git 凭据助手（独立二进制入口）与它的租约、OIDC 响应助手，各随其族另立。

## 3. 非目标

- 任何逻辑改动：六个文件逐字迁移，不改判断、不改行为。
- `util/gitCredentialHelper.ts`（单二进制的独立入口）与 `util/gitCredentialLease.ts`、`util/oidcResponse.ts`：随凭据与 OIDC 一族另立。
- `auth/`、`routes/`、`mcp/`、`ws/`：`auth/actor` 的去向是 identity-access 的 `AuthenticatedAuthoritySnapshot`（design §270），属权限传递语义，不在本 RFC。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：六个文件在新位置、旧位置不在；`src`、`tests`、`scripts` 里没有文件再取旧位置。
- **AC-2**：六个新文件只取 node 内置、shared 与 platform；行为不变（原用例照旧通过）。
- **AC-3**：`legacy-horizontal-files` 为 47，max 降到 47；新增 RFC-617 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
