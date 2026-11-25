# RFC-591 git 进程运行器归 platform（RFC-294 W5 余项第三步：`util/git` 拆成通用运行器与仓库语义）

- **状态**：Done（2026-11-25，落地 `992ae6140`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」——是对本会话列出的
  待定事项（含 W5 的 `util/git` 怎么拆）的回复：本会话按 RFC-294 总纲自行裁定，选 RFC-586 条目里的方案（b），偏离项见 design §0；设计门免、不派
  Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §8 / §15 与 plan W5；上一步见
  [RFC-586](../RFC-586-merge-conflict-resolution-into-source-control/proposal.md)。

## 1. 背景

`util/git.ts`（3968 行、87 个导出）是 W5 的最后一大块。RFC-294 design 写的是整份归 source-control，但它的导出里有一类与仓库语义无关：`runGit`——
`git -C <cwd> …` 的进程运行器（非交互环境、`-c` 加固参数、超时与取消时杀进程组、管道读取上限）与 `nonInteractiveGitEnv`、`GitRunResult`、两个
退出码。`runGit` 有 31 个读者，分布在 source-control、task-execution、development-automation 与 **platform**（版本探测、工作树备份、启动升级环境）；
platform 不依赖任何模块，整份归 source-control 就得把 platform 的这三处挪走、再给 runtime-management / collaboration / system-operations 补到
source-control 的边（方案 a）。

## 2. 目标

- **G1**：通用运行器逐字迁入 `platform/execution/local/gitProcess.ts`（与进程、平台 spawn 选项的工具同层）：`GitRunResult`、`nonInteractiveGitEnv`、
  `runGit`、`GIT_TIMEOUT_EXIT_CODE`、`GIT_ABORTED_EXIT_CODE`。旧位置不留转出；`util/git.ts` 自己的仓库操作改从新位置取。
- **G2**：全部读者改取新位置；行为不变（同一段代码、同一套加固参数与环境）。
- **G3**：其余计数不升；DAG 之外的边不增加；`util/git.ts` 剩下的都是仓库语义，下一步整体归 source-control。

## 3. 非目标

- `util/git.ts` 余下的仓库语义（下一步）；`util/gitHardening.ts` 与凭据、文件信任、安全路径一族（暂缓，本 RFC 只是新文件照旧 import 它）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：五个名字只在 `platform/execution/local/gitProcess.ts` 定义，`util/git.ts` 不再导出它们；新文件与原来那几段逐字相同。
- **AC-2**：全部读者改取新位置，没有说明符再从 `util/git` 取这五个名字；行为不变：git 相关用例通过。
- **AC-3**：计数不升；DAG 之外的边不增加；新增 RFC-591 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
