# RFC-086 — 结构图：方法内 / 匿名定义的正确归属与呈现（Method-local & Anonymous Definitions）

状态：**Done**（2026-06-06 用户 `/goal` 批准全做并实现；决策 D1〜D5 已锁定，见下表）

> 编号说明：用户口述方向时未给号；`RFC-084-conformance-auditor` / `RFC-085-method-call-chain` 已被并行协作者占用，本 RFC 顺延为 **RFC-086**。

## 背景

RFC-083 的类协作图把每个变更符号摆成「类卡片 + 成员行」。**卡片归属**由前端纯函数 `memberContainer`（`packages/frontend/src/lib/structureGraph.ts:198-208`）决定，它的逻辑是：

```ts
const idx = qualifiedName.lastIndexOf('.')
if (idx > 0) {
  const container = qualifiedName.slice(0, idx) // 取最后一个点之前
  return { key: `${filePath}::${container}`, title: container, kind: 'class' } // ← 一律当成 class
}
```

也就是**「限定名里最后一个点之前的部分 = 一个类」**。这个假设对「方法内定义」是错的。

**触发实例**（任务 `01KTDNGTHM975PF4WTG1Q3PV3Q`，Java snake-game）：`GameFrame.setupGameTimer()` 内 `new java.util.TimerTask(){ @Override public void run(){…} }` 是一个**匿名内部类**。后端如实上报它的 `run()` 方法符号，限定名 `GameFrame.setupGameTimer.run`（`run` 的最近被捕获祖先是方法 `setupGameTimer`——匿名类体本身没被 query 捕获，`extract.ts:107-115` 的 `nearestDefAncestor` 跳过它）。前端把中段 `GameFrame.setupGameTimer` 当类名，于是凭空生出一张 **徽标为 `class`、标题 `GameFrame.setupGameTimer`、只含一个 `run()` 成员的假卡片**——一个方法被画成了类。

### 这是语言无关的缺陷，且 JS/TS/Python 比 Java 更严重

触发条件：**任一被捕获的成员，其最近被捕获祖先也是函数/方法**，就会产出「中段是非类」的限定名，前端就造假类。对照各语言抽取 query（`packages/backend/src/services/structuralDiff/lang/queries.ts`）：

| 语言     | 方法内会被捕获的东西                                                                                     | 是否触发           |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| TS / JS  | 具名嵌套函数 + 箭头赋值（`function_declaration` / `variable_declarator … arrow_function`）——回调闭包遍地 | 🔴 重灾区          |
| Python   | 闭包 / 装饰器内层函数（`function_definition`）                                                           | 🔴 重灾区          |
| Rust     | `fn outer(){ fn inner(){} }`                                                                             | 🟠 中招            |
| Scala    | 方法体内局部 `def`（degraded 语言）                                                                      | 🟠 中招            |
| Java     | 匿名内部类 / 方法内局部类                                                                                | 🟠 本 RFC 触发实例 |
| Go / C++ | 闭包是匿名 func/lambda，不按名捕获                                                                       | 🟢 基本不中招      |

## 目标

1. **全语言消除假「类」卡片**：方法内定义不再被误判成类（语言无关的根因修复）。
2. **Java 家族匿名类正确呈现**：匿名类显示为一张 **`«anonymous» 基类型`**（如 `«anonymous» TimerTask`）卡片，其方法（`run()`）归入该卡片。
3. **「谁创建了它」可见**：补一条从**产生该匿名类的外层方法**指向匿名类的**引用边**（`setupGameTimer → «anonymous» TimerTask`）。
4. **其它语言的方法内具名定义**正确归属（默认折叠进最近真实容器作为成员行；是否升格为独立子节点见决策表）。
5. 全程**静态、确定性**（与 RFC-083 同政策）：信息来自 tree-sitter / 深度模式 SCIP，无 LLM；取不到基类型名就**老实标 `«anonymous»`，绝不臆造**。
6. **复用 RFC-083 既有产物与边模型**：`SymbolNode` / `parentId` / `classEdge`（`references` + `fromMembers`），不另起一套。

## 非目标（本 RFC）

- **不做调用链 / 时序图**——那是 RFC-085 的范围；本 RFC 只管「方法内定义的归属与呈现」。
- **不追求把每个闭包/回调都画成节点**——见决策表「呈现激进度」，默认收敛以免把类图冲成噪音。
- **不引入运行时 / 动态信息**、不引入 LLM。
- **不改文本 diff、不改三粒度 / 八语言 / 深度模式编排**——只动符号捕获 + 图构建。

## 用户故事

1. **不再有假类**：我在结构图里看一次 Java 改动，不再出现 `GameFrame.setupGameTimer` 这种「以方法名命名的类」。换 TS/Python 工程同样干净。
2. **匿名类看得懂**：那个 TimerTask 显示成 `«anonymous» TimerTask`，里面是它的 `run()`，并且有一条线从 `setupGameTimer` 指过来——我一眼知道「这个匿名 TimerTask 是 setupGameTimer 创建并调度的」。
3. **诚实**：lambda / 拿不到基类型的匿名体，显示成 `«anonymous»` 而不是瞎安一个类名。

## 验收标准（产品层）

