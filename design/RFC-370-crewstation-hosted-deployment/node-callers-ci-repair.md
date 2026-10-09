# N2 Node caller 接线后的 CI 源码断言修复

N2 源码提交 `cf50bc330dd0cb7d73095da26f8862dcb4db80ca` 的主流水线
`37885361029` 与 Windows 流水线 `37885361045` 暴露同一处测试接线过期。
macOS shard 7/12、Ubuntu shard 15/32 和 Windows 的完整作业日志都显示
`rfc371-invocation-wiring.test.ts` 的
`native model preparation uses final spawn env and local numeric retries avoid replaying stdout`
用例在 `expect(retries).toBe(1)` 处得到 `0`。

原断言只匹配 `opts.persistence.nodeExecution.appendEvents`。N2 已将实际调用接到
`selectTaskNodeExecutionWrites(opts.persistence, 'issuedResults').appendEvents`，
因此原计数器没有识别实际的观察数据修订批次。

修复使用 TypeScript AST 识别选择函数上的 `appendEvents` 调用，再明确要求选择函数只有
`opts.persistence` 与 `'issuedResults'` 两个参数。原有空 `events` 批次、
`opts.nodeRunId`、唯一 `observations` 简写属性、local authority 与 `unreaped`
条件、最终环境、normalizer 次数以及 `retries === 1` 断言全部保留；原测试预算不变。
其余用例和生产代码不改。

本批只做必要 CI 排障。局部格式、语法与原文件差异核对不代表运行用例通过；
发布后必须取得包含此修复的确切提交的主流水线与 Windows 全部成功，并核对原失败用例
及新 Node caller 用例的实际作业结果，再继续 RFC 实现。

当前状态：实现检视与新确切提交的完整 CI 待验收。完整 H7、A-G 和 CS 部署尚未完成。

## 后续分片暴露的配套缺口

首批七个配套文件已发布为 `f3fecc4309a4305e69a3558c457c9b6bb85997c0`，
主流水线 `37887985130` 与 Windows 流水线 `37887985092` 已启动，尚未取得完整成功。
旧 `cf50bc33` 主流水线后续九个失败作业还暴露以下缺口。

- `freshness.test.ts` 和 `runner-inject-snapshot-eager-write-source.test.ts` 仍匹配旧
  `nodeExecution.patch` 接线；改为明确匹配原调用的 `issuedResults` 选择结果，
  保留 consumed provenance、wrapper run id、成功 finalization 区域与 injected snapshot 断言。
- `rfc371-span-runner-wiring.test.ts` 仍匹配旧 `appendEvents` 接线；使用实际 selector
  AST 并增加三个精确参数断言，保留唯一最终写入、空事件批次、原 nodeRunId 与两个 capture
  合并顺序要求。
- 新 Node caller 用例的 terminal wrapper progress 夹具缺少原 codec 必填的 `phase`，
  导致原清理逻辑按既有 malformed payload 规则返回。夹具补入 `phase: 'inner-running'`，
  并明确断言该字段保留；仍要求删除 `reuseDisabled`、保留 `round`、两次独立 ACK
  及 owner revision 增加两次，生产 codec、SQL 与 cleanup 不改。
- 原 `originalCallerPurposes` 清单的 80 项逐项相等源码契约漏了账本登记。补登记的具名条目
  已准备，并已针对实际共享 ledger 在制内容进行必要发布协调；本五文件修复不宣称登记已发布。
  原清单、枚举规则和 80 项断言完整保留。

本五文件候选保留所有原用例及预算，新 Node caller 仍是每 provider 18 个用例和两个有限
源码用例。没有追加生产改动或第二次 census，没有执行本地 AW 测试、typecheck、build、
服务或 E2E。必须等账本登记落实，并取得包含全部修复的确切提交的主流水线与 Windows
完整成功及实际用例结果，才能继续 RFC 实现。

## 2026-10-09 登记后的 canonical 顺序修复与 CI 验收边界

80项完整登记已随84372720a6ee741b32953483b7f3a90ff8d35dac上库，原四个测试修复也完整包含。该SHA的Windows作业37893752035经现有workflow_dispatch默认入口执行原完整命令和预算，已1/1成功；它未命中push路径过滤，不能写成普通push触发。完整实际用例证据与主流水线总绿仍待验收。

本轮主流水线Ubuntu24作业113696280855的原canonical投影检查发现唯一80项登记排在14条自动投影记录之后。原projectGovernanceArtifacts保留手工登记，再追加原n1LedgerSpecs；此次仅将这一完整登记从129索引移至115索引，其他129条相对顺序及全部130条字段、baseline和why保持。原五个纯JSON摘要函数重算provenance.contentDigest，其余原锚点、sourceDigest和canonicalProjection保持；不修改原检查或再跑census。完整原账本可通过移动回原索引、恢复旧contentDigest逐字恢复。

同SHA文档链接作业113696280091仍因两个外部页面返回504失败；原配置包含5次重试，未接受5xx或删除任何引用。针对该完成作业的重跑请求返回403，原因是所属流水线仍在运行，请求尚未执行。本轮顺序修复、后续链接检查、完整GitHub主流水线及Windows总绿分别保留验收边界。没有本机AW tests/typecheck/build/services/E2E，完整H7/A-T7/A-G及CS adapter、M0部署与RFC完成状态继续开放。
