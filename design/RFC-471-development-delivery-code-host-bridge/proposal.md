# RFC-471 开发交付的代码托管桥归 integration：`services/developmentDeliveryDeps.ts` 退役（RFC-294 W9-D 第十八步）

- **状态**：Done（2026-11-08，落地 `a9207cbc0`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 业务实现按 owner 归位）
- **前序**：[RFC-310](../RFC-310-rule-driven-development-digital-employee/proposal.md) PR-5 T60（MR effects 由 integration 组装、DA 以结构同形端口消费）；
  [RFC-399](../RFC-399-context-dag-platform-one-way/proposal.md) A2（`matchRepoProvider` 归 DA domain）；
  [RFC-450](../RFC-450-code-host-family-into-integration/proposal.md)（把本文件记为留下的债）。
- **落位**：integration `domain/repositoryProviderMatch.ts`、`composition/codeHostEffects.ts`；development-automation
  `application/ports/developmentDelivery.ts`、`composition/developmentDelivery.ts`、`infrastructure/developmentDeliveryProvider.ts`。

## 1. 背景

1. `services/developmentDeliveryDeps.ts`（`legacy-service-implementations` 之一，owner 记为 development-automation）是开发交付的代码托管桥：
   把 development-automation（DA）的交付 provider 接到 integration 的 MR 能力上。它取 DA 的三个内部文件（reconciler 端口、`canonicalJson`、
   `mrFacts` 投影）与 integration 的三个内部文件（`application/mrEnsure`、`application/mrFacts`、`composition/codeHostEffects`），是 7 条 `R1`。
2. 目标 DAG 上两者的关系是 **integration 实现 DA 的开发效果 SPI**（`required-implementation:integration->development-automation`）、
   integration 可以消费 DA 的 public；DA 不依赖 integration。而现在 DA 的 `composition/missionOperations.ts` 与
   `infrastructure/developmentDeliveryProvider.ts` 从这个 `services/` 文件取 MR effects 与 integration 的绑定类型——等于 DA 经 `services/`
   绕到 integration 内部，是一条藏起来的 DA → integration 依赖。
3. MR effects 有两份实现：生产走本文件的 `createDevelopmentMrEffects`（异步绑定），4 个 e2e 用例走 integration composition 的
   `composeDevelopmentMrEffects`（同步绑定）。后者的头注释写的正是目标形状（「绑定闭包由装配点注入；DA 侧以结构同形端口消费，两模块互不 import
   对方内部」），生产却没用它。
4. 「仓库 → 代码托管绑定」（按远端 URL 选连接、算 provider/project、拼出调用依赖）现在由 DA 的交付 provider 做，类型借本文件取 integration 的
   `MrEnsureConnectionDeps`。这是 integration 的调用管线（连接、调用上下文、请求），DA 只该知道仓库。

## 2. 目标

- **G1** integration 拥有代码托管绑定：`composeDevelopmentCodeHostBinding` 由「按仓库取远端 URL」（DA 的 `RepoRemotePort` 同形）、代码托管连接与
  请求组装出 `repositoryId → MrEnsureConnectionDeps | null`；`matchRepoProvider` 随它的唯一生产调用方迁回 integration `domain`。
- **G2** MR effects 只剩一份实现：integration 的 `composeDevelopmentMrEffects` 改收可异步的绑定（同步绑定的 4 个 e2e 用例照旧可用）；
  本文件的副本删除。integration 另组装 MR 原始事实读取（`composeDevelopmentMrFactsSource`）与仓库认领键（`composeRepositoryCodeHostClaimKeys`）。
- **G3** DA 拥有端口与投影：交付 provider 只答仓库远端、MR 事实目标与 pipeline 执行；MR effects / 原始事实 / 认领键由 DA 自己的端口类型声明
  （integration 的实现按结构满足，用例编译期锁）；`buildDevelopmentDeliveryDeps` / `buildDevelopmentMrFactsDeps` / `buildDevelopmentPipelineDeps`
  原样迁入 DA composition，只把「取绑定再调 integration」换成注入的端口。`missionOperations` 收注入的 MR effects 与认领键。
- **G4** 装配根接线：bootstrap 由 DA 的交付 provider 与 integration 的连接 / 请求组装绑定，再把 effects、原始事实、认领键注入 DA；
  integration 的代码托管事件观察者直接用同一个绑定。`services/developmentDeliveryDeps.ts` 删除。
- **G5** 账本下降：`R1` 64 → 57、`services/` 61 → 60、`legacy-service-implementations` 62 → 61；DA `public/participants` 去掉只有本文件在用的三个
  pipeline 证据导出、`public/types` 去掉同样只有它们在用的 `PipelineStagingFactories`（public surface 1497 → 1493）；不新增跨 context 内部文件对、off-DAG 边与文件对、
  public surface 偏差、不可达生产文件与 `module-layer-violations`，未被消费的 public 符号不升。

## 3. 非目标

- 交付 provider 的仓库目录（`cachedRepos` 的 URL 解封、volatile URL 回退）、MR 事实目标查询与 pipeline 执行的实现：原样不动。
- `services/repoCredentials.ts`、`services/task.ts`、`services/runtime/**` 的去处。
- 任何 MR 行为、错误码与错误文案的变化；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/developmentDeliveryDeps.ts` 不在，src / 用例 / 脚本零 import；DA 不取 integration 的内部文件，integration 不取 DA 的内部
  文件；integration 的绑定、MR effects、原始事实与认领键实现与 DA 端口逐项相同（编译期锁）；MR effects 全仓只一份实现。
- **AC-2**：架构计数按实测（§2 G5），账本逐条相等；越界类计数、public surface 偏差与未被消费的 public 符号不升。
- **AC-3**：受影响用例（开发交付与数字员工的 e2e、代码托管绑定、交付 provider 两引擎、pipeline 证据、发布账本、架构守卫）与新增 RFC-471 用例
  全部通过；四个包的用例都跑。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **绑定归 integration，`matchRepoProvider` 迁回**：RFC-399 A2 把它从 integration 移到 DA domain，理由是「它唯一的生产调用方」在 DA；本 RFC
   把那个调用方（绑定组装）按内容归 integration——按远端 URL 选代码托管连接、GitLab project 编码是代码托管的知识——函数随调用方回去，同样只有
   一个生产调用方。DA 只交出仓库远端（它本来就有 `RepoRemotePort`），不再拼 integration 的调用依赖。
2. **端口归消费方、实现按结构满足**：DA 声明 MR effects、原始事实、认领键的端口类型（DA 已有 `MrEffectsPort` 与工作项依赖里的同形声明），
   integration 的 composition 不 import DA、DA 不 import integration，装配根接线，用例编译期锁两边逐项相同；不新增 public 导出。
3. **投影留在 DA**：MR 事实的 cell 投影、快照摘要（`canonicalDigest`，`snapshotRef` 落库）与线程摘要只在 DA 做；integration 只交原始快照，
   摘要算的仍是同一个对象，`snapshotRef` 逐字不变。
4. **effects 合一份**：保留 integration composition 的那份（它就是目标形状），绑定改成可异步；本文件那份删掉。两份在失败形状上逐字相同
   （design §3 列明），合并不改行为。
