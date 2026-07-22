# RFC-219 工作流节点选择器分类导航与类型显性化 — proposal

状态：In Progress（2026-07-22 用户批准；功能与本地定向验收完成，仓库总门和 Linux 权威视觉基线待收尾）。

## 1. 背景与现状证据

工作流编辑器的节点目录已经具备搜索、推荐、最近使用、点击/键盘添加和拖拽添加，但 Agent 数量
变多后，目录的浏览路径会明显退化：

1. `packages/frontend/src/components/canvas/nodePalette.ts` 的 `buildPalette()` 本来会返回
   `Agents / Wrappers / I/O / Human` 四个 section；
2. `WorkflowNodePicker.tsx` 的 `buildEntries()` 随后用 `flatMap()` 丢掉 section 身份；
3. 空搜索状态下的“全部步骤”直接渲染这条扁平数组，而 section 顺序固定为 Agent 在前；
4. 因此 Agent 越多，Wrapper、输入输出和人工节点离可视区域越远。混合的“推荐/最近使用/全部”
   行只有 glyph，没有稳定的文字类型标签，用户还需要逐项辨认；
5. 同一 `WorkflowNodePickerCatalog` 同时服务于 `>=1536px` 的常驻左栏、较窄桌面的侧边 Dialog
   和手机全屏 Dialog，所以问题不是单一断点的样式缺陷。

画布节点已经通过业务类型标题、容器形态和色彩区分 Agent、Wrapper、I/O、Human。本 RFC 不重做
画布，而是修复“添加节点”目录把既有分类拍平的问题。

## 2. 目标

1. 无论有多少 Agent，用户都能直接进入 Agent、Wrapper、I/O、Human 任一分类，不需要先滚过
   其他分类。
2. “全部”“推荐”“最近使用”和搜索结果中的每一行都显式显示所属类型，且不只依赖颜色。
3. 保留名称/类型/能力搜索、最近使用、推荐、键盘选择和拖拽添加，不降低 RFC-199 已交付能力。
4. 分类入口在 240px 常驻栏、420px 侧边 Dialog 和 390px 手机全屏 Dialog 中都可达、可读、
   可键盘操作。
5. 新节点 kind 继续由 `PALETTE_DESCRIPTORS` / `PaletteSectionKey` 单一事实源约束，不在组件里
   再维护一份易漂移的 kind 清单。

## 3. 非目标

- 不修改 workflow definition、NodeKind、运行时、校验器、保存/冲突协议或后端 API。
- 不改变画布节点卡、wrapper 容器、端口或连线的视觉/交互语义。
- 不增加 Agent 收藏、标签管理、服务端最近使用或跨设备偏好同步。
- 不引入列表虚拟化；本轮解决的是查找路径与信息层级，不是万级资源渲染。
- 不删除“推荐”“最近使用”，也不改变 localStorage key 与最近项身份格式。

## 4. 产品方案

### 4.1 固定分类入口

搜索框下增加共享 `TabBar variant="segment"`：

- 全部；
- Agent；
- Wrapper；
- 输入输出；
- 人工节点。

每项显示稳定的目录总数，例如 `Agent 42`、`Wrapper 3`。默认选中“全部”。分类切换是过滤式
快速到达：点击 Wrapper 后，列表只呈现 Wrapper，不需要滚过 42 个 Agent。目录总数不随搜索词
跳动；当前搜索结果数继续由 live region 播报。

### 4.2 分组与搜索规则

- **全部 + 空搜索**：先显示“推荐”“最近使用”（非空时），再按
  `Agents → Wrappers → I/O → Human` 显示四个 canonical section；不再显示一个扁平的“全部步骤”
  长列表。
- **具体分类 + 空搜索**：只显示该分类的 canonical section。
- **全部 + 有搜索词**：按四个 canonical section 分组显示匹配项，空 section 不渲染。
- **具体分类 + 有搜索词**：搜索与分类取交集；切换分类保留搜索词，便于比较同一关键词在不同
  类型下的结果。
- 搜索字段、匹配字段与大小写规则保持现状；没有匹配时继续使用统一空状态。

### 4.3 行内类型标识

每个节点行在名称旁显示一个紧凑文字 chip：`Agent / Wrapper / I/O / Human`，并带
`data-category`。行左边框与 chip 可使用与画布同族的轻量色调（Agent=accent、Wrapper=紫、
I/O=青、Human=琥珀），但文字 chip 与 section heading 是非颜色等价信息。

原 glyph、名称、描述、disabled reason 与拖拽 grip 保持；长 Agent 名/描述仍按既有截断策略，不让
类型 chip 把 240px 左栏撑宽。

### 4.4 键盘与响应式

- 分类栏复用 `TabBar` 的 roving tabindex、ArrowLeft/ArrowRight/Home/End 和 overflow affordance；
- 分类与唯一可见的 tabpanel 建立 ARIA 关联，不在隐藏 panel 中复制大量节点按钮；
- 搜索框的 ArrowDown/ArrowUp、列表行的 ArrowUp/ArrowDown/Home/End/Enter/Space/Escape 行为保持；
- 分类切换不抢走当前焦点；从搜索框进入结果时只进入当前分类/搜索结果；
- 窄栏分类条允许内部横向滚动并显示现有左右滚动 affordance，页面本身不得产生横向溢出。

## 5. 验收标准

- **AC-1**：50 个 Agent 的目录中，Wrapper/人工分类最多一次点击即可见，不需要滚过 Agent 列表。
- **AC-2**：默认“全部”保留推荐/最近使用，并把 canonical 列表拆回四个有标题的 section。
- **AC-3**：五个分类入口显示稳定总数；分类与搜索可组合，切换分类时搜索词不丢失。
- **AC-4**：推荐、最近使用、全部和搜索结果的每一行都有可见文字类型 chip；颜色关闭或无法区分
  时仍能判断类型。
- **AC-5**：选择、disabled reason、最近项写入、点击添加、键盘添加和拖拽 payload 字节语义不变。
- **AC-6**：无 Agent 时 Agent 分类显示 `0` 且可打开统一空状态，其余四类资源仍可用。
- **AC-7**：Tab/方向键/Enter/Escape 与 tab/tabpanel 名称、关联、焦点顺序通过组件测试与 axe。
- **AC-8**：1536px 常驻栏、1179px 侧边 Dialog、390px 全屏 Dialog 均无页面横向溢出；240px
  左栏中的名称、chip、drag grip 不互相遮挡。
- **AC-9**：中英文分类名、类型 chip、可访问名称与结果播报齐全，无裸英文回退。
- **AC-10**：前端定向测试、完整 frontend vitest、typecheck、format:check 与相关 Playwright/视觉
  基线全绿。

## 6. 兼容与发布

这是纯前端、即时生效的目录呈现调整：无 migration、无 wire/schema 变化、无新依赖。已有
`NODE_PICKER_RECENT_STORAGE_KEY` 和身份字符串保持不变，存量最近使用记录继续生效。回退只需撤销
前端提交，不影响已保存 workflow。
