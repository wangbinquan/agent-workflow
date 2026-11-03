# RFC-431 单机部署选择项的默认值集中到单机 profile（RFC-294 S2c）

- **状态**：Done（2026-11-03 落档并实施；exact SHA `90e1d0974` 主 CI 70/70、windows-platform 与 maintenance-soak-nightly 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：
  本会话调研、设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；用户 2026-10-31「后面的工作你可以不用启动codex来做，你自己完成」，
  不派 Codex。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c 余项第 1 项的第二步
  （[RFC-428 盘点](../RFC-428-dead-deployment-selections/inventory.md)「后继分步」第 2 条）
- **前序**：[RFC-428](../RFC-428-dead-deployment-selections/proposal.md)、[RFC-429](../RFC-429-evidence-deployment-selections/proposal.md)、
  [RFC-430](../RFC-430-derivable-deployment-selections/proposal.md)
- **落位**：`bootstrap/`（部署 profile 合同、单机 profile、启动 / 会话 / 应用 / HTTP 装配与各模块组）；各模块只在 `composition` 入口导出本地实现，
  并删去只为「选择项可能缺省」而存在的归一化。

## 1. 背景

`DeploymentSelections` 61 项全部可选。托管 profile（`bootstrap/crewstation.ts`）每项都设，单机 profile 一项不设（`selections: {}`），
单机行为靠各消费点在值缺省时补上：

- **同一个默认散在多处**：四个工作区工厂在启动、应用装配、`providerRuntime.ts` 各归一化一遍；`verificationCommands` 2 处、
  `repositoryBaselines` 3 处、`evidenceArtifacts` 5 处、`workspaceContent` 2 处、`bootExecutionRecovery` 2 处……
- **托管漏设不报错**：可选类型让托管 profile 少给一项也能编译，运行时静默退回单机的文件实现。
- **「能力关」藏在缺省里**：托管独有的能力（任务输入文件留存、人工门产物恢复、事件观测写前钩子、托管恢复循环、维护 Worker 效果描述、
  执行初始化包装）以「没给」表示关闭，读代码看不出哪些部署有意不提供。

RFC-428 盘点把收尾拆成四步：删死槽（RFC-428～430 已完成）、**单机默认值集中（本 RFC）**、需要会话图的默认值、按有无分支的项。

本次逐项追踪还发现一处根目录分叉：数字员工图开发（RFC-396，v0.19.3 已发布）在单机下把证据存进 `appHome` 根下的 `blobs/`、`bundles/`，
其余证据都在 `appHome/evidence/`；托管两者是同一个存储。单机磁盘上两处都已有数据。

## 2. 目标

- **G1 单机 profile 给出完整选择**：`bootstrap/standalone.ts` 新增 `standaloneSelections({ appHome })`，构造第二步范围内每一项的单机值；
  `composeStandaloneProfile()` 的 `selections` 由它给出，测试入口用同一个函数。
- **G2 选择项三分区**：
  - 39 项改为必填，单机给本地实现，托管照旧；
  - 6 项托管独有能力改为必填可空（`X | null`），单机显式给 `null`；
  - 其余 17 项保持可选，并逐项写明留给哪一步：10 项需要会话图（第三步），7 项是部署开关或有无分支（第四步）。
- **G3 装配层不再补缺省**：`bootstrap/` 对前两组的 45 项不再出现 `??`、`?.`、与 `undefined` 比较、`select*` 归一化：
  - 删除只为可选项存在的装配助手（如 `standaloneModuleAdapters`、`selectTaskRunRootSelection`、`createGraphDevelopmentArtifactBinding`）；
  - RFC-394 架构锁的 `REQUIRED_OVERRIDES` 收缩为只剩 `secretBox`。
- **G4 行为不变**：两种部署的实现、根目录与时序都与今天一致。
  - 图开发证据仍在单机 `appHome` 根下：新增必填选择项 `graphDevelopmentArtifacts` 显式表达，托管给的仍是与 `evidenceArtifacts` 同一个对象。
  - 单机 profile 在启动锁之前构造，选择项构造不做 IO：会建目录的两个证据存储与需求文档命令改为首次访问时打开。证据存储仍在应用装配时被访问，图开发存储与需求文档暂存目录推迟到首次读写（design §4），已有内容与读写位置不变。
