# RFC-371 CI 与定时工作流修复记录

更新：2026-09-30。本页属于 AW-R01 的 CI 关闭证据；两 RFC 的产品剩余范围继续按 remaining-work.md 实施。用户本轮明确要求修复 AW CI 和定时 CI，因此本轮读取失败步骤与日志定位根因；此前仅记录扫描元数据的历史保留。

## 基线与根因

- 当前基线 `f3bfc548fb25edfa95994e262730186820148f03`。[提交 CI 36658830125](https://github.com/wangbinquan/agent-workflow/actions/runs/36658830125) 终态 failure，48 success/2 failure。失败源是 dependency audit gate 的两条 fast-uri high 公告，CI required 随之失败；其余功能检查通过。
- 根清单已有 fast-uri 3.1.6 覆盖；本轮改为 **3.1.7** 并以 Bun lockfile-only/ignore-scripts 生成锁文件。仅该覆盖值、包版本及其完整性摘要变化。官方 [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) 和 [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) 均列 3.1.7 为修复版本。本轮不增加公告豁免，不降低严重度或必需检查。
- 三类红色定时运行都在旧 `904ccfdaa0de41d63472d1a4c251a657a32857fa`：WebKit [36578655269](https://github.com/wangbinquan/agent-workflow/actions/runs/36578655269) 与 full E2E [36566313981](https://github.com/wangbinquan/agent-workflow/actions/runs/36566313981) 在 Node 加载 JSON 夹具时失败；空 route-hit artifact 与覆盖对账拒绝是前置失败的后果。Windows [36571611662](https://github.com/wangbinquan/agent-workflow/actions/runs/36571611662) 是三处 capture union matcher 的 TS2769。
- 上述 JSON filesystem 读取与 capture kind 显式收窄已经随 `8c6e9a0766a1a184170dec1e9685a07b580334e5` 合入，并已确认是当前 main 的祖先；本轮不重复改写或削弱测试。旧 SHA 的红色记录不伪改为绿，新版本的定时配置必须实际运行验证。

## 本轮必须核对的工作流

| 工作流 | 频率（UTC） | 本轮退出要求 |
| --- | --- | --- |
| maintenance-soak-nightly | 每日 05:00 | 原 full 模式、默认规模和资源预算通过 |
| e2e-full-nightly | 每日 06:00 | 四分片与 RFC-319 覆盖账本对账成功，route-hit 完整 |
| windows-platform | 每日 06:15 | Windows 实际表面、类型、构建等全部成功 |
| e2e-webkit-nightly | 每日 07:00 | 两平台各四分片全部成功 |
| integration-opencode | 每日 07:30 | 固定工作流默认协议集成成功 |
| git-protocols-e2e | 每日 08:00 | 既定 Git 协议矩阵全部成功 |
| evidence-soak-nightly | 每日 08:30 | 原默认证据规模与预算成功 |
| visual-regression-nightly | 每日 09:00 | 原视觉矩阵通过，不批量接受差异 |
| postgresql-evidence | 每周日 03:30 | weekly/all 默认矩阵成功，真实 PG 证据完整 |

九个工作流保留现有 schedule、workflow_dispatch、权限、测试强度与失败汇总。本轮将复用该候选自动触发的等价运行，仅对缺少等价运行的工作流从 main 手动触发，逐个记录实际 headSha、run ID 和终态；不在本机运行 AW 测试、构建、类型检查或服务。每周 PG 最近 [36309246936](https://github.com/wangbinquan/agent-workflow/actions/runs/36309246936) 在 `a53425b87bc6fa124d74829c278f52059ca04c93` 成功，仍需本轮新版本验证。

## 当前状态与关闭边界

版本与锁文件已修正，精确提交 CI 和九个定时配置的新版本结果待回执。主 CI required 与所有目标工作流终态成功前，AW-R01 保持未关闭；若发现新的真实失败继续定位和修复，不能将旧修正祖先或单个绿色分片当整体成功。并行 resource-catalog 四文件原样保留，不纳入本轮提交。AW-R02～12、CS 开发来源/清理/消费/两级明细及真实身份/模型验收继续，不以 CI 修复宣称两个 RFC 完成。
