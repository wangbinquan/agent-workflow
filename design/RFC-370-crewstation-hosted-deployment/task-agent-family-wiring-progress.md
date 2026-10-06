# RFC-370 Task 执行族接线候选

状态：Stage A / A-T5 的增量候选，2026-10-06。CS production adapter、A-G 和 M0 部署仍开放。

按已批准的 [完整执行族设计](./task-agent-family-wiring.md)，Resource Catalog 提供有序声明及内容引用，Runtime Management 保存原冻结／session／internal runtime 语义，Source Control 解释工作区和挂载引用，TE 的完整 family 为同一调用绑定材料、内容、输出和执行参与者。原 native API 及唯一完整 Task core 保持；正常六处生产调用使用 `runTaskAgentWithFamily`。

实际接线为 nodeMechanics 的 host／merge／ordinary 三处、wrapperMechanics 的 shard／aggregator 两处、scheduler 的 commit／repair 一处。SQLite／PG、CLI 初始／重装、HTTP bootstrap 与直接 fixture 均显式选择；child 每次 drive 重新从同一选择工厂装配，不序列化完整 family。原 prompt／artifact reader 在一次 drive 的原读取位置构造，再绑定到所选 family，保持 receiver。

本机仅有限格式／lint 和纯 AST／字节证明。六调用的原有序业务字段及确切 scope 投影保持；完整中间 AST 仅补正常 injection 的单一 `material` 解构，再与当前 AST 和六调用逆向还原逐项相等。首份证明遗漏这项后续投影而失败，原脚本／日志保留；第二份明确该投影后通过。child fixture 只增加一个 `dropped-registered` family disposition，原继承键及完整其余 AST 保持。两组 synthetic 地址文字锁只跟随新的具名入口，原 6／3 数量不变；原 isolation 停止点和 clean-Git fixture 使用当前 normal API，原错误、断言和预算保持。

新候选测试为14个实际实例：有序 RC 内容和正常 nonce／选择边界2个、两 native protocol 的完整 local 编译2个、三个 runtime 冻结／恢复／配置等待用例在两数据库共6个、双协议／双数据库的真实 provider drive 共4个。最后四个在原真实 provider／ownership／TaskEngine 上选择现有完整逻辑隔离 workspace，再让选中的正常 family 保留原 compile failure 落库，证明实际消费者到达替换族；没有把未消费工厂作为运行证据。所有新用例加入原 hosted 测试选择，Windows push／PR 路径同步并增加相同套件。

此前 Task CI 地址／类型修复已推送 `e24de73a3ab0b12c99998b70bd5e3904e5be003a`，主 CI `37390522481` 与 Windows `37390610195` 另取确切终态。本候选源内容冻结后独立检视，随后原一次 matching census／metadata门与精确上库；正式功能结果由该新 SHA 的 hosted CI 给出。本候选尚未执行本机 tests／typecheck／build／services，不宣告这些测试已通过。

本增量之后继续尚未关闭的 System／smoke／retention、RC-MCP、脚本、H7 执行权／恢复、A-T7 与 AC00/A-G；阶段 A 独立通过后编写 CS adapter，M0 首次部署先行，再逐项 M1～M4，最终完整 RFC 验收。
