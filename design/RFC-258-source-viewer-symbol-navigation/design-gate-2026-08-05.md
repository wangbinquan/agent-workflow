# RFC-258 设计门记录(2026-08-05)

评审方式:Codex(gpt-5-codex,thread `019fd251-1970-7692-b12a-0948eba8d470`,约 40 分钟
全仓核验;worker 中途崩溃后 `codex exec resume` 取回 findings)。判定:needs-changes,
**6 P0 + 11 P1 + 1 P2 = 18 条,逐条核实全部属实、零驳回、全部折入**。折入后的正文即
当前 proposal/design/plan;本档只记 findings 与处置摘要。

| # | 级 | 问题(压缩) | 处置 |
|---|---|---|---|
| F-01 | P0 | 缓存摘要写错输入面:`digest.ts` contentDigest 是**符号清单**摘要(函数体编辑/未变更文件修改都不变),做 SCIP 缓存 key 会回旧引用 | 新建专用 per-repo `worktreeSnapshotDigest`(HEAD + porcelain + dirty/untracked 内容指纹),design §2.3 重写 |
| F-02 | P0 | `taskId+digest` 命名空间不完整:多仓 per-repo 跑 deep、SCIP 路径 repo-relative 会串仓;TS-only index 会被 Go 查询当完整索引 | key=(taskId, repoKey, snapshotDigest, indexerId@version);graph 记语言覆盖面,查询先验覆盖,partial 不冒充完整 |
| F-03 | P0 | SCIP `local N` 按全局 bySymbol 合并会跨文件串定义 | local symbol 改 `(document, symbol)` 复合键;补两文档同 `local 0` 反例测试 |
| F-04 | P0 | CodePosition 仅"label 前缀 filePath"不可靠;根仓 canonical key 为 `''` 而 file-content 拒空 repo | CodePosition 显式携带 `repoKey`(repo-relative path);线上用既有 `repoKeyWire('')==='.'` 规约 |
| F-05 | P0 | hunk 视图点击缺 old/new side 契约:删除行在 base 侧,unified 行有 marker 列偏移 | 查询与 CodePosition 增加 `side`;新纯函数 `hunkPointToFilePoint`(状态机:context 双计数/add→worktree/del→base/marker 扣列);v1 base 侧走 baseline(deep 不索引 base) |
| F-06 | P0 | 调用链/时序图无位置可传:CallTarget 无 range、SeqCallNode 丢 ref | `walkChainTree`/SeqCallNode/SeqMessage 保留 `ref`;图码联动经 file-symbols 按 (file, qualifiedName) 解析 range;external/unresolved 为禁用态;T9 依赖补 T3 |
| F-07 | P1 | 空结果无法区分"精确无引用/文档未被索引" | 响应加 requestedEngine/actualEngine/coverage/degradedReason;目标文档未覆盖 → per-file 降级 baseline |
| F-08 | P1 | "baseline 引用=impact 子集"不如实:impact 是 `name(` 启发式(误报+60 候选截断) | 文案改「推测调用者,可能漏报或误报」;透传 confidence;definitions 域明确收缩口径 |
| F-09 | P1 | FileSymbolsResult 丢 `hadError`/degraded/parse-error 语义 | 加 `status: ok\|degraded\|unsupported\|parse-error` + 符号级 confidence 保留 |
| F-10 | P1 | `caretPositionFromPoint`+行列正则在 shiki 嵌套 span DOM 上不成立;无可聚焦 token,AC-2 的 Enter 无载体;`#private` 正则声明错误 | 改 shiki transformer 给行 span 写 `data-line`,列 = 同行前序 text node 累加(算法写明);键盘路径改经符号锚点条/概要树(token 点击为鼠标增强);`#` 前缀单独匹配 |
| F-11 | P1 | AnnotatedDiff 委托层与既有 `.changes__hunk-owner` 点击双触发 | 委托只接受 diff body 代码行文本,`closest('button,a,[role=button]')` 短路;回归锁「owner 点击仅一次既有跳转」 |
| F-12 | P1 | 分栏 fitView 覆写用户 viewport,违背刚做的 keep-alive;DrilldownOverlay 常驻导致 codeNav 不随"关闭"重置 | 尺寸变化不自动 fit(仅未交互时);codeNav 在 onClose/kind→null/taskId 变化时显式重置 |
| F-13 | P1 | 语言映射锚点写错(在 `grammars.ts` 的 `resolveLang`,非 gitBackend);语言并集漏 scala、多了无 grammar 的 c/csharp | §0 锚点表订正;T2 改为复用 `resolveLang` + 显式 LangId→shiki id 映射(含 scala;不加 c/csharp) |
| F-14 | P1 | 2000 行阈值挡不住 1.5MB 长行;缺取消/防回写 | 多维预算(bytes/lines/最长行);超限纯文本+行号;高亮结果带请求版本守卫,过期丢弃 |
| F-15 | P1 | 点击高频触发 indexer spawn:无 singleflight/负缓存/权重上限 | per-key singleflight + 失败负缓存(冷却)+ graph 按 occurrence 权重 LRU;spawn 面进测试 |
| F-16 | P1 | react-query key `(path,line,col)` 缺 taskId/repoKey/side/name/mode/snapshot | key 覆盖全部语义输入;snapshot 变化显式失效 |
| F-17 | P2 | 导航栈未建模 origin/side/视图/滚动快照;去重与清空规则缺失 | 会话模型:entry={repoKey, side, filePath, line, col?, viewMode, scroll};连续同目标去重;侧栏切换清空 |
| F-18 | P1 | 测试矩阵缺主要失败边界;e2e 默认仅 Chromium,Safari 面无证 | §6 补 local-N 反例/digest 突变/多仓根 key/hunk 双侧全域/owner 冒泡/shiki DOM 列换算/keep-alive viewport 断言;跨浏览器承诺收缩为 Chromium 保证 + WebKit fallback 单元层覆盖 |
