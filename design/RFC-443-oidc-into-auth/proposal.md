# RFC-443 OIDC 提供方服务与开通策略归 identity-access 的 auth/oidc（RFC-294 W4 B / D 第九步）

- **状态**：Done（2026-11-04；`21ae7afa3`，exact SHA 主 CI run 41867668794：attempt 1～4 只有 macOS e2e 分片因 GitHub macOS arm64 runner 容量不足未被分配 runner 而取消，其余作业全绿；逐次只重跑失败作业，attempt 5 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-442](../RFC-442-collaboration-facades-out-of-services/proposal.md)（协作的三个 services/ 兼容层收口）
- **落位**：identity-access 的现址 `src/auth/oidc/`，与 OIDC 的发现、端点、流程、身份、令牌五个文件同处。

## 1. 背景

RFC-442 之后 12 个路由仍 import `services/`。其中 `routes/oidc.ts`、`routes/oidc-auth.ts` 各只依赖一个 OIDC 的 `services/` 文件：

- `services/oidcProviders.ts`（335 行）：OIDC / OAuth2 提供方的增删改查、客户端密钥的静态加密、`/test` 探测与脱敏视图。
  引用方是 `routes/oidc.ts` 与 bootstrap 的 `daemonHttpComposition.ts`；它对 identity-access 只经 `public/operations`。
- `services/oidc/provisioning.ts`（84 行）：登录回调的开通决策表（`decideProvisioning` 六分支）与邮箱信任规则，纯函数。
  引用方是 `routes/oidc-auth.ts` 与 `auth/oidc/identity.ts`。后者是一条 auth → services 的类型边，而依赖规则 `no-auth-to-services` 的说明写着
  「认证领域的策略逻辑属于 auth/」。

两者在 RFC-294 legacy 归属表里都登记为 identity-access；OIDC 其余五个文件早已在 `auth/oidc/`。

## 2. 目标

- **G1**：`services/oidcProviders.ts` → `auth/oidc/providers.ts`，`services/oidc/provisioning.ts` → `auth/oidc/provisioning.ts`，均原样搬迁。
- **G2**：引用改到新位置：两个路由、`auth/oidc/identity.ts`（改同目录相对路径）与 bootstrap。
- **G3 行为不变**：提供方增删改查、密钥加密与保留、探测、开通决策与邮箱信任全部不变。
- **G4 不留 facade**：原 2 个文件删除，`services/oidc/` 目录随之消失。

## 3. 非目标

- `src/auth/` 整体并入 `modules/identity-access`。
- 其余 10 个路由的 `services/` 依赖。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个 `services/` 文件不再存在，源码里没有对它们的 import；`auth/` 下没有任何对 `services/` 的 import（含类型）。
- **AC-2**：计数按实测更新，其余结构门不回退：import `services/` 的路由 12 → 10（`oidc`、`oidc-auth`）；`services/` 文件 223 → 221。
- **AC-3**：OIDC 提供方、OAuth2 回调、登录策略、开通决策与探测的用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **归 `auth/oidc/`，不进 `modules/identity-access`**：与 RFC-440 对 token 读视图的处理一致。调用方是 legacy 路由与 bootstrap，
   进模块内部会新增 R1 边；`auth/` 是 identity-access 的现址，`auth/oidc/` 已有同一流程的其余五个文件。随 `src/auth/` 整体并入模块时一起处理。
2. **原样搬迁、保留文件内的别名 import**：不顺手改写，e2e 注释里的 `file:line` 引用只需改路径。
