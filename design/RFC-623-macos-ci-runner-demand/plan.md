# RFC-623 实施与验收

状态：In Progress，2026-11-26。用户已授权择优实施，无新增付费资源或账户设置变更。

- [x] T1：复核7轮真实队列、官方方案、原失败annotation及容量边界。
- [x] T2：选择三片与完整reporter权重，完成离线容量与1.5倍敏感性分析；落档设计。
- [x] T3：完整实现矩阵、权重、source topology兼容及所有回归。
- [x] T4：集中相关验证、静态检查与独立功能复核。
- [ ] T5：精确路径发布，跟踪exact-SHA hosted CI与collector；核验完整覆盖及实际耗时。

本轮不修改生产代码、测试case timeout、平台/provider/coverage或13组required标准。69物理job和10E2E产物是完整新拓扑，不是减少测试集合。

后续记录保留真实失败、重试与队列事实，区分离线选型模型、局部通过和完整hosted验收。不反复刷新权重制造验证循环。

## 集中验证与发布前复核

设计门与完整候选的独立功能实现门均PASS，未发现P1/P2。所有实现与回归写齐后集中运行：9文件124项测试通过、0失败、2600断言（isolate/randomize、seed62326、coverage）。相关TypeScript依赖闭包检查、ESLint、Prettier、全workflow actionlint均通过；本RFC链接离线检查0错误。没有运行共享工作树的重复全量gate；整仓判据仍以托管CI为准。

真实旧来源6c92/run45846353277的11份完整artifact通过新CLI，产出与本轮安装的权重逐字节一致（SHA256 c004230b1ed4e0c381250668d7fea943b27237ce3ea4cc60f19b34011f0a8b4a）。来源仍3/4/4，仅mac3来自attempt2，全部文件无Playwright retry。当前实际planner重分同一原生输入后，Linux3=532 tests/121 specs，macOS3=532/121，Windows4=526/120；完整test对象、身份与discovery digest不变，运行期selection检查通过。macOS新分配147/199/186 tests，原预期skip与retry语义保持。

候选保持原20分钟E2E、4workers、CI retries1、全部13组required输出。新主CI应完整69job/10个E2E产物；发布后的领取等待、实际执行、整轮等待与总墙钟尚待取证，离线模型不计作托管收益。

## 首轮托管：保留非绿结果

1b9825b9/run45912970988共69jobs：67success、backend10 cancelled、CI required failure；官方原因为执行超过15m0s，非未领取runner。该片931pass/0fail，仍在推进时被截止。13组输出完整，test-backend=cancelled，其余12组success，门禁按原标准拒绝。总墙钟53m23s不能记作完整成功提速。全部10E2E及feedback/windows-platform/visual辅助工作流成功；macOS3最慢实际job17m30s、余150s，含3项flaky。失败来源仅43份backend产物，collector按规则skip，未刷新权重。

- [x] T5a：首轮exact-SHA完整跟踪与失败归因；代码/测试同blob、整片约19%变慢，未发现本轮业务缺陷。
- [x] T5b：严格复核6c92与d838两个完整green来源，逐文件取真实较大值重平衡，保持44片/15分钟，独立复核数据来源与边界。
- [ ] T5c：发布数据修正，完整hosted与实际新拓扑collector验收；首轮失败保留。

单源d838候选在交叉成本中出现949.332s片，独立复核暂缓实施；其数据本身完整但不能签稳定余量。采用两个完整green逐文件max的最终设计；新增严格数据准备器与回归，完成后集中验证，不将离线模型或首轮E2E通过代签整个CI。

## 后端排程修正集中验证

完整88份原始artifact经CLI重放，两个来源分别覆盖3102/3108文件；当前3108文件全部有真实测量、无unmeasured/removed。逐文件核对最大值及来源一致：1711项取6c92、1397项取d838，合成排程估值27227560ms。输出原样安装，未采用失败run或未提交测试。

相关9文件136项测试通过、0失败、2721断言（isolate/randomize、seed62326、coverage）；相关TypeScript依赖闭包、ESLint、Prettier、全workflow actionlint均通过。没有运行重复全量本地gate；数据来源交叉复核、原单源CLI兼容性及独立功能实现门另记，hosted仍待验收。

独立功能实现门PASS，无P1/P2；两数据文件与CLI输出逐字节一致，88原始来源逐值复算及44原生分片边界审计通过。原单源CLI对d838真实44份输入的回放exit0，两输出均与旧review artifact逐字节一致。后端44片/15分钟、三平台、coverage/provider与13门禁均未修改。
