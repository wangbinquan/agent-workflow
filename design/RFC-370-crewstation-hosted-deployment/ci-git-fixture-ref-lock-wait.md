# CI：原 Git 崩溃夹具的残锁等待

该批只处理总绿前的既有测试夹具故障，不改变 AW 或 CS 的生产行为。

`c73756628b9ee2705918889067ac991e48861274` 主 run `37868217985` 的 macOS 后端 `6/12` 作业 `113619940054` 中，`rfc303-worktree-abort-cleanup.test.ts` 第一个原 case 在 `5131.62ms` 失败，日志明确记录 `this test timed out after 5000ms`。同组出现十四次 `terminal-race.lock` 残锁错误。原 helper 最多调用 Git 二十一次，显式 sleep 是十九次 `25ms`，子进程启动成本额外累积。

原 `util/git.ts` 的取消路径先等待 `proc.exited`，然后才到 `worktree-add-failed-before-cleanup` 测试钩子。夹具在这里规范化原部分结果，再构造原崩溃形态。生产代码继续使用原始取消与清理流程。

本次保留第一次真实 `git worktree add` 的完整参数、`cwd`、非残锁错误传播。仅在原 `cannot lock ref` 错误后，直接检查该夹具的原 ref lock，沿用十九次 `25ms` 的最大显式等待；锁自然消失时提前结束等待。随后沿原路径移除夹具残锁，使用相同 Git 命令重试一次，最终错误仍传播。Git 调用最多二次。

两个原 case、全部断言、测试预算、真实仓库/目录/分支材料化、非空目录保留，以及生产清理和 Git 规则全部保留。不新增生产、架构输出或 census；原 N1 唯一成功 census 仍复用。验证采用精确源码保留、限定格式/lint 与独立功能检视，再按 exact-SHA hosted 总流水线及实际两例验收，不运行本机 AW tests/typecheck/build/services/E2E。

截至本候选，独立功能门与新提交 CI 待验收。原失败历史保留。N2/H7/A-T7/A-G、CS M0～M4 继续开放，AW 尚未部署 CS。
