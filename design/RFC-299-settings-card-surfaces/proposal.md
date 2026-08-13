# RFC-299 设置界面统一卡片化

状态：**In Progress（2026-08-13 用户已批准完整实现并提交上库）**

## 1. 背景

`/settings` 已经把 11 个配置分区收进同一套 URL-backed 导航与草稿保存模型，但各分区的
内容层仍有三种并存形态：

- 「系统 Agent」的每个配置组都使用共享 `<Card>`，有清晰的标题、说明、边框、背景、圆角与
  字段节奏；
- 「认证」只有登录方式使用 `<Card>`，OIDC provider 列表仍是裸 header + table，编辑弹窗内
  又使用一套私有 `oidc-form__group` chrome；
- 运行时、限额、恢复、Git、网络、外观、渲染与代码平台大部分仍把字段或列表直接平铺在
  section panel 中；GC 只有备份/恢复块单独是卡片。

结果是同一设置入口内，信息层级、分组边界、留白与小屏阅读节奏不断切换。用户已明确要求：
**所有配置页面都以「系统 Agent」界面为基准卡片化，包括运行时、OIDC 等二级配置界面。**

## 2. 用户已拍板的产品规则

### D1. 覆盖全部 `/settings` 配置面

覆盖 11 个主分区及其二级配置编辑器：

1. 运行时
2. 系统 Agent
3. 限额
4. 恢复
5. Git
6. GC
7. 网络
8. 代码平台
9. 外观
10. 渲染
11. 认证
12. 运行时新增/编辑 Dialog
13. OIDC provider 新增/编辑 Dialog

确认删除、整实例恢复确认等确认弹窗不是配置分组；错误、加载、空状态也各有既有公共原语，
不为了“看起来都是卡片”而再包一层无语义卡片。`/agents`、workflow inspector、webhook 管理页
等 `/settings` 之外的资源作者面不在本 RFC 范围内。

### D2. 以「系统 Agent」卡片为唯一视觉基准

所有配置卡统一复用共享 `<Card>` 的 panel 背景、border、radius、padding、标题层级与深浅色
token。抽出共享 `<SettingsCard>`，取代 `settings.tsx` 内只供系统 Agent 使用的本地
`AgentCard`；不复制 `.system-agent-card`，也不为各页再造一套卡片 CSS。

对需要原生 `fieldset disabled` 语义的 OIDC 分组，最小扩展 `<Card>` 支持 fieldset root，
`<SettingsCard as="fieldset">` 仍使用相同 title/hint/body 结构，并以 `aria-labelledby`
提供分组名称。不能为了视觉统一丢掉批量禁用和可访问分组语义。

### D3. 按功能语义分卡

不是“每个字段一张卡”，也不是“整页只套一张无区分大卡”。卡片边界必须对应一个用户能命名的
配置主题；同一主题内保留现有字段顺序与双列网格。主分区映射如下：

| 分区       | 卡片分组                                                                      |
| ---------- | ----------------------------------------------------------------------------- |
| 运行时     | 运行时注册表（现有列表与新增动作一起进入一张卡）                              |
| 系统 Agent | 提交推送、记忆提取、变更导读、合并冲突、意图构建、技能融合，保持一 Agent 一卡 |
| 限额       | 任务与节点预算；并发与调用层级；日志                                          |
| 恢复       | 自动恢复行为；检测、熔断与周期核对                                            |
| Git        | Submodule 拉取；后台刷新                                                      |
| GC         | Worktree 清理；事件归档；Webhook 投递保留；备份与恢复                         |
| 网络       | Daemon 监听；外部 API / MCP 访问                                              |
| 代码平台   | GitLab 连接；GitHub 连接                                                      |
| 外观       | 显示偏好（主题与界面语言）                                                    |
| 渲染       | PlantUML 渲染服务                                                             |
| 认证       | 登录方式；OIDC provider 列表                                                  |

二级编辑器：

| 编辑器                  | 卡片分组                                             |
| ----------------------- | ---------------------------------------------------- |
| 运行时新增/编辑         | 身份与启动命令；执行配置                             |
| OIDC provider 新增/编辑 | Provider；手动端点；凭据；行为（沿用现有四组与顺序） |

### D4. 只改呈现，不改配置行为

- `SectionForm` 仍是 config 分区的唯一 Save、saved/error/stale/outcome-unknown/restart 反馈边界，
  Save 继续位于该分区全部卡片之后，和系统 Agent 当前行为一致；
