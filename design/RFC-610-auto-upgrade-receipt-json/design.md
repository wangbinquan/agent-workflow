# RFC-610 技术设计

记号：`S/` = `packages/backend/src/`，`SO/` = `S/modules/system-operations/`，`T/` = `packages/backend/tests/`。数字取 HEAD `8cf8ee11d`。
生产行为不变（CLI 打印的 JSON 逐字不变）。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：system-operations 内部——domain 的结论类型、application 的记录端口、infrastructure 的文件记录实现。
- **裁定一：回执是发布出去的 JSON**。
  - 记录端口的 `receipt()` 本来就把值序列化写进 `receipt.json`，恢复时读回原来的字节；回执的权威形态就是这份 JSON。
  - 端口改为返回发布字节的解析结果（平台 `JsonObject`）：第一次与恢复时同形，值为 `undefined` 的键不再留在内存里的回执上。
  - 入参照旧不透明（RFC-398 §2.7：记录层的载荷不定型）；只定“发布出去的是 JSON”这一层。
- **裁定二：结论用平台的 JSON 类型**。`AutoUpgradeConclusion.receipt?: JsonObject`，RFC-606 已把 `JsonObject` 认作指定的平台合同类型。
- **偏离项**：无。

## 1. 改动

| 位置                                                                  | 改动                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SO/domain/epochSwitch/autoUpgrade.ts`                                | `AutoUpgradeConclusion.receipt?: JsonObject`                                            |
| `SO/application/ports/epochSwitch.ts`                                 | `AutoUpgradeRecordPort.receipt()` 返回 `Promise<JsonObject>`，注明“返回发布出去的 JSON” |
| `SO/infrastructure/epochSwitch/autoUpgradeRecords.ts`                 | 第一次发布后返回所写字节的解析结果；恢复时照旧读回原字节                                |
| `SO/application/epochSwitch/autoUpgrade.ts`                           | 结论的回执参数类型改为 `JsonObject`                                                     |
| `T/rfc294-architecture-preflight.test.ts`、`architecture/counts.json` | 去掉这 1 条，12 → 11                                                                    |

## 2. 用例

- 新增 `T/rfc610-auto-upgrade-receipt-json-boundary.test.ts`，登记 guard-manifest：
  1. **行为**：文件记录实现的 `receipt()` 第一次返回所写 JSON 的解析结果（`undefined` 的键不在、嵌套值逐字相同）；再次调用（恢复）返回原来发布的
     JSON，不看新值；文件里的字节就是第一次的序列化。
  2. **类型**：结论的 `receipt` 与端口 `receipt()` 的返回都写成 `JsonObject`（AST）。
  3. **检测器**：伪造的 public 类型里 `Readonly<Record<string, unknown>>` 照旧记债，`JsonObject` 不记（负对照只喂伪造源码）。
- 原用例照旧覆盖自动升级的流程（`rfc398-auto-upgrade-policy`、发布升级门的 helper）。

## 3. 失败模式

- **有人把回执改回任意对象**：preflight 的精确清单与计数红，RFC-610 用例 ② 红。
- **第一次与恢复时返回不同形状**：RFC-610 用例 ① 红。

## 4. 对 RFC-294 刷新后规则的对账

- **C12**：RFC-610 用例跑文件记录实现、读源码、喂检测器。**C13**：计数降，清单同步收紧。
