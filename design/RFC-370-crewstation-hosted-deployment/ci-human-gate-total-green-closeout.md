# RFC-370：HumanGate 修复后的总绿验收

2026-10-10，精确提交 `ca947c2431cd710bdaa63af3bae4903c1ace03b4` 的主 CI `38044940528` 正式 `completed / success`，72 个作业全部 `success`；同一提交的原默认完整 Windows `38045024500` 正式 `completed / success`，作业 `114192710710` 的 26 个步骤全部 `success`。根会话已读取全部 73 个作业的名称和终态，以及两条流水线四工作区共八条 `typecheck: Exited with code 0` 记录。历史外链检查和原 `Static scans` 作业的终态均为 `success`。

四个文档路径均不匹配原 Windows push 的 342 条路径规则，因此只触发一次无输入覆盖的默认 `workflow_dispatch`；没有重复创建或重跑 Windows。主 CI 是原 push 运行。既有检查范围、规则、超时及测试用例预算保持。

## 实际功能案例

根会话已核对原 32 个 Ubuntu、12 个 macOS 后端分片和完整 Windows 的 45 份功能报告，逐条读取目标案例的名称、pass 状态和实际耗时；Ubuntu 同时包含 SQLite／PostgreSQL，macOS 与 Windows 使用 SQLite。

| 原测试合同                                | Ubuntu | macOS | Windows | 合计 |
| ----------------------------------------- | -----: | ----: | ------: | ---: |
| HumanGate 原事务与真实调用者              |     93 |    47 |      47 |  187 |
| Task runtime lifecycle 原事务与真实调用者 |    105 |    53 |      53 |  211 |
| 合计                                      |    198 |   100 |     100 |  398 |

398 次实际案例与原注册人口逐项相等，无缺失、非预期、重复、失败、skip 或 todo 的目标案例。H05／H08 真实 while-loop 在所有原 provider／平台组合中通过；原事务、拒绝回滚、COMMIT 后发布、draining 既有结果、原调用者与完整源码逆向恢复均有实际通过记录。这些数字是执行案例数，不是 `expect` 语法位点数。

最初的临时日志收集器把专门的 `Backend tests (real PostgreSQL)` 列表页作业也计入了矩阵前缀，因数量不符而停止，未生成验收结论。收集器按实际 32／12 分片名称修正后完成；该专门作业仍在全部 73 个成功作业之内。没有修改生产、测试、原 CI 或预期案例人口。

## 身份与原记录

源码提交 `127ab32d5948383f5bd92c92204df65cd5c99da1`、紧邻许可退役 `abca1d5118e20227b9b5a0cfa51c29035dd83934` 的原 SOURCE／MATCHING 功能门按 32 份完整 source／control 字节身份复用。后续并行 `ff450237` 的三路径和 `ca947c24` 的四文档引用修复均保留；旧主 CI `38042223483` 的 70 success／2 failure、旧默认 Windows 成功和全部旧回执没有改写。

本轮实际证据包括：whole-green verdict 36582 bytes，SHA256 `a0ec443183a59de42391f14038e0865b5c7174a2acd5897ebfe713e3b674550a`；398-case verdict 247431 bytes，SHA256 `8434f107f180a79b8b6de26616b10d1203f33ddc756df5bf397a15bc0759bf28`；根会话消费记录 15129 bytes，SHA256 `c801fffa877d562ba9d0c01d3c2a4113587e55d3d2c3a368d65ced5d06214f50`。原日志完整 EOF 字节身份已复核；Windows 的 100 条记录与本轮既有根消费记录完整相等。无本机 AW tests／typecheck／build／services／E2E，无新增 census。

用户要求的“总流水线全绿后再继续 RFC”前置门已满足。下一批回到 Task 启动恢复与周期资源恢复的原写入／事务清单，再补齐宿主装配；完整 H7／十九 owner／三个根、A-T7／A-G、各层 CS 独立 adapter 和 M0～M4 继续开放。AW 尚未部署 CS，RFC 未完成。

关联：[HumanGate 修复](ci-human-gate-context-and-frozen-fixture.md)、[历史引用修复](ci-historical-source-citation.md)、[实施计划](plan.md)。
