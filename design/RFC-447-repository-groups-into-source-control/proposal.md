# RFC-447 仓库组用例归 source-control（RFC-294 W4 B / D 第十三步）

- **状态**：In Progress（2026-11-04）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-446](../RFC-446-repository-reads-into-source-control/proposal.md)（仓库 refs / files 读取归 source-control）
- **落位**：source-control 的 `application/repositoryGroups.ts`（仓库组目录树的增删改查、展平与预览）、`application/ports/repositoryGroups.ts`
  （路由用的操作合同）、`composition/repositoryGroups.ts`（装配：URL 现场导入按部署形态选择）；`public/types` 转出合同类型，
  `public/queries` 转出展平函数给 legacy 启动路径。

## 1. 背景

RFC-446 之后 6 个路由仍 import `services/`。source-control 的 `routes/repoGroups.ts`（仓库组管理面）全部用例都在
`services/repoGroup.ts`（658 行）：

- 七个用例（列表、详情、展平预览、草稿预览、新建、全量替换、删除）只经 `RepositoryWorkspaceStore` 端口读写；
- 新建 / 替换时，挂 URL 的节点要现场换成已登记仓库的 id：
  - 托管部署经 `mirrors.remoteRegistration.register` 校验远端后登记；
  - 单机部署经 `services/gitRepoCache` 的 `resolveCachedRepo` 克隆进镜像缓存，等待上限取系统配置的 git clone 超时；
  - 这两样依赖都由路由拼好再传进来（路由因此要收系统配置、仓库存储与 mirrors 三样东西）；
- 展平函数 `resolveRepoGroupLayout` 还被 source-control 的三个文件与 legacy 的 `services/task.ts` 使用；
- `groupsReferencingRepo`、`detachRepoFromAllGroups` 只是存储端口同名方法的转手，生产里没有调用方（只有一个用例经它们调存储）。

## 2. 目标

- **G1 用例归 source-control application**：`services/repoGroup.ts` 迁入 `application/repositoryGroups.ts`：
  - URL 现场导入改为注入的 `importRepositoryUrl(url) → cachedRepoId`，application 不再 import legacy；
  - 其余函数体原样。
- **G2 路由只经 public 合同**：
  - 新的 `RepositoryGroups` 合同（`list` / `get` / `layout` / `preview` / `create` / `update` / `remove`）在 `application/ports`，
    经 `public/types` 转出；
  - `composeRepositoryGroups` 装配它：托管部署导入走远端登记，单机部署走镜像缓存，等待上限每次请求现取；
  - 路由改为 `mountRepoGroupRoutes(app, groups)`，不再 import `services/`，也不再收系统配置、仓库存储与 mirrors。
- **G3 展平函数经 public**：source-control 内部三个文件改取同模块文件；`services/task.ts` 改取 `public/queries`。
- **G4 删除死转手**：`groupsReferencingRepo`、`detachRepoFromAllGroups` 不随迁，用例改为直接调存储端口的同名方法。
- **G5 行为不变**：七个端点的参数、权限、响应与错误码不变；URL 导入的选择（托管登记优先）、等待上限与「无导入能力」
  时的 `repo-group-url-import-unavailable` 不变。
- **G6 不留 facade**：`services/repoGroup.ts` 删除。

## 3. 非目标

- `routes/cached-repos.ts` 与 `services/gitRepoCache`、`services/repoBatchImport`、`services/repoCredentials`；
- `services/task.ts` 的其余部分；其余 5 个路由；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：
  - `services/repoGroup.ts` 不再存在，源码里没有对它的 import；
  - `routes/repoGroups.ts` 不 import `services/`，对 source-control 只经 `public/types`；
  - application 文件不 import legacy 与 infrastructure。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 6 → 5；
  - `services/` 文件 217 → 216；
  - 模块里 import `services/` 的文件 143 → 142；
  - `R1` 166、`R2` 39 不变。
- **AC-3**：以下用例全部通过：
  - 仓库组管理面（HTTP 与服务层）、展平预览、删除摘引用与定时任务；
  - 仓库组物化与启动、托管的远端登记；
  - 路由注册、错误码与 API 合同。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **用例进 application，不进 infrastructure**：七个用例只经存储端口读写、只依赖共享合同的纯函数，属于用例层；唯一的
   legacy 依赖（镜像缓存的克隆）改为注入后，application 层规则（不 import infrastructure / composition / legacy）成立。
2. **两种 URL 导入合成一个注入函数**：原先 `register`（托管）优先、`cache`（单机）其次、都没有则拒绝；装配层按部署形态选其一，
   效果与原优先级相同，用例层只剩一个分支。
3. **系统配置不进 source-control**：等待上限由装配根以 `cloneTimeoutMs()` 函数传入，source-control 不依赖 system-operations 的
   配置类型；每次新建 / 替换现取一次，与原路由按请求读取一致。
4. **展平函数经 `public/queries` 给 `services/task.ts`**：它是 source-control 的查询，`public/queries` 已有同类的函数导出；
   改走 public 不新增 R1 边。
5. **删除两个死转手而不是迁过去**：生产没有调用方；保留会给 application 层留下两条只转手存储的空 API。