- **G5 结构锁**：新锁 `rfc431-standalone-selections` 锁住以下四点，每点带负例：
  - 三分区逐项对账；
  - 单机 profile 恰好给齐前两组；
  - `bootstrap/` 对前两组无缺省；
  - 退役助手不回来。

## 3. 非目标

- 第三步（需要会话图的 10 项改为两侧都给的工厂型选择项）与第四步（`databaseInstallation`、`secretBox`、`repositoryRemote`、
  `crewStationEvents`、`executionAuthority`、`repositoryCandidateEffects`、`conflictMergeWorkspaceEffects`）。
- 模块内部、除 `bootstrap/` 之外还有其他调用方（模块级用例、维护 Worker、CLI）的可选依赖及其缺省：本 RFC 不动，逐项列为债务（design §6）。
- 维护 Worker 线程内按效果族的单机缺省（`maintenanceEffectsBootstrap` 为 `null` 时由 Worker 图自己装配）。
- 统一证据根目录：需要数据迁移，另行立项。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 三分区**：`DeploymentSelections` 62 项（RFC-430 后 61 项，加 `graphDevelopmentArtifacts`）= 39 必填 + 6 必填可空 + 17 可选，
  结构锁逐项对账，含负例。
- **AC-2 单机 profile**：`composeStandaloneProfile().selections` 的键恰为前两组 45 项，可空组为 `null`；行为用例断言：
  - 各项是本地实现；
  - 根目录取传入的 `appHome`；
  - 构造时不在磁盘上建任何目录。
- **AC-3 装配层无缺省**：`bootstrap/` 对前两组没有 `??` / `?.` / `undefined` 比较，结构锁含负例；RFC-394 锁的 `REQUIRED_OVERRIDES`
  只剩 `secretBox`；退役助手不再出现在源码里。
- **AC-4 托管**：托管键集合与键表 61 → 62；托管的 `graphDevelopmentArtifacts` 与 `evidenceArtifacts` 是同一对象。
- **AC-5 回归**：既有部署 profile、root wiring、工作区、证据、开发目的、任务执行、资源包、事件中心用例全部通过；只读源码的接线锁改为断言新接线。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **图开发证据保留根目录**：新增 `graphDevelopmentArtifacts`，不在本 RFC 统一到 `appHome/evidence`。统一会让 v0.19.3 以来单机已写的图开发
   证据读不到；数据迁移另行立项。
2. **托管独有能力用 `X | null`**：消费点判 `null` 即「能力关闭」，与今天「没给 = 关」一一对应。不用空操作充当中立值：观测写前钩子的空操作会给
   事件事务多一次 await，维护效果描述的空值会换掉 Worker 入口。
3. **候选提交与冲突合并推到第四步**：两者缺省时，单机按请求换用调用方的 git，候选推送还能推到本地文件 remote（`localFixtureSession`）。
   这不是一个值能表达的，需要先为「本地模式」设计端口。
4. **选择项构造不做 IO**：单机 profile 在启动锁之前构造。会在构造时建目录的两个证据存储与需求文档命令改为首次访问时打开。图开发存储与需求文档暂存目录因此从应用装配时推迟到首次读写（空目录；内容盘点与备份对缺目录按 ENOENT 跳过）。
5. **模块内部的缺省按调用方处理**：
   - 只被 `bootstrap/` 调用的模块入口：改为必填，删掉缺省；
   - 还有其他调用方的：保留，列为债务。
     这样本 RFC 的边界可由结构锁判定，不把模块级用例的改写卷进来。
6. **一个 RFC 做完第二步**：45 项机械但互相牵连（开发目的依赖证据存储，工作区工厂跨三处归一化）。拆开会多出一轮「部分必填」的中间态。
