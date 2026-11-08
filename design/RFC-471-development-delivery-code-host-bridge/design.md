# RFC-471 设计

**落在哪个 context、哪一层**：代码托管绑定与 MR 能力在 integration `domain` / `composition`（integration 实现 DA 的开发效果 SPI，目标 DAG 的
`required-implementation:integration->development-automation`）；端口与投影在 development-automation `application/ports` / `composition`；
接线在 bootstrap。**承担的演进**：W9-D 的一步——`services/developmentDeliveryDeps.ts` 按内容拆回两个 owner，DA 经 `services/` 绕到 integration 内部的
那条藏起来的依赖消失，MR effects 合成一份。**留下的债**：DA 现有的三个 off-DAG offered 文件对（`composition.ts`、
`infrastructure/developmentDeliveryProvider.ts`、`infrastructure/local/legacyPipelineEvidence.ts` → integration public，取 pipeline 执行与适配器
绑定类型）不在本 RFC 动；交付 provider 仍取 `services/repoCredentials` 解封仓库 URL。

## 1. integration：绑定与 MR 能力

- **`domain/repositoryProviderMatch.ts`**：`matchRepoProvider` 及其私有辅助从 DA `domain/repositoryProviderMatch.ts` 原样迁回（RFC-399 A2 把它移到 DA，
  理由是唯一生产调用方在 DA；那个调用方本 RFC 归 integration，见 §2）。纯函数，只取 shared 的 `parseGitUrl`。
- **`composition/codeHostEffects.ts`**：
  - `RepoCodeHostBindingResolver` 改为 `(repositoryId) => MrEnsureConnectionDeps | null | Promise<MrEnsureConnectionDeps | null>`（与
    `composeDevelopmentCodeHostEventObserver` 收的绑定同形）；`composeDevelopmentMrEffects` 三个方法里 `deps.binding(repositoryId)` 前加 `await`，
    其余不变。4 个 e2e 用例给的同步绑定照旧可用。
  - 新增 `composeDevelopmentCodeHostBinding({ repositories, connections, requests })`：返回 `async (repositoryId) => MrEnsureConnectionDeps | null`。
    函数体是 DA 交付 provider 现在的 `resolveBinding`：取仓库远端 URL（`repositories.resolve(repositoryId)`，DA 的 `RepoRemotePort` 同形；
    `null` 即返回 `null`）→ `connections.resolve('gitlab' | 'github')` 取候选 → `matchRepoProvider` → 拼
    `{ provider, project, call: { connection, ctx: { ports: {} } }, requests }`。
  - 新增 `composeDevelopmentMrFactsSource({ binding })`：`collect(repositoryId, mrRef, { selfMarker })`——绑定缺失返回
    `{ ok: false, code: 'code-host-connection-missing', detail: 'no code-host binding for repository <id>' }`，否则
    `collectMergeRequestFacts(binding, mrRef, { selfMarker })` 的结果原样返回（快照是同一个对象）。
  - 新增 `composeRepositoryCodeHostClaimKeys({ binding })`：`resolve(repositoryId)` →
    `{ codeHostEndpointRef: binding.provider, stableProjectRef: decodeURIComponent(binding.project) } | null`（本文件 `resolveRepoClaimKey` 的
    函数体）。
  - 这些都只取 integration 自己的文件；不 import DA。

## 2. development-automation：端口、投影、provider

- **`application/ports/developmentDelivery.ts`**（新）：DA 自己的端口类型，按结构由 integration 满足——
  - `DevelopmentMrFactsSourcePort`：`collect(repositoryId, mrRef, options: { selfMarker })` → 原始快照结果。快照与线程、消息的类型逐项写成与
    integration `MrFactsSnapshot` / `MrThreadFact` / `MrThreadMessageFact` 同形（含 DA 不读的 `mrRef`、`mergedAt`），失败分支是
    `{ ok: false; code: string; detail: string }`；
  - `RepositoryCodeHostClaimKeysPort`：`resolve(repositoryId)` → `{ codeHostEndpointRef; stableProjectRef } | null`；
  - MR effects 用 DA 已有的 `MrEffectsPort`（`reconcilerPorts.ts`，PR-5 T60 写明「integration 组装的结构同形」）。
- **`infrastructure/developmentDeliveryProvider.ts`**：`DevelopmentDeliveryProvider` 接口在这里定义（原来在本 `services/` 文件），只剩
  `resolveRepository`、`readMrFactTarget`、`pipeline`；`resolveBinding`、`connections`、`requests` 与 `matchRepoProvider` 的导入删除。仓库目录、
  URL 解封与 volatile URL 回退、MR 事实目标查询原样不动。
