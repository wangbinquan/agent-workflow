# RFC-088 结构化 Diff 语义增强：解释 / 分级 / 筛选 / 导览

状态：Draft

## 背景

RFC-083 已经把"某个 agent 节点执行前后"的改动从纯文本 unified diff 升级为结构化叠加视图
（`StructuralDiffView`：汇总卡 + tree/graph/impact/deps/callchain 五视图），引擎
（`services/structuralDiff`）已经为每个 `SymbolChange` 算出了 `changeType` / `before`/`after`
节点 / `signatureChanged` / `bodyChanged` / `bodyDelta` / `renamedFrom` / `hunkAnchor`，RFC-087
又补上了 `SymbolNode.visibility`（public/private 等结构化可见性）与 `heritage`。

但**这些已算出的语义字段在 UI 上只是被符号化地堆在一行**（`badge + kind + name + tag + 数字`）。
对"AI 一次写了很多代码、人要快速判断该不该信"的核心场景，目前缺三件事：

1. **没有"人话"**：每一条改动没有一句自然语言解释（"删除了 public 方法 `validate` —— 可能破坏
   调用方"）。读者要自己从 badge/glyph 反推语义。
2. **没有风险分级**：破坏性改动（删除/重命名 public 符号、签名参数删改）和无害改动（新增私有
   方法、改注释）被平铺成同一视觉权重，读者无法"先看危险的"。
3. **没有导览**：面对几十个文件、上百个 `SymbolChange`，没有"先看哪几处"的入口——读者只能逐文件
   扫 tree。

这三件事共享同一批已存在的字段（`changeType` / `signatureChanged` / `visibility` / `bodyDelta` /
`renamedFrom`），把它们抽成纯函数 + UI 联动，就能把"控制 opencode 进程上下文膨胀"省下来的
"全局总结"工作，从某个 audit agent（耗 token）改由确定性纯函数 + UI 承担，直接呼应平台核心动机。

> 本 RFC 建立在 RFC-083/085/086/087 的结构化地基之上。Q1（签名 before→after token 对比，
> `diffSignatureTokens`）已先行并入 RFC-083 收尾，本 RFC 复用它作为"签名变更"分级与解释的输入。

## 目标

- **G1 explainChange（Q11）**：为每条 `SymbolChange` 生成一句确定性、i18n 化的自然语言解释，
  渲染在 tree 视图的符号行下（或可展开）。纯静态、无 AI、无后端。
- **G2 breaking 分级（M1）**：为每条改动算出 `severity`（`breaking` / `risky` / `safe`），在 tree
  与汇总区用 chip / 配色呈现，并把破坏性改动置顶。判定基于 diff 内可确定的结构事实
  （删除/重命名 public 符号、public 符号签名参数删改、可见性收窄）。
- **G3 排序 / 筛选（Q14）**：tree 支持按 `severity` 或 `name` 排序、按 changeType/severity 过滤
  （"只看破坏性 / 只看新增 / 只看签名变了"），汇总卡数字可点即筛。
- **G4 walkthrough 导览（R1）**：在 `StructuralDiffView` 顶部（汇总卡与视图切换之间）渲染一条
  "导览"卡片，按 severity 列出 Top-N 最该先看的改动，点击跳转到对应文件/hunk 或调用链。

## 非目标

- **不做跨文件精确破坏性分析**：v1 的 breaking 只看"diff 内可确定"的结构破坏（被删/被改签名的
  public 符号本身），不追"它在别处的所有调用方是否会编译失败"——那需要 deep/SCIP 影响面，留作
  后续（可与 `impact` 面板、`computePreciseImpact` 合流时再升级为"有 N 个调用方受影响"）。
- **不做 AI 摘要**：解释与分级全部静态确定性（遵循 RFC-083"逻辑细节先静态确定性、AI 后置"）。
  AI 增强（如把多条改动归纳成段落）是后续 RFC 的事。
- **不改 `structuralDiff` 引擎 / schema**：v1 完全在前端纯函数 + 现有字段上做；不新增持久化字段、
  不动 artifact 落盘格式（向后兼容零迁移）。若后续 breaking 需要引擎补字段，另立 PR。
- **不新增路由 / 顶层页面**：导览卡片融进现有 `StructuralDiffView` 与 `tasks.detail` 宿主，不另
  起新 tab/route（参见审计完备性结论）。

## 用户故事

- 作为审阅者，我打开某个 task 的"结构化"tab，**第一眼**就在顶部导览卡看到"3 处破坏性改动"并能
  逐条点进去，而不是从第一个文件开始逐行读。
- 作为审阅者，我看到 `- validate(): bool` 这条删除时，旁边直接有一句"删除了 public 方法 —— 可能
  破坏调用方"，不用自己从 `−` glyph 反推。
- 作为审阅者，文件很多时我点一下汇总卡的"破坏性"数字，tree 立刻只剩破坏性改动。
- 作为审阅者，我能把 tree 从字典序切到"按风险排序"，危险的改动浮到最上面。

## 验收标准

- AC1：`explainChange` 对 5 种 `changeType` × 各 `kind` × 有/无 `visibility` 都返回非空、语义正确
  的 i18n 句子；纯函数单测全覆盖；中英双语 key 均存在（zh-CN `Resources` 类型同步）。
- AC2：`classifyBreaking` 判定矩阵单测通过：删除 public 符号=breaking；public 方法签名删/改参数
  =breaking；可见性 public→private=breaking；renamed/moved public=risky；新增/纯 body 改动/私有
  符号改动=safe；缺 `visibility`（旧 artifact / degraded 语言）时保守降级为 risky 并标注"未知可见性"。
- AC3：tree 支持 severity/name 排序 + changeType/severity 筛选；汇总卡数字点击即筛；切换有
  `role`/`aria` 且复用 `.segmented` 公共控件，不新写 radio 组。
- AC4：导览卡片在存在 breaking/risky 改动时渲染，按 severity 排序列出 Top-N，点击触发既有
  `onJumpToHunk` / `openCallChain`；无破坏性改动时整卡不渲染（不占版面）。
- AC5：纯函数优先可断言；运行时组件最低限度保留一条源代码层文本断言兜底。
- AC6：`bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过
  （涉及 shared 导出时按 [reference_binary_build_module_cycle]）。

## 与既有 RFC 的关系

- 复用 RFC-083 的 `StructuralDiffView` / `structureView.ts` / `diffSignatureTokens`（Q1）。
- 复用 RFC-085 的 `openCallChain` 入口（导览卡的"看调用链"动作）。
- 复用 RFC-087 的 `SymbolNode.visibility`（breaking 分级的关键输入）；对 C++/Scala 等 degraded
  语言缺 visibility 时按 AC2 保守降级。
