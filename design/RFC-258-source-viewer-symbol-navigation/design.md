# RFC-258 · 技术设计(设计门后修订版;findings 处置见 design-gate-2026-08-05.md)

## 0. 现有锚点(接手者先核对这些仍成立)

| 地基 | 位置 | 本 RFC 的用法 |
|---|---|---|
| 单文件符号提取 | `services/structuralDiff/lang/extract.ts` `extractSymbols(...)` → `Promise<{symbols, hadError}>`(partial parse 置 `hadError`,符号带 `confidence/degraded`) | 任意文件符号表;状态必须透传(F-09) |
| 语言检测单源 | `services/structuralDiff/lang/grammars.ts` `resolveLang`(ext→{lang, grammarFile};**gitBackend 只是它的调用方**,F-13 订正) | file-symbols/code-intel 直接复用,不迁移 |
| SCIP 解析 | `deep/scip.ts` `ScipGraph{documents, bySymbol}`;**注意 bySymbol 是全局 map,`local N` 会跨文档串**(F-03) | deep 引擎数据源;local 键须按文档限定 |
| deep 编排 | `deep/service.ts`(probe → run → parse);`deep/runner.ts` spawn indexer | 复用 probe/run;上面加缓存+singleflight(F-15) |
| 文件全文 | `GET /api/tasks/:id/file-content?side&path&repo`(`worktreeFileContent.ts:128`;多仓 `repo` **拒绝空串**,根仓 wire 值用 `repoKeyWire('')==='.'` 规约,F-04) | 全文视图与跳转目标内容源 |
| shiki | `frontend/src/components/prose/highlighter.ts` 单例(`cached: Promise<Highlighter>`) | CodeViewer 高亮;语言集扩展见 §4.1 |
| call-targets | `callGraph/expandService.ts:151`;`CallTarget{ref,label,order,resolution,ownerClass}` **无 range**(F-06) | 图码联动位置需经 file-symbols 二次解析 |
| 结构 diff repo 归属 | `FileStructuralDiff.repoKey` 显式字段(shared schemas/structuralDiff.ts)——**不得按路径前缀反推**(F-04) | CodePosition 的 repoKey 源 |
| 下钻 Dialog | `DrilldownOverlay`(full 尺寸 + graph keep-alive:隐藏非卸载,fitView 不得覆写用户 viewport,F-12) | 图码联动宿主 |

## 1. 共享契约(packages/shared/src/schemas/codeIntel.ts,新)

```ts
/** 一个可跳转位置。repoKey 显式携带(F-04);side 区分 base/worktree(F-05)。 */
export interface CodePosition {
  repoKey: string          // 单仓 '';wire 层经 repoKeyWire 编码('' ↔ '.')
  filePath: string         // repo-relative(不带 label 前缀)
  side: 'base' | 'worktree'
  startLine: number        // 1-based
  startCol?: number        // 1-based
  endLine?: number
  preview?: string
}

export interface SymbolResolution {
  requestedEngine: 'deep' | 'baseline'
  engine: 'deep' | 'baseline'          // 实际引擎(F-07)
  degradedReason?: string               // deep→baseline 的原因(indexer 缺失/未覆盖该文档…)
  symbol: string
  definitions: CodePosition[]
  /** deep = occurrence 级;baseline = 启发式「推测调用者」(F-08,可能漏报误报)。 */
  references: Array<CodePosition & { confidence?: 'extracted' | 'inferred' }>
  truncated?: boolean
}

export interface FileSymbolsResult {
  lang: string | null
  /** F-09:不完整必须可见。unsupported=无提取器;degraded=partial parse。 */
  status: 'ok' | 'degraded' | 'unsupported' | 'parse-error'
  symbols: Array<{ name: string; qualifiedName: string; kind: SymbolKind;
                   range: { startLine: number; endLine: number };
                   confidence?: 'extracted' | 'inferred' }>
}
```

## 2. 后端

### 2.1 `GET /api/tasks/:id/file-symbols?path=&repo=&side=`

worktree(或 base)侧读文件(复用 `worktreeFileContent` 路径安全/上限)→ `resolveLang`
→ `extractSymbols` → `FileSymbolsResult`。`hadError` → `status:'degraded'`;无提取器 →
`'unsupported'`(200);fatal parse → `'parse-error'`(200,symbols:[])——三态都不是 HTTP
错误(F-09)。`repo` wire 规约同 file-content(`.` ↔ 根仓)。
错误码:`file-symbols-missing-path`;oversized/binary 沿 file-content 语义。
用途:全文视图符号锚点条、baseline 引擎目标文件核对、**图码联动的 ref→range 解析**(F-06)。

