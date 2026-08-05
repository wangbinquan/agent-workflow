# RFC-258 · 源码审阅器与符号跳转(结构变更页签的代码呈现升级)

状态:Draft(待设计门 + 用户批准)

## 背景

「结构变更」页签(RFC-239 合并后)已具备:文本 hunk diff(AnnotatedDiff)、符号概要树、
关系图(RFC-083)、调用链树/时序图(RFC-085)、影响面、AI 导读。但在真实审查中有三个断层:

1. **hunk 截断上下文**:审查者看到函数的 3 行改动,却看不到函数其余 40 行——判断
   一个改动是否正确经常需要函数/文件的完整上下文,目前只能离开平台开编辑器。
2. **结构视图与代码割裂**:关系图卡片、调用链节点、时序图消息、影响面条目上到处是
   函数名,但**没有一处能点进去看到代码本身**。图回答"什么变了/谁受影响",却回答
   不了下一个必然问题"让我看看它的代码"。
3. **没有符号跳转**:diff 里出现 `verifyManifest(...)` 调用时,审查者无法点击跳到
   其定义;反过来也无法从定义出发列出所有引用处。这是 IDE / Sourcegraph 式审查的
   基本动作,当前完全缺失。

仓内地基(全部已存在,本 RFC 是组合而非新建):

- **shiki**(RFC-008)——语法高亮引擎,单例缓存,双主题;
- **file-content API**——任意 worktree 文件双侧全文读取(不限于 diff 文件);
- **baseline 结构引擎**——tree-sitter 8 语言单文件符号提取(`extractSymbols` 纯函数,
  符号带精确 `range`);
- **SCIP deep 引擎**(RFC-083 PR-E)——`ScipGraph.bySymbol: symbol → occurrences
  {range, isDefinition}`,即完整的 definition/references 数据,目前只用于算 impact,
  未暴露查询面;
- **call-targets API**——方法级 callee 懒展开。

业界对照:Sourcegraph(SCIP 符号导航)、Sourcetrail/NumbatUI(图码联动)、
GitHub/JetBrains(全文视图 + 展开上下文)。本 RFC 取这三家的交集能力,不做
代码城市/3D 类展示(审查价值低)。

## 目标

- **G1 全文视图**:文件详情区新增「全文」模式(与现有 hunk 视图 Segmented 切换):
  shiki 语法高亮渲染 worktree 侧全文,变更行加色条标注,长段未变更代码折叠
  (可展开),支持按行号定位滚动。
- **G2 符号跳转(定义 + 引用)**:全文视图与 hunk 视图中的标识符可点击,弹出
  「跳到定义 / N 处引用」菜单;选择后在**面板内导航**打开目标位置(含未变更文件,
  以只读全文视图呈现),顶部**面包屑历史栈**支持逐级返回。
- **G3 双引擎**:deep(SCIP)可用时按 occurrence 精确解析(跨文件、同名区分);
  不可用时 baseline 兜底(任务内符号表名称匹配,同名多义列候选)。引擎降级对
  用户可见(与现有 engine=baseline/deep 徽标一致)。
- **G4 图码联动**:关系图卡片成员行、调用链树节点、时序图参与者/消息、影响面
  条目全部获得「查看源码」动作;在全屏下钻 Dialog 内以**右侧源码栏**呈现
  (Sourcetrail 式图码分栏),复用同一 CodeViewer 与导航栈。

## 非目标

- 不做编辑能力(只读审阅);
- 不做常驻 LSP / language server 进程(查询即算,SCIP index 按内容摘要缓存);
- 不做跨任务/全仓库索引(范围 = 当前任务 worktree);
- 不做 hover 类型提示(v1 只做点击跳转;hover 文档留后续);
- 不改变现有 hunk diff / AnnotatedDiff 的默认地位(全文视图是切换项,不替换默认)。

## 用户故事

1. 审查者在 diff 里看到 `_parse_feed()` 的调用被改,点击它 → 菜单显示定义位于
   `src/sources/solidot.py:20`(未变更文件)→ 点击 → 右侧面板切到该文件全文视图
   并滚动定位,函数完整可读;面包屑「manifest.test.ts › solidot.py」点击可返回。
2. 审查者打开关系图,看到 `SolidotSource` 卡片的 `fetch()` 成员被标为 modified →
   点「查看源码」→ Dialog 右侧滑出源码栏定位到 `fetch()` 定义,图保持可见,
   点图上另一个成员源码栏跟随切换。
3. deep 引擎不可用的机器上,点击标识符仍能跳转到"任务内已提取符号"的定义;
   点击一个任务外符号(如三方库函数)时菜单显示「未在本任务符号范围内」而非静默。
4. 审查者从定义出发点「7 处引用」→ 列表(文件+行+代码行预览)→ 逐个点击跳转,
   核对每个调用点是否适配了新签名。

## 验收标准

- AC-1 文件详情 Segmented 出现「改动/全文」两档;全文档 shiki 高亮 + 行号 +
  变更行标注 + 折叠段展开;二进制/超限文件降级提示(沿 file-content 语义)。
- AC-2 全文与 hunk 视图中标识符 token 可点击(鼠标增强路径);菜单含定义与引用两组,
  菜单本身键盘完整(Enter 选择、Esc 关闭);**键盘触达跳转的保证路径 = 符号锚点条与
  符号概要树**(shiki token 不进 Tab 序,设计门 F-10 口径);菜单为公共原语,不自造
  chrome。引用组标注引擎与置信度:baseline 引用显示「推测调用者,可能漏报或误报」
  (F-08)。
- AC-3 面板内导航:跳转把目标(文件,行)推入历史栈;面包屑逐级返回;跳到
  diff 外文件时以只读全文视图呈现并在侧栏高亮显示"任务外文件"标识。
- AC-4 双引擎:mode=deep 且 SCIP index 可得**且目标文档被覆盖** → occurrence 级精确;
  否则按文件降级 baseline(名称匹配,多候选全列),响应如实携带
  requestedEngine/engine/degradedReason(F-07);base 侧(删除行)点击一律 baseline
  (v1 不索引 base,F-05)。两引擎结果结构一致。
- AC-5 图码联动:关系图成员行 / 调用链节点 / 时序图参与者与消息 / 影响面条目
  均可打开源码栏;Dialog 内图列与源码栏分栏布局,源码栏内跳转沿用同一历史栈;
  关闭源码栏回到纯图。
- AC-6 SCIP index 按**专用 worktree snapshot 摘要**(HEAD+porcelain+dirty 内容指纹,
  per-repo)缓存;同 key 重复查询不重跑 indexer,**并发首击 singleflight 只 spawn 一次**,
  失败负缓存冷却;函数体级编辑(符号清单不变)也必须失效(F-01/F-02/F-15)。
- AC-7 全链路测试:纯函数层(token→位置换算、名称候选解析、导航栈 reducer、
  hunk→全文行映射)+ 组件层(渲染/点击/降级)+ 端点层(双引擎/缓存/错误码)+
  e2e 1 条(diff→点击→跳转→返回)。
- AC-8 i18n 双语;新增 UI 全部复用公共原语(Dialog/Segmented/EmptyState/btn 体系),
  无自造 chrome;`bun run typecheck && lint && test && format:check` 全绿。

## 能力影响清单

本 RFC 纯新增,不关闭/收缩任何既有能力;现有 hunk diff、markdown 渲染切换、
下钻四视图行为不变。无 breaking change。
