# RFC-515 设计：组合层只装配的全模块门

## 1. 现状（HEAD，源码实读）

- **旧锁**：`architecture/rfc414-composition-io-out` 只看 task-execution 的 `composition/`：禁取 `drizzle-orm`、`bun:sqlite`、
  `@/platform/persistence/sessionTables`、`@/platform/persistence/queryHelpers`、`fs`（含 `node:` 与 `/promises`）、`child_process`、`@/util/git`，
  禁调 `tablesOf(`、`Bun.spawn(`，另钉 RFC-414 迁出的符号归属；`architecture/rfc423-composition-assembly-only` 同样只看 task-execution：无循环
  与 switch、`try` / `throw` 按账本（RFC-514 后为空），另钉 RFC-423 迁出的符号归属。
- **计数**：`architecture/counts.json` 的 `composition-control-flow-<module>`（F13 口径：`composition/` 目录里行首的分支与 `throw`）按模块挡增长；
  `composition-forbidden-import-files`（RFC-376：可达 fs / 进程 / drizzle 的组合文件）为 12，都是 RFC-370 文件。
- **清点**（语法树；`composition/` 目录 339 个文件 + 模块根 `composition.ts` 19 个）：
  - RFC-370 的 27 个 `crewstation*` / `taskImage*` 文件带循环、switch、`try`、`throw` 或禁用 import（11 个模块）；
  - 其余 `composition/` 文件只有一处违反：resource-catalog `composition/intentApply.ts` 的 `composeLegacyIntentSkillArtifactCompat` 用
    `first(skillOperationStateQuery(db, opId))` 自己读库（取 `@/platform/persistence/queryHelpers`）；
  - 模块根 `composition.ts` 有 6 个带循环、`try` 或 `throw`：digital-employee、event-center、identity-access、source-control、system-operations、
    task-execution（模块生命周期的暂停与释放、几处装配期整理与核对）。

## 2. 机制与落位

### D1 一条门

新增 `packages/backend/tests/architecture/rfc515-composition-assembly-only.test.ts`：

- **语料**：`packages/backend/src/modules/<m>/composition/**/*.ts` 与 `packages/backend/src/modules/<m>/composition.ts`，按语法树读（下限 350）。
- **规则**（每个文件逐条）：`loop`（`for` / `for…in` / `for…of` / `while` / `do`）、`switch`、`try`、`throw` 语句；`import:<模块>`（静态 import /
  export 与 `import()`，含仅类型的，模块名按 RFC-414 的清单）；`call:tablesOf` 与 `call:Bun.spawn`。
- **例外清单**：逐文件登记（路径 → 后继），实测有违反的文件集合必须与清单逐文件相等：清单外出现违反报 `unregistered`，清单里的文件不再违反报
  `stale`。清单初值是 §1 的 27 个 RFC-370 文件（后继：RFC-370 余项）与 6 个模块根 `composition.ts`（后继：S10 的模块根收口）。
- **负对照**：每类违反在伪造的组合文件里都被报出；例外文件的违反不报；陈旧例外与清单外违反都报；模块根 `composition.ts` 在扫描面内；非组合层文件不在。

### D2 唯一的非 RFC-370 违反项归位

`resource-catalog/infrastructure/skillOperationStateQuery.ts` 增 `loadSkillOperationState(db, opId)`，函数体是 HEAD `composition/intentApply.ts` 第
111～112 行那个箭头函数的函数体（`first(skillOperationStateQuery(db, opId))`）；组合文件改为引用它，不再取 `queryHelpers` 与
`skillOperationStateQuery`。`intent/ports/skillArtifactCompensation.ts` 的端口形状不变。

### D3 旧锁并入

- `rfc414-composition-io-out`：删去禁用 import / 调用的活语料检查与负对照（新门以同一份清单覆盖全部模块），只留 RFC-414 迁出符号的归属检查。
- `rfc423-composition-assembly-only`：删去循环 / switch / `try` / `throw` 的形状检查、throw 账本与负对照，只留 RFC-423 迁出符号的归属检查。
- 两条锁在 guard-manifest 里的条目随行数更新（仍是语料扫描、仍带“断言不存在”与负对照）。

### D4 分支上限（S10 退出门“经用户确认的上限”）

