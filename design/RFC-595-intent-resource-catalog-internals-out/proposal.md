# RFC-595 intent 不再取 resource-catalog 的内部（RFC-294 S9 余项：跨 context 内部文件对 6 → 4）

- **状态**：Done（2026-11-25，落地 `6f05a750b`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §14 终局判据“跨 context 内部文件对 → 0”、“bootstrap 唯一装配”；
  S9 的同类先例见 [RFC-559](../RFC-559-memory-consumer-owned-ports/proposal.md)、[RFC-563](../RFC-563-content-reference-own-shapes/proposal.md)。

## 1. 背景

`cross-context-internal-file-pairs` 为 6。其中两对是 intent 取 resource-catalog 的内部：

1. `intent/composition/apply.ts` → `resource-catalog/composition/intentApply.ts`：intent 的装配文件自己造了 resource-catalog 的四件东西——本机插件 / 技能工件属主、
   技能工件补偿原语、技能内容定位查询。resource-catalog 那边的注释写的本来就是“由 RC 提供、bootstrap 注入”；四个调用方又全在 bootstrap 里。
2. `intent/infrastructure/intentApplyEngine.ts` → `resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants.ts`：apply 引擎驱动的资源
   会话，类型取自 resource-catalog 的 infrastructure 文件。

目标 DAG 上 intent → resource-catalog 是 offered-consumption，只能经 exact public 入口。另外四对（integration 取 task-execution 的效果能力、code-capability 取
resource-catalog 的写入参与者）属能力合同与 W4-E8 的兼容岛，不在本 RFC。

## 2. 目标

- **G1**：intent 的三个装配函数不再自己造 resource-catalog 的东西，改为必填入参；bootstrap 从 resource-catalog 的装配根取来交入。本机工件一族照托管一族的
  形状：托管一族收 `HostedIntentResourceArtifacts`，本机一族收 intent 声明的 `LocalIntentResourceArtifacts`，由 resource-catalog 新增的
  `composeLocalIntentResourceArtifacts` 造出（构造与原来逐一相同）。
- **G2**：资源会话改用 intent 自己的端口形状（`application/ports/intentApplyResourceSession.ts`），只写引擎实际调用的方法与传的值；resource-catalog 的实现
  在 bootstrap 绑定处按结构满足它（编译期检查）。
- **G3**：`cross-context-internal-file-pairs` 6 → 4；其余计数不升（public 面与 public 类型偏差不变）；行为不变。

## 3. 非目标

- 另外四对跨 context 内部文件对（见背景）。
- apply 引擎本身、资源会话的实现、本机 / 托管工件的行为——都不动。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：intent 的全部文件只经 `resource-catalog/public/*` 取 resource-catalog；resource-catalog 的 `composition/intentApply` 在生产代码里只有 bootstrap 取。
- **AC-2**：本机工件一族、维护 worker 的工件内容与两处工件生命周期的构造与原来逐一相同；intent apply、工件恢复与守护进程 intent 装配的用例通过。
- **AC-3**：`cross-context-internal-file-pairs` 上限 6 → 4；其余计数不升；新增 RFC-595 用例并登记（含编译期断言）。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
