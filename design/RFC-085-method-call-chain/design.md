# RFC-085 — 技术设计

> 已据用户四轮澄清定稿:全仓穿透 + 按需懒加载 + 入口=改动方法 + 1 层默认 + 方法&构造 + 尽力而为断点 + 全 8 语言 + 先树后时序图。

## 0. 与 RFC-083 的关系

复用、不重造:符号集 `SymbolNode`、成员范围 `collectClassMembers`、深度 SCIP(`structuralDiff/deep/*`)、注释/字符串剥离 `stripCommentsAndStrings`、8 语言 tree-sitter 提取(`lang/extract.ts`)。本 RFC 新增的核心 = **按需正向调用解析(懒)** + **调用链遍历** + **时序图**。

## 1. 核心架构:懒加载,而非预算产物

调用链穿透全仓,但**绝不预先全仓建图**。模型是一个**"展开一层"服务**:

```
expandMethod(methodRef) -> CallTarget[]   // methodRef 的直接被调(方法+构造),按源码顺序
```

- 前端从根(改动方法)开始,点 `▸` 才请求该节点的 `expandMethod`,结果缓存。
- 一次 expand 只 parse:该方法所在文件 + 为解析其调用目标而触达的少量文件。

### 1.1 数据契约(shared schema,新增)

```ts
export const callTargetSchema = z.object({
  /** 被调方法的稳定引用:`${filePath}#${qualifiedName}` —— 可作为下一次 expand 的入参 */
  ref: z.string().optional(), // resolved 时有；unresolved 省略
  /** 展示名:解析到的方法签名，或源码字面 `factory.get().x` */
  label: z.string(),
  kind: z.enum(['method', 'constructor']),
  /** 主调方法体内出现序号(0 起)——驱动树的子节点顺序 + 时序图消息顺序 */
  order: z.number().int().nonneg(),
  resolution: z.enum(['resolved', 'external', 'unresolved']),
  /** resolved/external 时:被调所属类的卡片 id（复用 RFC-083 `${file}::${ClassQn}`），给时序图当 lifeline */
  ownerClass: z.string().optional(),
})
```

> `callTargets` **不挂在 `StructuralDiff` 上**(那是预算产物的思路);改由**新端点按需返回**(见 §4)。`StructuralDiff` 只多一个布尔 `callChainAvailable`(是否有可作根的改动方法)。

## 2. 后端:懒展开服务(新)

新模块 `structuralDiff/callGraph/`:

### 2.1 抽调用点(单方法,有序)

`extractCalls(methodNode, tree)`(PURE):tree-sitter 遍历方法体 AST,按源序收集 `call_expression` 与 `new_expression`(各语言 grammar 节点),产出 `{ receiverText, name, kind, order }[]`。复用 RFC-083 已 parse 的树(根=改动方法时直接复用;穿透到未改动文件时按需 parse 该文件)。注释/字符串里的"调用"由 `stripCommentsAndStrings` 先剥除。

### 2.2 目标解析(receiver type → class → file → method)

按置信度阶梯,**能解析才连**:

- **深度模式 SCIP(最准,任意语言)——v1 未实现,留作后续**:occurrence symbol → 被调方法 SCIP symbol → 映射回 `ref`。v1 的调用解析**仅启发式**(下方基线),不接入 SCIP。
- **基线启发式(v1 的唯一路径,精度按语言分档)**:
  1. `this.foo()`/`self.foo()`/`foo()` → 当前类的 `foo`(静态/动态语言皆可);
  2. `new T(...)` → 类 `T` 的构造函数(`T` 经 §2.3 索引定位文件);
  3. `recv.foo()` 且 `recv` 是本方法可见的**字段/参数/局部变量**,其**声明类型** `T`(静态类型语言可得)→ `T.foo`;
  4. 解析到类 `T` 但 `T.foo` 找不到 → `external`(连类不连方法);
  5. **动态类型(Python/JS)`recv` 无声明类型** / 链式 / 泛型 / lambda / 接口多实现 → `unresolved`(只留 `label`)。

**绝不臆造**:解析不到 → `unresolved`,前端灰显、不可下钻。

### 2.3 轻量"类名→文件"索引(跨文件解析的支点)

为把 `T` 定位到其文件,需要一个 `类名 → 文件` 表。**不全量 parse**:一次**浅扫**(正则/轻量 query 抓 `class/interface/struct/...` 声明行)建表,**按 worktree 缓存**(随 task 缓存,失效随 worktree 变化)。目标文件只在**真的要展开到它**时才完整 parse(懒)。

### 2.4 入口与穿透

- **根** = 改动方法(其 `ref` 来自 RFC-083 已有符号集);
- 展开到**未改动**方法:`ref` 的 `filePath` 指向 worktree 任意文件 → 按需读 + parse → §2.1/§2.2。
- 复用 RFC-083 `MAX_ANALYZE_BYTES` + 降级标注;超大/解析失败的文件 → 该层标"不可展开"。

## 3. 前端:调用链树 + 时序图

### 3.1 调用链模型(纯函数,可测)

`lib/callChain.ts`:`CallChainNode = { ref?, label, kind, resolution, ownerClass?, children?: CallChainNode[], loaded, truncated?, cycle? }`。

- 入口:根方法 → 调 expand 取直接被调(默认仅此 1 层);
- `▸` 展开:对该节点 `ref` 调 expand,填 `children`(按 `order`),缓存;
- **环检测**(展开路径含 `ref` → 标 `cycle`、不再下钻)、**深度上限**、**节点上限**(命中标 `truncated`);
- `external`/`unresolved` 为叶子(无 `▸`)。

### 3.2 阶段 1-2:调用树视图(第 5 标签)

`StructuralDiffView` 加第 5 视图「调用链」(空根时空态)。树/关系图的**改动方法行**加小入口图标 → `onOpenCallChain(ref)` → 切第 5 标签、设根。行样式复用 RFC-083 卡片/成员风格 + 解析徽标(`✓`/`⚠ 未解析` 灰显)+ 变更徽标(根是改动方法)。

### 3.3 阶段 3:时序图

调用链 → 有序消息流:DFS,产出 `{ from: ownerClass, to: ownerClass, message: name, depth, order }[]`,lifeline 去重(按 `ownerClass`)。渲染二选一(**PR-C 拍板**):

- **A mermaid `sequenceDiagram`**:消息流转 mermaid 文本渲染;激活/嵌套/自循环开箱即用;代价=新增前端依赖(进 bundle、不进后端二进制,过 build:binary smoke 验)。
- **B 自绘 SVG 泳道**:lifeline 竖线 + 有序水平消息 + 激活矩形;无依赖、风格统一;代价=嵌套布局自写。

倾向先 A 快出(数据是真资产、渲染器可换)。

## 4. 接口契约

- **新端点** `GET /api/tasks/:id/call-targets?methodRef=<file#qn>` → `{ targets: CallTarget[] }`(§1.1 数组)。**worktree-wide,不接受 scope/nodeRunId**:调用链读 live worktree 文件,task/node/wrapper 共用同一 worktree,scope 不改变结果,故省去。missing `methodRef` → 422;worktree 不存在 → 410。挂 `mountTaskRoutes`、contract registry 登记。
- `StructuralDiff` 加 `callChainAvailable: boolean`(有无可作根的改动方法)。
- 前端:`<CallChainView>`(懒展开树)+ 阶段 3 `<SequenceDiagram>`;`buildCallChain`/`expandNode` 走端点。
- 兼容:无该端点的旧后端 → 入口禁用 + 空态。

