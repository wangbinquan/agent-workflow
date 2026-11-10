# RFC-479 技术设计

本 RFC 只改架构守卫的用例代码（`packages/backend/tests/architecture/`）、`architecture/counts.json`、`architecture/guard-manifest.json`
（改到的守卫行数）与文档；不改任何 `packages/*/src`。落在 RFC-294 的治理面（W0-R / S4 建立的硬结构门与减速带），不属于任何
bounded context；RFC-294 C10 / C11 不适用，C12 / C13 见 §7。数字取 HEAD `27a42a3aa`。

## 1. 落位总表

| 改动                     | 位置                                                                                                 | 说明                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 低于上限判红             | `tests/architecture/rfc294Gates.ts` 的 `checkCounts`                                                 | 返回值只剩 `errors`；`decreases` 删除 |
| 4 项收紧到实测           | `architecture/counts.json`                                                                           | `reason` 写明 RFC-479 与实测值        |
| public 合同两项          | `tests/architecture/architectureReport.ts` 新增导出 `publicContractGateSets`，`reportGateSets` 合入  | 与报告章节同一份输入                  |
| composition 控制流 19 项 | `tests/architecture/rfc294Gates.ts` 新增导出 `compositionControlFlowSets`，`reportGateSets` 合入     | F13 口径、语法树计数                  |
| 基线渲染去重             | `renderGateBaselines` 删去单独的 `KNOWN_PUBLIC_SURFACE_DEVIATIONS` 行                                | 该常量改由同名门生成                  |
| 用例                     | `rfc376-structural-guards`（减速带）、`rfc376-report`（计数个数）与新增 `rfc479-governance-gap-fill` | 变异用例见 §6                         |
| 文档                     | RFC-294 plan §1.2 增列；`docs/dev-gotchas.md` 一条                                                   | §5                                    |

## 2. 上限 = 实测

`checkCounts(measured, limits)` 现在的判据：未知 / 缺失 id、非法数值、`reason` 缺 `max=N`、实测高于上限报错；实测低于上限只放进
`decreases`，减速带用例把它打印成一行日志。改为：

- 实测低于上限报 `below max: <id>: <measured> < <max> (set max=<measured> in architecture/counts.json)`，与 `over max` 同级；
- 返回 `{ errors }`；调用方（只有 `rfc376-structural-guards`）随之去掉打印 `decreases` 的循环。

收紧的 4 项（实测见 §8 的复核再确认）：

| id                                  | 现 `max` | 实测 |
| ----------------------------------- | -------- | ---- |
| `cross-context-internal-file-pairs` | 48       | 43   |
| `export-star-barrels`               | 21       | 1    |
| `legacy-thin-facades`               | 42       | 0    |
| `unreachable-production-files`      | 27       | 18   |

## 3. public 合同两项计数

架构报告现在这样算两个章节（`buildArchitectureReport`）：取 `packages/{backend,shared,frontend}/src` 的单元作 inventory，
`buildOwnerEntries` → `observedContextEdges` → `buildPublicSurfaces`，再 `unconsumedPublicSymbols(surfaces)`；偏差是
`publicSurfaceViolations(inventory)`。三个构造函数是模块私有的。

新增导出 `publicContractGateSets(corpus: GateCorpus)`：从 `corpus.byPath` 取同一组 inventory 单元，跑同一串函数，返回

- `unconsumed-public-symbols`：未消费条目的 `id`（`public:<context>:<entrypoint>:<symbol>`），排序；
- `public-surface-deviations`：`publicSurfaceViolations(inventory)`（已排序）。

`reportGateSets` 把这两组并进返回值，于是 `report.gates` / `report.counts`、`--gates` 打印的基线与减速带用例的实测都带上它们。
`buildArchitectureReport` 先算 surfaces 再算门，把 surfaces 交给 `reportGateSets`（可选参数），不重复计算；章节
`unconsumedPublicSymbols` / `publicSurfaceDeviations` 原样保留（S9 与各后继的计数复核在用）。减速带用例的语料
（`rfc376-structural-guards` 的 `CORPUS`）已含 backend / shared / frontend 的 src，不需要新的输入。

偏差同时还有 `rfc294-architecture-preflight` 的逐条白名单 `PUBLIC_SURFACE_DEBT`；两者并存（白名单回答是哪几条，计数是总量锁）。

## 4. composition 控制流

`compositionControlFlowSets(corpus)`：对 `packages/backend/src/modules/<module>/composition/` 下的每个 TS 单元，遍历语法树，
`IfStatement`、`ForStatement`、`ForInStatement`、`ForOfStatement`、`WhileStatement`、`SwitchStatement`、`TryStatement`（branch）与
`ThrowStatement`（throw）中，起点是所在行第一个非空白字符的计一行，条目写成 `<path>:<line>:<branch|throw>`；每个有 `composition/`
目录的模块一项 `composition-control-flow-<module>`（id 里不能有 `/`：`renderGateBaselines` 把 id 转成常量名）。

