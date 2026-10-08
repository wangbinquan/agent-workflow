# 完整来源查询的功能 CI 对齐

## 原始失败

提交 `79b63f483990136a1e6e131da4966c3704be2803` 的正式 GitHub CI（run `37746020731`）发现以下功能失败。独立会话已在 `00c757fc6b0e9c5281741ccf901012d924736b52` 仅修复三处测试类型错误并退役已消费的临时增长许可；本文件处理其余观测范围问题。

1. `rfc371-retained-output-revision.test.ts:319`（双 provider）：warm 读取仍执行 Task 的原始可见集合检查，但旧断言只识别此前 `count(*) JOIN tasks` 的 SQL，未识别现在原 Task owner 的 `visibleIds` 查询，因此误报 0 而非 2。
2. `e2e/rfc371-run-observability.spec.ts:537`（Windows/Ubuntu）：原始托管 trace 显示自动记忆提取进入同一天的趋势桶后，真实按钮从 `1 tasks` 变为 `2 tasks`，旧定位把数量写死为 1，因此 focus 超时。缺口文案仍为 `Usage records are incomplete for this scope`，原查询和缺口状态未消失。此前按文案漂移推断原因不成立，现以托管 trace 中前后两个真实快照纠正。
3. N1b 精确 facade 清单：`services/runtime/usage.ts` 已成为无实现的真实再导出 facade，原逐字名单缺少该文件。
4. W5 `rfc371-system-native-provider.test.ts` 原生文件 fixture 实际有两个 `new Database` 调用点（父 fixture 创建原生文件与实际子进程打开同一原生文件），旧登记误记为 1。AW 应用执行与账本仍由原 `describeEachProvider` 验证两个真实数据库。
5. 观测端口对 Task 公共查询类型的反向模块导入不符合既有 offered DAG；移至原生 Worker 的真实公共查询消费，保持观测内部结构端口，见 `system-agent-display-names.md`。

## 设计与实施计划

- 保留每一个已有测试用例、用量判据、预算及真实双 provider；不增加超时、跳过、模糊匹配或改为模拟执行。
- warm 断言识别原 owner 的两次 `SELECT tasks.id ... WHERE tasks.id IN (...)` 查询，并保留完整物理检查不重复、actor/原集合每次检查和原回执读取断言。
- 趋势定位使用从原 `trendRows` 选定的非 ready 桶 key；从同一真实按钮断言状态文案和四类未观测 Token，然后保留真实 focus、Enter、范围切换、任务点击、间距与键盘遍历。
- 精确 facade 名单只增加已实际转为 facade 的 `services/runtime/usage.ts`；原生成算法与断言不变。
- W5 保留全部旧条目，唯一误登记改为原实测两调用点，机械理由明确其仅为外部 OpenCode 的原生 SQLite 文件。原历史统计不回写；现行总量据原 census 实测与最小临时许可登记，禁止压低实际点数或删掉原生执行 fixture。
- 模块类型边按实际生产消费修复，不扩大 DAG、增加债务列表或放宽守卫。
- 生产源内容落定后仅运行一次必要的原 census/归属生成，校对全部原条目/why/SCC 与来源摘要；所有 guard 实现与原生成规则保持不变。
- 按路径独立功能设计门、实现门；本机仅 scoped ESLint/Prettier 与原纯元数据生成，测试/类型/构建/E2E 由发布后的正式 exact-SHA CI 执行。
