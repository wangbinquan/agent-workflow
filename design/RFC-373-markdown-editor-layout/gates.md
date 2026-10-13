# RFC-373 门检视与验证记录

## 功能设计门

2026-10-13，由本任务的独立 Codex 子代理 `markdown_design_gate` 按路径只读检视 proposal / design / plan 及关联的现有组件和样式。

首轮发现一个 P2：Skill 描述与正文处于同一个受限高度页签，仅给编辑器内部滚动仍可能被祖先裁切。设计已补充 `.skill-detail__edit` 外层滚动、描述不收缩和真实可见区域 E2E。复检结论 **PASS**，结合首轮其他项无 P1/P2，设计门通过。

用户已在本会话明确批准原型、正式实现及提交推送。门检视限于功能正确性、完整性、用户可见行为和功能回归。

## 功能实现门与验证

生产组件、调用接线、样式、中英文资源、纯函数/组件回归及三个真实页面 E2E 已全部写齐后进入集中检查。最终结果以本次远端提交的 GitHub Actions 为准；不以本地静态检查或原型验收代替正式功能验收。

静态检查：本次代码 ESLint 零错误、前端 TypeScript 检查通过；本次文件完成 Prettier 与 diff 检查。独立实现门首轮发现新增 E2E 错把 Agent 未修改状态等同于保存按钮禁用，已改为断言布局不发保存请求、真实保存完成后请求计数为一次并从 API 读回正文，保留原保存行为。

独立实现门复检 **PASS**：上次唯一 P2 关闭，限定的生产实现和新增测试范围内无未关闭 P1/P2。这是源码检视结论，不能代替 CI 或浏览器执行。

## 共享架构清单同步未闭合

准备提交时，`architecture/*.json` 与 RFC-294 status 已存在来自并发 RFC 的大量未提交变化（例如 current-report 的 backendProductionFiles 从 2503 增至 2516，module-symbol-owners / public-surfaces 各有数百至上千行变化）。当前后台源码还有进一步未完成的宿主绑定和观测功能，不能将这套清单当成本 RFC 的独立产物提交。

现有 `architecture:write` 从整个主工作树读取源码；直接提交其全量结果而不提交所有对应源码会导致 canonical projection 不一致。用户硬规则又禁止清除并发 WIP、另建 checkout/worktree、临时移走代码或扫入未核对的无关在制品。因此本次先发布功能所属文件，保留共享清单及其源文件现状；清单同步与相关 CI 不宣称闭合。本 RFC 新增源码也会改变 sourceDigest，不能把随后所有 canonical drift 都归为其他 session 的问题。

