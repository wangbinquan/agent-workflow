# RFC-370：原生消息字段测试的分页类型与夹具基线修复

`ab5c6ab7a834f86b2ec4ee282de21074a0a91c06` 的完整 Windows 作业 `37936458471` 在 Typecheck 失败：新测试 `rfc371-native-message-field-reuse.test.ts:169` 的循环分页变量 `page` 触发 TS7022，两个原 `reduce` 的四个参数随后触发 TS7006。该作业的原平台用例和 shared 用例通过；同 SHA Visual Regression 成功。这些有限结果不代表主／Windows 总 CI 全绿。

本批仅在原 `consume` 循环为 `page` 增加 `ReturnType<Reader['next']>`，复用紧邻原 `last` 变量已有的返回类型。`Reader` 仍是原 baseline/final 与 historical reader 的联合；两个公开 reader 合同保留各自 identity 与同一原 sessions/steps 分页字段。不添加类型断言、`any`、新的运行调用或 provider 实现。

同 SHA 的 Ubuntu 6/32 与 macOS 2/12 作业还报告 `rfc359-w5-test-engine-hardcoding: 源码 337 vs 基线 335`。此前两个已提交的原生 SQLite 文件／FILE TEMP 夹具各登记一条实际构造，配套遗漏该基线。本批依据这两个实际失败日志与已发布的 337 项声明，将该行精确同步到 337，并显式记录 RFC-371 本次增长；随后在无增长后继提交退役该许可，符合原 T17 的父提交比较规则。130 行的原 id／file／symbol／why／顺序与其余内容完整保留，使用原 pretty canonical 算法更新内容摘要，来源 census 与祖先快照沿用原证据。连接复用候选的第三项 338 由其 owner 下一批处理。

原 reader、cursor、ACK、字节计算、原 SQL 标量与完整指纹 oracle、1211／2402 原人口、全部四个用例和原预算保持。仅用纯源码／AST 和类型擦除后的完整 JavaScript 对比确认运行体一致，另做目标格式与 lint 检查；不在本机执行 AW 测试、构建、服务或 typecheck，也不重跑未变化的 production census。主／Windows 总 CI 及新 SHA 实际用例仍须由 GitHub 验收。

本批属于恢复 CI 的测试类型与配套基线修复。H7 全部 19 owner、三个实际启动根、Task 生命周期与其它待接切面、A-T7／A-G、CS 独立 adapters 及 M0～M4 部署验收仍未完成；AW 尚未部署到 CS，RFC 保持 In Progress。
