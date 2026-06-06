# RFC-085 — 技术设计

## 0. 与 RFC-083 的关系

复用、不重造:

- **符号集** `SymbolNode`(含 `id` / `qualifiedName` / `range` / `signature` / `parentId`)—— 调用链的节点就是这些方法符号。
- **成员范围** `collectClassMembers`(`MemberRange`,含 name/kind/range)—— 把"某行的调用"归属到某个方法。
- **深度模式 SCIP**(`structuralDiff/deep/*`)—— 有 SCIP 时用它的精确 occurrence/relationship 做调用解析。
- **`impact`**(callee → callers,反向)—— 可**反转**成 caller → callees 作为补充信号。

本 RFC **新增**的核心是:**有序、正向的调用提取**(`callSites`)+ **调用链组装/遍历**+ **时序图视图**。

## 1. 数据模型(shared schema)

新增一个**可选**产物,挂在 `StructuralDiff` 上(向后兼容,旧响应 = 空):

```ts
// packages/shared/src/schemas/structuralDiff.ts
export const callSiteSchema = z.object({
  /** 调用所在方法(主调)symbol id —— 复用 SymbolNode.id */
  from: z.string(),
  /** 被调方法 symbol id;解析不到具体方法时省略(unresolved) */
  to: z.string().optional(),
  /** 被调方在源码里的字面接收者+方法名,如 `context.getSnake`(用于 unresolved 展示 + 调试) */
  callee: z.string(),
  /** 主调方法体内的出现序号(从 0 起),驱动时序图自上而下顺序 */
  order: z.number().int().nonneg(),
  /** 解析置信度:'resolved'(定位到本 diff 内的具体方法)| 'external'(解析到已知类但方法不在 diff)| 'unresolved' */
  resolution: z.enum(['resolved', 'external', 'unresolved']),
})
export type CallSite = z.infer<typeof callSiteSchema>
// StructuralDiff 增: callSites: z.array(callSiteSchema).default([])
```

> 注:`order` 是**主调方法体内**的相对序号,不是全局序;时序图按"展开路径上每层各自的 order"排。

## 2. 后端:有序正向调用提取(新)

新模块 `structuralDiff/callGraph.ts`(PURE 优先,文本/AST 注入):

### 2.1 抽取调用点

对每个**变更方法**(已有 `MemberRange` + 其 body 文本/AST):

1. 用 tree-sitter **遍历方法体 AST**,按 DFS/源序收集 `call_expression`(各语言 grammar 的调用节点),记下:
   - `order`(遍历计数);
   - 接收者表达式文本(`context` / `this` / `factory.create(x)` …)+ 方法名(`getSnake`)。
2. **基线无 tree-sitter 重解析成本**:RFC-083 已为该文件 parse 过一次,复用同一棵树(把 parse 结果在 assemble 阶段透传,避免二次 parse)。

### 2.2 目标解析(receiver type → class → method)

按置信度阶梯,**能解析才连**:

- **SCIP(深度模式,最准)**:用 occurrence 的 symbol 直接拿到被调方法的 SCIP symbol,映射回 `SymbolNode.id`。
- **启发式(基线 / 回退)**:
  1. `this.foo()` / `foo()` → 当前类的 `foo`;
  2. `recv.foo()` 且 `recv` 是本类的**字段/参数/局部变量**,其声明类型 `T` 是本 diff 里的类 → `T.foo`(用 RFC-083 的 `collectClassMembers` + 类型→类名表);
  3. 解析到类 `T` 但 `T.foo` 不在 diff → `resolution='external'`(连到类、不连到具体方法行);
  4. 链式 `a.b().c()` / 泛型 / lambda / 无法定位接收者类型 → `resolution='unresolved'`(只留 `callee` 字面)。

解析失败**不抛错、不臆造**:产出 `unresolved` 记录,前端灰显。

### 2.3 装配

`gitBackend.augmentCallSites(diff, parseTrees)`:对每个变更方法跑 2.1+2.2,产出 `callSites[]`,挂到 `diff`。链路位置:在 `augmentClassEdges` 之后(同样只读 worktree)。复用 RFC-083 的 `MAX_ANALYZE_BYTES` 上限 + 降级标注。

## 3. 前端:调用链组装 + 视图

### 3.1 调用链模型(纯函数,可测)

`lib/callChain.ts`:

```ts
buildCallChain(callSites, rootSymbolId, opts: {maxDepth, maxNodes}): CallChainNode
// CallChainNode = { symbolId, label(签名), children: CallChainNode[], truncated?, resolution }
```