### 2.2 `GET /api/tasks/:id/code-intel?path=&repo=&side=&line=&col=&name=&mode=`

符号解析主端点。参数含 `side`(F-05:base 侧点击「删除行」时解析 base 版本)与
`repo`(wire 规约同上)。`mode=deep|baseline`;deep 请求在 indexer 不可用**或目标文档
未被现有 index 覆盖**时按文件降级 baseline,响应 `requestedEngine/engine/degradedReason`
如实标注(F-07)。无命中 → 空数组(200)。
错误码:`code-intel-missing-params`。

### 2.3 SCIP index 缓存(`deep/indexCache.ts`,新;F-01/F-02/F-15)

- **snapshotDigest(新,专用)**:per-repo,`sha256(HEAD sha + git status --porcelain -z
  原文 + 每个 dirty/untracked 文件的 (path, size, mtimeMs, 内容 sha256))` 截 16 hex。
  **不复用 `digest.ts` 的 contentDigest**(那是符号清单摘要,函数体编辑不变,F-01)。
  终态任务 worktree 稳定 ⇒ digest 稳定;运行中任务每次点击重算 digest(纯 git 读,
  dirty 文件通常个位数)。
- **key = `(taskId, repoKey, snapshotDigest, indexerId@indexerVersion)`**(F-02);value =
  该 repo 的 `ScipGraph` + `coveredLangs`(本次 run 实际覆盖的语言集)。查询前先验
  「目标文件语言 ∈ coveredLangs 且文档存在于 index」,否则视为未覆盖 → 降级,partial
  graph 不冒充完整(F-02/F-07)。
- **singleflight**:同 key 并发首击共享一次 indexer run(per-key promise map);
  **负缓存**:probe/run 失败按 key 记冷却(5 min)内直接降级不重 spawn(F-15)。
- **权重 LRU**:按 occurrence 总数为权重,全局上限(默认 2M occurrences),超限逐出
  最旧;单 index 文件超 64MB 拒载(F-15)。
- `structural-diff?mode=deep` 同批切到该缓存(行为不变,消重复 spawn)。

### 2.4 SCIP local symbol(F-03)

`bySymbol` 对 `local N` 形式的 symbol 改用 `(relativePath, symbol)` 复合键(或独立
`byLocalSymbol: Map<doc, Map<symbol, occ[]>>`);全局 symbol 走原全图索引。
`mergeScipGraphs` 同步适配。反例测试:两文档同 `local 0` 不得互串。

## 3. 双引擎解析语义

### 3.1 deep(SCIP)

- 命中:该文档 occurrences 中覆盖 (line,col) 的最窄 range;0-based→1-based 换算单测;
- definitions/references 按 `isDefinition` 分组;references 含未变更文件(核心增量);
- references > 500 截断置 `truncated`;
- side:v1 SCIP 只索引 worktree;`side='base'` 的查询**直接走 baseline**(F-05)。

### 3.2 baseline(零依赖兜底)

解析域 = 结构 diff 符号(before/after 按 side 选) ∪ 点击文件 `extractSymbols` 全量
∪ impact.callers。

- definitions:叶子名匹配,多义全返回(候选);
- references:impact 启发式结果**原样透传 confidence,UI 文案「推测调用者,可能漏报
  或误报」**(F-08:impact 是 `name(` 正则 + 60 候选截断,既漏报也误报,不承诺子集);
- definitions 域口径如实:任务外未变更文件中的定义 baseline 找不到(deep 专属)。

## 4. 前端

### 4.1 `components/code/CodeViewer.tsx`(新公共组件)

props:`{ taskId, repoKey, filePath, side, focus?: {line, endLine?}, changedRanges?,
onSymbolClick?: (pos: CodePosition, name: string) => void, readonlyBadge?: boolean }`

- **高亮管线**:shiki 单例 `codeToHtml` + **自定义 transformer 给每个行 span 写
  `data-ln`(1-based)**(F-10;shiki 官方 line transformer hook)。语言集扩展:现 12 种
  + `go/rust/java/scala`(= baseline 提取器 8 语言的实际集合;**不加 c/csharp**——
  baseline 无其 grammar,F-13);LangId→shiki id 显式映射表(纯函数,单测)。
