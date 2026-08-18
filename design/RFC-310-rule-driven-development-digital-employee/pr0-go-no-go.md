# RFC-310 · PR-0 T8 go/no-go 报告

> 状态：✅（2026-08-18）。判据按 2026-08-18 用户裁决修订后的 plan.md PR-0 目标：无 OS 沙箱/网络管控，
> 机制为「提示词禁止 + 前后快照事后校验 + 违规整树回退 + 零凭据/零 Git identity 注入」。
> **结论：全部 pass，进入 PR-1。**

## A. 架构前提（RFC-294 依赖方向）

| 项                                                                | 结论     | 证据                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 `development-automation` 七层骨架 + exact public 入口可落地    | **pass** | `modules/development-automation/{public/types.ts,composition.ts,composition/required-ports.ts}` 落地且 `rfc294-architecture-preflight` 全绿。**偏离记录**：全仓无 bootstrap 单点，沿用「exact composition entrypoint + 装配散点」既有惯例（identity-access/source-control 同形），不在本 RFC 新造全局 bootstrap 目录 |
| A2 consumer-owned required-ports 只被 composition/登记 adapter 用 | **pass** | preflight `crossContextViolations` 原生放行 `application/adapters/*-adapter.ts` 的 type-only import（`rfc294-architecture-preflight.test.ts:253-258`）；`rfc310-architecture-lock` 锁模块内 composition-only + 全仓消费者 toEqual 账本（当前 []）                                                                    |
| A3 既有 ratchet 可扩展覆盖新模块（负 fixture 打红）               | **pass** | `rfc310-architecture-lock.test.ts` 6 条规则，变异实证 5 次全部打红后还原全绿（domain-hono / services-import-composition / public-misc / legacy-code-capability-import / GIT_AUTHOR_NAME token）                                                                                                                      |

## B. runtime 检测/回退前提

检测机制是文件系统层（快照对拍），runtime-agnostic；OpenCode/Claude 的差异面（env 组装）分别验证。
证据：`tests/rfc310-pr0-detect-rollback-probe.test.ts`（6/6，全部真实子进程）+ `tests/helpers/rfc310MetaSnapshot.ts`。

| 项                                                           | OpenCode | Claude Code | 证据                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 业务路径正向写成功并进入真实 diff                         | pass     | pass        | B1 用例：git 只读命令（`GIT_OPTIONAL_LOCKS=0`）+ 业务写 → 保护面对拍 []、业务树 digest 变化                                                                                                                                |
| B2 Git metadata 写（commit/index/refs/config）被快照对拍检出 | pass     | pass        | B2 用例：真实 `git commit` → HEAD/objects/index/logs 多处 violation，全部 root=git-meta                                                                                                                                    |
| B3 evidence/受保护路径写被检出且分类正确                     | pass     | pass        | B3 用例：file API 写 refs、写 `.agent-workflow/pipeline` → added violation 且 root 标签正确                                                                                                                                |
| B4 violation 后 workspace 从 baseline byte-identical 重建    | pass     | pass        | B4 用例：整树废弃重物化 → 业务树 digest 相等 + HEAD sha 相等 + porcelain 空（口径注释见测试头，PR-4 沿用）                                                                                                                 |
| B5 spawn env 无 Git identity / 平台 connection secret        | pass     | pass        | B5 用例：`buildOpencodeEnv`（无 identity 参数）不新增 GIT\_\*；`assembleClaudeEnv` 受控 source 下零 GIT\_\* 键；spawn-through 子进程实测 ABSENT。secret 面：平台 connection secret 存 DB 不入 env（PR-4 T44 再锁生产链路） |
| B6 同形攻击（file API / `GIT_DIR` 绝对定位）零漏报           | pass     | pass        | B3 用例含 `GIT_DIR=<ws>/.git git update-ref`（进程 cwd 在 workspace 外）仍被检出                                                                                                                                           |

## C. provider/evidence 前提

证据：`tests/rfc310-pr0-evidence-sink-probe.test.ts`（4/4）+ `packages/system-mocks/src/development/{requirement,pipeline}-provider.ts` + 包内合同测试 `rfc310-development-providers.test.ts`。

| 项                                                              | 结论     | 证据                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 one-shot EvidenceSink 流式导入，峰值内存不随日志线性增长     | **pass** | **probe 先照出真缺陷**：Bun fetch/node:http 客户端不背压（裸读丢 128MB → RSS 峰值 680MB/580MB，线性）。改为「curl 子进程落盘 + 流式 hash 登记」后 64MB 探针 peakDelta 仅个位 MB，断言 <48MB 稳定通过；生产合同确认 adapter 自行落盘、daemon 绝不代理大响应（gotcha 已沉淀） |
| C2 safe-walk 拒绝 traversal/symlink/device/超预算               | **pass** | `../`、绝对路径、`a/../b`、单文件超限、总量超限、symlink、fifo 全部拒绝（fifo posix-only）                                                                                                                                                                                  |
| C3 runnable requirement/pipeline provider mock 可起、可产多文件 | **pass** | 真 node:http 服务：REQ 元数据+3 文件下载；pipeline 多 gate + content-length 精确的流式日志                                                                                                                                                                                  |

## D. 结论

全部 pass ⇒ 进入 PR-1（规则与配置内核）。两点跟进：

1. mock 的 suite 集成（service 前缀 + 控制面 + 故障注入）按 plan 归 PR-3 T36 / PR-6 T70，PR-0 刻意不动 `suite.ts`；
2. B5 的 secret 面在 PR-0 只证「env 组装函数不注入」；「connection secret 不进 Agent env/文件/MCP」的生产链路负向测试归 PR-4 T44/T52。
