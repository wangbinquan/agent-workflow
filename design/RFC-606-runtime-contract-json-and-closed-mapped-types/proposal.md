# RFC-606 runtime-management 合同里的开放类型：JSON 值、有限键映射与失败原因（RFC-294 S9 余项）

- **状态**：Done（2026-11-26，落地 `01306b9ce`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  检测规则与收法由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S9；接
  [RFC-605](../RFC-605-opaque-identity-handles/proposal.md) 之后余下的 runtime-management 四条。

## 1. 背景

RFC-605 之后 `PUBLIC_SURFACE_DEBT` 余 16 条：11 条属能力 / 凭据 / 身份一族（等 RFC-546），1 条是 system-operations 的自动升级回执，4 条在
runtime-management：

- **运行时用量事件**：`RuntimeUsageMeter.observe(event: Readonly<Record<string, unknown>>)` 收的是运行时 stdout 上的一条原生 JSON 事件。各驱动的
  事件格式不同，本来就开放；但它是 JSON，不是任意值。
- **探测回执视图**：`RuntimeView.lastProbe: unknown` 是存量探测回执里的 `smoke` 段，从数据库的 JSON 列解析而来。
  - 只有 codec 1、目标与当前运行时一致的回执才会展示，其余为 `null`。这本身就是对存量回执的兼容口径（plan 的 2026-11-24 对账要求先定它）。
- **清单声明**：shared 的 `InventoryDeclaration` 是按清单面（`InventoryFace`，一个封闭的 `z.enum`）映射的类型。新增一面时每个驱动都必须表态（RFC-462）。
  - 检测器把一切映射类型记为开放，但键集合封闭的映射类型就是一个有限的对象类型。
- **子会话清扫的失败原因**：`SystemAgentSessionSweepOutcome.failureReason?: unknown`。唯一的实现（opencode）给的是字符串，消费方只取它的消息。

design §3.3 对 public 类型的要求是“JSON-safe value”，与“开放的 `unknown`”不同。

## 2. 目标

- **G1**：平台新增 `platform/contracts/json.ts` 的 `JsonValue` / `JsonObject`（递归的 JSON 值与对象）。迁移转换里同名的 `JsonValue` 改为从这里转出，只留
  一份定义。二者认作指定的平台合同类型（RFC-604 规则一的清单加两项）。
- **G2（规则三）**：映射类型的键约束不是 `string` / `number` / `symbol` 这类原始键、也不是模板字面量时，算闭合；键约束与值类型照旧检查。
- **G3**：用量事件改为 `JsonObject`，探测回执视图改为 `JsonValue | null`，清扫失败原因改为 `string`。两处调用方本来就是 `JSON.parse` 的结果，只改断言的目标类型。
- **G4**：这 4 条离开 `PUBLIC_SURFACE_DEBT`（16 → 12），`public-surface-deviations` 同步降到 12；其余计数不升。

## 3. 非目标

- system-operations 的自动升级回执（`AutoUpgradeConclusion.receipt`）。它经纪元切换的会话记录层逐级组装，RFC-398 §2.7 有意让记录载荷保持不透明，另立。
- 能力 / 凭据 / 身份一族，等 RFC-546。
- 不给探测回执定具名 DTO：回执的 `smoke` 段随运行时与版本而异，前台也只按 JSON 展示。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：四处类型如 G3 所述；`tsc` 通过，运行期行为不变。
- **AC-2**：检测器对 `JsonValue` / `JsonObject` 与键集合封闭的映射类型放行；对其他平台类型、原始键或模板字面量键的映射类型照旧记债（正反用例）。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 去掉 4 条且逐条相等，计数降到 12。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
