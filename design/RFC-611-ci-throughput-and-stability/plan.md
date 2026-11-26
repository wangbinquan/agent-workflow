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

首次发布仅包含 RFC-611 的 CI、脚本、测试与本目录文档等明确路径。共享 `STATE.md` / `design/plan.md` 同时包含 RFC-610 未发布文档的引用，完整保留在工作区，待其关联内容可以共同发布时再纳入；不剥离或回退并发条目。
