# RFC-371 实际入口验收后的 CI 修复

`e6098f5ba885875013f0af9a6c0831c69084c032` 主 CI 的 Typecheck 作业 `113126138638` 报告四处 TS2740：续接回归夹具给完整 TaskLaunchConfigurationSnapshot 提供了局部配置。修复使用共享 DEFAULT_CONFIG 构造经过校验的完整配置，保留零重试预算、同步/异步 live reader 与原 receiver 的断言。删除可选 runtime 覆盖后，必须恢复正常必填预算，不能把不合法的空配置当产品输入或保留 boot 时的值。

同一修复增加实际 CLI 根的三项逆向回归：完整已审续接读源通过，改成旧 selectedQueries 或夹带无关属性均继续拒绝。原根 helper 和 JSON 由负责 RFC-370 的会话维护；本会话不改写其逆向实现或共享配套输出。

较早主 CI 的 RFC-217 G4 则发现动态工作组观测直接判定 workgroupId。修复复用共享 isWorkgroupTask 判据，再保留原冻结工作组模式、原节点与 rerunCause 的精确分类。五项双 provider 动态确认回归保持，真实人工确认的执行时间继续存在，真实模型生成和未知执行仍不能免除采集。

本机只运行这两个自有路径的格式和 lint 检查，不运行 AW 测试、类型、构建或服务。原生数值和正式服务复验已有独立证据，源码变更交新确切 SHA 的 hosted CI；旧失败和未完成的 System Agent 采集继续保留。
