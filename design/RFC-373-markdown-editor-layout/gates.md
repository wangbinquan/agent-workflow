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