- **多维性能预算**(F-14):bytes > 512KB ∨ lines > 2000 ∨ 最长行 > 4000 字符 →
  跳过 shiki,纯 `<pre>` + 行号(仍可点击标识符——列换算走 textContent 直取);
  高亮为异步任务,**结果带请求版本号,过期(props 已变)丢弃不回写**。
- **变更标注**:`changedRanges` 由 `lib/fullFileRanges.ts` 从 hunks 换算(worktree 侧)。
- **折叠**:连续未变更 > 20 行折叠;`focus` 所在段初始展开;行定位 scrollIntoView+闪烁。
- **标识符点击层**(F-10/F-11 修订):container 单一 click 委托:
  1. `closest('button,a,[role=button]')` 命中 → 直接 return(不抢既有控件,F-11);
  2. 从 event.target `closest('[data-ln]')` 取行号;
  3. 列 = 遍历该行 span 内 text node,累加 target 之前的文本长度 + 节点内偏移
     (`caretPositionFromPoint` 只取**节点内**偏移,行内列由累加得出——不依赖它跨节点;
     WebKit `caretRangeFromPoint` 同形兜底;两函数都不可用 → 忽略点击);
  4. `tokenAt(lineText, col)`:标识符 = `#?[A-Za-z_$][\w$]*`(`#` 前缀显式并入,F-10);
     命中 null(空白/操作符)→ 不发请求。
- **键盘可达性口径**(F-10):token 不进 Tab 序;键盘路径 = 符号锚点条 / 符号概要树
  (role 完整的真按钮)触达同一跳转;标识符点击是鼠标增强。proposal AC-2 同步修订。
- 尺寸:组件自带 flex 形态 + `min-height:0`(CSS 锚点锁,xyflow 0 高同族防线)。

### 4.2 文件详情集成(ChangeFileDetail)

- 视图 Segmented 加「全文」档(worktree 侧 CodeViewer + file-symbols 锚点条,
  status ≠ ok 时锚点条带「符号表不完整」徽标,F-09);
- **hunk 视图点击换算**(F-05):新纯函数 `hunkPointToFilePoint(hunk, bodyRowIdx, col)`
  → `{side, line, col} | null`:状态机推进 old/new 双计数;`+` 行→worktree、`-` 行→base、
  context→worktree(双侧同内容取 worktree);col 扣 1 列 diff marker;hunk header/
  metadata 行返回 null。全输入域单测(F-18);
- AnnotatedDiff 委托复用 §4.1 的 helper(`lib/identifierClick.ts`),排除规则同源;
  回归锁:`.changes__hunk-owner` 点击只触发一次既有跳转、不发 code-intel(F-11)。

### 4.3 跳转菜单与导航会话(F-16/F-17)

- `SymbolMenu`:定义/引用分组列表(文件:行 + preview + confidence 徽标),空态
  「未在本任务符号范围内」+ 实际引擎徽标 + degradedReason;键盘 Enter/Esc;
- react-query key = `['codeIntel', taskId, repoKey, path, side, line, col, name, mode,
  snapshotHint]`(snapshotHint = structural-diff 响应的 contentDigest,作为前端可得的
  失效代理;后端仍以自身 snapshotDigest 为准,F-16);
- **导航会话**(`lib/codeNav.ts` 纯 reducer):entry =
  `{repoKey, side, filePath, line?, col?, viewMode: 'hunk'|'full', scrollTop?}`;
  push 前把**当前**位置(含视图模式与滚动快照)存入栈(= 返回可精确复位,F-17);
  连续同目标去重;pop 恢复 entry 全量状态;侧栏切换文件 / taskId 变化 → 整栈清空;
- diff 外文件 → 合成只读 entry(CodeViewer + 「任务外文件」徽标),面包屑唯一出入口。

### 4.4 图码联动(DrilldownOverlay;F-06/F-12)

- **位置契约**:`walkChainTree` 保留每节点 `ref`;`SeqCallNode`/`SeqMessage` 增加
  `ref?: string`(sequence.ts 纯层适配);图入口的 `onOpenSource(target)` 传
  `{repoKey, filePath, qualifiedName}`(从 ref 拆,多仓 label 按 expandService 既有
  拆分规约);源码栏打开时先调 **file-symbols** 按 qualifiedName 解析 range 再定位
  (解析失败 → 栏内空态「符号未在当前文件符号表中」);external/unresolved 节点
  按钮禁用态(F-06);
