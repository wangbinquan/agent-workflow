# RFC-395 T19：本机单机实例（2026-10-28）

## 决定

本机实例 `~/.agent-workflow` 是分叉的开发库：已发布迁移到 0258，另有 14 条从未发布的迁移（RFC-370 M1 的原版 0259 与 13 条从未进入任何提交的开发期迭代）。转换器按 migration §3 拒绝未知指纹；已发布版本自 10/16 起同样无法启动这个库（见 plan「本机只读采样试算」）。

用户 2026-10-28 选择「归档后全新安装」：旧目录原样改名保留，本机用 epoch-2 全新安装；本机的任务历史、代理、工作流等不带入新实例。这条路不经过 epoch 切换，不产生迁移计划与批准材料，因此不填 `rehearsal-template.md` 的切换字段。

## 执行记录

时间均为 UTC。原始日志在 `/private/tmp/rfc395-t19/local-instance.log`（本机）。

| 步骤 | 实际结果 |
| --- | --- |
| 前置检查（04:40:01） | 没有 daemon 在使用该目录（`lsof` 无打开文件）；本机唯一相关的 LaunchAgent 是 GitLab 中继，只用 `~/.agent-workflow-gitlab`，与实例目录无关 |
| 归档（04:40:13） | `~/.agent-workflow` 同卷改名为 `~/.agent-workflow.epoch1-archive-20261028`，约 43 GB，其中 `db.sqlite` 24.7 GB；没有删除或改写任何文件 |
| 安装（04:40:22） | 用最终候选 `c431dac3a` 的 CI 正式产物（运行 40611938709，`agent-workflow-macos-arm64`，SHA-256 `32a5cfa1ac1fc24ecbebfbbca7f3c002ac1bdf343b89cdce699113e0a9e9ebfd`）执行 `agent-workflow migrate`，写入默认配置并安装数据库 |
| 新代次 | `database-generation.json`：`schemaEpoch: 2`、`role: installed`、`provider: sqlite`、`generationId: dbg_7a087f8a-2260-44d7-8694-2a58099cced2` |
| 试启动（04:40:32） | `agent-workflow start --port 47930`，`/health` 返回 `ok: true`，`status` 显示运行中 |
| 停止（04:40:40） | `agent-workflow stop` 正常退出。之前该实例没有在运行，这里也保持不运行 |

## 之后如何使用

- 启动：`agent-workflow start`。首次启动会提示初始管理员的设置入口。
- 旧数据：只在归档目录里，不会被自动删除。已发布版本打不开这个分叉库，旧资源无法直接导出，需要时在新实例中重建。
