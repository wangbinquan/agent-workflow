# RFC-625 实施计划

状态：In Progress，2026-11-26。用户已授权本批实现、完整CI及实际耗时比较。

- [x] T1：上一批与当前CI取证、Windows上游语义、Q3/V2准备成本及44片三源模型研究。
- [x] T2：完整设计与独立功能设计门，冻结实施边界。
- [x] T3：Windows进程身份/锁及所有消费者兼容，诊断与回归写齐。
- [x] T4：复用job-local不可变manifest，保留全部原case/隔离，缓存与真实provider回归写齐。
- [x] T5：严格三源max权重及来源记录，确认新测试人口和默认权重。
- [x] T6：全部实现完成后集中类型/lint/format、相关回归、真实provider、独立功能实现门。
- [ ] T7：共享main精确路径发布，完整主CI和Windows平台CI；失败按责任归因，不重跑追绿。
- [ ] T8：同口径实际耗时/覆盖/重试对比，记录负结果与限制，收口发布并验证远端同步。

根代理管理RFC、基线、唯一Git发布与CI监控；内部代理分工Windows、manifest与权重/独立审查。禁止跨独立session消息和并发Git发布；共享main原树，保留并发产出。

本地main530e3bc52与origin同步且启动时干净。上一批主代码240首次69/69 success；530仅改文档，其CI45943689640为62success/4failure/1skipped（macOS构建上传失败导致macOSE2E未展开三片），不进入全量性能比较。日志保存在/private/tmp/aw-rfc625-20261126/baseline/hosted/45943689640；RFC363与system-mocks失败均保留证据，未代改。

独立功能设计门A/B通过，无剩余P1/P2。已修正adopt合同：watch与自动升级均保留，每次新token隔离旧lease；缓存整个prepare共用90秒截止，覆盖admission/key/hash与晚到发布。最终设计hash e8ba9b614131be8f50f27049be094c45a7039130c41d59d146f212193302ac35。全部实现及回归已写齐，三份独立功能实现审查通过，现集中验证。静态检查的两处lint已保持语义修正；本机默认4GB后端typecheck内存不足，其他workspace通过，后端以8GB单独继续。

集中首批验证：后端28文件272case为271pass/1fail（真实PG同连接第二次manifest仍miss），锁/CLI相关20文件164case为159pass/4个Windows原生skip/1fail（Windows push/PR路径清单不一致）；前端harness13pass。原11Q3与14V2、lock/watch/自动升级/CLI/restore用例均通过。两批候选内容摘要均未变化。

已定位并修正本轮两项问题：专用PG17.12新会话实证首次PL/pgSQL DO新增5项pg_settings，key采样前同连接执行no-op DO加载必要模块，继续纳入全部配置值；Windows PR paths同步原push新增5项，原严格一致性断言保持。现集中定向复验6文件，原全批结果保留；最终主CI与Windows平台结果尚待发布取得。

修正后定向6文件77case：76pass/1fail。PG同pool三态与Windows路径一致性原失败断言均通过；新失败为跨进程命中检查期间源码输入变化。随后只复验native8case：7pass/1fail，完整3589路径输入摘要确认运行中daemonStart.ts/developmentReload.ts被并发开发修改，本轮24文件未变。停止本机追跑，保留环境不稳定证据，最终由干净提交的hosted CI验证；不暂停其他开发、不清除其在制品。最后补齐Bun实际解析的3份tsconfig输入键，原16项行为回归增加逐配置失效断言，数量/预算保持。

最终三份tsconfig输入键回归16/16通过，原生跨进程回归不再在持续变化的共享输入上追跑；最终backend类型检查以CI相同6144MB配置通过，改动文件lint/format/actionlint及独立增量实现门通过。验证期间共享main前进到30e88867e（RFC616两次独立修复），与origin精确同步；原测试文件人口不变，复用已有效的候选验证，不重跑全本地门。实际CI比较会披露这些并发提交的影响，另保留尚未提交的dev-reload在制品。