- 运行时、代码平台与认证继续使用各自独立 REST mutation，不并入 config PUT；
- 不移动字段到别的 tab，不改字段顺序、默认值、校验、disabled 条件或 dirty slice；
- 不改权限、路由守卫、确认步骤、revision fence、token 密封或危险操作语义；
- 不新增数据库、shared wire、backend route 或配置字段。

### D5. 桌面与小屏使用同一结构

- 卡片栈在桌面与 390px 小屏都保持单列；卡内已有双列字段网格沿现有断点降为单列；
- card header 的动作在窄屏可换行，但不能把按钮推到页面 viewport 外；
- runtime rows 与 OIDC table 继续使用自身响应式/内部滚动，不把横向 overflow 转移到页面；
- Dialog 内多卡纵向排列，footer 保持公共 Dialog 的固定动作语义与触控尺寸；
- 浅色、深色都只取公共 Card token，不写固定色值。

## 3. 目标

1. 用户进入任一设置分区，都能先扫描卡片标题再定位字段，不再面对无边界的长表单。
2. 主分区、独立资源列表与二级编辑器共享同一种信息层级、间距和响应式规则。
3. 「系统 Agent」不再是唯一视觉特例，其本地 `AgentCard` 升格为设置域公共原语。
4. 卡片化完全不改变配置的读取、草稿、保存、并发防护、权限或失败语义。
5. 通过共享 primitive + 全分区覆盖锁，避免后续新增设置重新退回裸字段堆叠。

## 4. 非目标

- 不重新规划设置导航、tab 名称、tab 顺序或字段归属。
- 不把独立 REST 资源强行改成 `SectionForm`，不合并保存请求。
- 不重做输入框、Select、Switch、Dialog、TableViewport、NoticeBanner 或 EmptyState。
- 不把列表中的每一行再改成 `<Card>`；runtime row 已有自己的 bordered row 语义。
- 不卡片化 `/settings` 之外的 Agent、工作流、Webhook 等作者面。
- 不借本 RFC 修改设置值、schema bounds、配置迁移或 daemon 生效时机。

## 5. 用户故事

1. **扫读长设置页**：管理员进入「限额」时先看到预算、并发、日志三张卡，可以直接定位主题。
2. **跨页一致**：从系统 Agent 切到网络、GC 或代码平台，标题、说明、边框与字段留白不再变化。
3. **编辑运行时**：打开新增/编辑运行时 Dialog，身份/命令与执行 profile 是两张清晰卡片，底部测试、
   取消、保存仍保持原位置和行为。
4. **编辑 OIDC**：Provider、手动端点、凭据、行为四组仍能整体 disabled，视觉与主设置卡一致。
5. **移动端配置**：390px 下卡片和 header actions 不造成页面横向滚动，双列字段自然变单列。

## 6. 验收标准

- [ ] 11 个主分区在完成加载后都至少渲染一张共享 `SettingsCard`，不存在配置字段直接平铺在
      panel 根部的旧形态。
- [ ] 系统 Agent 六张卡从本地 `AgentCard` 迁到共享 `SettingsCard`，标题层级与现有视觉基准不退化。
- [ ] 运行时与 OIDC 新增/编辑 Dialog 全部分组卡片化；OIDC 四组仍保留 fieldset disabled 与可访问名称。
- [ ] runtime 注册表、Code Hosts 两 provider、Authentication provider 列表的 header action 均进入
      Card title/action 槽，不保留私有 header chrome。
- [ ] `SectionForm` 的单 Save、独立 endpoint mutation、dirty/stale/outcome-unknown/restart、revision fence、
      权限与确认行为的既有测试不变或按纯 DOM 包装更新后全绿。
- [ ] 删除 `AgentCard` 与 OIDC 私有卡片 chrome；生产设置代码不得出现第二套 border/background/radius/padding。
- [ ] 中英文为所有新增功能分组补齐标题与说明，类型完整性 1:1。
- [ ] 390×844 网络设置、桌面运行时、桌面系统 Agent、移动端 OIDC Dialog 的视觉与 overflow/a11y 验收通过。
- [ ] 前端全量、E2E 定向、visual regression 与 `bun run gate:local` 全绿；实现门 findings 全部处置。

## 7. 能力影响

这是纯前端视觉层次与 DOM 分组重构，不扩大也不收缩任何配置能力。所有现有字段、动作、权限、
API body、保存顺序、并发保护与失败结果保持不变，因此无需能力下线清单或迁移。
