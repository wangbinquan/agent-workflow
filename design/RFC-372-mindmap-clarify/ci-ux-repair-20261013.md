# RFC-372 UX 发布后的 CI 修正

功能与真实验收提交为 `f3ab372d9e42604b3041759e91470bffb5a20f36`。本记录只补该提交暴露的配套遗漏；日常 AW 的两次真实模型任务、最终文档和实际录制回放见 [真实验收记录](real-aw-ux-acceptance-20261013.md)。本次不改产品、模型输出、问答协议或任务推进逻辑。

## 本次责任与修正

主 CI `38360391078` 的 Windows frontend shard 3（job `115172936073`）暴露两个本次遗漏：

1. `header-compaction.test.ts` 只接受固定字符串 className。脑图页面已改为追加条件 class 的模板字符串，原 `page` / `page--clarify-detail` 仍无条件保留。现在先定位正式 `clarify-detail-page` 根节点，再要求插值之前的静态 class 同时包含两个完整名称；loading/error 页面不能替代正式根满足断言，所有 CSS 紧凑布局约束保留。
2. `overlay-ux-inventory.test.ts` 漏记 `MindmapWorkspace.tsx` 的一个公共 Dialog。补入原 `review-and-clarify` 家族，并注明已有行为与响应式 E2E 归属。原 AST 双向精确集合比较、家族归属和移动端约束不变。

主 CI 静态检查 job `115172935767` 还将实际录制文档的两个示例幂等 UUID 命中 `generic-api-key`。这两个值是模型设计文档中的预约请求示例，不是认证凭据。为保留真实文档逐字回放，只在既有 `.gitleaksignore` 追加 `f3ab372d9` 下确切文件、规则与第 531/532 行的历史指纹；不改变扫描配置或加入路径级忽略。

以上三项已以 `0bb5e5fc7f29df50f4fa75e0aa77e806e0644669` 正常后继提交并推送。稍后完成的 Markdown link job `115172935699` 指出真实验收记录中两条 localhost 任务链接无法从 GitHub runner 访问；这是本次文档遗漏。后继将它们改为任务名称、完整任务 ID 与本地路径说明，保留可定位性，不关闭链接检查或为 localhost 扩大忽略。

## 集中复验

- 最终 `header-compaction` 与 `rfc372-workspace-ux`：2 files / 21 tests passed，3.01s；日志 `ux-ci-ratchet-repair-final.log`。
- 两份测试的定向 Prettier、ESLint 和差分空白检查通过。有限独立功能复核 PASS。
- 首次本地复验保留失败：头部匹配曾选中 loading 页，已改为正式根定位；overlay 的本次脑图漏项已消失，但共享树另外三个未发布观测组件仍使完整 inventory 失败（`ObservationAnomalies`、`ObservationExecutionAnalysis`、`ObservationMaintenance`，共四个 Dialog）。其内容保留，未扩充清单替其他会话修复；原始日志 `ux-ci-ratchet-repair.log` 留存。
- 产品及录制内容未变化，复用此前双 provider、真实模型任务、四尺寸交互和完整录制 E2E 的有效结果，不重复全仓本地 gate。完整 inventory 与历史指纹修正由后继确切提交的 hosted CI 验收。

## 其他失败及未闭合项

`f3ab372d9` 的 visual-regression-nightly `38360391074` 和 integration-opencode `38360391076` 均已 success；Windows `38360391073` failure（1492 pass / 3 skip / 14 fail），主 CI 此记录写入时尚未终态。不能据专项成功宣布全仓通过。

原 frontend shard 1 的两个观测投影刷新失败，在父提交 `a5e6582a7` 的 job `115169786000` 有同名失败及相同额外 projection-version 请求。其余报告刷新、provider/SQL 登记、根装配原样检查及格式失败均保留具体日志与基线 blob 对照；本次 f3ab 差分没有改变相应源文件。Markdown 编辑器的三个旧布局/样式检查已由后继 `4888202b` 修改，这不是本次脑图修正，不代签其通过。

证据目录为 `.agent-workflow/rfc372-real-acceptance-20261013/ci-f3ab372d9/`。`backend-failure-base-blobs.json` 保存 11 份相关源文件在父提交与本提交的相同 blob；其他前端、根装配及格式证据见同目录既有日志、`failure-baseline-blobs.json` 和 parent 日志。失败归属依据是具体断言、调用链与确切差分，不只依据文件名前缀或谁执行 push。

共享 13 份架构清单仍包含其他会话尚未发布的源码投影，本次不覆盖或扫入。自身清单同步与新确切提交的全仓 CI 仍开放，RFC 保持 In Progress；不发送跨 session 信息。