上限就是 `counts.json` 里现有的 `composition-control-flow-<module>`（RFC-514 之后的实测，按同一授权记为已确认，不另起一套数）：

| 模块                   | 上限 | 其中 RFC-370 文件 | 余下的装配期选择 |
| ---------------------- | ---- | ----------------- | ---------------- |
| development-automation | 82   | 80                | 2                |
| digital-employee       | 13   | 13                | 0                |
| event-center           | 5    | 5                 | 0                |
| integration            | 17   | 16                | 1                |
| intent                 | 4    | 4                 | 0                |
| resource-catalog       | 75   | 72                | 3                |
| runtime-management     | 22   | 22                | 0                |
| source-control         | 110  | 101               | 9                |
| system-operations      | 26   | 24                | 2                |
| task-execution         | 11   | 1                 | 10               |

其余 9 个模块（code-capability、collaboration、execution-contract、identity-access、knowledge-evolution、memory、run-observability、task-catalog、
workspace-insight）为 0。RFC-484 起计数低于上限只报不红；后继收口时按实测收紧。

## 3. 清单（退出门）

| 位置                                                                                             | 内容                      |
| ------------------------------------------------------------------------------------------------ | ------------------------- |
| `packages/backend/tests/architecture/rfc515-composition-assembly-only.test.ts`（新）             | 全模块门（D1）            |
| `packages/backend/src/modules/resource-catalog/infrastructure/skillOperationStateQuery.ts`（增） | `loadSkillOperationState` |

允许的形状：例外清单之外，全部模块的 `composition/` 文件与模块根 `composition.ts` 没有循环、switch、`try`、`throw`，不取 RFC-414 清单里的模块、不调
`tablesOf` 与 `Bun.spawn`。

## 4. 用例

新门本身即本 RFC 的主用例（登记 guard-manifest：语料扫描、断言不存在、负对照）。另在同一文件里钉 D2：`loadSkillOperationState` 只在
`infrastructure/skillOperationStateQuery.ts` 声明，`composition/intentApply.ts` 引用它、不再取 `queryHelpers`。行为由现有用例经装配入口对拍
（`rfc359-w36-skill-operation-state-query`、`rfc359-w7-intent-apply-artifact-conformance`、`rfc370-intent-artifact-content`）。

## 5. 失败模式

- **门的判据与旧锁不一致**：禁用 import 与调用的清单逐字取自 RFC-414，循环 / switch / `try` / `throw` 的判据取自 RFC-423；旧锁删去的只是这两部分。
- **例外清单漂移**：清单与实测逐文件相等，陈旧与新增都红；RFC-370 余项与模块根收口的后继改动时同步删条目。
- **按原文钉住被迁行的锁**（RFC-514 的教训）：迁移前按被迁那一行的原文全仓搜用例，已查无。

## 6. 取舍（可推翻）

1. **例外按文件登记、不记次数**：例外文件内部的增长由按模块的 F13 计数与 `composition-forbidden-import-files` 挡住；门本身只管“哪些文件还能违反”，
   让 RFC-370 余项改这些文件时不必同步改一份逐次账本。
2. **模块根 `composition.ts` 纳入扫描面**：它们同样是组合层；先登记例外，让“新违反”立刻红，再由后继逐个清掉。
3. **两条旧锁只留归属检查**：形状规则只有一处真相，归属检查仍是各自 RFC 迁出符号的专属断言。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：门正是“组合层只装配”的全模块判据；D2 把唯一的非 RFC-370 违反项落到 infrastructure。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子（`loadSkillOperationState` 留在 infrastructure，经组合文件交给 intent 的端口）。
- **C12**：门覆盖全部模块的组合层（下限 350），负对照覆盖每类违反、陈旧例外与清单外违反。
- **C13**：计数不升；分支上限按 D4。

## 8. 本步承担的演进与留下的债

- **承担**：S10 的门落地（RFC-414 / RFC-423 的组合层规则推广到全部模块、例外显式登记），D4 写明分支上限。
- **留下**：例外清单 33 个文件——RFC-370 的 27 个（与 `composition-forbidden-import-files` 的 12 个）待 RFC-370 余项；模块根 `composition.ts` 的 6 个
  另立后继；例外清单清空、`composition-forbidden-import-files` = 0 时 S10 关闭。
