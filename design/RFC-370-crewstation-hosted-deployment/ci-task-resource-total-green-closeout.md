# Task 资源恢复：确切提交的总绿验收

提交 `3ed6040c339da628398cfd6eba5353c2935a3b93` 已通过用户要求的 GitHub 总流水线前置门。它包含 [真实 CI 修复](task-resource-recovery-ci-repair.md) 的四个 TS 候选、有限文档及原十三份配套产物；原 `6db03c7d` 的失败与生成历史保留，不能以旧 `ca947c24` 的成功代签此次验收。

## 发布与功能门

独立 SOURCE R1 的 fingerprint 为 `b25bf314f0111657c683d513cd5f7711c6642febeea508186fbfd7565be13ae9`；独立 MATCHING R1 为 `492f9ac9cd972c47120ce8623731f48c95d9ca1022863a4a43f38ff2b5a4c7c2`。两门均为功能 PASS／零 findings，全部分析与 EOF 身份已由根会话实际消费。四个 TS 字节与源码回执、十三份配套与原生成／纯投影结果保持一致。

本次改变后的候选只运行一次原 scoped census，成功一次；资源恢复整个波次的原历史仍是四次尝试、三次成功、一次原中止。实际库存无增长、减少或新增许可，未制造退役提交。共享 main 的二十个精确路径在短发布临界区提交；提交前后共享 index 与非本片 WIP 核对完成，最后 `HEAD == origin/main == 3ed6040c…`，ahead／behind 为 0／0。未运行本机 AW test、typecheck、build、service 或 E2E。

## 完整 GitHub 终态

| 流水线 | 确切运行 | 正式终态 | 实际核对 |
| --- | --- | --- | --- |
| 主 CI | [38115032019](https://github.com/wangbinquan/agent-workflow/actions/runs/38115032019) | completed／success | 72／72 作业 success，包括 CI required |
| 完整 Windows | [38115032033](https://github.com/wangbinquan/agent-workflow/actions/runs/38115032033) | completed／success | 原默认完整 push workflow，1／1 作业、26 步 success |

两条运行均绑定 `3ed6040c339da628398cfd6eba5353c2935a3b93`。Windows 没有手动缩小 dispatch，也没有降低原 workflow 范围。根会话实际核对全部 73 个作业终态、26 个 Windows 步骤和主 CI／Windows 各四个工作区 typecheck 的八条 `Exited with code 0`。`Static scans` 作业正式 success，本次没有读取其原日志或扩展排障。

## 实际行为执行

| 原合同 | Ubuntu | macOS | Windows | 合计 |
| --- | ---: | ---: | ---: | ---: |
| HumanGate | 93 | 47 | 47 | 187 |
| Task runtime lifecycle | 105 | 53 | 53 | 211 |
| Task resource recovery | 33 | 17 | 17 | 67 |
| 原 boot recovery family／local pairing | 23 | 23 | 23 | 69 |
| 合计 | 254 | 140 | 140 | 534 |

前 465 次执行逐项匹配原 H／L／R 完整登记人口；原 boot 另逐项匹配二十三个完整注册、原名称与预算，共 69 次。所有目标实际案例均为 pass，无缺失、额外、重复、fail、skip 或 todo。Ubuntu 包含原 SQLite／PostgreSQL provider 人口，原 boot 按其本来注册执行，未伪造 provider 扩展。整份 shard 日志可能含其他原 skip，此处结论只签上述实际目标人口。语法 `expect` 站点数不当作执行断言数。

根会话实际读取全部 534 条具名执行记录。45 份 backend／Windows 原日志与主类型检查原日志通过 EOF 字节身份核对；原 SOURCE／MATCHING 的静态正确性不代替这些 hosted 行为证据。R01／R05 的七／两个独立 SQL 写原子、原回滚与重试，R08 的冷构造及拒绝语义，以及原 boot 的 stage 读取顺序与错误传播均已实际通过。

本次完整终态记录为 36,547 bytes，SHA256 `28e4319d82752302295aa0a1968a18ef8a8560b177336055038af1150cdf047c`；行为记录为 307,512 bytes，SHA256 `4e730565585249ea88c59ae9eaf9b18c8c0a29bd264788d66569f0a91d467d07`；根消费记录为 2,205 bytes，SHA256 `67fe966ed102f13261384e8fe750f36f9560faa27dcfdb63bdf75e1a491dfcdb`。记录位于 `/tmp/aw-rfc370-task-resource-ci-3ed6040c-{whole-green-verdict,cases-verdict,root-consumed}-r1.json`，发布 SHA 与 GitHub 运行作为持久核验入口。

## 继续已批准的 RFC

总绿前置门已满足，下一片实施 [SO 写上下文生命周期控制](host-write-lifecycle-control.md)，沿原 authority 队列连接 prepare、activate、真实 lease facts 续租、quiesce 和全部旧 admission ACK 后的 retire。之后继续 [三个根与十九 owner 的实际装配](host-execution-root-assembly.md)、A-T7／A-G、各层独立 CS adapter，仍按 M0 首次部署、再 M1～M4 逐项接入。

本次只闭合资源恢复修复的 exact-SHA CI 前置门。完整 H7、三个根、十九 owner、A-T7／A-G、CS adapter、M0～M4、实际部署与 RFC 完成仍开放；AW 尚未部署 CS。此前失败、全部旧 STATE／plan 与并行产物完整保留。
