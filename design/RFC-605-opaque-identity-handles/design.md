# RFC-605 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `be07a4e96`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 平台原语 `S/platform/contracts/opaqueIdentity.ts`（平台合同类，与 `hash.ts`、`semaphore.ts` 同列）。
  - development-automation 的 `application/ports/evidenceStaging.ts` 与 integration 的 `application/ports/developmentAdapterEffects.ts` 改类型。
  - 两个模块 infrastructure 的铸造点改用平台原语。
  - task-execution `public/commands.ts` 的任务房间参与方结果去掉 `eventRef`，`infrastructure/workgroupTaskRoomTaskParticipant.ts` 不再返回它。
- **裁定一：不透明身份是平台原语**。
  - 这四个引用是同一种东西：由拥有命名空间的实现铸造、按身份做键、消费方只携带的令牌。development-automation 的暂存令牌还由 integration 的适配器
    运行器铸造。
  - 各模块各写一个带品牌的类型，铸造函数就得经对方的 public 值导出，而 `public/types` 是纯类型面（design §3.2）。放进平台，每个模块都能 import 铸造函数。
  - `OpaqueIdentity<Tag>` 按 tag 区分，令牌不能错递到别的用途；对象本身不带数据、冻结。
  - 它与平台日志器同属“指定的平台合同接口”（RFC-604 规则一的清单加一项），只放行这一个具名类型。
- **裁定二：任务房间结果里的事件引用去掉**。
  - 这个引用的用途是让事务属主在提交后催发投递，但唯一的属主 resource-catalog 从未使用它：没有催发，事件由平台的持久投递（空闲时每秒一轮）送达。
  - 留着它、再让 resource-catalog 催发，等于把平台的事件机制类型放进合同，也与 design §3.3 的“结果不带事件”相悖；去掉它，行为与现状相同。
  - 若将来要更快，宜由平台在会话层给事务挂“提交后催发”，而不是经模块合同传递引用（非目标）。
- **偏离项**：无。

## 1. 平台原语

```ts
declare const opaqueIdentityBrand: unique symbol
export type OpaqueIdentity<Tag extends string> = { readonly [opaqueIdentityBrand]: Tag }
export function mintOpaqueIdentity<Tag extends string>(): OpaqueIdentity<Tag>
```

`mintOpaqueIdentity` 返回 `Object.freeze({})`。品牌只存在于类型里，运行期仍是一个空对象，可作 `WeakMap` 的键、按 `===` 比对，与此前的 `{}` 相同。

## 2. 改动

| 位置                                                                | 改动                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| development-automation `application/ports/evidenceStaging.ts`       | 命名空间与暂存引用的 `reference` 为 `OpaqueIdentity<'evidence-staging-namespace'>` / `<'evidence-staging'>`               |
| integration `application/ports/developmentAdapterEffects.ts`        | 配置与程序引用的 `reference` 为 `OpaqueIdentity<'development-adapter-configuration'>` / `<'development-adapter-program'>` |
| 两个模块 infrastructure 的 12 个铸造点                              | `reference: {}` → `mintOpaqueIdentity()`                                                                                  |
| task-execution `public/commands.ts`                                 | 恢复与判失败两个结果去掉 `eventRef`，不再 import `CommittedEventRef`                                                      |
| task-execution `infrastructure/workgroupTaskRoomTaskParticipant.ts` | 追加事件照旧，不再返回引用                                                                                                |
| `T/architecture/rfc294Gates.ts`                                     | `PLATFORM_CONTRACT_INTERFACES` 加 `@/platform/contracts/opaqueIdentity#OpaqueIdentity`                                    |

用例里手工构造这些引用（`reference: {}`）的地方同样改用 `mintOpaqueIdentity()`；调用方由 `tsc` 全量核对。

## 3. 账本与计数

`PUBLIC_SURFACE_DEBT` 去掉 3 条：development-automation `assertEvidenceStagingFactory` 的 `ObjectKeyword`、integration `RequirementAdapterBinding` 的
`ObjectKeyword`、task-execution `WorkgroupTaskRoomTaskParticipantInTx` 的 `CommittedEventRef`。`public-surface-deviations` 19 → 16（max 同步降）。

## 4. 用例

- 新增 `T/rfc605-opaque-identity-handles-boundary.test.ts`，登记 guard-manifest：
  1. **检测器**：合成的 public 类型引用 `OpaqueIdentity` 不记债；`object` 与同文件的其他导出照旧记债。
  2. **类型**：四个引用的 `reference` 声明为对应 tag 的 `OpaqueIdentity`。两个模块的 `src` 里不再有 `reference: {}` 字面量，判据带负对照。
  3. **原语**：每次铸造得到不同的冻结空对象，可作 `WeakMap` 的键。
  4. **结果**：任务房间参与方两个结果的类型不声明 `eventRef`。
- 计数：`public-surface-deviations` 19 → 16，其余不变。

## 5. 失败模式

- **有人把令牌改回 `object` 或空对象字面量**：`tsc`（类型不匹配）或 RFC-605 用例 ② 红。
- **有人把结果里的事件引用加回来**：RFC-605 用例 ④ 与 preflight 的逐条相等红。

## 6. 对 RFC-294 刷新后规则的对账

- **C12**：RFC-605 用例读源码并跑合成语料与原语，检测器逐条相等由 preflight 执行。
- **C13**：计数降、不升。

## 7. 留下的

- 有限键映射类型（shared 运行时清单）与 `unknown` DTO（材料证据的失败原因、运行时配置命令、用量事件、自动升级回执）。
- 能力 / 凭据 / 身份一族，等 RFC-546。
- task-execution 内部的 `task-script-result` 结算令牌（`reference: {}`）不在 public 面上，本 RFC 不动。
