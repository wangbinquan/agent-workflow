# RFC-450 代码平台连接与调用归 integration（RFC-294 W4 B / D 第十五步）

- **状态**：In Progress（2026-11-05）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-449](../RFC-449-code-host-requests-injected/proposal.md)（task-execution 与 development-automation 已只认自己的端口）。
- **落位**：integration 的 `domain`（URL、TLS 选项判据、project 定位段推导）、`application/ports`（调用与连接合同）、`application`（测试连接用例、
  MR 用例改走端口）、`infrastructure/codeHost`（连接服务、调用执行器、恢复探测）、`composition`、`public/types`；两个路由与装配根。

## 1. 背景

RFC-449 之后 4 个路由仍 import `services/`，其中 `codeHosts`、`accountRepositoryTransportCredentials` 两个取 `services/codeHost/connections`
（规范化 TLS 选项、探测连接、服务类型）。`services/codeHost/` 的五个文件（连接 670 行、调用 914 行、project 定位段 124 行、恢复探测 97 行、
URL 75 行）在架构报告里已登记 owner 为 integration：

- integration 自己的 MR 用例（`application/mrEnsure.ts`、`application/mrFacts.ts`）直接 import 调用执行器与连接探测，`R2` 账本里记着 4 条
  application → legacy 的边，「该能力尚无 port/public 合同可替代」；
- `codeHosts` 路由的「测试连接」端点自己做编排：未传的字段回落到已存值、规范化 TLS 选项、探测、只有测的就是已存那套时才回写结果；
- 装配根从 legacy 取连接服务、三个节点请求函数与启动恢复探测。

RFC-449 已经让 task-execution、development-automation 只经注入的端口使用这些能力，所以这一步可以整体搬进 integration 而不产生 DAG 外的边。

## 2. 目标

- **G1 家族迁入 integration**：五个文件按层落位（纯规则进 `domain`，调用 / 连接的数据形状与端口进 `application/ports`，执行器、连接服务与恢复探测
  进 `infrastructure/codeHost`）；`services/codeHost/` 删除。
- **G2 MR 用例走端口**：`mrEnsure` / `mrFacts` 经绑定里的 `requests`（`CodeHostRequests`：执行调用、探测连接）发请求；绑定由交付 provider 与测试给出，
  实现由装配注入；清偿 4 条 `R2`。
- **G3 测试连接成为用例**：`codeHosts` 路由「测试连接」的编排原样迁入 integration `application/codeHostConnectionTest.ts`；路由只经 public 合同
  `CodeHostConnectionAdministration`（列表、保存、删除、测试）；个人凭据路由只经 public 合同 `CodeHostConnectionProbe` 探测。
- **G4 装配**：integration composition 给出连接服务、两个路由合同（出站 fetch 测试注入点在这里绑定）、MR 绑定用的请求实现、节点请求实现与启动恢复探测；
  装配根与 HTTP 装配改从这里取。
- **G5 行为不变**：调用、回退、恢复探测、连接 CRUD、测试连接的回落 / 回写规则、个人凭据测试、所有错误码与 HTTP 形状不变。

## 3. 非目标

- `cached-repos`、`tasks` 两个路由（后续 RFC）；
- `services/developmentDeliveryDeps.ts` 的收口（W4-E）；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/codeHost/` 不存在；没有文件 import `services/codeHost/*`；两个路由不再 import `services/`。
- **AC-2**：integration 的 application / domain 不 import 本模块 infrastructure（分层门不新增债）；`R2` 清偿 mrEnsure / mrFacts 的 4 条；
  public surface 不新增债。
- **AC-3**：计数按实测更新：import `services/` 的路由 4 → 2；`services/` 文件 213 → 208；`R2` 39 → 35；模块里 import `services/` 的文件按实测下降。
- **AC-4**：代码平台节点执行、调用 / 回退 / 恢复探测、MR ensure / facts / reply、连接 CRUD 与测试连接、个人凭据测试、交付 provider 的既有用例全部通过；
  新增测试连接用例的单元用例（回落已存值、只在测已存那套时回写、缺字段报未配置、GitHub 关 TLS 校验被拒）。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **MR 用例的端口放在绑定里**：绑定本来就带着调用期依赖（连接、模板上下文、fetch 测试注入点）；把执行器作为绑定的一项，legacy 的
   `services/developmentDeliveryDeps.ts` 只是转手绑定，不需要改，也不新增 legacy → 模块内部的边。
2. **纯规则进 domain**：URL 拼装、TLS 选项判据、project 定位段推导都是无副作用的规则，供 infrastructure 与测试连接用例共用；
   Bun fetch 的 TLS 片段仍在 infrastructure。
3. **两个路由合同各取所需**：管理端路由只拿它用到的「列表 / 保存 / 删除 / 测试」四个操作；个人凭据路由只拿「探测」。
   出站 fetch 的测试注入点从路由依赖移到 composition。
