# RFC-484 设计

落点：只改架构门的测试设施（`packages/backend/tests/architecture/`）与治理文档，不碰任何 bounded context 的生产代码与分层。

## 1. 现状（HEAD `b0de9c6a7`，源码实读）

- **判据**：`packages/backend/tests/architecture/rfc294Gates.ts` 的 `checkCounts`（第 926～956 行）：未知 / 缺失 id、非法数值、`reason`
  缺同值的 `max=N`、实测高于上限报错；RFC-479 起实测低于上限也报错（消息以 `below max: <id>: <实测> < <max>` 开头，附应改成的值），
  返回值只有 `errors`。唯一调用方是 `rfc376-structural-guards.test.ts` 的 counts 用例（第 1055～1056 行，要求 `errors` 为空）；同文件第 1061
  行的单元用例锁「等于通过、低于与高于都红」。
- **写「不高于上限即过」的现行文字**：`architecture/counts.json` 的 `note`；RFC-294 design §13.1（`design.md` 第 655～657 行）、§13.3
  （第 676～677 行）、§13.4（第 684～686 行，明文「不改成逐次相等」）；RFC-294 plan 的退出门口径段（第 50 行）；`status.md` 第 18 行；
  `scripts/depcheck.ts` 头注释（第 31～33 行）。
- **写「低于即红」的现行文字**：RFC-294 plan §1.2 的 S11 行（第 109 行）、S10 的「减速带接口」（第 457～458 行）、S11 的后继行（第 466 行）；
  `docs/dev-gotchas.md`「减少了某项计数……低于上限与高于上限一样红」一条（第 716 行起）；RFC 索引的 RFC-479 行；RFC-479 三件套；
  `rfc294Gates.ts` 的 `checkCounts` 头注释、`rfc376-structural-guards.test.ts` 第 1055 行的注释与第 1061 行的用例标题、
  `rfc479-governance-gap-fill.test.ts` 第 3 行的注释。
- **历史记录（不改）**：`STATE.md` 各条目；RFC-376 design 第 160 行（RFC-376 当时的 `note` 原文）；RFC-476 plan 第 94 行（当时的余量记录）。

## 2. 判据

`checkCounts(measured, limits)` 恢复 RFC-479 之前的返回形状 `{ errors, decreases }`：

- 实测低于上限不报错，列入 `decreases`：`<id>: <实测> < <max> (tighten to max=<实测> when a successor closes; RFC-294 C13)`，保留 RFC-479
  给出的「应改成的值」；
- 其余判据不变：未知 / 缺失 id、非法数值、`reason` 不含与 `max` 相同的 `max=N`、实测高于上限报错；`errors` 与 `decreases` 都排序；
- 调用方：counts 用例要求 `errors` 为空，`decreases` 每条打印一行 `[RFC-376 counts below max] …` 日志（RFC-479 之前同样打印）；
- 头注释改写为 §13.4 的口径，并记下 RFC-479 曾改成相等、本 RFC 改回。

## 3. 文档

- `counts.json` 的 `note`：「measured <= max 即通过（低于上限只报不红，RFC-294 design §13.4）；RFC-294 的后继收口时把所触及计数的 max
  收紧到实测（C13），dated review 核对；抬高 max 必须在同一提交，且 reason 含 max=<N>。无 provenance、无过期、无历史比较。」
- RFC-294 plan：§1.2 的 S11 行与 S11 后继行去掉「低于即红」并注明由 RFC-484 撤回；S10 的「减速带接口」改为「`max` = 实测，后继收口时
  收紧」；§1.2 增 RFC-484 一行（S11 修正）。
- RFC-294 design §13.4：在「不改成逐次相等」一句后补沿革（RFC-479 曾改成相等判据，RFC-484 改回）。
- `docs/dev-gotchas.md` 那一条改写：低于上限只报不红；上限 = 实测由后继收口时收紧（C13）；抬高仍须同一提交；`KNOWN` 等逐条清单是双向精确门，
  减少条目仍须同改（原条目最后一段保留）。
- RFC-479 三件套与 RFC 索引的 RFC-479 行：在相关句旁注明「低于上限即红」由 RFC-484 撤回，回到 design §13.4；其余不动。
- 用例文件里的注释与标题随判据改写。

## 4. 用例

- `rfc376-structural-guards` 的 `checkCounts` 单元用例：等于上限通过且 `decreases` 为空；低于上限 `errors` 为空、`decreases` 列出该项与应
  收紧到的值；高于上限、未知 / 缺失 id、`reason` 不符、非法数值照旧报错（既有用例不变）。改回相等判据时第一条转红（变异实证）。
- counts 用例照旧在全仓语料上实测 `counts.json` 的每一项；guard-manifest 刷新改到的两个用例的行数。

## 5. 失败模式

- **余量回长**：低于上限不再红，余量可能在后继之间攒起来。由 C13（后继收口收紧所触及的项）、§13.5 的独立对账（重出报告、把计数与上限
  对一遍）与 `decreases` 日志承担；本 RFC 落地时 60 项仍等于实测。
- **文档漏改**：按 §1 的清单逐处改，验证时对仓内重新搜一遍「低于即红」「below max」，只允许出现在历史记录与撤回说明里。
- **误改历史记录**：`STATE.md`、RFC-376 design、RFC-476 plan 里的旧文字是当时的记录，不改。

## 6. 对 RFC-294 刷新后规则的对账

- **C10 / C11**：不涉及生产代码与 public 面。
- **C12**：`checkCounts` 覆盖 `counts.json` 的全部项，覆盖范围不变。
- **C13**：不变；本 RFC 只把「收紧」从每个提交的义务退回为后继收口的纪律，与 proposal C13 的原文（「后继收口时把所触及计数的 `max`
  收紧到实测值……dated review 统一核对一次」）一致。
- **design §13.4**：判据回到它的原文，补一句沿革。
