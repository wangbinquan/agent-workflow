# RFC-370 CI：空闲分片的原生就绪夹具

Runtime 修复098481069d318c4d08c7515cf612afe2c4f85f4f的主CI37424916817正式failure（46success／4failure），Windows37424916827success。macOS shard5 job112142720264只在local-gate-runner.test.ts:318的就绪前提失败：150ms idle timer已正确发TERM／KILL，但新Bun VM尚未打印idle-process-ready。原日志与失败保留。

只把该既有POSIX用例的子进程夹具换成系统/bin/sh：原TERM忽略先注册，打印同一ready行，静默等待1.8s后写同一survivor marker并退出。marker路径作为独立argv交给$1。既有Windows早退、真实runBackendShard、进程组与实际日志路径均保持。150ms idle／10000ms hard／50ms grace／2500ms duration上限／1400ms原观察等待及全部名称、断言不变；其他用例、runner生产代码和默认deadline不动。

夹具去掉被测空闲窗口内的新Bun VM启动成本；原完整文件只有这一用例的fixture与argv变化，纯逆向证明恢复全部原AST／assertions／budget。正式行为交新exact-SHA hostedCI，本机仅owned format/lint与纯AST／byte核对，无AW tests/typecheck/build/service。原主CI另有RFC371报告425和Static scans正式failure；该片不分析Static scans，不记整套CI绿，RFC370/A-G与CS部署继续。
