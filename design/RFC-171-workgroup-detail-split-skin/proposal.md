# RFC-171 工作组详情页 split 皮肤对齐——左成员卡片列 + 右编辑区

- 状态：Draft
- 作者：（本 session）
- 日期：2026-07-13
- 依赖：RFC-164（工作组）、RFC-168（工作组详情页 UX：成员画廊 + 上下文面板）、RFC-169（资源页双栏化 split 皮肤，本 RFC 复用其 `.split*` 视觉语言）
- 设计门：Codex 第一轮（2026-07-13）NEEDS-ATTENTION 10 findings（3H+5M+2L）**已全部折叠**——见 design.md §9 逐条处置表。核心修正：配置条目移出滚动区（真固定）· 保留 blank-area-deselect（不做行为回归）· 保住 stretched hit-area 的 `position:relative` · CSS 清理明确 keep-list · 测试补 `workgroups-pages.test.tsx` + 真实 DOM 断言 · 端口计数走复数。

## 1. 背景

RFC-169 把 agents / skills / mcps / plugins 四个资源页做成了统一的 master-detail 「双栏」皮肤（左卡片列表 + 右编辑区，公共类 `.split` / `.split__list` / `.split-card` / `.split__detail`）。当时明确把 workgroups **排除**在外（`design/plan.md` RFC-169 行："workflows/workgroups 不适用"），因为工作组详情页在 RFC-168 里已经是另一套「studio」布局：

- `/workgroups` 列表页 = 老式 `data-table` 表格。
- `/workgroups/$name` 详情页 = 「studio」：主区是**宽**的成员卡片画廊（`.workgroup-studio__main`，`minmax(0,1fr)`），右侧是**窄**的 380px 固定上下文面板（`WorkgroupContextPanel`，三态 config / member / add）。

结果：agents 一族现在是精致的双栏卡片皮肤，工作组详情页却是「宽画廊 + 窄面板」的另一套观感，视觉不统一。

用户 2026-07-13：「工作组编辑界面改成和 agent 编辑界面一样吧，左侧卡片栏右侧编辑界面，界面风格拉齐。」

两轮澄清拍板（见 §6 决策记录）：
- **只改详情页皮肤**（列表页 `/workgroups` 保持表格不动）。
- 详情页做成 agents 那种 split：**左侧成员卡片列 + 右侧编辑区**。
- 「组配置」放**左栏顶部固定的「⚙ 组配置」条目**（默认选中），右侧编辑区未选成员时显示组配置表单、选中成员切成员编辑器。

本质：把 RFC-168 studio 的两列**角色对调 + 换皮**——成员从「宽画廊」变成「窄卡片列（像 agent 卡片）」、编辑区（config/member/add 三态）从「380px 窄面板」变成「宽的右侧编辑区（像 AgentForm）」。**底层选择状态机、成员写入语义、RFC-168 的 Codex 加固全部保留**，改动集中在布局 / CSS / 左栏增补两处控件（配置条目 + 添加按钮位置）。

## 2. 目标

- G1：`/workgroups/$name` 详情页采用与 agents 一致的 split 双栏皮肤（复用 `.split*` 公共类，不自写一套 chrome / CSS）。
- G2：左栏对齐 agents rail 的「固定头 + 滚动卡区 + 固定尾」——**固定头区**（不随成员滚动）= 「成员 · N」计数 +「⚙ 组配置」条目（默认选中）；**滚动区** = 成员卡片列；**固定尾区** =「添加 Agent 成员 / 添加人类成员」按钮。成员卡片采用 `.split-card` 卡面语言（窄卡、选中高亮、agent/human 类型描边），与 agent 卡片观感对齐。
- G3：右栏 = 宽编辑区，未选成员时显示**组配置表单**（`WorkgroupForm`），选中成员切**成员编辑器**（别名 / 角色 / 设 leader / 移除 / 只读能力卡 + 跳转 `/agents/$name`），添加时显示添加表单。三态渲染逻辑沿用 `WorkgroupContextPanel`。
- G4：工作组级顶部区（`DetailHeaderActions`：名称 + ACL / 保存 / 删除 / 重命名 / 启动 + 就绪度横幅）保持全宽在顶部不变；配置「保存」语义、成员即时 PUT 语义均不变。
- G5：保留 RFC-168 全部行为契约与其 Codex 加固：id 重生成后按内容重选中（`findMemberKeyByContent`）、in-flight 面板冻结（`changePanel` guard）、config 保存重解析选中、成员 save single-flight / 错误归属、MemberBody 内容身份键、焦点契约（F8）、面板级 Esc（F9）。
- G6：纯前端、零后端、零 migration；单 PR。
- G7：明暗双主题 + 窄屏（≤1080px 复用 `.split` 的单列降级）视觉一致。

## 3. 非目标