- 给定含**方法内匿名类**（Java）的 before/after：结构图**不再出现**以方法限定名命名的 `class` 卡片；匿名类呈现为 `«anonymous» 基类型` 卡片，其方法归入其中；存在 `外层方法 → 匿名类` 的引用边（点边可高亮到外层方法行）。
- 给定含**方法内具名嵌套函数**（TS / Python / Rust）的 before/after：不再出现假类卡片；嵌套函数按既定呈现规则正确归属。
- 取不到基类型名 → 卡片标 `«anonymous»`，不臆造类名。
- 旧响应（无 `anonymous` 字段）向后兼容、视图不崩。
- 全绿门槛：`bun run typecheck && bun run test && bun run format:check`（动到 shared / 后端 → `bun run build:binary` smoke，按 [reference_binary_build_module_cycle]）。

## 决策记录（已锁定 2026-06-06）

| #   | 维度                         | 决定                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **具名嵌套函数的呈现激进度** | **(a) 已采纳**：仅匿名类（Java 匿名内部类、JS/TS 匿名 `class` 表达式）独立成 `«anonymous» Type` 卡 + 创建边；具名嵌套函数 / 闭包**折叠进最近真实容器**（PR-0 的 `memberContainer` 跳过 callable 段实现）。低噪音、贴「类协作图」本意，且不与 RFC-085 调用链重叠。                      |
| D2  | **匿名类命名**               | **`«anonymous» TimerTask`**（基类型 leaf；取不到基类型 → `«anonymous»`）。                                                                                                                                                                                                             |
| D3  | **创建边的语义**             | **复用 `references` 边**（`fromMembers=[外层方法]`），零 schema/渲染改动；由 `computeAnonCreationEdges` 走 parentId 链确定性产出。                                                                                                                                                     |
| D4  | **lambda 目标接口**          | 基线（tree-sitter）语法层取不到 lambda 的目标函数式接口 → **基线下 lambda 不升格、保持折叠**（已实现）。**深度模式 SCIP 解析 lambda 目标接口 = 已记录的后续增强**（与 RFC-083「真索引器产出 `.scip` 需本地验」同属 CI 不可验边界，故不在本轮）。匿名**类**（有语法基类型）已全量覆盖。 |
| D5  | **止血先行**                 | PR-0〜PR-C 在 `/goal` 批准下**一并实现、一次推送**（main-only 开发）。                                                                                                                                                                                                                 |

## 交付（2026-06-06）

- **PR-0**：`structureGraph.ts` `memberContainer` 用符号 kind 定容器（跳过 callable 段）——全语言消假「类」卡。
- **PR-A**：`SymbolNode.anonymous?` schema；`lang/queries.ts` Java `object_creation_expression(+class_body)` 捕获；`extract.ts` 基类型名 + `$anon<line>_<col>` 合成 qn + 放行空名；`classGraph.computeAnonCreationEdges` 走 parentId 链产「外层方法→匿名类」`references` 边，`gitBackend` 合并。
- **PR-B**：匿名卡 title `«anonymous» {base}`（容器分支权威覆盖）+ `GraphCard.anonymous` + `.sg-card--anonymous` 样式。
- **PR-C**：TS/JS `(class !name)` 匿名类表达式捕获（extends 取基类型）。
- **测试**：前端 structure-graph +4、后端 `structural-diff-anon-class` 5（Java + TS/JS + 创建边 + 负例）。

### 审计修复（2026-06-06，post-merge 对抗式审计）

合并后做了一次 5 维对抗式审计，发现首版仍漏 3 个真 bug，已修 + 补回归锁：

- **B1（headline，已修）**：`memberContainer` 的 `qnKind` 只由「变更符号」构建；匿名容器 bodyHash 只含 header，**只改内层成员体**时容器不在 diff → 向上遇到未知 `$anon` 前缀又造出 `$anon` 假类。修：`memberContainer` 识别未知的 `$anon…` 合成段并跳过（容器在 diff 时仍正常出 `«anonymous»` 卡）。
- **B2（已修）**：impact 调用方分支对「永不在 diff」的调用方 qn 复用 `memberContainer`，嵌套**具名**函数调用方 `outer.inner` 造出 `outer` 假类。修：用调用方 symbolId 里的 `kind`——`function` 的容器必非类 → 折叠到 file 卡。
- **B3（已修）**：`$anon<line>` 对**同一行两个匿名类**会撞 id/qn（第二个丢失）。修：合成段加列 → `$anon<line>_<col>`。
- **回归锁**：前端 +4（内层体改无 `$anon` 假类 / 具名函数调用方折叠 / `anonymousCardTitle` / 无基类型 `«anonymous»` 渲染）、后端 +6（同行双匿名 / Python·Rust·TS 嵌套函数 / 字段初始化匿名 / 匿名套匿名）。

### 后续（已记录、非本轮）

- **D4** 深度模式 SCIP 解析 lambda 目标接口升格（CI 不可验，同 RFC-083 SCIP 边界）。
- **Java enum 常量类体**（`enum E { A { … } }`）暂不捕获——override 方法会并到 enum 卡（**不产生假类卡**），属已知后续项；匿名**类**（有语法基类型）已全覆盖。

详见 [design.md](./design.md) 与 [plan.md](./plan.md)。
