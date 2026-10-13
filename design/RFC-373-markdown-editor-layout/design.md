# RFC-373 技术设计

## 落位与已有能力

本次属于前端资源创作的共享表现层；Agent 与 Skill 消费相同 `MarkdownEditor`。依据 RFC-294 的统一机制原则，把布局放在该共享组件与前端纯函数中，业务数据仍由原页面持有，不增加后台、数据库、路由、跨域依赖或临时 facade。

保留 `TextArea`、`Prose` 与 `useDeferredValue`；模式工具栏复用公共 `Segmented` 的 radio 语义、方向键导航和 activeOptionRef，均分按钮复用 `.btn .btn--sm`。启用 `allowActiveReselect`，确保在自动回退到编辑时再次明确选择编辑，仍会将其保存为用户的显式单栏偏好；可选的 `ariaDescribedBy` 关联禁用原因。现有 `useResizable` 面向 review 右侧栏固定像素宽度和 window 监听，不足以表达容器比例与单栏回退，本次不修改其消费者。新布局能力在共享 MarkdownEditor 内完成，数学/偏好解析落入 `lib/markdown-editor-layout.ts`。

## 布局状态

持久偏好 `{ version: 1, mode: 'edit' | 'split' | 'preview', ratio: number, singlePane: 'edit' | 'preview' }`，使用独立 key `aw.markdown-editor.layout.v1`。ratio 为用户期望的编辑侧比例，合法有限值限制在 0..1；损坏结构整体回退。默认 mode=split、ratio=0.5；singlePane 按初次只读状态选择。

组件独立维护容器宽度。首次 layout effect 测量 `.md-editor__panes` 的实际宽度，再通过 ResizeObserver 跟踪；无 ResizeObserver 时监听窗口 resize。宽度为 0 的隐藏页签不重置已知布局。最初尚未测量时渲染可收缩的等分列，不把 0 当成必须切换模式。

分隔条宽度固定 12px，触控有效命中区通过伪元素延伸；总宽不足 `2 × 320 + 12 = 652px` 时进入单栏。双栏实际比例夹取到 `320/(width-12)..1-320/(width-12)`，只改变显示值，不改持久期望。源文与预览 pane 始终挂载，使用 `hidden`；样式显式尊重 `[hidden]`。

模式选择更新持久偏好。自动窄屏回退不改 mode。编辑 focus / 预览交互记录最近面板，恢复空间时只在 mode 仍为 split 时恢复。只读 prop 在后续变化时仍严格下传给 TextArea，不改变持有的正文。

## 拖动与焦点

分隔条使用可聚焦的 separator，带 `aria-orientation=vertical`、编辑区 aria-controls、min/max/now/valuetext。Pointer Events + pointer capture 跟踪同一个 pointer；按容器坐标计算比例。pointerup / pointercancel / lostpointercapture / 切换模式或窄屏隐藏 / unmount 都结束拖动，不在 body 留 cursor 或全局 move 监听。

左右方向键每次移动 2 个百分点，Home/End 到当前可用边界；Enter 转到仅预览并把焦点移到预览模式按钮。双击与「均分」设置期望比例 0.5。隐藏包含焦点的面板时，把焦点放到仍显示的模式入口；textarea 本身不卸载、不改 value，保留选区和 scrollTop。

## 尺寸与滚动

- 根、列、pane、textarea、预览均 `min-width:0`，列使用 `minmax(0,...)`；工具栏换行，控件不挤成细条。
- `.md-editor--fill` 改为工具栏 + 内容区的 flex 布局；内容区至少 16rem，短窗口由编辑器滚动而不是压扁 textarea。
- Skill 的 `.skill-detail__edit` 自身承担整个页签内容的纵向滚动（`min-height:0; overflow:auto`），描述字段不收缩，正文保留最小高度；因此描述、正文和技术信息都能滚入可视区，不会被祖先 `.agent-form__panel--prompt` 的 overflow:hidden 永久裁掉。`.skill-detail__body` 同时补 min-width:0。这项是设计门 P2 的修正。
- Prose 保持现有渲染能力；预览滚动壳固定且不随空/非空分支更换，宽表格和代码留在壳内部。
- 删除 720px 下对 md-editor 强制上下双行的旧规则；保留同块中的 memory-compare 规则及其他消费者。
- 不改页面头部、既有路由列表/详情切换或保存机制。

## 测试策略

先写齐生产实现与全部测试，再集中验证。纯函数覆盖比例边界、临界宽度、非有限/损坏偏好；组件测试覆盖三态、ResizeObserver、只读、草稿/DOM身份/选区/滚动保持、键盘、Pointer Events 及清理、storage 异常。保留 Prose 原 GFM 回归。

新增真实浏览器 E2E，使用项目现有 API fixture 新建 Agent 与 Skill，分别从真实页面操作，覆盖均分、真实鼠标拖动与 clamp、改容器/视口、320/390px、小高度、恢复宽屏比例、保存后重读正文、刷新偏好、长代码和宽表格的布局断言。以 GitHub Actions 的 exact-SHA 三平台结果作为正式质量证据，本机不启动产品服务或重复全量 gate。

Skill 短窗口用例应先滚动整个工作区，再检查 textarea、预览和技术信息确实能进入祖先裁切后的可视区域并完成编辑/预览切换；只断言元素自身高度不算通过。

门检视仅检查功能正确性、完整性、用户可见行为与功能回归。安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响结论。