- 以 `from === current` 过滤、按 `order` 升序取直接被调;
- 递归展开,**环检测**(路径集合,A→B→A 标 `cycle` 不再下钻)、**深度上限** `maxDepth`、**节点上限** `maxNodes`(命中标 `truncated`);
- `unresolved`/`external` 作为叶子(不再下钻)。

### 3.2 阶段 1-2:缩进树视图

复用 RFC-083 的卡片/行样式,渲染调用链树:每行 = 方法签名 + 解析徽标;`▸` 展开下一层;`unresolved` 灰显。从结构树/关系图的方法行加"看调用链"入口(`onJumpToCallChain(symbolId)`)。

### 3.3 阶段 3:时序图

数据 → 时序图:DFS 调用链,生成 `(caller lifeline, callee lifeline, message=方法名, depth)` 的**有序消息流**。

渲染二选一(design 取舍,待拍板):

- **方案 A:mermaid `sequenceDiagram`**。把消息流转成 mermaid 文本,用 `mermaid` 渲染。优点:激活条/嵌套/自循环开箱即用、标准。代价:新增 `mermaid` 依赖(体积/单二进制影响需评估——mermaid 是前端 bundle,不进后端二进制,风险可控)。
- **方案 B:自绘 SVG 泳道**。lifeline 竖线 + 有序水平消息箭头 + 激活矩形。优点:无依赖、风格与现有图统一、可与 xyflow 视觉对齐。代价:嵌套/激活布局要自己写。

倾向:**先 A 快速出可用时序图**(数据模型是真资产,渲染器可替换),若依赖/体积不可接受再切 B。

## 4. 接口契约

- 后端:`StructuralDiff.callSites`(新,default `[]`);computeFromWorktree / computeBetweenRefs 链路追加 `augmentCallSites`。
- 前端:`StructuralDiffView` 加第 5 个视图入口或独立面板"调用链";`buildCallChain` 纯函数 + `<CallChainView>` / `<SequenceDiagram>` 组件。
- 兼容:旧 diff(无 `callSites`)→ 入口禁用 + 空态文案;不影响 RFC-083 既有四视图。

## 5. 失败模式 & 边界

| 情形 | 行为 |
| --- | --- |
| 接收者类型无法定位 | `unresolved`,灰显,不下钻 |
| 被调类在 diff 外 | `external`,连到类不连方法行 |
| 递归环 | 环检测,标 `cycle`,停 |
| 超大链 | `maxDepth`/`maxNodes` 截断,标"已截断" |
| 深度 SCIP 不可用 | 回退启发式,横幅标"基线精度" |
| 非变更方法做主调 | v1 只从**变更方法**起链(无 row 的方法不在卡片上);可后续放宽 |
| 文件超 `MAX_ANALYZE_BYTES` | 跳过该文件调用提取 + 标注 |

## 6. 测试策略(test-with-every-change)

**必写**(纯函数优先):

- `callGraph`(后端,PURE):
  - `this.foo()` / `foo()` → 当前类方法;
  - `field.foo()` 且 field 类型在 diff → 解析到 `T.foo`(`resolved`);
  - 类型在 diff 外 → `external`;链式/无法定位 → `unresolved`;
  - `order` 反映源码顺序(先 `a()` 后 `b()` → order 0,1);
  - 注释/字符串里的"调用"被 RFC-083 的 strip 排除(复用 `stripCommentsAndStrings`)。
- `buildCallChain`(前端,PURE):直接被调按 order;递归展开;**环检测**;`maxDepth`/`maxNodes` 截断;`unresolved` 作叶子。
- 时序图数据预言(PURE):调用链 → 有序消息流(lifeline 去重、消息顺序、depth)。
- 集成:`StructuralDiffView` 点方法行触发 `onJumpToCallChain`;`<SequenceDiagram>` 渲染 smoke(至少 lifeline 数 + 消息数断言)。
- 回归锚:真实 git 仓 fixture(Java + TS)端到端断言一条已知调用链。

**门槛**:`typecheck && test && format:check`;动到 shared/后端 → `build:binary` smoke。

## 7. 分阶段(降低风险 + 增量交付)

1. **阶段 1** = §2 调用提取 + §3.1/§3.2 直接被调缩进视图(先有"点方法看它调了谁")。
2. **阶段 2** = `buildCallChain` 递归 + 展开/环/截断。
3. **阶段 3** = 时序图(顺序消息流 + 渲染器)。

每阶段单独 PR、单独验收(见 plan.md)。
