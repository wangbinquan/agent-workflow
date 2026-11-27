# RFC-624 实施与验收

状态：In Progress，2026-11-26。用户已授权完整第一批实施与CI验收。

- [x] T1：源码、完整历史计时、重复输入/断言及不可合并边界审计；固定批准范围。
- [x] T2：独立功能设计门；完成全部夹具、扫描/报告、E2E、前端实现和回归。
- [ ] T3：完整候选集中验证、义务映射及独立功能实现门。
- [ ] T4：共享main精确路径发布，完整exact-SHA CI和collector验收。
- [ ] T5：基线/候选实际耗时同口径比较、记录限制并完成交接。

根代理负责RFC、E2E、调度/配置回归、集中验证和唯一发布；内部子代理分别负责fixture、静态守卫和frontend，不与其他独立session联系或并发操作Git。现有RFC616 plan在制修改保持。

基线HEAD79085123，主CI45925598806尚未完成；历史参考097d41d6/run45921188560完整69/69 success。所有实现/回归写齐后进入集中验证。没有因本任务启动重复全量本地gate。

独立功能设计门PASS，无P1/P2；显式Node四文件名单及CI1/本地0重试口径已补齐。全部实现与回归已完成；独立功能实现门A/B均PASS、无P1/P2。集中检查发现RFC583独有walk遗漏，已保留原函数/断言修复，账本按实际职责更新，集中复验中。

集中验证已确认前端专项7文件41case通过；原生Vitest发现全集897=Node4+DOM893，互斥完整，原四文件正文未变，test/hook 30s、isolate、retry、setup/alias保持。真实PostgreSQL17与SQLite相关后端验证、浏览器和静态检查继续执行，未将临时检查配置报错或沙箱启动失败冒充产品回归。

## 保留义务与新增回归

| 调整 | 保留的质量义务 | 新增/集中验证 |
| --- | --- | --- |
| 15份重复静态扫描 | 同四目录、工作树及未跟踪文件、同解析器、每RFC独立零违规断言、>=6000下限；原107个独有test调用保持 | 共享parser由实际scanner和原负夹具共同使用；15规则清单、空语料拒绝、扩展名/排除规则、误报对照；RFC583独有枚举保持 |
| 报告构建3→2 | module-owner人口、backend/module计数、source SHA；同固定SHA两次独立读取和构建再比完整结果 | committed reader原revision/额外输入/缺失路径/无效revision回归继续 |
| Q3热模板 | 仅11个固定head文件opt-in；默认reset可立即访问空库；每例独立物理库、模板不被修改 | 18个真实双provider生命周期case覆盖冷/热、错误key、二次安装、行/DDL隔离、晚到clone取消、真实SQL错误和锁释放 |
| 独立E2E重试与canvas准备 | 3+3+7场景、文件内顺序、全局workers/retry/预算、原清理；真实浏览器几何/遮挡/点击 | 真实Playwright runner用default/serial对照重试记录；原生发现13+1case；canvas本机Chromium通过 |
| 纯源码前端测试 | 原4文件正文、原897文件发现全集、30秒预算、isolate与DOM setup | 原生发现验证4 Node+893 DOM互斥完整；专项7文件41case |
| 真实ValidationPanel | warning分组、code/raw message、Auto-fit显隐/legacy callback、路由clearWrapperSize接线；fresh组件/definition/回调 | 原7case增至10case；strict target优先、失效不回退pointer、缺callback隐藏 |

集中阶段发现的本次问题已修复：RFC583原独有walk接线遗漏、T14迁移后13条assertsAbsence账本未同步，以及Panel测试role查询的无效exact选项（字符串name仍精确匹配）。T14按原检测算法如实登记集中后的职责，全部原断言及负夹具保持，不改检测算法、例外或高水位。后端/E2E定向类型检查通过；前端两文件10case、前端类型检查及修复路径lint复验通过。浏览器首次因本机沙箱MachPort拒绝而无法启动，授权执行同一用例后1/1通过（case 440ms，runner 2.0s）。这些本机计时不作为跨主机优化收益。

发布阶段不取消或重启已运行的41文件本机诊断：18项双provider生命周期、前端专项、原生发现/配置、Playwright重试语义和真实浏览器已通过；账本及RFC583修复单独复验后发布完整候选，让权威GitHub CI与剩余本机数据库场景并行。完整本机/hosted结果尚未闭合前保持In Progress，不将进行中视为通过。

发布前修复复验：RFC583、architecture-ledgers、corpus-floor、negative-fixture共4文件65case通过（seed624，189次expect，2.96s）；修复后的类型/lint/format均通过。43路径候选固化；RFC616 plan在制内容不包含在提交中。
