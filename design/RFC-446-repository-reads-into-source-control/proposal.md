# RFC-446 仓库 refs / files 读取归 source-control（RFC-294 W4 B / D 第十二步）

- **状态**：In Progress（2026-11-04）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-445](../RFC-445-launch-multipart-and-recovery-counters/proposal.md)（启动 multipart 信封与恢复计数归 platform）
- **落位**：source-control 的 `infrastructure/local/repositoryIntrospection.ts`（本机镜像目录上的 refs / files 读取，以及 `?path=`
  形式只读已登记镜像目录的判定）；`composition/repositoryMirrors.ts` 改为装配它。

## 1. 背景

RFC-445 之后 7 个路由仍 import `services/`。其中 `routes/repos.ts`（`GET /api/repos/refs|files`，启动向导的分支与文件下拉）
只差一个函数：

- `services/repo.ts`（60 行）有三样东西：
  - `getRepoRefs`、`getRepoFiles`：在本机镜像目录上跑 git，读分支、标签、最近提交与文件清单；
  - `isKnownRepoPath`：判定一个目录是否落在某个已登记镜像目录之内（RFC-099）。
- `getRepoRefs`、`getRepoFiles` 的唯一生产消费者是 source-control 的 `composition/repositoryMirrors.ts`：单机部署的
  `RepositoryMirrors` 用它们按仓库 id 读，也作为 `local`（旧的 `?path=` 形式）直接按目录读。
- `isKnownRepoPath` 的唯一生产消费者是路由：`?path=` 形式在调 `mirrors.local` 之前，先取 `store.listKnownRepositoryPaths()`
  判定目录已登记，否则 422 `repo-path-unknown`。这一判定是路由要额外收 `RepositoryWorkspaceStore` 的唯一原因。

## 2. 目标

- **G1 读取归 source-control**：`getRepoRefs`、`getRepoFiles`、`isKnownRepoPath` 原样迁入
  `modules/source-control/infrastructure/local/repositoryIntrospection.ts`。
- **G2 已登记目录判定随本地读**：
  - 路由里「先判定、再读」的两步移进同一文件的 `createKnownPathRepositoryReads`；
  - 单机部署的 `RepositoryMirrors.local` 由它装配；
  - 端口文档写明 `local` 只读已登记镜像目录之内的路径。
- **G3 路由变薄**：`routes/repos.ts` 不再 import `services/`，不再收 `RepositoryWorkspaceStore`：`mountRepoRoutes(app, mirrors)`。
- **G4 行为不变**：以下全部不变：
  - 两个端点的参数、权限、响应与错误码；
  - 判定顺序：缺参 → 部署不持有本机镜像 → 目录未登记 → git 读取；
  - 未登记目录在任何 git 调用前被拒；
  - 按 id 读时错误消息不带本机路径（RFC-204）。
- **G5 不留 facade**：`services/repo.ts` 删除。

## 3. 非目标

- source-control 的其余两个路由（`repoGroups`、`cached-repos`）与 `services/gitRepoCache`、`services/repoGroup`、
  `services/repoCredentials`；其余 5 个路由。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：
  - `services/repo.ts` 不再存在，源码里没有对它的 import；
  - `routes/repos.ts` 不 import `services/`，也不再收仓库存储；
  - 已登记目录判定只在 source-control 一处。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 7 → 6；
  - `services/` 文件 218 → 217；
  - `R1-inbound-module-internals` 166、`R2-outbound-module-to-legacy` 39 不变。
- **AC-3**：以下用例全部通过：
  - 仓库 refs / files 端点（按 id 与 `?path=`，单机与托管）；
  - 已登记目录判定；
  - 启动向导相关的路由与 API 合同。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **三个函数进 `infrastructure/local`，不进 domain**：
   - 两个读取在本机目录上跑 git；
   - 目录判定按 `node:path` 的 `resolve` 解析，相对路径依赖进程工作目录，而且只对本机镜像有意义；
   - 所以与读取放在同一个本机适配器文件里。
2. **判定移进 mirrors，不经 public 给路由**：
   - 判定只服务于 `local` 读取，而 `local` 本身就是 `RepositoryMirrors` 的成员；
   - 移进去之后路由不再需要仓库存储，判定与读取也不再分在两处；
   - 若改成经 public 把判定函数给路由，就要给 public 面加一个函数值导出，路由也仍要收存储。
3. **判定写成本地读的工厂（`createKnownPathRepositoryReads`），不直接写进 composition**：
   - composition 只负责装配；
   - 规则与它保护的读取同处，用例可以直接构造工厂、断言未登记目录不触发 git。