- N1：**不动 `/workgroups` 列表页**——保持现有 `data-table` 表格 + 快速创建弹窗（用户明确「只改详情页皮肤」）。是否把列表页也双栏化留作后续，不在本 RFC。
- N2：不改成员编辑的**语义**：配置走 draft + 顶部「保存」，成员操作（别名 / 角色 / 设 leader / 增删）仍即时 full-replace PUT。
- N3：不引入编辑 **agent 全局定义**的语义（沿 RFC-168 D3：编辑成员 ≠ 编辑 agent；能力卡只读、跳转 `/agents/$name`）。
- N4：不动 workflows 页（其编辑器是全画布 xyflow，双栏 master-detail 不适用；如需另立 RFC）。
- N5：不动聊天室 / 任务详情 / 动态 workflow 面板等运行态视图（本 RFC 只碰**资源编辑态**的 `/workgroups/$name`）。
- N6：不新建后端端点、不改 schema、不改 `lib/workgroup-form.ts` 纯函数契约。
- N7（可接受的取舍，范围精确）：成员**窄卡**唯一收窄的是**逐个 in/out 端口名 chips**（RFC-168 曾在宽画廊卡上铺）→ 改为一个「N 端口」计数徽标，完整端口 / 能力卡在右侧编辑区的 `AgentCapabilityCard` 呈现（信息不丢，只是从窄卡移到宽编辑区）。**卡上其余信息一律保留**：别名、引用（agentName / 用户名）、角色描述 `roleDesc`、类型 chip、leader 徽标；页面**成员计数**移到左栏固定头「成员 · N」保留。除此之外不静默删除任何可见信息（设计门 Codex#6）。

## 4. 用户故事

- US1：作为工作组 owner，我打开 `/workgroups/my-group`，看到的布局和 `/agents` 一致——左边一列卡片（顶部「⚙ 组配置」+ 下面每个成员一张卡），右边是编辑区。第一眼就在编辑组配置（模式 / 说明 / 开关 / 轮次 / 确认门）。
- US2：我点左栏某个成员卡片，右侧切成该成员的编辑器（改别名 / 角色、设为 leader、移除，看只读能力卡，点「编辑 agent 定义」跳去 `/agents/$name`）。再点「⚙ 组配置」条目回到组配置。
- US3：我点左栏底部「添加 Agent 成员」，右侧出现添加表单（和 RFC-168 同一套 `MemberFields`）；提交后新成员出现在左栏并被选中。
- US4：窄屏下左右两栏堆叠（复用 `.split` 的 ≤1080px 降级），卡片列在上、编辑区在下，不横向溢出。
- US5：我在成员编辑器改了别名还没保存，此时后台刷新 / 我点了顶部「保存」（保存的是组配置）——我的未保存别名草稿不丢（RFC-168 加固保留）。

## 5. 验收标准

- AC1：`/workgroups/$name` 渲染为 `.split` 双栏皮肤（左 `.split__list` + 右 `.split__detail`），源码不再出现 `.workgroup-studio` / `.page--studio` 布局类（源级文本断言兜底）。
- AC2：「⚙ 组配置」条目位于左栏**固定头区**（在滚动区 `.split__cards` 之外，成员再多也不随之滚走——设计门 Codex#1，真实 DOM 结构断言）；页面初次进入时它 `is-selected`，右侧显示 `WorkgroupForm`。
- AC3：点成员卡片 → 右侧切成员编辑器、该卡片高亮、配置条目取消高亮；点回配置条目 → 右侧切回组配置。testid `workgroup-context-panel` / `workgroup-card-open-<alias>` / 新增 `workgroup-config-entry` 均在。
- AC4：底部「添加 Agent 成员」/「添加人类成员」按钮（testid `workgroup-add-agent-member` / `workgroup-add-human-member`）在左栏；`dynamic_workflow` 模式隐藏「添加人类成员」（沿 RFC-167）。
- AC5：成员卡片采用 `.split-card` 卡面（窄卡 + 选中高亮 + agent/human 类型描边，`position:relative` 保 stretched hit-area），显示别名 + 引用（agentName / 用户名）+ **角色描述 roleDesc**（非空时）+ 类型 chip + leader 徽标 + 「N 端口」计数徽标（agent）；点击卡内任意处（含 subtitle / badge 区）均选中该成员。
- AC6：RFC-168 现有行为测试（三态切换 / 选择存活于 id 重生成 / config 保存不丢成员草稿 / 成员 PUT 失败保草稿 / P1 in-flight 冻结 / P2 设 leader 不冲草稿 / 焦点契约 / Esc / **成员区空白点击取消选中回配置**）在新布局下继续绿（必要处更新布局锚点如 blank-deselect 承载元素，不改行为断言意图）。
- AC5b：成员窄卡端口计数徽标走 `_one/_other` 复数（不产生 "1 ports"，设计门 Codex#10）；count=0 不渲染。
- AC7：新增测试覆盖：配置条目默认选中、配置↔成员互斥选中、split 皮肤源级锚点、成员窄卡端口计数徽标。
- AC8：门禁 `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke 绿；agents/workgroups 相关 e2e / 视觉基线按需刷新（见 design §测试策略）。
- AC9：明暗双主题 + 窄屏视觉自查通过（最小 repro / dev server 核验，遵循 feedback_frontend_visual_verify_repro）。

## 6. 决策记录（澄清问答）

- Q1「工作组编辑界面」指哪一层？→ **只改详情页皮肤**（列表页保持表格；把 `/workgroups/$name` studio 换成 split 卡片皮肤：左成员卡片、右成员/配置编辑）。
- Q2 右栏是否再套页签组织「成员 + 配置」？→ **不涉及**（用户选 Q1 后，成员已是左栏、右栏就是编辑区本身，不存在右栏再分页签）。
- Q3 「组配置」放哪？→ **左栏顶部固定「⚙ 组配置」条目**（默认选中）；右侧未选成员显示组配置、选中成员切成员编辑器（保留 RFC-168「配置=常驻默认态」语义，只换 split 皮肤；与 agents「左栏可选项 + 底部新建」最一致）。