- 关系图卡片成员行「‹›」按钮 / 调用链树节点 / 时序图参与者头与消息(SVG `role=button`
  g)/ 影响面条目(升级为行级)全部接 `onOpenSource`;
- 分栏:`.changes__drill--split` 左图右码(右 40%,可关);图列 `min-width:0`;
  **宽度变化不自动 fitView**(用户已交互过的 viewport 神圣不可覆写;仅从未交互过的
  初始状态可在可见时 fit 一次,F-12);
- **codeNav 会话重置**(F-12):DrilldownOverlay 常驻(kind=null 返回 null 不卸载),
  故源码栏的导航栈在 `onClose` / kind→null / taskId 变化时显式 reset;
- keep-alive 回归断言升级:不只断组件未卸载,还断 viewport transform 在开关源码栏
  前后逐字节不变(F-18)。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| indexer 不可用/超时/负缓存冷却中 | 降级 baseline,`engine:'baseline'` + degradedReason |
| deep index 未覆盖目标文档/语言 | 同上(按文件降级,F-07) |
| baseline 无命中 | 空结果菜单(非错误) |
| `side='base'` 的 deep 请求 | 直接 baseline(v1 不索引 base,F-05) |
| 目标 oversized/binary | 菜单可跳,CodeViewer 降级提示 |
| 多仓根仓 | `repoKey:''` wire `'.'`(F-04),两端点与 file-content 同规约 |
| worktree GC | file-content 410 → 空态「工作区已回收」,跳转不可用 |
| 快速切换文件 | 高亮/查询结果版本守卫,过期丢弃(F-14) |

## 6. 测试策略(含 F-18 补全)

**纯函数**:tokenAt(含 `#` 前缀/unicode 拒绝域);fullFileRanges;
hunkPointToFilePoint **全输入域**(context 双计数/add/del/marker 列/header null);
codeNav reducer(快照复位/去重/清空);SCIP 命中(最窄/换算/截断)+ **local N 跨文档
反例**;LangId→shiki 映射(含 scala、无 c/csharp);snapshotDigest(dirty 内容变化必变
/仅 mtime 不变内容不变时的口径)。

**端点**:file-symbols(8 语言/degraded/unsupported/parse-error/binary/oversized/
多仓含根仓 `.`);code-intel(deep 命中/未覆盖降级/负缓存/base-side 强制 baseline/
错误码);indexCache(同 key 命中不重跑/digest 突变 miss/**并发 singleflight 单次
spawn**/权重逐出/partial 不冒充完整)。

**组件**:CodeViewer(高亮/降级/折叠/focus/点击参数/**版本守卫过期丢弃**);
SymbolMenu(分组/空态+degradedReason/truncated/键盘);hunk 视图(**owner 点击单动作
回归**/标识符点击换算);导航(push 快照-pop 复位/清空/diff 外合成 entry);
DrilldownOverlay(开关源码栏 **viewport 逐字节不变**/codeNav onClose 重置/
external 禁用态);CSS 锚点(CodeViewer flex 形态/分栏 min-width:0)。

**e2e(Chromium 1 条)**:diff→点击标识符→菜单→跳 diff 外定义→面包屑返回复位。
跨浏览器口径(F-18):Chromium 为保证面;WebKit 的 caretRangeFromPoint fallback 在
单元层以 mock 覆盖,不做 e2e 承诺。

## 7. 性能

- 高亮预算三维(512KB/2000 行/4000 字符行),超限纯文本仍可交互(F-14);
- code-intel 点击驱动 + 完整 query key 缓存;snapshotDigest 计算为纯 git 读;
- indexer:首击一次成本(singleflight 保并发唯一),负缓存挡不可用机器的反复 spawn,
  权重 LRU 挡内存(F-15)。

## 8. 与既有机制的耦合点

- structural-diff deep 路径切 indexCache(行为不变);
- AnnotatedDiff 点击层是叠加,排除规则保证既有控件零冲突(F-11);
- 分栏建立在 full Dialog + keep-alive 之上,fitView 约束以 F-12 为准;
- 不触碰受控执行面(indexer spawn 沿 deep/runner.ts 既有路径,新增的只是缓存与
  节流治理)。
