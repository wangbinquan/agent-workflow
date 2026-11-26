# RFC-611 实施计划

用户已于 2026-11-26 授权按诊断建议实施。先完成全部实现与用例，再集中验证。

- [x] T1 两 lane 完整 CI 排队、独立静态 feedback、内容缓存与原 required 合同。
- [x] T2 后端计时合并器、来源/全集校验、初次刷新和可审阅自动更新产物。
- [x] T3 原生 Playwright discovery、按时长文件分配、测量报告与全部平台接线。
- [x] T4 RFC-398 原子 barrier 发布与意外退出快速失败、确定性回归。
- [x] T5 build-success 下游条件、仓内/变更外链提交门与全外链 nightly。
- [x] T6 更新受影响的拓扑测试、必要文档/清单；只做静态自查至此完成。
- [x] T7 集中验证、只读功能复核、缺陷修复与对应复验。
- [ ] T8 精确路径提交、推送、核对同步与 exact-SHA CI，记录有效结果及外部阻塞。

## 验证记录

实施及本节验证由 Codex 完成；所有生产实现、接线和回归用例完成后才进入集中验证。未运行全量本地 gate。

- 新增/受影响 8 个单元与拓扑文件，最终候选的 89 个测试均有通过证据（首次 85/85；修复及新增回归按受影响文件复验）。
- Playwright 原生 discovery 与全部 11 个 child config 的实际 `--list` 校验：Linux 3 片、macOS 4 片各覆盖 532 tests / 121 specs；Windows 4 片保留原排除后覆盖 527 tests / 120 specs。每平台 ID 并集精确相等、文件无交集。本机为 macOS，Linux/Windows 的实际平台条件分支由 hosted reporter 核对。
- 44 份真实 backend artifacts 经刷新 CLI 校验，覆盖来源 SHA 的全部 3081 文件、23724995ms。旧基线 run 45772006810 的 attempt 为 1。当前新增文件仍使用缺省权重，未冒充已测。
- RFC-398 五文件实进程回归：13 pass / 1 fail，270.39s；唯一失败在入口要求本机缺失的 `AW_TEST_POSTGRESQL_URL`，未进入 PG 业务路径，记录为环境未验证。signals、retry、SQLite start、takeover、barriers 实际路径全部通过。
- 修改文件的 ESLint、Prettier、后端完整 TypeScript、CI 脚本/Playwright 配置严格 TypeScript、全 workflow actionlint 通过。全部 design 仓内链接：3422 条检查、0 错误；变更文档链接：475 条、0 错误。
- 集中验证发现并修复：Node/Playwright CJS 配置不接受 `import.meta`、reporter `onEnd` 必须异步返回覆盖状态、可选 matrix 索引类型、无资格 completion 取消 collector、旧失败 backend timing artifact 在重跑后残留。均补充或复用针对性验证。
- 本任务内部独立只读实现复核 PASS：主 CI/feedback/计时/链接及 E2E 发现—运行—测量链路，无剩余 P1/P2。此结论不代替 exact-SHA 全量 hosted CI。

托管 CI 与发布状态在完成后补充；当前不宣称已实测缩短到某个墙钟目标。

## 共享发布范围

代码已发布为 `6c6185496d10181d4b47e6d2d765d024eb13ba46`，29 个明确路径；发布前后 fetch 核对 `main == origin/main`。RFC-610 已先行发布为父提交 `0fdb118d8`，其候选内容正是本次集中验证时的共享内容；未重跑相同候选全量验证。共享 `STATE.md` / `design/plan.md` 当前只剩本 RFC 条目，本次文档跟进可以完整按路径提交，无需剥离并发内容。

首次代码 exact-SHA 运行：[完整 CI](https://github.com/wangbinquan/agent-workflow/actions/runs/45796122638)、[CI feedback](https://github.com/wangbinquan/agent-workflow/actions/runs/45796122676)。2026-11-26 发布时已被 GitHub 接受、处于排队状态；后续状态以运行页面和本次会话验收记录为准。

发布后只读复核发现旧 `root-test-entrypoint` 断言仍要求失败片也上传，未随 success-only 策略同步；补丁把断言限定到该步骤并要求仅成功上传。对应 root entrypoint + backend timing 共 36 项复验通过。原两条运行如果在旧断言处失败，属于本 RFC 遗漏；由包含此补丁的后继候选继续验收，不把重跑当修复。

## 托管观察与计时资格修补

`92222f0c3` 的主 CI [run 45797271947](https://github.com/wangbinquan/agent-workflow/actions/runs/45797271947) 持续验收中。macOS E2E 四片均通过，实际首 step 至 job 完成分别为 15m59s、11m47s、9m48s、11m16s；部分成功片存在 Playwright 重试，因此不作为 clean 权重来源，也不据此宣称整体尾片改善。Mac1 的长 spec 启动较晚，最后约 120s 单独占据尾段，说明总权重平衡仍不能保证四 worker 完成时间平衡。

计时资格修补：完整且通过但有重试的 E2E 样本，在全部 11 片来源/全集/结果序列/文件 metadata 校验完毕后中性跳过刷新，并输出 status JSON；普通验证错误仍失败。覆盖 serial 重试中的 passed/skipped/failed 组合、损坏证据与 retry 共存的顺序无关性、旧输出防复用。相关 2 文件 22 项通过，严格 TypeScript 与 ESLint 通过；此修补不改主测试选择或结果。累计新增/受影响测试的有效通过证据为 93 项。

最初两条带有已知旧上传断言缺陷的本会话 run（45796122638、45796337118）已手动取消，随后其剩余 queued 聚合 job 占住 lane，核实无运行步骤后 force-cancel 释放；没有取消其他会话运行。该人工清理不改变两 lane 保留所有 SHA 的常规策略。包含本 RFC 的后继 `1d4faeac5` 经候选路径与祖先核对，CI feedback 及 Windows CI 已成功；前者实际执行 8m53s、后者 9m54s，属于后继证据。
