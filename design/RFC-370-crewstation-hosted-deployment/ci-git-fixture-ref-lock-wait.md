# CI：原 Git 崩溃夹具的残锁等待

该批只处理总绿前的既有测试夹具故障，不改变 AW 或 CS 的生产行为。

`c73756628b9ee2705918889067ac991e48861274` 主 run `37868217985` 的 macOS 后端 `6/12` 作业 `113619940054` 中，`rfc303-worktree-abort-cleanup.test.ts` 第一个原 case 在 `5131.62ms` 失败，日志明确记录 `this test timed out after 5000ms`。同组出现十四次 `terminal-race.lock` 残锁错误。原 helper 最多调用 Git 二十一次，显式 sleep 是十九次 `25ms`，子进程启动成本额外累积。

原 `util/git.ts` 的取消路径先等待 `proc.exited`，然后才到 `worktree-add-failed-before-cleanup` 测试钩子。夹具在这里规范化原部分结果，再构造原崩溃形态。生产代码继续使用原始取消与清理流程。

本次保留第一次真实 `git worktree add` 的完整参数、`cwd`、非残锁错误传播。仅在原 `cannot lock ref` 错误后，直接检查该夹具的原 ref lock，沿用十九次 `25ms` 的最大显式等待；锁自然消失时提前结束等待。随后沿原路径移除夹具残锁，使用相同 Git 命令重试一次，最终错误仍传播。Git 调用最多二次。

两个原 case、全部断言、测试预算、真实仓库/目录/分支材料化、非空目录保留，以及生产清理和 Git 规则全部保留。不新增生产、架构输出或 census；原 N1 唯一成功 census 仍复用。验证采用精确源码保留、限定格式/lint 与独立功能检视，再按 exact-SHA hosted 总流水线及实际两例验收，不运行本机 AW tests/typecheck/build/services/E2E。

截至本候选，独立功能门与新提交 CI 待验收。原失败历史保留。N2/H7/A-T7/A-G、CS M0～M4 继续开放，AW 尚未部署 CS。


## 2026-10-09 当前 main 总绿与 N2 调用者设计

40a0d70518f31d18321ae7680bf946a733b74d91 主 CI37872131154 全72/72 success，原 Windows workflow 手动dispatch37873022203 同SHA success/Typecheck通过，全部73 terminal jobs已完整消费；原RFC303两case在Mac/Ubuntu各成功，5000ms和全部断言保持。旧failure/INVALID保留，用户总绿门槛满足，CI修复闭合。N1原8768599的196真实provider案例及原完整main/Windows总绿已消费，40a包含且相关完整source blobs保持，不重复该候选全门或census。

继续已批准N2有限设计：80直接/helper Node动作明确28准备/52结果；进一步核对四个混合run-row helper、三个clarify事件、两个unowned spawn回执和dynamicWorkflow转交。拟新增中立显式选择、selected-only装配标记和真实caller接线，managed effect仍由原登记者负责；详见host-authority-task-node-callers.md。设计门/实现/唯一原census/配套/精确上库及new exact-SHA总绿各自验收。本机无AW执行，全部既有正文与并行输出保持。完整H7/A-T7/A-G/十九owner/三roots/CS M0～M4仍开放，AW未部署CS；继续RFC，不以本有限批收尾。
