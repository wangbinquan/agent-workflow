# 真实业务工作流用例

这组 YAML 把调度能力放进可识别的业务闭环，而不是只验证孤立节点。配套真实 daemon
端到端测试位于
[`../../../e2e/business-workflow-scenarios.spec.ts`](../../../e2e/business-workflow-scenarios.spec.ts)：
YAML 通过公开导入与精确 revision 校验接口进入系统，任务再经过 SQLite、scheduler、
隔离 Git worktree、包装器、人工作业状态与输出投影；只有外部模型由确定性桩替代。
跨 Workflow / Workgroup 的业务验收合同与后续场景见
[`../../BUSINESS_SCENARIOS.md`](../../BUSINESS_SCENARIOS.md)。

## 用例

### `defect-fix-controlled-release.yaml`

模拟线上结算金额缺陷的受控修复：

1. `wrapper-loop` 每轮驱动一个 `wrapper-git`，任务只在隔离工作树中改文件，不提交、不推送；
   每轮审计和测试消费该轮真实差异。
2. 第一轮修复解决取整问题，但代码审计与契约测试共同发现非法输入未防护。
3. 质量门把首轮失败证据写入 `business-evidence/quality-gate.md`；第二轮修复必须在同一
   工作树读取它并修复遗留问题。
4. 复审返回 `clean`、测试返回 `passed` 后质量门才放行；发布包接收最后一轮差异，并从
   质量证据账本读取两轮由失败到 clean 的完整链路，最后由人工批准。

所需 Agent 输出契约：

| Agent                       | 输出                                                |
| --------------------------- | --------------------------------------------------- |
| `business-fix-engineer`     | `fix_summary: markdown`                             |
| `business-code-auditor`     | `audit_status: string`, `audit_report: markdown`    |
| `business-test-runner`      | `test_status: string`, `test_report: markdown`      |
| `business-quality-gate`     | `quality_status: string`, `release_brief: markdown` |
| `business-release-preparer` | `release_brief: markdown`                           |

### `document-batch-compliance-publishing.yaml`

模拟一批政策文档的合规审阅和出版：

1. 启动器接收仓库内 Markdown 文件列表与统一合规政策。
2. `wrapper-fanout` 每个文件产生一个真实分片，广播政策，并在所有分片完成后聚合证据。
3. Publisher 在 `drafts/` 生成公告与核对表，每篇携带稳定的 `business-publish-path`
   元数据，并用 `list<markdown>` 一次提交多篇文档。
4. 人工首轮驳回后，Publisher 获得驳回意见与 Prior Output 并修订；第二轮逐篇选择后批准，
   独立 Releaser 只把接受的文档写入 `published/`，未接受的草稿没有发布路径。

所需 Agent 输出契约：

| Agent                            | 输出                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `business-document-reviewer`     | `finding: markdown`                                                      |
| `business-compliance-aggregator` | `report: markdown`；`role: aggregator`；包装器端口名 `compliance_report` |
| `business-document-publisher`    | `documents: list<markdown>`                                              |
| `business-document-releaser`     | `published_paths: list<path<md>>`                                        |

## 本地验证

```sh
bun run build:binary:e2e
bun run e2e e2e/business-workflow-scenarios.spec.ts
```

配套测试桩只替代模型生成，不绕过公开 API、任务 worktree、Git diff、Loop/Fanout
调度、Review 拒绝/选择/批准或持久化。
