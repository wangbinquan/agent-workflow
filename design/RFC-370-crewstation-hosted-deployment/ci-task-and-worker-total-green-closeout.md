# RFC-370：Task 原行为与报告 Worker 总绿验收

2026-10-12，确切提交 `540168eceeabe9a70ba6030dbbd5cb8a79db78c2` 已满足用户要求的“GitHub 总流水线全绿后才继续 RFC”。[主 CI](https://github.com/wangbinquan/agent-workflow/actions/runs/38188857513) 正式 completed／success，72 个作业全部 success；同一提交的[默认完整 Windows](https://github.com/wangbinquan/agent-workflow/actions/runs/38188857518) 正式 completed／success，唯一完整平台作业的 26 个步骤全部 success。没有采用 fast 模式、测试子集或重跑成功替代原失败。

根会话已实际解析完整 run／jobs JSON，核对全部 73 作业的提交、身份与终态，并复用「设计运行观测统计全景」取得的原始日志缓存。44 份 backend 分片、完整 Lint 和完整 Windows 共 46 份原日志均读至 EOF，合计 18,596,988 B；逐份与原归档、字节数及 SHA256 对照，没有重复下载。两条流水线分别出现四个包级 typecheck 的实际 `Exited with code 0`，共八条。

| 实际具名人口                           | Ubuntu | macOS | Windows | 合计 |
| -------------------------------------- | -----: | ----: | ------: | ---: |
| Task 原 provider／source 目标          |     59 |    30 |      30 |  119 |
| Task 原 runtime lifecycle              |    105 |    53 |      53 |  211 |
| 报告 Worker 原七案例＋当前环境新增案例 |     16 |     8 |       8 |   32 |

三组均无缺失、额外、重复或非 pass。Worker 保留原七案例的完整预言，新增每种 provider 一个真实原生库切换案例，四组实际执行均通过；没有删除用量四桶、人民币估值、历史行、真实分页、外部写入、连接代或 cold／hot 判据。Task 配置透传、W7／W8、升级和原生事实 provider 也按原实际登记平台逐项核对；除 Worker 新增案例外，这些相关测试源码与 `d7de7fdd` 逐字相同，原登记的 375 次执行全部 pass。Lifecycle 的 211 次属于该 375 次，不重复计总数。

完整根验收在 `/tmp/aw-rfc370-task-worker-current-environment-total-green-540168/root-total-green-acceptance.json`：485,999 B，SHA256 `f6688679881181e7699f801d2e7ae99ff32a77f6d39f5151a9291d3b837afd1f`。它包含完整原日志身份、具名实际 pass 行引用、原人口及来源保持核对；Windows 的独立完整回执同目录保存。原归档缓存位于 `/private/tmp/observability-exact-current-ci-status-20261012-v377/main/` 与 `windows/`。临时证据路径用于本次接手，仓库记录和正式 Actions 运行链接保留；不假定临时目录永久存在。

更正此前失败记录的表述：`d7de7fdd` 的 Windows API 包含 `Typecheck` 第 15 步，但它因原平台步骤失败而为 skipped，原日志没有四包实际退出码。此前“无 typecheck 步骤”应读为“无 typecheck 实际执行证据”，不能声称该旧失败提交通过八条检查。原主 CI／Windows 的 24 次 Worker 失败和所有 SOURCE／MATCHING 结论仍保留于[原修复记录](ci-task-provider-host-fixture-and-original-oracles.md)。

本次总绿允许恢复 RFC-370 生产实施。Maintenance 冷生命周期 R1 的 55 次只是声明，独立 SOURCE 实际发现两项 P2；R2 补三条回归后声明 64 次，正式 SOURCE 确认原两项修正，但另发现普通暂停与同步工厂失权两项 P2。R3 再补十条回归后预期 94 次，仍待独立 SOURCE、必要配套、发布和新提交的实际 CI，均不属于本次已通过人口。历史 FAIL 保留，详细候选见[维护服务记录](maintenance-cold-lifecycle.md)。累计使用量、缓存持久化及 Phase2 性能继续由「设计运行观测统计全景」负责，本次不签性能达标。完整十九 owner、三个真实启动根、H7／A-T7／A-G、各层 CS adapter 和先 M0 实际部署再 M1～M4仍开放；AW 尚未部署 CS，RFC 未完成。没有运行本机 AW test／typecheck／build／服务／E2E 或额外 census。

后续维护进度：上述 R3 待验是本次总绿验收时的候选状态。其正式 SOURCE 后来确认为有效、稳定 FAIL／一项 P2；R4 补一条两种 ACK 顺序的恢复回归，独立源码复核有效、稳定 PASS／零 findings，根已完整核对并消费回执及全部 51 份材料。原失败和旧预言保留。R4 预期三平台 97 次当前尚未实际运行，不属于上表实际人口；必要清单仅为这五个 TypeScript 文件执行一次原 scoped census，清单检视、精确发布与新 SHA 完整 CI 另验，见[维护清单与发布](maintenance-cold-publication.md)。
