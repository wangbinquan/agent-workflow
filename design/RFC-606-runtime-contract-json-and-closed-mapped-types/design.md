# RFC-606 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `170f3e2cc`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 平台合同 `S/platform/contracts/json.ts`。
  - runtime-management 的 `domain/usageMeter.ts`、`domain/runtimeProfile.ts`、`public/types.ts`、`application/ports/agentMaterialEvidence.ts` 改类型。
  - task-execution 的两处调用方（`application/callUsageWriter.ts`、`infrastructure/crewstation/runtimeEvents.ts`）改断言目标。
  - 迁移转换 `S/platform/persistence/migration/conversion/types.ts` 转出平台的 `JsonValue`。
  - 检测器在 `T/architecture/rfc294Gates.ts`。
- **裁定一：JSON 是合同的正当形态**。
  - design §3.3 的 type 一行允许“JSON-safe value”。运行时的原生事件、存量回执的一段，构造上就是 JSON：写成 `unknown` 丢掉了这个事实，写成具名 DTO
    又不对，因为它们随驱动与版本而异，本来就由消费方解析。
  - 平台给出一份递归的 `JsonValue` / `JsonObject`，与 RFC-605 的 `OpaqueIdentity` 一样列为指定的平台合同类型。
  - 迁移转换里原有一份同形的 `JsonValue`，改为从这里转出，平台只有一份定义。
- **裁定二：键集合封闭的映射类型是有限对象类型（规则三）**。
  - 映射类型开不开放，取决于键集合：`string` / `number` / `symbol`、`PropertyKey`、模板字面量，以及含有它们的联合，是开放记录。
  - 字面量联合、对封闭联合（如 `z.enum` 推出的类型）的引用、`keyof` 一个封闭形状，都是有限的。
  - 检测器照旧检查键约束与值类型。shared 的 `InventoryDeclaration` 正是靠映射类型，让新增一面时每个驱动都必须表态（RFC-462），保持原样。
- **裁定三：失败原因是字符串**。清扫的唯一实现（opencode）给的就是字符串，唯一的消费方只取它的消息。
- **存量探测回执的兼容口径**：
  - 视图只展示 codec 1、目标与当前运行时一致的回执里的 `smoke` 段，其余为 `null`。这条规则不变，类型只从 `unknown` 收紧为 `JsonValue | null`。
  - 任何存量的 JSON 都是 `JsonValue`，不需要迁移，也不会因收紧而读不出。
- **偏离项**：无。

## 1. 改动

| 位置                                                             | 改动                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `S/platform/contracts/json.ts`（新）                             | `JsonValue`（递归联合）与 `JsonObject`（只读字符串索引）                                                       |
| `S/platform/persistence/migration/conversion/types.ts`           | 删去自己的 `JsonValue`，改为 import 并转出平台的                                                               |
| runtime-management `domain/usageMeter.ts`                        | `RuntimeUsageMeter.observe(event: JsonObject)`（本地名 `JsonEvent`，与本文件已有的松散 `JsonObject` 别名区分） |
| runtime-management `public/types.ts`、`domain/runtimeProfile.ts` | `RuntimeView.lastProbe: JsonValue \| null`；解析时把 `JSON.parse` 的结果断言为 `JsonValue`                     |
| runtime-management `application/ports/agentMaterialEvidence.ts`  | `SystemAgentSessionSweepOutcome.failureReason?: string`                                                        |
| task-execution 两处调用方                                        | 解析后的 stdout 行断言为 `JsonObject`                                                                          |
| `T/architecture/rfc294Gates.ts`                                  | 指定清单加 `JsonValue`、`JsonObject`；映射类型只在开放键时记债（规则三）                                       |

驱动里两个用量计的实现由 `RuntimeUsageMeter` 给参数类型，原有的类型收窄照常成立。用例里三处按新类型调整：替身的失败原因改为字符串，两处解析后的事件
断言为 `JsonObject`，一处视图比较先把实际值放宽为 `unknown`（接口类型不能隐式满足索引签名，这是 TypeScript 的写法限制，不是数据差异）。

## 2. 账本与计数

`PUBLIC_SURFACE_DEBT` 去掉 4 条：runtime-management `AgentMaterialEvidence` 的 `UnknownKeyword`、`AgentInvocationProtocol` 的 `MappedType` 与
`UnknownKeyword`、`RuntimeProfileCommands` 的 `UnknownKeyword`。`public-surface-deviations` 16 → 12（max 同步降）。

## 3. 用例

- 新增 `T/rfc606-runtime-contract-json-and-closed-mapped-types-boundary.test.ts`，登记 guard-manifest：
  1. **检测器**：两个 JSON 类型放行，同文件的其他导出照旧记债。键集合封闭的映射类型放行（值类型里的 `unknown` 照旧记债）；原始键、含原始键的联合、
     模板字面量、`PropertyKey` 照旧记债。
  2. **类型**：四处类型如 §1，清单声明仍是按 `InventoryFace` 的映射类型。
  3. **单一定义**：迁移转换从平台合同转出 `JsonValue`，自己不再定义。
- 计数：`public-surface-deviations` 16 → 12，其余不变。

## 4. 失败模式

- **有人把开放键的映射类型当成封闭**：RFC-606 用例 ① 的反例红。
- **有人把这些类型改回 `unknown`**：RFC-606 用例 ② 与 preflight 的逐条相等红。
- **有人在迁移转换里重新定义 `JsonValue`**：RFC-606 用例 ③ 红。

## 5. 对 RFC-294 刷新后规则的对账

- **C12**：RFC-606 用例读源码并跑合成语料，检测器逐条相等由 preflight 执行。
- **C13**：计数降、不升。

## 6. 留下的

- system-operations 的 `AutoUpgradeConclusion.receipt`：回执由纪元切换的会话记录层逐级组装，记录载荷按 RFC-398 §2.7 保持不透明。收紧它要从记录层开始改为
  `JsonObject`，另立。
- 能力 / 凭据 / 身份一族 11 条，等 RFC-546。
