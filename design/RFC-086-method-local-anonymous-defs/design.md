# RFC-086 — 技术设计

## 0. 与 RFC-083 的关系

复用、不重造：

- **符号集** `SymbolNode`（`id` / `kind` / `name` / `qualifiedName` / `parentId` / `range`）——本 RFC 给它加一个可选 `anonymous` 标记，其余不动。
- **抽取管线** `lang/queries.ts`（per-language tree-sitter query）+ `lang/extract.ts`（`nearestDefAncestor` → `qualifiedName` / `parentId` / `finalKind`）——本 RFC 在此**新增匿名类捕获**。
- **类边模型** `classEdge`（`references` + `fromMembers` + `toMembers`）+ 前端 `buildStructureGraph` 的边渲染——创建边**复用 `references`**，不加新 kind（决策 D3）。
- **深度模式** `structuralDiff/deep/*`——有 SCIP 时用它补 lambda 的目标接口类型（语法层拿不到）。

## 1. 根因与两层修复

| 层                    | 问题                                                                                          | 修复                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **前端（语言无关）**  | `memberContainer` 把限定名最后一个点之前的部分一律当 `class`                                  | 用**符号 kind**（而非字符串切分）定容器：向上跳过「已知 callable 段」，绑定到最近「已知容器」，否则落 file 卡。**全语言止血。** |
| **后端（Java 家族）** | 匿名类体没被 query 捕获 → 其方法 re-parent 到外层方法，且**根本没有匿名类节点**，基类型名丢失 | 新增匿名类捕获 + 取基类型名 + `anonymous=true`；匿名类方法因此正确 re-parent 到匿名类。                                         |

> 关键：基类型 `TimerTask` **当前数据里完全没有**（实测 `/api/.../structural-diff` 只返回 `run`，`qualifiedName=GameFrame.setupGameTimer.run`，无任何匿名类节点）。它只能由后端从语法树的 `object_creation_expression.type` 取——前端无源码正文，单层无解。

## 2. 数据模型（shared schema）

`packages/shared/src/schemas/structuralDiff.ts` 的 `symbolNodeSchema` 加一个**可选**字段（向后兼容，旧响应 = `undefined`）：

```ts
  /** True for an anonymous type (Java anonymous class, JS/TS anon class
   *  expression). name = its base/super type (e.g. `TimerTask`); 取不到基类型时
   *  name='' 且前端显示 `«anonymous»`. (D4: 深度模式 lambda 目标接口为后续增强，
   *  本轮不产出。) */
  anonymous: z.boolean().optional(),
```

- `kind` 仍用 `'class'`（下游容器逻辑天然把 class 当容器，无需新 kind）。
- `name` = 基类型名（`TimerTask`）；`qualifiedName` = `<enclosing>.$anon<line>_<col>`（如 `GameFrame.setupGameTimer.$anon165_47`，**合成名**，基类型只在 `name` 里），起止行+列做消歧（同一行多个匿名类也不撞，见 §6）。前端识别 `$anon…` 合成段，不会把它当真实类名展示。
- **创建边**不需要新 schema：复用 `classEdge{kind:'references', from:外层真实类, to:匿名类, fromMembers:[外层方法 id]}`。

## 3. 后端：匿名类捕获（新）

### 3.1 query（`lang/queries.ts`）

按语言加捕获模式（**分阶段**，先 Java）：

- **Java**：`(object_creation_expression type: (_) @name body: (class_body)) @def.class` —— 仅当带 `class_body`（匿名类）才匹配；`@name` 落在 `type` 上（`TimerTask` / `java.util.TimerTask`）。
- **TS / JS**：匿名 `class` 表达式 `(class … )`（无 name 的 `class_declaration`/`class` 节点，取 `extends` 子句类型为 name）。
- **Python / Scala**：方法内**具名**局部类已被现有 query 捕获（有自己的名字，不是匿名）——它们的修复在前端层（§4）即可，后端无新捕获。

### 3.2 extract（`lang/extract.ts`）

- `leafName`：匿名类节点取 `type` 文本的**叶子**（`java.util.TimerTask` → `TimerTask`），设 `anonymous=true`；取不到 → `name=''`、`anonymous=true`。
- `qualifiedName`：匿名类 → `${qn(parent)}.$anon<line>_<col>`（合成名，**与基类型无关**——基类型在 `name` 里）；它**现在被捕获**，于是其内部 `run()` 的 `nearestDefAncestor` 命中匿名类（`CLASS_LIKE`），`run` 的 `qn=…$anon<line>_<col>.run`、`finalKind='method'`、`parentId=匿名类 id`——假类不再产生。
- 现有 `if (name === '') continue`（pass 3）需放行匿名类（name 允许空 + `anonymous` 标记），否则匿名类被丢弃、又退回老 bug。

### 3.3 深度模式（lambda 目标接口，决策 D4）

Java/Kotlin lambda 的目标函数式接口在语法树里**不出现**（上下文推断）。仅当深度模式 SCIP 可用时，用 occurrence 的 symbol relationship 取到目标接口名补成匿名节点；基线下 lambda 保持折叠（不升格）。

### 3.4 创建边（`classGraph.ts`）

匿名类名（`$TimerTask`）**不会以文本形式出现在别处**，所以现有「按类名在 body 里匹配」的启发式抓不到它。改为**显式补边**：遍历匿名类节点，对每个补一条 `references` 边——

- `from` = 匿名类的最近**真实**外层类的 card key（`${file}::GameFrame`）；
- `to` = 匿名类 card key；
- `fromMembers` = `[外层方法 symbol id]`（从 `parentId` 链取「匿名类的直接父——那个 callable」）。

