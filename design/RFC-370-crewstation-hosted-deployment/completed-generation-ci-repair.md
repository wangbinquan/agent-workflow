# A-T1：已完成历史数据库状态的 CI 用例收尾

`119b59c7` 的 Windows `37349482848` 已通过；主 CI `37349482894` 的 macOS 分片5（job `111896402198`）中，原 `a healthy completed root target keeps the original public resume rejection` 用例在 5 秒处超时。原错误码／消息、历史 root/head 和 accepting-writes/finalized 四种组合、manifest／pointer／SQLite 字节不变的断言继续保持，不扩预算，不改生产判断，也不把重跑当修复。

该用例原来每个 phase 都创建新的真实 coordinator，重复加载同一历史迁移；已有 coordinator 本身按实例缓存这次读取。本片让同一真实 fixture/coordinator 先接受 accepting-writes 的原拒绝，再以原 `advanceDatabaseMigration`、原 CAS 和原 pointer 写法推进到 finalized，验证第二次原拒绝。两个 phase 每次仍先冻结各自真实 manifest、pointer 和数据库字节，保留全部原断言。所有其他 fixture 调用的原最终状态及写顺序保持；只是将原 phase 和 pointer 操作整段拆成可复用测试 helper。未注入假的 history、coordinator 或 provider，也不绕过真实历史版本解析。

其余四个失败分片是新并行 participant 断言未登记进 guard 清单，`4ff95e5e` 已提交该地址与原匹配计数；保留该完整输出，后续 matching 继续使用原 counter。原 `119b59c7` 的失败／通过分别留证，新确切 SHA hosted CI 另验。本机只对这个文件做 format/lint 和纯源码逆向比较，不跑 AW 测试／typecheck／build／service。完整 A-G、独立 CS adapter、M0 首次部署和 M1～M4 仍继续。
