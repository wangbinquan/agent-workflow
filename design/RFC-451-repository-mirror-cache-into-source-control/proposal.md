# RFC-451 仓库镜像缓存家族归 source-control（RFC-294 W4 B / D 第十六步）

- **状态**：Done（2026-11-05；`79867699c`，exact SHA 主 CI run 42102014181 与 windows-platform run 42102014104 首轮全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D（兼顾 W5 的 repo / cache owner 余项）
- **前序**：[RFC-450](../RFC-450-code-host-family-into-integration/proposal.md)。
- **落位**：source-control 的 `infrastructure/local`（镜像缓存、批量导入、子模块自动保鲜、开发工作区仓库准备）、`application/ports` 与
  `public/types`（镜像管理合同）、`composition`；子模块参数解析进 `platform/workspace/local`；路由、装配根与 HTTP 装配。

## 1. 背景

RFC-450 之后 import `services/` 的路由只剩 `cached-repos` 与 `tasks`。`routes/cached-repos.ts` 取 `services/gitRepoCache`（列表、分页、刷新、删除）
与 `services/repoBatchImport`（批量导入、快照、重试）。这两个文件连同 `services/submoduleRefresh`（后台保鲜）是 source-control 的本地镜像缓存
实现——source-control 自己的 7 个文件早已 import 它——但仍挂在 legacy：

- `services/gitRepoCache.ts`（1455 行）的 `resolveSubmoduleParams` 被 `platform/workspace/local/isolation.ts` 直接 import；平台不能依赖模块
  （平台 → 模块的文件对必须为 0），所以镜像缓存搬进 source-control 之前，这个子模块参数解析要先归平台；
- `services/developmentDeliveryDeps.ts` 的「开发工作区仓库准备」（部署形态选择项，经 `deploymentProfile` 装配）调用镜像缓存的
  `resolveCachedRepo`；镜像缓存搬走后，legacy 不能再直接取模块内部，这段准备随缓存一起归 source-control。

## 2. 目标

- **G1 平台的子模块参数解析**：`resolveSubmoduleParams`（及读设置的 `submoduleConfigFromDisk`）原样迁入
  `platform/workspace/local/submoduleParams.ts`；平台隔离、镜像缓存与工作区物化都从这里取。
- **G2 镜像缓存家族迁入 source-control**：`gitRepoCache`、`repoBatchImport`、`submoduleRefresh` 与开发工作区仓库准备原样迁入
  `infrastructure/local`；`services/` 删除这三个文件，`developmentDeliveryDeps` 只留交付编排。
- **G3 路由只经 public 合同**：`cached-repos` 路由的六个端点改用 source-control 的 `CachedRepositoryOperations`（列表、分页、刷新、删除、
  批量导入的发起 / 快照 / 重试），编排（读配置取超时、删除前的快照与确认、引用计数拒绝）留在路由或迁入合同实现以保持原样。
- **G4 行为不变**：镜像的克隆 / 拉取 / 锁、批量导入与重试、后台保鲜、删除确认与引用守卫、开发工作区准备的新鲜度检查、所有错误码与 HTTP 形状不变。

## 3. 非目标

- `tasks` 路由（后续 RFC）；`services/developmentDeliveryDeps` 其余部分的收口（W4-E）；
- `services/gitVersion`、`services/gitSubmodule`（git 能力探测与子模块原语，W5）；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/gitRepoCache.ts`、`services/repoBatchImport.ts`、`services/submoduleRefresh.ts` 不存在、零引用；`cached-repos` 路由不再 import
  `services/`；平台 → 模块文件对仍为 0。
- **AC-2**：计数按实测更新：import `services/` 的路由 2 → 1；`services/` 文件 208 → 205；`R1` / `R2` 不回退；public surface 不新增债；
  模块里 import `services/` 的文件按实测记录（迁入的家族仍取的 legacy 依赖如实计入）。
- **AC-3**：镜像缓存、批量导入、保鲜、开发工作区准备、隔离工作区与子模块参数、cached-repos HTTP 的既有用例全部通过；新增 RFC-451 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一次迁整个家族**：拆两步会让第二步重做大半接线，而本机每轮集中验证约 3 小时；一次迁移用一轮验证，靠路径段级的引用扫描防漏。
2. **子模块参数解析归平台而不是 source-control**：平台隔离直接用它，平台不能依赖模块；它读的是全局设置与 git 能力，本就不属任一 context。
3. **开发工作区仓库准备随缓存归 source-control**：它只做镜像的取回与新鲜度判定，是部署形态选择项，由装配根选择。
