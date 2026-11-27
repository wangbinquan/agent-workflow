# RFC-625：第二批 CI 优化——Windows 进程身份与不可变准备复用

状态：Done（本批实现与验证完成；排队和未明超时风险保留），2026-11-26。用户明确授权第二批：优先定位并解决 Windows 人工门恢复用例的进程锁冲突，压缩 Q3 与最慢后端片，保持覆盖、隔离及现有门禁，完整 CI 验证并比较实际耗时。本 RFC 落实该授权，不新增待批准产品能力。

## 背景与证据

第一批代码240ee338 / CI45939395356完整69/69成功，但Windows人工门恢复一个case首次因PID7256锁被判活而失败，原retry1通过。锁只有PID，无法区分同PID的不同进程实例；Bun1.4.3所固定的libuv已检查退出码与进程handle的signaled状态，不能把事故解释为缺少终止状态探测。原日志尚不能证明PID7256发生复用，须保留不确定性并补诊断。

Q3 11文件992.055秒，最慢backend30为14个V2文件、801.568秒，旧权重仅641.203秒。V2整文件减case自报时间残差522.661秒，每文件约37秒；源码显示每个isolate重复构建完整SupportedSourceManifest。残差含imports/hooks等，不能全部当作可节省时间。

后继纯文档530e3bc52 / CI45943689640因macOS产物上传ETIMEDOUT、既有RFC363 SQLite用例超时及Windows system-mocks失败而红，日志单独保留，不作为完整性能样本。主对照仍是240，790/9cb提供完整成功历史参考。

## 批准范围与非目标

1. Windows daemon锁记录进程创建身份，修复PID复用导致的错误占用判断；保持真实活owner独占、旧格式兼容、watch/自动升级/CLI行为。增加有限的恢复进程诊断。
2. 在现有CI job临时缓存中复用只读SupportedSourceManifest；每次仍完整核验冻结输入，冷构建仍走真实SQLite/PG compiler。保留每例独立source数据库、原target重置/安装、reader与清理流程及原11个Q3入口：SQLite target每例新文件，PG target按原流程在describe内复用物理库、每例重新打开并重置两个schema。
3. 使用完整绿色44片计时的逐文件最大值重平衡，保留真实来源，不使用预计缓存节省改写实测值。初次发布来源为790/9cb/240；本轮完整3aa成功后，以9cb/240/3aa刷新，将新增回归的实际成本纳入调度，历史来源及负结果保留。
4. 全部实现及回归完成后集中验证、独立功能实现门、精确SHA完整CI与实际成本比较。

不合并Q3/V2文件、不共享live数据库或daemon、不修改业务迁移/人工门合同、不增加case/job timeout或retry、不减少provider/platform/coverage/required项。不为其他归属明确的独立session缺陷代改；新失败先归因。仅性能观测不能宣称根治外部runner排队或长期红率。

## 验收

- 同PID同创建身份仍拒绝重复获取；明确不同创建身份可回收旧锁；unknown与legacy活PID保守处理，迟到release不删除替代owner；保留旧CLI读PID能力。
- 原生Windows回归接入现有Windows平台测试；原三个人工门恢复case及150秒预算、4 workers、retry1保持。
- cache cold/warm/off结果完整等值、命中重新admission、输入变化失效、失败/损坏不产生可用结果、跨isolate真实命中且返回独立对象；真实双provider和原case全集保持。
- 44片完整source、来源与目标文件人口可审计；新增未测回归明确使用原生默认值，不能伪造实测。
- 完整CI给出实际结论，分别报告case重试、runner执行、排队、Q3/V2成本、backend P95/max及总墙钟；保留负结果。

完整实测与未解稳定性边界见[验收记录](./acceptance.md)。033后继69/69成功，Q3/V2及最大后端耗时较第一批基线下降；总墙钟、后端P95及累计runner运行区间未改善，不宣称整体CI已提速或长期稳定性已根治。
