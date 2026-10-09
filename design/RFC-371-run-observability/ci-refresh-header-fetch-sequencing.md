# RFC-371：HTTP 错误回归的原查询完成时序

确切提交 2e671510 的原前台三平台 CI 均在 `a new report HTTP error cannot resurrect the previous snapshot` 第 768 行失败，旧 snapshot 仍显示。前次修正已让 fake interval 下的非 DOM 计数等待继续执行；新实际失败发生在随后清除 snapshot 的原断言。旧失败及其日志保留。

夹具先把第二次 POST 加入 reports 数组，再返回 building。原测试只等 reports.length 为 2 就 invalidate；若该 POST 尚未完成，TanStack Query 复用仍进行中的初次 fetch，不会发出测试刚阻塞的 header GET，因此释放 HTTP 502 没有参与被观察的请求。仅在原 invalidate 之前，使用同一 fake clock 的 vi.waitFor 等待原 QueryClient 的相关 isFetching 为 0；安装 block 后记录 requests 起点，invalidate 后等本次新增的确切 reportId header GET 已进入原夹具，再释放原 502，避免 bookmark 异步摘要使 release 先删掉尚无人读取的 block。随后仍沿原 snapshot 移除、刷新可用、4000ms 不再请求、手动刷新第三份报告的真实路径核对。

生产代码、原 502、四桶/CNY、population/EOF、所有原断言、原 5000ms 等待预算与 4000ms 观察区间保持；新加查询已结束及确切 header GET 已进入的两个前置断言。有限首轮因遗漏 GET 进入屏障实际 FAIL，原失败回执保留；修正后另行检视及验收。不改错误合同，不延长预算，不以重跑通过处理。仅 hosted CI 执行 AW 测试，本机仅精确格式检查及有限功能检视。
