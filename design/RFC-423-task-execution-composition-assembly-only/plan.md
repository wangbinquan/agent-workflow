# RFC-423 实施计划

**前置**：RFC-422 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号       | 内容                                                                                                            | 依据          |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-423-T1 | 三块适配器逻辑与恢复选择类型迁入 infrastructure；composition 删除一个文件、一个改为类型再导出、两个改为同名转交 | design §1     |
| RFC-423-T2 | 收口锁 `rfc423-composition-assembly-only`（含负例，`throw` 账本取实测值）与端口绑定用例                         | design §2、§5 |
| RFC-423-T3 | 账本改指（RFC-328 / RFC-294 / RFC-376 / RFC-305）、用例 import、guard-manifest、Windows、全仓 grep              | design §4     |
| RFC-423-T4 | 集中验证：静态检查、针对性验证集、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI               | design §3     |

## 实施记录

1. 三块逻辑的主体逐字迁移，只改相对 import 与函数名（`composeCrewStationRecovery` 的主体成为 `createHostedRecoverySelection`）。
2. composition 的 `taskRecoverySelection.ts` 只再导出 bootstrap 用到的 `TaskRecoveryDeploymentSelection`。自审时收窄：另两个类型没有经由
   composition 读取的地方。
3. 托管恢复选择的业务闭包与 fence 门控，迁移前在仓内没有直接用例（`rfc370-m3-recovery-consumer` 只测下层 consumer）。端口绑定用例补上一条
   走真实数据库的用例（design §5）。
4. 附带：`scheduler-clarify-dispatch` 的「interrupted STOP-clarify rerun」给 20s 显式预算。RFC-422 的 CI 上它的 PostgreSQL 一侧以 5398ms
   越过 5s，归因见 RFC-422 plan「CI（AC-5）」。同一次 CI 里 `rfc311-perf-guards` 的偶发停顿，证据补进 `docs/audit-backlog.md` 的已有条目。

## 集中验证（T4）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0、0 个错误，端口绑定用例重写后复跑。改动的 TS 文件 eslint `--max-warnings 0` rc=0。
  改动的 `packages/**` 与 workflow 文件 prettier 全部通过。
- **实现门**（本会话自审，只审功能）：四段迁移主体与 HEAD 逐字相同。自审补了实施记录第 2、3 条。第 3 条的新用例在导出仓库里做了两次变异
  （去掉 fence 检查、改错 owner 映射），各自报红。PASS。
- **针对性验证集**（6 worker，负载约 21～26）：907 个文件，891 个通过。范围是导入闭包触及改动文件的 308 个用例、全部架构测试，以及读
  guard-manifest、Windows workflow 或 task-execution 源码文本的守卫和扫描语料的守卫。16 个失败里两个是本 RFC 的缺陷，已修：
  - `rfc294-architecture-preflight` 的能力 owner 账本按排序比较，改指后的条目没有挪到排序位置；
  - `rfc414-port-bindings` 的一条源码文本断言读 `composition/crewstationRecovery.ts`。路径由目录与文件名拼出，全仓 grep 没扫到；已改读
    `infrastructure/crewstation/hostedRecoverySelection.ts`。

  其余 14 个是 PostgreSQL 一侧的负载超时及其连带错误。

- **第二轮**（3 worker）：16 个失败加上验证期间改过的 rfc423 端口绑定、rfc328，共 18 个，14 个通过，两处修正都在内。
- **第三轮**（单进程，负载约 10～13，本候选与基线 HEAD `465fa2087` 的导出对照）：余下 4 个在本候选上全部通过。基线上 3 个通过；
  `scheduler-clarify-dispatch` 在基线上失败，是同文件另一条 PostgreSQL 用例以 5944ms 越过 5s。判为负载超时，不归本 RFC。附带 20s 预算的
  那一例，第一轮负载下 PostgreSQL 一侧 8.5s 通过，单进程两侧都在 4.2s 左右。
- **按已提交源码生成报告的用例**：在「HEAD 加本候选」的独立导出仓库里，`rfc376-report` 16/16、`rfc370-committed-architecture-source`
  2/2 通过。同一仓库里收口锁与 RFC-317 的语料下限、账本、负例守卫也通过。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## CI（AC-5）

`128e439d7` 的主 CI（运行 41407877240）68/70，windows-platform（运行 41407876989）全绿。主 CI 红了一格，汇总门 `CI required` 随之红：

- **backend shard 16/44**：`rfc311-backup-concurrency` 的「checkpoint yields during a snapshot」以 5013ms 越过 bun 默认 5s。这是纯 SQLite
  用例（顺序插 400 行再做一次离线程 VACUUM INTO 快照），此前四次运行 1.7～2.5s；同一分片总耗时反而比上一提交低约两成。本 RFC 不涉及备份、
  checkpoint 与任务列表，不归本 RFC；RFC-424 给该例 20s 显式预算（承重断言「快照期间取页 < 2s」不变）。
- 同一次运行里，RFC-422 那两格红对应的用例都通过：`scheduler-clarify-dispatch` 的 STOP-clarify 例 PostgreSQL 一侧 1824ms（本 RFC 给的预算
  生效），`rfc311-perf-guards` 的过滤视图 PostgreSQL P95 16.86ms。

AC-5 以包含本 RFC 的后继提交（RFC-424）的 CI 作后继证据收尾。

- **后继证据**：`556a45573`（RFC-424）主 CI `41420057803` 70 个 job 全部 success，windows-platform `41420057759` 与 git-protocols-e2e `41420057760` success；本 RFC 的改动原样包含在该提交里（`128e439d7` 是它的父提交；RFC-424 在本 RFC 的路径上只改共享索引、
  guard-manifest 与 RFC-376 结构门的另一条基线，没有改动本 RFC 的生产文件）。`rfc311-backup-concurrency` 在该运行里
  通过（RFC-424 给的预算生效）。AC-5 成立，RFC-423 Done。

## 冲突面

- **composition**：`TE/composition/{triggerExecution,taskRecoverySelection,crewstationRecovery,workspacePreparationMaintenance,providerRuntime}.ts`。
- **infrastructure**：`TE/infrastructure/{taskExecutionTrigger,taskRecoverySelection,workspacePreparationGc}.ts`、
  `TE/infrastructure/crewstation/hostedRecoverySelection.ts`。
- **守卫与账本**：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## 验收清单

- [x] proposal AC-1～AC-4（本地集中验证，见上）
- [x] 推送后 exact SHA 的 CI 全绿（AC-5，后继 `556a45573`，见上）