- **`composition/developmentDelivery.ts`**（新）：本 `services/` 文件的三个组装函数迁来，函数体原样，只把「`provider.resolveBinding` 再调 integration」
  换成注入的端口：
  - `composeDevelopmentDeliveryDeps({ provider, mrEffects, mrFacts, staging })` → `{ repoRemote, mrEffects, mrFacts, pipelineEvidence }`（原
    `buildDevelopmentDeliveryDeps`）：`mrFacts.collect` 对原始快照做原来那份映射（`unresolvedReviewCount`、`reviewThreads`）；绑定缺失的失败
    仍是 `code-host-connection-missing` 与原文案。
  - `composeDevelopmentMrFactsCollector({ provider, mrFacts })` → `{ mergeRequestFacts }`（原 `buildDevelopmentMrFactsDeps`）：三处 `throw` 的文案
    逐字不变（`mission … has no MR claim …`、`mr claim … or mission not found`、`no code-host binding for repository …`、
    `mr facts collect failed: <code>: <detail>`）；cell 投影、`canonicalDigest`、线程 `bodyDigest` 不变。
  - `composeDevelopmentPipelineDeps(runner, staging?)`（原 `buildDevelopmentPipelineDeps`，两个重载原样）。
  - 类型只取 DA 自己的文件（pipeline 执行类型经 `../composition` 的既有转出取，与 `composition/pipelineEvidence.ts` 同路）。
- **`composition/missionOperations.ts`**：依赖 `deliveryProvider` 换成 `mrEffects: MrEffectsPort` 与
  `repositoryClaimKeys: RepositoryCodeHostClaimKeysPort`（`deliveryProvider` 原本只用于这两处）。
- **`domain/repositoryProviderMatch.ts`** 删除（迁回 integration）。
- **`public/participants.ts`**：`composeSelectedDevelopmentPipelineEvidence`、`composeLegacyDevelopmentPipelineEvidence` 与
  `LegacyPipelineEvidencePort` 不再转出——它们唯一的跨模块消费方就是本 `services/` 文件，迁入后 DA 在模块内直接取 `composition/pipelineEvidence`；
  留着就是无人消费的 public 符号（集中验证的架构报告查出：未被消费的 public 符号 322 → 324）。
- **`public/types.ts`**：`PipelineStagingFactories` 同理不再转出（跨模块消费方只有本文件与上面那个参与者导出；去掉参与者导出后报告仍是 323，
  第二轮报告查出的就是它）；DA 的 `composition.ts` 改从 `application/ports/evidenceStaging` 取这个类型。

## 3. 行为等价

- **MR effects 合一份**：两份实现的成功分支相同（`{ ok: true, mr }`、`{ ok: true, noteRef }`、`{ ok: true, observation }`）；失败分支——本文件
  原样返回 integration 函数的失败对象，integration 那份重建 `{ ok: false, code, detail }`：integration 的 `ensureMergeRequest` /
  `observeMergeRequest` / `replyMergeRequestThread` 每个失败出口都只构造这三个字段，两者逐字相同。`reply` 本文件把调用方的入参整体转交、
  integration 那份只取四个字段：被调函数只读这四个字段，相同。绑定缺失两份同码同文案。
- **绑定**：`resolveRepository` 与原 `resolveBinding` 读同一行、走同一个 URL 解封（同一个 `resolveUrl`），`null` 的条件相同；之后的候选、匹配与
  绑定拼装逐字迁移。
- **MR 事实**：DA 拿到的是 `collectMergeRequestFacts` 返回的同一个快照对象，`snapshotRef = canonicalDigest(snapshot)` 逐字不变。
- **认领键**：同一个绑定，同一段计算。
- **装配**：装配根给 DA 的仍是同一个交付 provider（`createDevelopmentDeliveryProvider` 少收两个参数）；integration 的代码托管事件观察者原来经
  `resolveDevelopmentRepoBinding(provider, id)`（即 `provider.resolveBinding(id)`），现在直接用同一个绑定组装。

## 4. bootstrap

- `daemonModules/repositoryCredentials.ts`：`createDevelopmentDeliveryProvider` 不再传 `connections` / `requests`；用它的 `resolveRepository`、
  `codeHostConnections` 与 `codeHostRequests` 组装 `developmentCodeHost = { binding, mrEffects, mrFacts, claimKeys }`，与 provider 一起放进返回的束。