## 5. 失败模式 & 边界

| 情形                                      | 行为                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| 动态语言无类型 / 接口多实现 / 链式 / 反射 | `unresolved` 灰显,不下钻                                             |
| 解析到类、方法不在该文件                  | `external`,连类不连方法                                              |
| 递归环                                    | 环检测,标 `cycle`,停                                                 |
| 超大链                                    | 深度/节点上限,标"已截断"                                             |
| 调用解析(v1)                              | **始终启发式**(无 SCIP 接入);精度按语言分档,解不开即 unresolved 灰显 |
| 目标文件超 `MAX_ANALYZE_BYTES`/解析失败   | 该节点标"不可展开"                                                   |
| 根必须是改动方法                          | 未改动方法无入口图标(v1)                                             |

## 6. 测试策略(test-with-every-change)

**必写**(纯函数优先):

- `extractCalls`(PURE,8 语言代表样本):有序收集方法调用 + `new`;注释/字符串剥除;`order` = 源码序。
- 目标解析(PURE):`this/self.foo`→当前类;`field.foo`(静态类型)→`T.foo`(`resolved`);类在表外→`external`;动态语言 `recv.foo`/链式→`unresolved`;`new T()`→构造。
- `类名→文件`浅扫索引(PURE):多文件建表正确。
- `buildCallChain`/`expandNode`(前端 PURE):直接被调按 order;懒展开填 children;**环检测**;深度/节点截断;`external`/`unresolved` 叶子化。
- 时序图数据预言(PURE):链 → 有序消息流(lifeline 去重、消息顺序、depth)。
- 集成:真实 git 仓 fixture(Java + TS + 一个动态语言如 Python 验"多 unresolved")端到端断言一条链 + 一个断点;`<CallChainView>` 懒展开渲染 smoke;阶段 3 `<SequenceDiagram>` 渲染 smoke。
- 端点契约:`call-targets` 200 形状 `{targets}` + missing methodRef→422 + 无根空态(worktree-wide,无 scope)。服务层 `worktreeExpandCtx`+`expandMethod` 已端到端覆盖解析逻辑(见 `call-graph-worktree.test.ts`);薄 HTTP 包装层的 200/422 走真实 task+worktree harness 时较重,列为可跟进测试债。

**门槛**:`typecheck && test && format:check`;动 shared/后端 → `build:binary` smoke(阶段 3 若引 mermaid 必验)。

## 7. 分阶段

1. **阶段 1**(PR-A)= §1 schema + §2 懒展开服务(extractCalls + 启发式解析 + 类名→文件索引)+ §4 端点 + §3.2 调用树视图(默认 1 层 + 入口图标)。
2. **阶段 2**(PR-B)= `▸` 递归懒展开 + 环检测 + 深度/节点截断。
3. **阶段 3**(PR-C)= 时序图(有序消息流 + 渲染器,渲染方案 ExitPlanMode/询问定)。
