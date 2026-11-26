# RFC-610 自动升级结论的回执取发布时的 JSON（RFC-294 S9 余项：public 类型偏差 12 → 11）

- **状态**：Done（2026-11-26，落地 `0fdb118d8`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」：
  收法由本会话裁定（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S9（public 类型污染清单为空，design §14）；接
  [RFC-606](../RFC-606-runtime-contract-json-and-closed-mapped-types/proposal.md) 的平台 `JsonValue` / `JsonObject`。

## 1. 背景

`PUBLIC_SURFACE_DEBT` 余 12 条：能力 / 凭据 / 身份一族 11 条（延后），以及 system-operations 的 `AutoUpgradeConclusion` 1 条。

- `db migration auto` 的结论（CLI 以 JSON 打印，daemon 启动时的自动升级也返回它）在成功时带回执：`receipt?: Readonly<Record<string, unknown>>`。
- 回执由自动升级的记录端口 `receipt()` 发布：第一次把值序列化写进 `receipt.json`，恢复时读回原来的字节。
- 记录层的载荷按 RFC-398 §2.7 不透明，可回执是发布出去的 JSON，不是任意对象。
- 端口第一次调用时返回的却是传进来的对象本身，不是发布出去的 JSON：值为 `undefined` 的键还在，与恢复时读回的形状不一致。

## 2. 目标

- **G1**：记录端口的 `receipt()` 返回发布出去的 JSON（平台 `JsonObject`）：第一次与恢复时一样，都是发布字节的解析结果。入参照旧不透明。
- **G2**：`AutoUpgradeConclusion.receipt` 的类型改为 `JsonObject`（RFC-606 指定的平台合同类型），用例照旧把端口返回的回执交给结论。
- **G3**：这 1 条离开 `PUBLIC_SURFACE_DEBT`（12 → 11），`public-surface-deviations` 同步降到 11；其余计数不升。

## 3. 非目标

- 记录层其余载荷（`append` 的 `data`、会话记录）的类型：按 RFC-398 §2.7 保持不透明。
- 能力 / 凭据 / 身份一族 11 条（延后）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。CLI 打印的 JSON 逐字不变：值为 `undefined` 的键本来就不进 JSON。

## 6. 验收标准

- **AC-1**：`receipt()` 第一次与恢复时返回同一份 JSON（发布字节的解析结果）；恢复时返回原来发布的字节，不看新传入的值。
- **AC-2**：`AutoUpgradeConclusion.receipt` 是 `JsonObject`；`tsc` 通过。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 去掉这 1 条且逐条相等，计数降到 11。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