- `daemonModules/developmentAutomation.ts`、`digitalEmployee.ts`：改调 DA composition 的三个组装函数（注入 `developmentCodeHost` 的 effects 与原始事实）；
  `missionOperations` 收 `mrEffects` 与 `repositoryClaimKeys`。
- `daemonModules/integration.ts` 与 `daemonApplication.ts`：事件观察者收 `developmentCodeHost.binding`。
- 装配根只取两个模块的 composition（不取 `infrastructure/`）。

## 5. 用例与账本

- 改路径：`rfc310-code-host-binding`（`matchRepoProvider` 改取 integration domain）、`rfc254-platform-surface-guard`（`posix-path-prefix` 登记的文件路径）、
  `rfc359-w4-d13-adapters`（交付 provider 少两个参数；绑定的断言改走 integration 的组装）、`rfc370-pipeline-evidence-content`（provider 类型改取 DA）、
  `rfc349-digital-development-provider-boundary`（读文件清单去掉本文件、加 DA 的新 composition）、`rfc321-repository-publication-ratchet`（两条否定锁改读
  DA 的新 composition 与 integration 的 composition，原意不变：交付桥不从 key file 解析凭据）、`tests/helpers/staticCachedRepositoryPreparation.ts`
  的注释、架构报告 owner 表去掉本文件、`tests/architecture/rfc380-daemon-module-bundles` 的组装名单按实际调用补齐、`tests/rfc380-daemon-module-bundles`
  的 repositoryCredentials bundle 键名单补 `developmentCodeHost`（集中验证的全量 SQLite 查出漏改）。
- 新增 `tests/rfc471-development-delivery-code-host-bridge.test.ts`：
  1. 本文件与 DA 的 `repositoryProviderMatch.ts` 不在、全仓零 import（`preProcessFile` 取说明符，带负对照）；
  2. 编译期锁：integration 的三个组装结果与 DA 的 `MrEffectsPort`、`DevelopmentMrFactsSourcePort`、`RepositoryCodeHostClaimKeysPort` 逐项可赋值，
     DA 的原始快照类型与 integration `MrFactsSnapshot` 逐项相同（`Equal`）；
  3. DA 不 import integration 的内部文件、integration 不 import DA（新文件与改动文件的说明符扫描）；DA 的 `public/participants.ts` /
     `public/types.ts` 不再转出那三个 pipeline 证据导出与 `PipelineStagingFactories`（TypeScript AST 取导出名，带正对照、拒 `export *`）；
  4. 行为：绑定（远端 URL 为空 → `null`；GitLab project 编码；无匹配连接 → `null`）；MR effects 绑定缺失的失败形状、异步绑定可用；原始事实绑定缺失
     的失败、成功时返回同一个快照对象；认领键的解码；`composeDevelopmentMrFactsCollector` 的四条错误文案与 `snapshotRef` 等于
     `canonicalDigest(snapshot)`；`composeDevelopmentDeliveryDeps` 的 `mrFacts` 映射。
  5. 交付 provider 的两引擎行为沿用 `rfc359-w4-d13-adapters`（真库）。
- 账本：`architecture/commons-debt.json` 的 `R1` 按实测销账（预期 64 → 57）；`rfc294-architecture-preflight` 的 public surface 债务登记改名——
  `composeSelectedDevelopmentPipelineEvidence` 不再 public 后，证据暂存命名空间那个开放的 `object` 字段改由 `assertEvidenceStagingFactory`
  先触到（偏差去重按声明、记在第一个触到它的 public 导出名下），偏差数 94 不变；guard-manifest 刷新改到的守卫文件行数。

## 6. 失败模式

- 绑定组装在 bootstrap 漏接 → 编译期（DA 依赖是必填）与 `rfc380` / 本 RFC 的接线锁同时报出。
- 结构同形漂移（integration 改了快照字段）→ RFC-471 用例的 `Equal` 锁编译期报出。
- 新文件误取对方内部 → 架构报告的跨 context 内部文件对与 off-DAG 文件对增加，`rfc376` / `rfc294-review-offered-edge-dag` 报出。

## 7. 测试策略

完整实现与用例写完后集中验证：backend 全量 SQLite（导出仓库）、PostgreSQL lane（改到的用例、闭包、全部架构测试）、P0 两引擎、**shared /
system-mocks / frontend 三个包的用例**（RFC-470 教训：别的包会按路径读后端源码）、文档用例、架构报告计数复核。
