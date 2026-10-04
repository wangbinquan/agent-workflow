# RFC-370 CI 接续：无效目标配置在 Source Worker 前失败

当前 main d005ca80d7f592929dda5630350801f99833717e 的 CI37177891308 completed/failure（42 success、8 failure）。macOS5 job111364257512 的 RFC359 T19h 两个独特 root/stale-link、root/refreshed-link 用例分别在5066.87ms、5395.90ms超过原5000ms；日志末尾重复列出的同名失败不当作另两个用例。其目标 URL 环境变量明确缺失。源码 withRunner 在构造实际 PostgreSQL runtime 前，仍启动真实 SQLite Source Worker 并完成完整 preflight；无效目标不需要这些工作。日志没有每个内部步骤的耗时，不宣称唯一超时原因。

仅调整 SO infrastructure 的 withRunner 初始化：原 operation/manifest/version/target schema 和显式恢复判据全部先完成，然后用原 createPostgresqlDatabaseRuntime 一次构造目标 runtime，再打开原 Source Worker／做原完整 preflight。constructor 是原 URL/config 判据和 lazy pool，不新增解析器、选项、platform 能力或网络连接；实际 reserve/advisory lock 仍由原 lazy openTarget 发生。有效目标仍跑相同 Source Worker、完整快照、runner、CAS/receipts、失败记录和最终 logicalTarget→source→runtime 关闭顺序。

新初始化的两个失败出口必须关闭已构造的 runtime：Source Worker open 失败关闭 runtime；preflight 失败以 try/finally 关闭 source 再关闭 runtime，再传播原错误（关闭错误沿既有 await/finally 语义）。runtime constructor 拒绝时没有 Source Worker 或 runtime 可关闭。有效目标的环境引用改为初始化时捕获一次；无效目标和坏 source 同时存在时，目标配置错误先返回，这个错误优先级明确记录。原显式恢复、pointer/generation、取消前无 target reserve、失败 manifest 保留等状态规则不改。

独立设计门通过后实施。保留原 T19h 的四个 version/link 案例全文、名字、断言和5000ms默认预算；不调重试或 Worker timeout。添加经真实 coordinator/原目标 constructor 的回归：head 恢复有缺失／损坏 source 时，原缺失／非法目标配置先失败，原 pointer 和失败 manifest 不变；一个抛任意错误的 env getter 只读取一次、错误 identity 保持。原真实 PG migration integration 继续验收有效目标、源错误与释放；机械比较只允许初始化移动及两个新增 early cleanup 出口，其余完整函数不改。本机不执行 AW tests/typecheck/build/services；新 SHA hosted CI 承担实际运行，本有限修复不关闭 A1～A8/A-G/RFC/部署。
