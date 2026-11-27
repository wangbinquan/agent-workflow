# RFC-624 实施与验收

状态：Done，2026-11-26。用户授权的第一批已实现、发布并完成精确源码完整CI和实际耗时比较；结果及限制见[实测验收](acceptance.md)。

- [x] T1：审计重复输入、断言、完整历史计时及不可合并边界，固定批准范围。
- [x] T2：独立功能设计门通过；全部夹具、静态扫描/报告、E2E、前端实现和回归写齐后集中验证。
- [x] T3：义务映射、集中验证及独立功能实现门通过；集中阶段发现的问题已修复并复验。
- [x] T4：共享main按精确路径发布；最终代码240ee338的完整CI首次69/69通过，collector来源和完整性核对通过。
- [x] T5：同口径比较基线、第一候选及修正候选，记录收益、变慢项和归因限制。

## 保留义务与验证

| 调整 | 保留的质量义务 | 新增/集中验证 |
| --- | --- | --- |
| 15份重复静态扫描 | 原四目录、工作树及未跟踪文件、同解析器、每RFC独立零违规断言、>=6000下限；原107个独有test调用保持 | 共享parser由实际scanner和原负夹具共同使用；15规则清单、空语料拒绝、扩展名/排除规则、误报对照；RFC583独有枚举保持 |
| 报告构建3→2 | module-owner人口、backend/module计数、source SHA；同固定SHA两次独立读取和构建，再比完整结果 | committed reader原revision/额外输入/缺失路径/无效revision回归继续 |
| Q3热模板 | 仅11个固定head文件opt-in；默认reset可立即访问空库；每例独立物理库，模板不被修改；每次install完整校验 | 原7项加11项真实SQLite/PostgreSQL生命周期回归，共18项；再加5项resolver行为，共23项，覆盖冷/热、错误key、二次安装、行/DDL隔离、取消与清理、失败重试、独立实例和每次install重新校验 |
| 独立E2E重试与canvas准备 | 3+3+7场景、文件内顺序、全局workers/retry/预算、原清理；真实三平台浏览器几何/遮挡/点击 | 真实Playwright runner以default/serial对照重试记录；原生发现13+1case；canvas本机Chromium通过 |
| 纯源码前端测试 | 原4文件正文、原897文件发现全集、30秒预算、isolate与DOM setup | 原生发现4 Node+893 DOM互斥完整；专项7文件41case |
| 真实ValidationPanel | warning分组、code/raw message、Auto-fit显隐/legacy callback、路由clearWrapperSize接线；fresh组件/definition/回调 | 原7case增至10case，新增strict target优先、失效不回退pointer、缺callback隐藏 |

第一候选本机41文件410case：409 pass，唯一失败为职责迁移后T14账本未同步；原算法保持、元数据如实修正，RFC583与三份账本/语料/负夹具门禁4文件65case复验通过。集中检查发现的RFC583独有walk遗漏和Panel role查询无效exact选项也已修复；原walk、断言和字符串name精确匹配保持。

前端专项7文件41case通过，修补后的两文件10case及相关类型/lint/format通过。原生Vitest resolved/worker配置核对完整；Playwright调度回归与真实Chromium canvas通过。浏览器初次因本机沙箱MachPort限制未启动，执行同一用例后通过，未将启动限制算成产品失败或计时收益。相关actionlint与账本检查通过。

第一候选发布后，依据完整实测发现initial key每case额外核验冻结夹具。修正为每describe/file实例内惰性求取固定key一次，失败可重试，原每次install核验继续。修正全部写齐后集中复验7文件103case全部通过（seed62402、737次expect、SQLite与真实PostgreSQL17.12）；类型/lint/format通过。原18数据库回归正文保持，新增5个resolver行为回归。两轮独立功能实现门及修补复核均PASS、无P1/P2。

没有启动重复完整本地gate；未变的前端/浏览器候选复用有效结果，新增修正以定向验证及最终完整hosted CI验证。本人测试容器已停止删除。

## 发布与完整CI

- 基线79085123 / CI45925598806：首次69/69 success。
- 第一候选9cbf497ac / CI45933650528：首次69/69 success；视觉回归45933650513通过。
- 修正候选240ee338 / CI45939395356：首次69/69 success；CI feedback45939395275通过；计时collector45942711721通过且source精确对应修正候选。
- 工作流、44后端片、前端两OS各3片、E2E 3/3/4、13组required输出及原预算/重试/coverage/provider/平台保持。最终无失败job、无workflow/job重跑；一条Windows E2E使用原有一次retry后通过，E2E权重刷新按原标准拒绝。测试级覆盖、重试归因与耗时详见acceptance及metrics。

第一候选辅助feedback因后继同ref文档push被concurrency取消，未将其未完成的步骤计为通过；最终修正候选feedback已经独立完成。根代理负责唯一Git发布与CI监控；内部子代理只处理分工及独立功能复核，未联系其他独立session。并发RFC616文档收口9be36b1f完整保留；它不改变本次测试候选代码。

本次收口仅更新RFC验收资料与状态，不修改已验证代码。完整CI结论绑定240ee338，后继纯文档提交不得冒用为自己已经完整CI通过。
