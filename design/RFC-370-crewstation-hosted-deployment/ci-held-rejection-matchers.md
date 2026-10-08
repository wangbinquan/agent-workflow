# RFC-370 CI：先释放 held ACK，再断言原 rejection

精确 `05e60236c42a3e3945bc4ed1d5575d521db557a1` 的主 CI `37705887143` 已正式 failure，Windows `37705887174` 已正式 cancelled。原 PG writer cause 两用例及 W5 许可退役所对应的 Ubuntu21、Ubuntu6、macOS2 作业均 success；仍有六后端分片与 Windows 超时取消，不能记为 CI 绿。

实际七份功能作业日志都停在三套 RFC-370 测试：`rfc370-authority-polling-runtime`、`rfc370-host-authority-provider-runtime`、`rfc370-task-authority-loss-quiesce`。三个测试表面共有四处先创建 `expect(pending).rejects` matcher，再在后续 JavaScript 释放同一 pending 所等待的手工 barrier。固定 Bun 1.4.0 源码 `oven-sh/bun@bun-v1.4.0 src/runtime/test_runner/expect.rs:477-530` 的 process_promise 在 matcher 内直接 wait_for_promise；该调用还未返回，后续 release 不会执行。CI 停点及四处源码与这个自锁形状一致；不把外部 Worker issue 的不同触发条件套成本仓根因，不以增大时间预算或重跑掩盖它。

本批只在四处 pending 原 Promise 上先注册 rejection observer，随后执行原 barrier release / loss / close，最后才对原 Promise 执行完整原 rejects matcher。早注册的 catch 不替换被检视的 Promise，不吞掉断言、改变原失败值或给出成功 receipt。两处 provider start 都保留 grant-lost 断言；polling 保留 exact fatal 身份；Task 保留原 authority-quiesced 消息。正常路径、全部其他断言、完整 case 名称、双 provider、30_000／原隐式用例预算、15／25 分钟 workflow 预算、生产 polling cadence、ACK 与取消策略都保持。

该片属于原测试与 CI 时序修复，零生产修改，零 canonical 修改，无新 census、无本机 AW tests/typecheck/build/service。对三个文件原名称／预算／expect 输入和完整逆变换做静态核对，再走独立功能实现门、精确路径发布与新的 hosted CI。两项回顾 P2 的设计与源码验收独立进行；runtime／Node／CS 的新能力实现仍暂停，H7／A-G／M0～M4 不由该修复代签。共享 STATE／plan 的原全文和并行输出保留。
