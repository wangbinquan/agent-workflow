# RFC-596 事件收件箱的通道在 integration 的业务层改用中立名字（RFC-294 §14：业务层部署模式分支 1 → 0）

- **状态**：Done（2026-11-25，落地 `eead26c45`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §14 的不变量“业务层部署模式分支 = 0”。

## 1. 背景

`architecture/counts.json` 的 `deployment-mode-branch-sites` 为 1，唯一一处是 integration 的 `application/ports/crewStationEventInbox.ts` 里
`CrewStationEventChannel = 'crewstation' | 'shadow'`：托管事件入站给每个目标端点一个通道，`crewstation` 表示接纳事件，`shadow` 只记录本会接纳什么。
业务层只区分“是不是 `shadow`”（`application/crewStationEventIngress.ts`），`crewstation` 这个名字来自 CrewStation 的事件源配置（`AW_EVENT_SOURCES`
里绑定的 `mode`）与收件箱表的 `mode` 列——是部署的词汇，不是业务含义。RFC-426 收口时把它留作唯一例外。

## 2. 目标

- **G1**：业务层（application 端口与入站用例）把接纳通道叫 `admit`；`shadow` 不变。
- **G2**：CrewStation 的配置与收件箱表照旧用 `crewstation`（外部合同与持久值不变，不需要迁移）；名字的互译只在托管适配器（`infrastructure/crewstation/`）
  的一对函数里做，配置 → 目标、目标 → 行、行 → 目标三处都经它。
- **G3**：`deployment-mode-branch-sites` 1 → 0，§14 的该条不变量成立；其余计数不升；行为不变。

## 3. 非目标

- 收件箱表、CrewStation 事件源配置的取值与 schema（不改持久值，不改外部合同）。
- 托管入站的其余行为。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无（通道名只在 integration 进程内的业务层出现，不经 HTTP / WS 交出）。

## 6. 验收标准

- **AC-1**：integration 的 domain / application / engine / inbound / public 不再出现部署名字面量；业务层的通道是 `admit` / `shadow`。
- **AC-2**：互译是全的、互逆的；配置里的 `crewstation` 绑定照旧接纳事件，`shadow` 照旧只记录；收件箱行的 `mode` 照旧存 `crewstation` / `shadow`；托管入站与收件箱
  的用例通过。
- **AC-3**：`deployment-mode-branch-sites` 上限 1 → 0；其余计数不升；新增 RFC-596 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
