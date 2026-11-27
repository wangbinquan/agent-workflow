# RFC-623 第三轮 CI 优化验收

状态：Done，2026-11-26（America/Los_Angeles）。验收精确对应 `097d41d6d4501233370bcaa5c5c29e6770fe9c35`，不替后继并发业务提交签署 CI 结论。

## 完整托管结果

[主 CI 45921188560](https://github.com/wangbinquan/agent-workflow/actions/runs/45921188560) 首次 attempt 即 69/69 success：44 个后端分片、10 个 E2E 分片全部成功，13 组 required 输出全部 success。[feedback](https://github.com/wangbinquan/agent-workflow/actions/runs/45921188379) 也成功。此次 CI 数据/脚本改动未命中独立 Windows/visual 工作流的路径过滤，未人为补触发；首轮实现的这两条辅助工作流已通过，主 CI 内三平台 build/E2E 始终运行。

运行创建于 UTC 01:12:02，首个实际工作 step 为 01:12:05，最后计算 job 结束于 01:47:08，required 从 01:48:01 到 01:48:03；总墙钟到最后 job 为 36m01s，GitHub run.updated_at 完成代理为 36m02s。初始等待 3s、计算跨度 35m03s、最后门禁等待 53s。没有重新运行失败 job 追绿。

## 同口径观测对比

基线为优化前最近五次完整成功 run：45884250904、45886498851、45890130833、45893307751、45893530203。下表基线为五轮各自指标的中位数；排队从 job.created_at 到首个实际 step，执行含准备、测试和收尾。

| 指标 | 前五轮中位数 | 本轮 |
| --- | ---: | ---: |
| 每轮 macOS runner 申请 | 5（build 1 + E2E 4） | 4（build 1 + E2E 3） |
| 初始准入等待 | 50m54s | 3s |
| 完整计算跨度 | 57m40s | 35m03s |
| 整轮到最后 job | 111m01s | 36m01s |
| macOS E2E 等待中位数 | 8m29s | 14m42s |
| macOS E2E 最长等待 | 13m57s | 14m51s |
| 后端分片执行 P95 | 13m14.05s | 12m05.55s |
| 后端最慢分片执行 | 14m35s | 14m01s |
| 全部计算 runner-minutes | 579.02 | 578.03 |

总墙钟观测减少 75 分钟（67.6%），计算跨度减少 39.2%；这些差值包含外部容量、其他工作占用和运行波动，不能全部归因于代码。总计算 runner-minutes 基本不变，说明主要工作量并未被删除。macOS 排队中位数在本轮反而更长，不能声称外部排队已根治；确定性变化是少一次 macOS 申请，E2E 申请减少25%、含 build 的 macOS 总申请减少20%。

本轮 macOS 三片执行为 9m03s、3m58s、14m28s；均在原20分钟内，无容量取消。最后 macOS 结束比最后计算 job 早 8m46s，本轮仍由非 macOS 工作收尾。后端最慢第30片从首个step计14m01s；按GitHub job.started_at计14m02s，距原15分钟上限58s；历史最大值权重不是未来上界。

## 覆盖与采集验收

原始10份 E2E artifact 的官方 ZIP digest 均通过验证；SHA/run/attempt 与 source 的3/3/4拓扑一致。原生 test ID、文件、expectedStatus 和 discovery digest 与完整6c92来源逐项相同：

| 平台 | 分片 | spec 文件 | test IDs | 原有预期 skip |
| --- | ---: | ---: | ---: | ---: |
| Linux | 3 | 121 | 532 | 65 |
| macOS | 3 | 121 | 532 | 65 |
| Windows | 4 | 120 | 526 | 65 |

每个文件和 ID 均归属恰好一个分片，运行结果覆盖完整分片计划，无遗漏或重复。这里的唯一归属不禁止既有 retry。Windows 第3片的 `rfc294-human-gate-restart.spec.ts` 有一个首轮失败测试，引发同一 serial 组的三个身份重试；最终成功，其余9片无 retry。保留原 retries=1，不将本轮描述为零 flaky。

[自动 timing collector 45924638197](https://github.com/wangbinquan/agent-workflow/actions/runs/45924638197) success。虽然 workflow_run 的外层 HEAD 已随并发主线前进，日志明确 checkout 验收 SHA097d、下载本 run45921188560；产物名为 `reviewed-ci-timings-45921188560`，ZIP digest 相符。后端44份完整原始测量覆盖3108文件，实测总和24923826ms，unmeasured/removed均空。E2E 完整性检查后正确输出 `skipped / retried-tests`，仅列上述 Windows 文件，未生成或应用污染的 E2E 权重。严格 CLI 的独立回放与 hosted 结果一致。

后继 RFC-616 已另增20个后端测试及新 E2E；这些不属于097d的源树。本任务不伪造其测量、不删除或回退并发产出，新文件继续走既有默认权重与完整执行规则。当前共享 HEAD 上手动单源 CLI 若投影到后继树，会诚实记录20个 unmeasured；这与自动 collector 固定097d目标的零缺失并不冲突。

## 实施与验证记录

- `1b9825b9`：macOS4→3、完整 E2E 权重和 source topology 严格兼容；首轮主 CI 因后端10超过原15分钟取消，非绿证据保留在 plan/proposal，不列作成功提速样本。
- `097d41d6`：两个完整成功来源的逐文件较大实测值重平衡后端，44片/15分钟不变；严格准备器保留每个值的真实来源，原单源 CLI 输出兼容。
- 完整候选集中验证：9文件136 pass、0 fail、2721断言；相关TypeScript、ESLint、Prettier、actionlint均通过。设计与实现独立功能门PASS，原生44片边界、3108文件逐值与来源审计PASS。
- 保留 Linux/macOS arm64/Windows、SQLite/PostgreSQL、coverage、全部13组 required、原case/job timeout、worker/retry配置及严格失败规则。没有新增付费 runner、修改账户配额或自动重跑规则。

完整原始日志、API快照、artifact摘要、逐文件来源和离线对比保存在本次本地证据目录 `/private/tmp/aw-ci-round3-20261126/`；GitHub链接与已提交来源metadata可用于复核，临时目录不作为永久唯一证据。