这样点这条边能高亮到 `setupGameTimer` 行，语义即「`setupGameTimer` 创建了这个匿名 TimerTask」。

## 4. 前端：容器解析重写（语言无关止血）

`structureGraph.ts` —— 用符号 kind 取代字符串切分：

1. `buildStructureGraph` 先做一遍**预扫**，建本文件 `qnKind: Map<qn, SymbolKind>`（含所有 changes 的 `after??before`）。
2. 新 `resolveContainer(filePath, qn, qnKind)`：从 `qn` 去掉叶子后，**逐段向上**——若该前缀是已知 callable（`function`/`method`/`constructor`）则继续上跳；命中已知**容器**（class/interface/…）则用之为卡片；都没有 → file 卡片。
3. 匿名类节点（`anonymous=true`）单独成卡：`title` 渲染为 `«anonymous» {name||''}`（D2）；卡片 `kind='class'` 但带匿名样式徽标。
4. **具名嵌套函数**（决策 D1）：
   - **(a 推荐)**：`resolveContainer` 把它归到最近真实容器（或 file 卡）作为**成员行**——天然无假类、低噪音。
   - **(b)**：升格为独立子节点 + `references`(nested-in) 边——需与 RFC-085 协调语义。

边渲染、成员高亮、`fromMembers/toMembers` 机制**全部复用** RFC-083 既有路径。

## 5. 接口契约

- shared：`SymbolNode.anonymous?`（新，可选）。无 breaking。
- 后端：`extractSymbols` 可能多产出匿名类节点；`computeClassEdges`（或装配层）多产出 `references` 创建边。`StructuralDiff` 顶层结构不变。
- 前端：`buildStructureGraph` 容器解析行为变更（消假类）；`StructuralGraph.tsx` 渲染匿名徽标。旧 diff（无 `anonymous`）→ 匿名节点不出现，但**止血仍生效**（§4 不依赖 `anonymous`）。

## 6. 失败模式 & 边界

| 情形                                | 行为                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 取不到基类型名                      | `name=''` + `anonymous=true` → 显示 `«anonymous»`                                                                                                                         |
| 同一方法内多个匿名类（含同一行）    | 合成 qn 含**起始行+列**（`$anon<line>_<col>`）消歧，各成一卡                                                                                                              |
| 匿名类嵌匿名类                      | `parentId` 链向上找最近真实类做创建边的 `from`；逐层各自成卡                                                                                                              |
| 匿名容器自身未变（仅内层成员体改）  | 它不在 diff（容器 bodyHash 只含 header）→ 不在 `qnKind`；前端 `memberContainer` 识别 `$anon…` 合成段跳过，内层成员折叠进最近真实类，**不产生 `$anon` 假类**（审计回归点） |
| 嵌套**具名**函数做 impact 调用方    | 调用方 qn 永不在 diff；用其 symbolId 里的 `kind`：`function` 的容器必非类 → 折叠到 file 卡，不产生 `outer` 假类                                                           |
| lambda（基线模式）                  | 不升格，保持折叠（D4）                                                                                                                                                    |
| Java enum 常量带类体（`E{ A{…} }`） | **暂不捕获**（`enum_constant` 非 object_creation/class 节点）：override 方法 re-parent 到 enum，行可能并到 enum 卡上；**已知后续项**（同 D4，不产生假类卡）               |
| 旧响应无 `anonymous`                | 止血生效（§4），但不画匿名卡（无数据）——视图正常                                                                                                                          |
| 局部**具名**类（Java/Python）       | 用它自己的名字成卡（非匿名），父为最近真实类                                                                                                                              |

## 7. 测试策略（test-with-every-change）

**必写**（纯函数 / 源码层优先）：

- **前端 `resolveContainer`（PURE，止血核心）**：
  - `GameFrame.setupGameTimer.run`（callable 中段）→ 容器解析到 `GameFrame`，**不产生** `GameFrame.setupGameTimer` 卡（回归锁，注明源自本 RFC + 任务 `01KTDNGTHM…`）；
  - JS `outer.inner`（inner 为 function）→ 不产生 `outer` 假类；
  - 真实内嵌类 `Outer.Inner.method`（Inner 为 class）→ 仍正确归到 `Outer.Inner`（不误伤合法内部类）。
- **后端 `extract`（Java fixture，PURE 跑真 wasm）**：`new TimerTask(){run(){}}` → 产出 `anonymous=true`、`name='TimerTask'` 的 class 节点 + `run().parentId=该节点`；取不到基类型 → `name=''`。
- **后端创建边**：匿名类 → `references` 边 `GameFrame→匿名类`、`fromMembers=[setupGameTimer.id]`。
- **集成**：`buildStructureGraph(真实 diff)` → 无假类卡 + 有 `«anonymous» TimerTask` 卡 + 该创建边。
- **schema**：`anonymous` 可选、旧 JSON（无字段）仍 valid。

**门槛**：`typecheck && test && format:check`；动 shared/后端 → `build:binary` smoke。

## 8. 分阶段（降风险 + 增量）

1. **PR-0** = §4 前端容器解析重写（**全语言止血**，不依赖后端，可先行）。
2. **PR-A** = §2 schema + §3.1/3.2/3.4 Java 匿名类捕获 + 创建边。
3. **PR-B** = 前端匿名类呈现（`«anonymous» Type` 卡 + 徽标 + 边）+ 决策 D1 落地。
4. **PR-C** = 推广 TS/JS class 表达式、§3.3 深度模式 lambda、噪音收敛规则。

每阶段单独 PR、单独验收（见 plan.md）。
