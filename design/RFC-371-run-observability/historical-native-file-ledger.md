# RFC-371 原始 native 文件测试登记设计

Ubuntu c81fc950 的 W5-T19f 原逐文件相等检查发现新增 `rfc371-historical-original-report-provider.test.ts: 1` 尚未登记（原日志 job 113376683218）。

该用例所有业务 Task、Memory、Intent、MCP 与报告写入／查询由原 `describeEachProvider` 双引擎执行。唯一 `new Database(path)` 创建的是上游 OpenCode 本来的 SQLite 磁盘文件，作为真实 native 来源；其文件格式是被测输入，不是把业务持久化改为单引擎。原机械 `real-file-database` 分类已经覆盖这种来源，不新增分类、豁免或 open 待办。

仅在 `TEST_ENGINE_HARDCODING_DEBT` 原路径字典序处增加该实际调用点一行和旁注。原 AST 调用计数、全 tests 树、语料下限、所有机械分类、原严格逐行相等与分类完整切分、原 30000ms 预算以及所有其他行完全保留。已有真实文件格式的原示例保持不动。

独立设计门通过后实施，冻结全文进行独立实现门；只使用 hosted exact-SHA CI 执行原判据，不跑本地 Bun 测试。原生产源 census 已成功完整产生 13 项原投影（生产源 3238 文件）；此测试登记不更改生产源或原投影算法，只在最终配套复核中核对实际依赖及原声明。
