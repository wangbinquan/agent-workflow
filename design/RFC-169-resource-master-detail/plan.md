# RFC-169 · 任务分解

状态：Draft（待用户批准后实现）。本仓 main 直推模式，无独立 PR 分支——下述「批次」= 逐批 commit + push + CI 验证的粒度；每批自带测试（Test-with-every-change），每批 push 前过全量门禁（typecheck / lint / test / format:check / frontend vitest / build:binary 冒烟）。

## 任务清单

### 批次 A —— 公共原语（不接线，纯新增，零回归面）

- **RFC-169-T1** `lib/stable-stringify.ts` + 单测（键序/嵌套/undefined 丢弃/数组保序/标量）。
- **RFC-169-T2** `lib/resource-card-filter.ts`（`filterResourceCards`）+ 单测。
- **RFC-169-T3** `useDraftFromQuery` 扩展 `dirty`/`commitSaved(submitted, saved)`（提交快照契约，design §3.3）+ **`followWhenClean` opt-in**（clean-follow / dirty-freeze，R2-P1-1；hydrate-once 默认契约不动、现调用方零改动）+ 姊妹 hook `useDirtyBaseline(draft, initial)`（`resetBaseline(next)` 显式收参）+ 单测（seed→改→dirty；保存在途继续输入→新输入保留且仍脏；clean 时后台刷新自动 rebase / dirty 时冻结；A→B→A 延迟响应；慢 config 基线两方向）。
- **RFC-169-T4** `components/ResourceBadges.tsx` 抽取；`ResourceNameCell` 内部改用之（workflows/workgroups 调用方零改动）+ `resource-list-shell.test.tsx` 增补抽取回归断言。
- **RFC-169-T5** `components/split/ResourceSplitPage.tsx`（骨架/搜索/卡片/选中/新建/三态/**父草稿级 `SplitDirtyContext`**〔`report(cardKey, dirty)` 上报父草稿 dirty→画圆点+guard；同步 ref 读 T-D5；子缓冲 best-effort 不追踪，三次定案〕）+ `components/split/UnsavedChangesGuard.tsx`（useBlocker + Dialog `onClose=reset` + beforeunload + **保存在途拦截文案**）+ 页签面板 keep-mounted 骨架（`hidden` 而非条件卸载）+ `.page--split`/`.split*`/`.split-card*` 样式（`minmax(0,1fr)`/min-width 链，design §1.1）+ i18n 新 key 双语 + 组件测试（`resource-split-page.test.tsx`、`unsaved-guard.test.tsx` 真 memory-router 拦截链 + ESC/×/遮罩 dismiss 三入口 + 切页签往返子缓冲保留（keep-mounted） + **删除：确认冻结/失败逐字恢复/成功导航〔矩阵㉛〕** + **迟到回执 reseed no-op 不污染〔矩阵⑱〕**）。

依赖：T3 依赖 T1；T5 依赖 T1/T2/T3；T4 独立。

### 批次 B —— agents 页接线（打样页，含表单页签化）

- **RFC-169-T6** 路由重构：`agents.tsx` → layout + `IndexRoute`（空态）；`agents.new` / `agents.detail` 挂为子路由；detail 子路由声明 `remountDeps: ({params}) => params`（T-D11，含 a→b 参数导航重播种回归锁——兼修现存依赖树跳转旧草稿串台 bug）；`router.tsx` `addChildren`。
- **RFC-169-T7** `AgentForm` 五页签重构（TabBar/徽标纯函数 `portBadgeCount`/`resourceRefCount`/提示词页签 flex 撑满——必要时 `MarkdownEditor` 加可选 `fill`）；`hasResourceContent`/`hasAdvancedContent` rising-edge 体系退役。
- **RFC-169-T8** agents 三视图接线：卡片模型（运行时/默认 tag/builtin/ResourceBadges）+ 详情（`<h2>`、保存留原地 + `commitSaved` reseed + cache transaction〔集合 cancel→空值安全 eager patch→exact invalidate + 详情 key 先 cancel 再写 saved 的 GET fence〔矩阵⑲〕，design §4〕、父草稿 dirty 上报）+ 新建内联（轻 header、导入保留、`applyDefaults` 分别喂 draft 与 baseline、创建后 navigate 选中）。
- **RFC-169-T9** agents 侧测试迁移：翻转 `edit-routes-navigate-on-save.test.ts`（agents 部分）、退役 `agents-list-cell-wrapping`、改写 `rfc115-node-policy-global` 列头断言、重写 `agent-form-sections.test.tsx`（五页签）、新增 `agents-split-page.test.tsx`、wiring 源码锁。
- **RFC-169-T10** 视觉自查（明暗双主题 + 窄视口，[feedback_frontend_visual_verify_repro] 最小 repro 或 dev server 截图）；`agents.png` 基线重生成。

依赖：T6-T10 依赖批次 A；T7 可与 T6 并行；T9/T10 收尾。

### 批次 C —— skills 页接线（最重的一页）

- **RFC-169-T11** 路由重构（同 T6 形态）+ layout 卡片（managed/external chip）+ 空态承载 `<SkillSourcesCard/>`。
- **RFC-169-T12** 详情四页签（概览/内容/文件/历史，能力门控沿 `skillCapabilities`）；**后端小件①=SKILL.md 写删守卫**（纯函数 `isProtectedSkillMainFile`〔canonical relative-file identity〔剥尾随 `/`、折叠 `.`/`//`、拒目录形式〕+ **Unicode NFC 规范化 + 完整 Unicode case-fold**〕单点抽出、`writeSkillFile` 与 `deleteSkillFile` 两入口共用 + **后端两入口再做已存在候选/根 SKILL.md 的 realpath 或 dev+inode 身份比较**〔F3：ASCII fold 挡不住 APFS `ſKILL.md`〕+ 前端 Add/Save 同纯函数拦、`SkillFileTree` 加 `readonlyPaths`；带双入口测试含 `SKILL.md/` 尾随分隔符 + `ſKILL.md` Unicode 等价名 + APFS inode 回归，矩阵⑭；需预置 symlink 的间接身份边角转 170）；**skills 保存/读取沿用现状**（double-PUT LWW + 双查询播种，零后端改动）——双栏前端两处：①onSuccess=全 PUT fulfilled 才 `commitSaved` 一次+不导航（**保存留原地**）；②**reseed 留原地+刷新版本历史**〔onSuccess reseed 父草稿+不导航、best-effort refetch detail+versions；版本操作（save/restore/文件写）标准 isPending 按钮互斥；三次定案不建精密 gate，同页竞态窗口/不确定提交/离线/跨页深层一致性转 170，矩阵㉔a〕；双通道错误沿 `DetailHeaderActions.errors`。**版本恢复**（`SkillVersionHistory` 加 `onRestored`；restore.isPending 与保存互斥、成功失效五组 key+`restoreEpoch` 重挂 rebase；跨页/跨窗口版本栅栏转 170，矩阵㉔⑮⑳）；`page--wide` 退役。**（combined-save/单 fenced read/contentVersion CAS/深层版本一致性整套=RFC-170 入口。）****（跨窗口全域 OCC/复合 token/快照权威/quarantine/fusion/source ACL 全部转 RFC-170，169 不实现。）**
- **RFC-169-T13** 新建四模式页签入驻右栏（`ImportZipPanel` 加可选 `onDirtyChange`〔上报已选文件/决策脏态〕+ **`onImported` 回调把终态导航上移到捕获 scopeId 的父级**〔现内部 fetch 后直接 navigate，R5-P1-3〕；folder 注册成功落空态；ZIP 暂存维持现状本地状态、keep-mounted 跨页签存活）。**（子缓冲完美追踪三次定案移出 169；ZIP 覆盖 OCC/并发创建 reservation 转 RFC-170。）**
- **RFC-169-T14** skills 侧测试：翻转 navigate 锁（skills 部分）、`skills-detail-save-channels` 改断言（**保留双 PUT 双通道**，只改 onSuccess=全部 fulfilled 才 `commitSaved` 一次+不导航；部分失败保持 dirty）、退役 `skills-list-cell-wrapping` 与 `skill-source-pill.test.tsx`、`skills-new-zip-tab` 核对、新增 `skills-split-page.test.tsx`（含**脏 support 文件→确认 header 保存→PUT 失败→正文逐字保留（两阶段 discard，R13）**、空态 SourcesCard、SKILL.md 写删守卫双入口锁〔含 `SKILL.md/` 尾随分隔符 + `ſKILL.md` Unicode 等价名 + APFS inode〕、**operationBusy 全链〔mutation settled 但 refetch 未 settle 期间仍禁全版本写+历史只读、refetch 失败保持 busy 至重试、restore 2xx→refetch 失败→尝试输入→重试成功不丢输入，矩阵㉔a〕**、restore→rebase→再保存不回退、文件页签宽度冒烟）。**（combined-save/CAS/新端点 ACL/live 失败等保存协议测试随入口转 RFC-170。）**

### 批次 D —— mcps + plugins 页接线

- **RFC-169-T15** mcps：路由重构 + 卡片（type/enabled/probe chip + **`probeFreshness` 配置指纹**〔`startedAt > updatedAt` 严判、同毫秒 fail-closed，纯函数单测含启动-保存-完成竞态〕）+ **后端守卫之二：探针 `startedAt` 捕获前移到配置快照读取之前**（零 schema；注入时钟测「读旧快照→保存→记 startedAt」窗口消失，矩阵㉑）+ 详情两页签（配置/工具与探测——InventoryPanel 迁入）+ 保存失效 probes + 展开行体系退役删除（`McpExpandedSummary` 等）+ 新建单组。
- **RFC-169-T16** mcps 侧测试：重写 `mcps-list-probe-columns`、改 `mcps-detail-inventory-mounted`、核对 `mcps-page-wiring`、退役 `mcps-list-cell-wrapping`、新增 `mcps-split-page.test.tsx`（含「探测后改配置→需重新探测」）。
- **RFC-169-T17** plugins：路由重构（`$id` key）+ 卡片（sourceKind/版本/更新/enabled chip）+ updateInfo cache 化（`['plugins','updates']` 字典，entry 带 `{spec,resolvedVersion}` 指纹、v5 对象签名 + `gcTime: Infinity`、save/upgrade/delete 清除不匹配项）+ 详情两页签（配置/更新——check-update/upgrade 迁入）+ 新建单组。
- **RFC-169-T18** plugins 侧测试：`plugin-create-retry` 导航断言改向、`plugins-page-wiring` 行内 upgrade 锁改页签锁、新增 `plugins-split-page.test.tsx`（含 cache 化链路：详情检查更新→卡片 chip；「检查后改 spec→回到未检查」）。

### 批次 E —— 收尾

- **RFC-169-T19** 全仓 grep 复核残余引用（`data-table` 于四页、`colRuntime`、`page--wide`、退役组件/样式类无孤儿；[feedback_grep_locks_before_push] 全量盘锁）；死样式清理。
- **RFC-169-T20** e2e 核对与适配：`a11y.spec`（/agents/new 页签交互）、`rfc099-ownership-acl`、`main.spec` 两用例、`nav-redesign`；`agents.png` 双 OS 基线随 CI 回填。
- **RFC-169-T21** 归档：`design/plan.md` RFC 索引置 Done、`STATE.md` 已完成表加行、RFC 目录补终态注记。

## 验收清单（对 proposal §6 逐条）

- [x] 四页双栏 + 搜索过滤 + 徽标 + 「+ 新建」（§6.1）
- [x] 右栏三段结构 + 页签划分 + 提示词满高 + 徽标计数 + 切资源复位（§6.1a）
- [x] 深链三 URL 直达、选中态正确、外部入口零适配（§6.2）
- [x] 保存留原地/创建选中/删除回空态（§6.3）
- [x] 脏点 + 站内拦截 + beforeunload + 程序化导航不拦（§6.4）
- [x] 行级操作迁移：mcps 展开行退役不丢信息、plugins 更新页签、agents 启动在 header（§6.5）
- [x] skills：空态源面板全功能、文件页签不破版、四模式新建完整（§6.6）
- [x] 门禁全绿 + `agents.png` 刷新 + 明暗/窄视口自查（§6.7）
- [x] i18n 双语零硬编码（§6.8）
## 终态注记（T21 归档，2026-07-21）

批次 A–D 四页（agents/skills/mcps/plugins）双栏化已逐批交付并推送（批次D 收尾 `cd5e6294`、探针
startedAt 前移 `faccc35c`、跟进修 `3f75d93f`）。批次E：

- **T19**：残余 grep 复核完成（四页无 `data-table`；`page--wide` 仍被 workgroups/fusions 合法使用、非孤儿；
  无 `McpExpandedSummary`/`SkillSourcePill` 孤儿；`col*` i18n 键被 wiring 测试锁定、有意保留）——记录见 `8c7f26b0`。
- **T20**：e2e 适配完成（a11y.spec /agents/new 页签交互、main.spec rfc022 依赖树先开 Resources 页签）；
  `agents.png` 双 OS 基线经 nightly visual 回填 `37518c0f`，nightly 三连红清零、HEAD `33d1b00a` nightly 绿。
- **T21**：`design/plan.md` RFC 索引置 Done + STATE.md 落地记录 + 本注记（2026-07-21 归档批）。

验收清单逐条依据以上证据勾选。RFC-170（combined-save/CAS/版本一致性等技能保存协议深化）为既定
后续入口，与本 RFC 交付边界见 T12/T13/T14 括注。
