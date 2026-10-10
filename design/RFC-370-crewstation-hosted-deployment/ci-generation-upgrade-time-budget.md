# RFC-370 CI：迁移恢复文件的明确测试预算

## 原失败与依据

精确 `a9d60588ef735f9b1d406f1ab88a550f338ea358` 的主 CI `38023183230` 已终态 failure，72 个作业中 68 success、4 failure；完整 Windows `38023368643` 成功。除已另修的 writer 夹具和来源链接外，Ubuntu 27/32 作业 `114128377669` 的 T19h 恢复用例因 Bun 隐式 5000ms 预算失败，实际 5595.96ms。失败标题是 `explicit resume of the same failed PostgreSQL generation reaches its real target setup (root/refreshed-link)`，日志没有断言失败；同组 root/stale-link 4855.94ms、head/refreshed-link 2819.85ms、head/stale-link 2741.86ms 通过。日志未提供 CPU 或各初始化步骤的耗时，不据此宣称具体调度根因。

该文件构造真实历史 SQLite、持久化原迁移 manifest／generation pointer，再调用原公共准备和恢复机制，核对明确恢复要求、实际目标配置错误及错误 generation 拒绝。用例中的 5000ms 是测试运行器默认预算；原断言没有 5 秒产品性能要求。原失败时间戳仍须在实际调用开始与结束之间，原连接／语句超时也保持。

`docs/dev-gotchas.md:73–78,139–145` 要求为没有时间判据的真实 I/O 工作设置说明充分的预算，禁止用重跑代替修复。同组 `rfc359-t19h-postgresql-migration-sequence.test.ts:53–70` 和 `rfc359-t19h-logical-backup-restore.test.ts:45–58` 已使用 `setDefaultTimeout(60_000)`，原因是完整历史与 artifact 校验成本随历史增长。用户要求所有 AW 验证以 GitHub CI 为准，因此不执行本机单跑或性能测量。

## 有限修正

仅给 `rfc359-t19h-generation-upgrade.test.ts` 增加 `setDefaultTimeout` 导入、原 CI 失败与预算说明及文件级 `setDefaultTimeout(60_000)`。既有实例内历史复用注释的“this 5s case”改为“original 5s case”，说明其原上下文；不修改用例执行代码。

保留完整原 fixture、全部测试注册／矩阵、每个原 expect、真实公共调用顺序、错误分类、原环境 getter 次数、Source Worker 不启动判据、持久化结果、锁与资源清理。60 秒仅是运行器完成这些工作的上限，不是产品性能验收；不增加重试、跳过、假历史、提前终止或成功替身。生产迁移和 schema/history loader 不改。

设计门通过后实施，精确逆变换核对完整旧文件，另做原注册／断言的纯 AST 对比、范围内格式和 lint，再完成独立功能实现门。只发布该测试与两份直接相关记录；本机 AW tests／typecheck／build／services／E2E 和新 census 均为 0。

## 验收边界

后继精确 SHA 的主 CI 与默认完整 Windows 全部成功才满足用户总绿门槛；旧失败和取消保持记录。原 211 次生命周期跨平台实际执行另验，不能由本测试预算变化代签。HumanGate 新生产实施仍等总绿，完整 H7／十九 owner／三个启动根、A-T7／A-G、各层 CS adapter 与 M0～M4 仍开放；AW 尚未部署 CS，RFC 未完成。
