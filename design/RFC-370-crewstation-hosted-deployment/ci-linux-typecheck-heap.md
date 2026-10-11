# RFC-370：主 CI Typecheck 堆上限修复

精确 `16ba8f3668301e5a6afaf10616f25d871b2f6740` 的主 CI `38132049327` 已正式 failure，66/72 作业成功。`Lint + Typecheck + Format + Shared + system mock tests` 作业 `114448226496` 的 format、lint 与依赖分层检查成功，shared/frontend/system-mocks 三个工作区 Typecheck 均 code 0；backend tsc 在约 4024 MB 堆上反复 GC 后报 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`，最终 SIGABRT/code 134。该原日志的完整 23062 字节摘要为 `3677f2ab9ef232d892fd4e7ab6d12e03121749ad719fae314385a621ad35131e`。这是现有 Typecheck step 的 Node 堆容量阻塞，尚未得到这次 backend Typecheck 的成功结果。

本批只在 `.github/workflows/ci.yml` 的原 Typecheck step 增加 `env.NODE_OPTIONS: --max-old-space-size=6144`，与已发布 `.github/workflows/windows-platform.yml` 的完整 Typecheck step 相同。原 `bun run typecheck` 命令、四工作区输入、严格类型规则、全部作业/步骤、触发与并发方式及十五分钟预算保持；只对该 step 生效。Windows 流程、生产和测试源码保持，本批没有新增 census 或本机 AW 测试、类型检查、构建、服务、E2E。

这次主 CI 的另四个失败分片归属两项问题：原 RFC-294 §A2 status 全文投影不相等，以及新增 temp Message 回退夹具未满足原无物理查询断言；默认完整 Windows `38132049380` 也在同一 temp 用例失败，其后 Typecheck/compile 等步骤没有执行。相关 RFC-371 源文件和整套架构配套属于其原会话，本批不修改或提交其在制输出，已按真实阻塞做必要发布协调。Static scans 作业 `114448226341` 全部十四步为 success，只读取状态元数据，没有展开其原日志；用户仅授权必要 CI 排障的范围继续保持。

独立功能实现检视按三条 owned path 验证本 step 的完整逆变换、两份 CI 文档的事实和原正文保持；CI 配置微调沿用既有 RFC，不新增产品设计或行为。限定 Prettier 与纯字节/YAML检查通过后按共享 main 两把锁的短临界区精确提交，完整共享文件的原内容保持。后继包含本修复的精确 SHA 必须取得主 CI 全部 72 作业与完整默认 Windows 全部 26 步终态 success，并实际核对八条工作区 Typecheck code 0、H/L/R/SO 568 次及原 boot 69 次具名执行，才能继续下一适配层；这些结果目前均未签收。

原失败、有限 PASS/FAIL、源提交/退役提交和唯一原生成记录完整保留。此前三个 macOS 超时的源码及预算保持，原因仍未建立。本批不签完整 H7 三根十九 owner、A-T7/A-G、各层 CS adapter、M0–M4、CS 部署或 RFC 完成；AW 尚未部署 CS。
