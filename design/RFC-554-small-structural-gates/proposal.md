# RFC-554 两个小结构门：死的 export-star 门面与 application 里的直接副作用（RFC-294 S9 余项）

- **状态**：Done（2026-11-23，落地 `a74820d0b`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §14“`export *` barrel → 0”“application 直接副作用
  → 0”；RFC-376 的结构门（`export-star-barrels`、`application-direct-effect-files`）。

## 1. 背景

- **export-star 门面**：`runtime-management/application/runtimeRegistry.ts` 末尾 `export * from '../domain/runtimeProfile'`，是 `export-star-barrels`
  门上唯一的一条。实测没有任何文件经它取 domain 的名字（import、转出与命名空间 import 都没有）——它是死的转出。
- **application 直接副作用**：`integration/application/repositoryEndpointDiscovery.ts` 是代码平台的仓库元数据 HTTP 适配器（拼请求路径与鉴权头、
  解析响应），没有注入 `fetch` 时直接调全局 `fetch`，是 `application-direct-effect-files` 门上的两条之一。按内容它是 source-control 的
  `RepositoryEndpointDiscoveryParticipant` 端口在 integration 一侧的实现，属于 infrastructure（与同目录的 `infrastructure/codeHost/connections.ts`
  同类）。另一条（intent 的维护清理）在 RFC-375 的保留清单上、后继是 RFC-370 收口，不在本 RFC。

## 2. 目标

- **G1**：删掉死的 `export *`；`export-star-barrels` 1 → 0。
- **G2**：仓库端点发现挪进 `integration/infrastructure/codeHost/repositoryEndpointDiscovery.ts`，组合根与用例改取新位置；
  `application-direct-effect-files` 2 → 1。
- **G3 结局不变**：只删死转出、挪文件位置与改 import。

## 3. 非目标

- intent 的维护清理（RFC-375 保留清单）；部署分支字面量；不可达文件清单（RFC-375 的保留清单）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`runtimeRegistry.ts` 没有 `export *`；仓库端点发现在 integration 的 infrastructure，application 下没有它。
- **AC-2**：行为不变。
- **AC-3**：两份精确清单与 `counts.json` 随之降低；新增 RFC-554 用例并登记 guard-manifest；读旧位置的用例随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