- 口径与 review F13 的正则对账（HEAD `27a42a3aa`）：18 个模块逐个相同；development-automation 语法树 535 + 125 = 660，正则 541 + 126
  = 667，差的 7 行都落在模板字符串或注释里（RFC-479 用例逐行对账：正则多出的行只能落在字符串 / 模板 / 注释里，语法树计数的行必须
  被正则认出）。`} else if` 不计（同正则），`do … while` 不计（F13 不含 `do`）。
- 实测：development-automation 660、source-control 198、integration 101、resource-catalog 93、task-execution 43、system-operations 28、
  intent 23、runtime-management 23、digital-employee 19、event-center 5、code-capability 2、identity-access 2，其余 7 个模块
  （collaboration、execution-contract、knowledge-evolution、memory、run-observability、task-catalog、workspace-insight）0；合计 1,197。
- 新增一个带 `composition/` 的模块会多出一个 id，减速带用例报 `missing count`，必须登记；删掉一个模块的 `composition/` 会报
  `unknown count`。
- 这 19 项是 S10 落地前的临时减速带：S10 的退出门本就要求各模块的分支计数写入减速带，它经用户确认的上限直接改这些项，「composition
  只装配」的新门落地后由它取代（plan §3 S10 记一句「减速带接口」）。

## 5. 文档

- **RFC-294 plan §1.2 增列「结构锁 / 覆盖范围」**：逐行写守着该后继结果的结构锁（用例文件或门 id）、它扫什么（全仓哪些根 / 指定的
  哪几个文件）、有无负对照或变异 fixture。依据是各后继自己的用例与 `architecture/guard-manifest.json`，逐行可复核；某后继没有专属
  结构锁的，写「无专属结构锁」并写明接替它的全仓门或行为用例。不改该表其余列。
- **`docs/dev-gotchas.md`**：「收口时收紧上限」——减少了某项计数的提交，同一提交里把 `architecture/counts.json` 该项的 `max` 与
  `reason` 里的 `max=N` 一起改成实测；减速带用例会报 `below max` 并给出应改成的值；不要为了过门把计数「补回去」。

## 6. 测试策略

- `checkCounts`：等于上限通过；低于上限报 `below max`（带应改成的值）；高于上限、未知 / 缺失 id、`reason` 不符照旧报错。
- `publicContractGateSets`（新用例，fixture 语料）：一个模块的 public 导出没有任何模块外读者 → 计入；另一模块的生产文件 import 它 →
  不计入（负对照）；public 文件取了禁止的类型 → 偏差多一条。两组与 `buildArchitectureReport` 两个章节的逐条相同由 `rfc376-report`
  在提交的源码上断言。
- `compositionControlFlowSets`（新用例，fixture 语料）：行首 `if` / `for` / `while` / `switch` / `try` / `throw` 各计一行；`} else if`、
  模板字符串与注释里以这些词开头的行不计；非 `composition/` 目录不计；新模块目录产生新 id；对账判据自测（正则多算的模板行被认出、
  错配被报出）；真实语料上与正则口径逐行对账、没有错配。
- 减速带用例（`rfc376-structural-guards`）：实测覆盖 `counts.json` 的每一项且相等；public surfaces 在文件加载时构造一次，用例预算
  保持 20 s。
- `rfc376-report`：`counts` 是 21 + 2 项加上「源码里每个有 `composition/` 的模块一项」（按结构断言，不写死 42）；两项 public 合同计数与
  报告章节逐条相同；基线渲染不再有重复常量。
- 新增用例文件按命名进 guard-manifest（`tests/architecture/**` 都是守卫），字段如实填写。

## 7. 对 RFC-294 刷新后规则的对账

- **C12（写明锁的覆盖范围）**：两项 public 合同计数覆盖 backend / shared / frontend 的 src（与报告同口径）；composition 控制流覆盖
  `packages/backend/src/modules/*/composition/**`（模块根下的 `composition.ts` 不在内，F13 也不含）；`below max` 覆盖 `counts.json` 的
  全部项。
- **C13（触及的减速带收紧到实测）**：本 RFC 把它变成门（G1）。
- design §14 的不变量：本 RFC 不改生产代码，各项实测不变；新增的三类计数把「未消费 public 符号」「public 类型污染」两条不变量与
  「composition 内实现」的代理量纳入同一张减速带。

## 8. 失败模式

- **减速带用例变慢**：public surfaces 的构造是减速带用例最重的输入（本机 1 分钟负载 26 时 36.5 s，负载 66 时在 120 s 预算里
  超时）。它与 `OBSERVED` 一样在用例文件加载时构造一次，减速带用例只做计数比对，预算保持 20 s；报告本身照旧只构造一次。
- **并发会话的减少未同步 `max`**：CI 报 `below max`，责任在做了减少的那个提交（消息里给出应改成的值）；本 RFC 的 dev-gotchas 一条与
  RFC-294 C13 写明做法。
- **计数口径漂移**：语法树计数与 F13 正则的差异固定在 §4 列出的行；口径改动只能经新 RFC。
