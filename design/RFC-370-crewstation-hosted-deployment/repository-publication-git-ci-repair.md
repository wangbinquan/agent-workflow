# RFC-370 A4 Git workspace：托管类型检查补正

已发布的 source22 `109b8d63819a77ef8520378caa11313186a38a18`、metadata17 `e7d1eb8999e6425fa0b36ba41cd9f04c41e80069` 与五项回执退役 `5490f43927e816c70719ca26b0a6cf4e45853ff9` 的有限功能检视通过，但尚不能记作 CI 通过。5490 的 Windows37192311608／job111406912429 正式终态为 completed/failure，类型检查报五项错误，原日志保留在 `/tmp/aw-rfc370-repository-publication-git-r3-job-111406912429-api.log`。

TS2339 来自新增 commit-push ACK 回归把逻辑 mint 输入的 `cause` 当作持久行字段。实际 `buildNodeRunMintRecord.ts` 以 `rerunCause: input.cause` 写入；schema 的原字段也是 `rerunCause`。回归只改为读取这个真实持久字段，保留 commit-push 筛选、running 行唯一性、锁和网络尚未打开的全部断言。

四项 TS7006 来自 `Object.freeze` 的嵌套对象缺少上下文参数类型。测试 transport 的三个参数按完整 `RepositoryPublicationSession['runNetwork']` 的 Parameters 注明，options 仍可选；测试 factory 的 binding 按 `RepositoryGitWorkspaceFactory['bind']` 原参数类型注明。完整 native delegate、raw args/options、receipt、close、工厂方法与所有测试名称、预算、断言均不变。没有生产机制改动或类型强制转换。

本批三份测试源码和本文进行独立有限实现检视；只做目标格式／lint 和纯源码逆向证明，不运行本机 AW tests/typecheck/build/service，不修改生产 canonical 或其规则。新确切 SHA 的托管 CI 与 Windows 仍须验收；旧失败不改写。Task diff／repair 读取切面在独立设计已通过的下一候选继续；完整 A1～A8／AC00／A-G、各层独立 CS adapters、B/M0 实际部署及 M1～M4 继续，尚无 AW-in-CS 部署。
