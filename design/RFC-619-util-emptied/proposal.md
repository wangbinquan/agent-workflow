# RFC-619 util/ 清空（RFC-294 W9-D 余项）

- **状态**：In Progress（2026-11-26）。用户 2026-11-26「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  落位由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。凭据相邻的文件按 RFC-294 plan
  “只审功能地单独处理”，本 RFC 只搬位置、不改行为。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) W9-D；design §2.2“`util/` 中的通用原语归 `platform/`”。接
  [RFC-617](../RFC-617-util-primitives-into-platform/proposal.md)（六个通用原语归 platform）。

## 1. 背景

RFC-617 之后 `util/` 只剩三个文件：

| 文件                     | 内容                                                                       | 读者                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gitCredentialLease.ts`  | git 凭据的一次性租约与凭据助手子命令（`credential.helper` 协议）           | `bootstrap/daemonApplication.ts`（开机清理残留租约）、入口 `main.ts`（隐藏子命令）、source-control 四个文件 |
| `gitCredentialHelper.ts` | 单二进制额外打包的凭据助手入口（Windows 独立可执行文件无法可靠重入主模块） | 构建脚本 `scripts/build-binary.ts`                                                                          |
| `oidcResponse.ts`        | OIDC 回调失败页的 HTML 呈现                                                | `routes/oidc-auth.ts`（随它留在 `routes/`，与 OIDC 路由一族一起迁入 identity-access）                       |

## 2. 目标

- **G1**：三个文件按 owner 归位（OIDC 失败页先随唯一读者留在 `routes/`），`util/` 目录消失；读者一次改指，旧位置不留转出。
- **G2**：`legacy-horizontal-files` 47 → 45（max 同步降）；钉着旧路径的构建入口、架构门入口清单、源码锁与 CI 路径过滤随之改。

## 3. 非目标

- 凭据租约、凭据助手与 OIDC 失败页的任何行为改动（唯一的代码改动是租约在源码运行时找 `main.ts` 的相对路径，目录深了两层）。
- `routes/oidc-auth.ts` 等 legacy 路由与 `auth/` 一族（另立）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`util/` 不在；三个文件在新位置；没有文件再取 `util/` 下的路径。
- **AC-2**：单二进制构建的凭据助手入口在新位置，架构门入口清单与构建脚本一致；源码运行时凭据助手命令指向存在的 `src/main.ts`。
- **AC-3**：`legacy-horizontal-files` 为 45，max 降到 45；新增 RFC-619 用例并登记。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
