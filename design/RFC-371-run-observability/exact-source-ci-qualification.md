# 完整 CI 按原提交取得终态

## 触发与目的

RFC-371 的 `9fa8c3d4` 主 CI `37465298886` 和类型修复 `a1f97e05` 主 CI `37468182178` 均因后继 main 推进被取消，不能把已有通过 job 当成整个源版本的正式结论。后一提交的 Format / Lint / Typecheck 实际均 success，类型修复已被正式执行；其余被取消的 job 仍没有终态验收。

现有主工作流按 `${{ github.workflow }}-${{ github.ref }}` 分组并启用 `cancel-in-progress: true`。共享 main 正常小步发布会持续取消先前原 SHA；这与确切源版本必须完整验证的要求冲突。

## 候选

只将 `.github/workflows/ci.yml` 的工作流级 group 增加 `${{ github.sha }}`，并设 `cancel-in-progress: false`。不同原提交有独立组，已有运行不再被新提交取消；同一 workflow/ref/SHA 的重复运行仍在同组串行。原 push / pull_request / workflow_dispatch、所有 job / native shard / 双 provider / 类型 / E2E 范围、命令、环境、样本与超时预算逐字保留。没有自动重试、过滤、删断言或增加任务/调用上限。

[GitHub 官方 concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)说明：同组默认只保留一个 pending，新 pending 会替换旧 pending；`cancel-in-progress: true` 也会取消运行中项目。因此只关取消但继续按 ref 分组仍不能保证不同原 SHA 的等待检查都被执行。按原 SHA 分组消除该碰撞，不需要另建分支或工作树。

当前 Windows 工作流仍有其他会话的未提交配置与依赖，本片不收编或改写它们；待文件及依赖正常就绪后，再按当前实际候选处理其定时/手动运行的同类配置。原 observability-scale 已按原 target SHA 分组且禁止取消，保持原 100K/10M 与240分钟预算。

## 验证与验收

设计门和实现门只审功能。纯 YAML 与文本逆变换证明原 triggers/jobs 一致、确切 SHA 分组不同且原候选配置唯一；不为两行配置新增镜像实现测试。本机只做自有格式和纯源码核对，不运行 AW tests/typecheck/build/services。上库后等待该确切 SHA 的完整正式 CI，原失败/取消结果保留，不能将本设计、静态核对或部分通过记成最终成功。
