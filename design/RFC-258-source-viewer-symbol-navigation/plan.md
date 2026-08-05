# RFC-258 · 任务分解

单 RFC 单 PR 默认;如按批提交,三批边界 = T1–T4(后端+契约)/ T5–T8(前端主体)/
T9–T10(图码联动+e2e)。每个 T 均含其测试(Test-with-every-change)。

## 任务

- **T1 shared 契约**:`CodePosition` / `SymbolResolution` / `FileSymbolsResult`
  (+ zod schema,进现有 shared 导出面)。
  验收:类型 + schema 单测(1-based 约定、可选字段)。

- **T2 语言检测复用**(设计门 F-13 订正:单源已在 `lang/grammars.ts` 的
  `resolveLang`,**不迁移不复制**):新增 LangId→shiki 语言 id 显式映射
  (shared 纯函数,含 scala;不含 c/csharp)。
  验收:映射全 8 语言单测 + 未知语言 null。

- **T3 file-symbols 端点**:§2.1。
  验收:8 语言 fixture / binary / oversized / 多仓 repo / 错误码;
  路由契约注册表(RFC-054)登记。

- **T4 SCIP indexCache + code-intel 端点**:§2.2/§2.3/§2.4/§3(含 snapshotDigest、
  per-repo+indexer 命名空间、singleflight、负缓存、权重 LRU、local-N 复合键)。
  依赖:T1–T3。
  验收:deep 命中(最窄/换算/分组/截断)+ **local N 跨文档反例**、覆盖判定降级链、
  base-side 强制 baseline、baseline 三源解析(confidence 透传)、缓存(命中/
  **digest 突变失效**/**并发 singleflight 单 spawn**/负缓存/权重逐出/partial 不冒充)、
  structural-diff deep 切缓存零退化;错误码覆盖锁登记。

- **T5 CodeViewer 组件**:§4.1(含 `fullFileRanges` / `tokenAt` /
  `identifierClick` 纯函数层;shiki 语言集扩展)。
  依赖:T1。
  验收:纯函数全域单测;组件渲染/标注/折叠/定位/点击;不支持语言与
  oversized/binary 降级;CSS flex 形态锚点。

- **T6 SymbolMenu + codeNav**:§4.3(菜单组件 + reducer/hook)。
  依赖:T4、T5。
  验收:reducer 单测;菜单分组/空态/truncated/键盘;i18n 双语键。

- **T7 文件详情集成**:「全文」档 Segmented、符号锚点条、hunk 视图叠加点击层、
  面包屑与 diff 外文件只读呈现。
  依赖:T5、T6。
  验收:切换/锚点/叠加不破坏 AnnotatedDiff 既有跳转(change-review-panel 套件
  扩展);面包屑跳转-返回-清空;「任务外文件」徽标。

- **T8 影响面升级**:onJumpToFile → onOpenSource(行级定位,兼容旧行为)。
  依赖:T7。
  验收:影响面条目点击定位到 caller 行;既有 impact 测试更新。

- **T9 图码联动**:DrilldownOverlay 分栏 + 关系图成员「‹›」+ 调用链节点 +
  时序图接线(F-06:`walkChainTree`/SeqCallNode/SeqMessage 保留 `ref`,位置经
  file-symbols 按 qualifiedName 解析;external/unresolved 禁用态);独立 codeNav
  栈(F-12:onClose/kind→null 显式重置;分栏宽度变化不自动 fitView)。
  依赖:T3、T5、T6;建立在 full Dialog + graph keep-alive(已入库)之上。
  验收:开/关源码栏 **viewport 逐字节不变**;三视图入口 + 禁用态各 1 条组件测试;
  分栏 `min-width:0` CSS 锚点;时序图 SVG 可达性(role=button);codeNav 重置回归。

- **T10 e2e + 文档**:§6 e2e 1 条;`docs/`README 面向用户的一段说明
  (结构变更页签能力清单更新);STATE.md / design/plan.md 索引状态更新。

## 依赖图

T1 → T3 → T4 → T6 → T7 → T8
T2 → T3;T1 → T5 → T6;T5,T6 → T9;全部 → T10

## 验收清单(合并前逐项勾)

- [ ] AC-1…AC-8(proposal)逐条对应测试绿
- [ ] 四门禁 + build smoke + e2e 本地绿;push 后 exact-SHA CI 绿
- [ ] 设计门 + 实现门(Codex 双门)findings 全部处置
- [ ] 新公共组件(CodeViewer/SymbolMenu)以复用形态交付(命名空间样式、
      i18n key 体系、role 断言),非路由私有助手