基线 `e35275f83dfbdfb03ae90f18e3d80ed3d7c052a1` 的 [CI 38337912383](https://github.com/wangbinquan/agent-workflow/actions/runs/38337912383) 已是 failure；本次新增失败仍须按确切差异和失败日志归因。

首个发布候选 `a5e6582a72ce8eb63aa075ab143c5ea4f7022cb0` 的 [CI 38359410052](https://github.com/wangbinquan/agent-workflow/actions/runs/38359410052) 中，Ubuntu、macOS、Windows 均已通过新增 16 个布局纯函数、13 个交互测试和原有 3 个 Prose 回归，三个平台生产构建通过。集中验证中的本任务修复如下：

- 旧 `specialized-mobile-layout` 仍锁定上下堆叠 CSS，失败属于本任务，改为只保留 Memory 的原规则；Markdown 的新容器行为由组件与浏览器用例覆盖。
- RFC-319 Agent 正文 E2E 显式切换预览后再验证渲染，不再假设任何容器中预览永远可见，保留原渲染、保存与重载断言。
- Ubuntu / Windows 的新增 Agent 编辑与手机新建 E2E 通过，Skill 短窗口用例在外层工作区滚动断言失败。Windows trace 显示滚轮落在嵌套的 Markdown 编辑器上，编辑器工具栏已被内部滚动卷走，但被断言的外层 `scrollTop` 仍为 0。修复为悬停描述输入框后再滚轮，命中外层滚动所有者；正文/预览的祖先裁切可见面积、技术信息展开与保存后 API 读回断言全部保留。原失败不能当作完整 Skill 验收通过，修复后的完整结果仍须由新提交 CI 证明。

以上修复只更新测试适配与记录，生产实现未改动。基线与本次格式门均在相同三份 RFC-371 后台文件失败，其他观测报告回归也须按原日志归属保留，不为使全仓转绿代改并发功能。

独立功能复检已检查这三处测试修复，结论 **PASS**：滚轮落点与被验证的外层滚动所有者对齐，原有可见性、编辑、保存和重载验证保留，无未关闭 P1/P2；该源码复检结论不代替修复后的 CI 运行。

## 公共控件与主题规则修复

测试修复已发布为 `4888202bbf3a3e90eb07ab655cd71509c2684f34`，对应 [CI 38362806574](https://github.com/wangbinquan/agent-workflow/actions/runs/38362806574)；该 SHA 的 [视觉回归 38362806173](https://github.com/wangbinquan/agent-workflow/actions/runs/38362806173) 为 success。三平台的 29 项新增布局/交互、旧移动布局用例与生产构建均已通过，真实页面作业另待完整执行。

进一步读取分片完整失败日志，定位两项此前未闭合的自有失败：`ux-source-ratchets` 要求 `.segmented` 只能由公共 `Segmented` 渲染，`theme-css-ratchet` 禁止将前景别名 `--accent` 用作纯背景色。修复生产组件复用 `Segmented` 的 radio、方向键与 activeOptionRef，分隔条背景改为 `--accent-fill`；保留这两项原有全局规则，不加豁免或放宽断言。

复用时启用 `allowActiveReselect`，并新增回归覆盖自动回退后用户明确点击当前编辑选项、恢复宽屏仍保持编辑、方向键跳过禁用双栏及焦点移动；原草稿、拖动、单栏恢复与 Enter 收起检查保留。公共原语仅增加可选的禁用说明关联，并补对应合同用例。新增布局/交互用例变为 30 项；这些新改动的实际通过结果仍须由后继 exact-SHA CI 证明。

并发 `f3ab372d9` 改动的澄清根 class 与 MindmapWorkspace Dialog 对应 header-compaction / overlay 清单失败，已按源码差异归因；RFC-371 观测报告失败保留原基线证据。不得将这些失败与上述本 RFC 的两项自有问题混为一谈。

上述生产修复与补充用例完成后，定向 ESLint / Prettier 通过，独立功能复检 **PASS**；未关闭 P1/P2 为零。重新检查整个本地前端类型时，报告共享工作树未提交的 `components/shell/HostExecutionBanner.tsx:53` 缺少 `ErrorBannerProps.error`，该组件不在本 RFC 差异内，原语 `ErrorBanner` 也未被本次修改。保留并发文件与错误证据，不将这次全前端类型检查宣称为通过。

## 未操作默认值与加载时序

公共控件修复已发布为 `6d60aacda608fd07ddb8823e5db330f1f8b6a3c1`，对应 [CI 38366975170](https://github.com/wangbinquan/agent-workflow/actions/runs/38366975170)。该 SHA 的 Windows 构建、30 项 Markdown 布局/交互、27 项 Segmented 合同、22 项 UI 原语规则、3 项主题规则、6 项移动布局及 3 项 Prose 检查已通过，其余结果继续按各作业实际执行记录判断。

前一 SHA `4888202bb` 的 Windows Skill 完整真实流程已通过；Agent 编辑首轮在容器回退时实际为 preview、预期 edit，重试通过。不能忽略这次波动：源码确认一条同现象触发路径——Agent 页面信息加载时可暂时传入只读，而旧实现把这一刻的默认单栏在挂载时直接保存，后续可编辑状态不会再修正默认值。

修复将有效的已存/用户偏好与未操作默认值分离：无有效已存偏好且尚未操作时，默认值跟随当前只读状态，不写入 localStorage；用户实际操作后持久化，之后仍尊重明确选择。新增只读转可编辑的默认跟随及显式选择保留回归，损坏偏好仍整体回退。Agent E2E 在拖动前先确认正文可编辑并聚焦源码，明确“最近使用编辑区”这一回退前置条件，保留原几何、保存与刷新断言。新增布局/交互共 31 项，后继候选执行结果尚须 exact-SHA CI 证明。

该修复完成生产与用例编写后，定向 ESLint / Prettier 通过，独立只读功能复检 **PASS**，默认跟随、明确选择保留、原焦点与比例行为无未关闭 P1/P2。保留先前失败和重试通过的证据，源码检视不代替执行结果。

## Skill 保存完成后的读回顺序

默认视图修复已发布为 `2a39095f4c67a6393f0049829bddd1ce4500623e`，对应 [CI 38370654564](https://github.com/wangbinquan/agent-workflow/actions/runs/38370654564)。三平台生产构建通过；Windows 的 31 项布局/交互、27 项公共 Segmented、原语/主题/移动布局规则及 Prose 检查通过，Agent 编辑和手机新建真实流程均首轮通过。其余平台按最终作业记录验收。

Windows Skill 首轮在保存后的独立 GET `/api/skills/:id/content` 返回 404，重试通过；原布局、滚动、编辑与预览断言在此之前均已完成。这属于新增用例未等待保存完成的时序问题：`skills.detail.tsx` 的元数据保存等待 POST `/api/skills/:id/save` 回执，后台 `commitSkillVersion` 在提交新版本后、完成文件发布前存在临时不可读阶段，发布完成才恢复正常读取。原用例点击按钮后立刻发出独立 GET，可能落入这一阶段。

修复先监听这一 Skill 的实际 POST 保存响应，再点击按钮，断言响应成功且回执正文等于原完整草稿，然后执行原独立 GET、禁用状态、恢复宽屏及刷新读回断言。不捕获或忽略 404、不增加超时或重试、不改保存实现；此前首轮失败继续保留，后继 exact-SHA CI 单独验收。

这一有限修复的 ESLint / Prettier 与 diff 检查通过，独立只读功能复检 **PASS**：请求方法与 Skill 路径精确关联，响应及独立读回双重验证、原全部布局断言保持，无未关闭 P1/P2。
