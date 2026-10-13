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
