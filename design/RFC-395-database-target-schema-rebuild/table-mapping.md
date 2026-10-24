# RFC-395 逐表处置清单

## 1. 范围与判读

本清单按源码合同的 **217 张源表逐张列出，恰好一次**。基线 `3fcb14dbf8ab27cf451934942ea6b9cd647077f8`，contract v2，digest `sha256:8e6510d4d0927d538692ecf22cde0b1fa9a97c733a9e044af8d9768418ecb956`。

“保留”表示保留表的业务边界和现有非变更字段语义，仍需进入显式 schema contribution、provider codec 与迁移校验，不是豁免审查。“拆分 / 替换 / 关系化”表示物理模型改变；“共用机制”不等于物理合表；历史化不等于丢数据。源合同的 owner / disposition 是旧标签，仅作对照，目标 owner 是本 RFC 明确裁决。

下列条目是设计处置，不是逐表迁移已经通过的证明。键、约束、retention 与真实读写者的机器合同由 plan T1/T2 固化；不能用本文的“保留”覆盖实施发现的未处理差异。源完整列定义仍以当前合同和实际源指纹为准，2,639 列需在转换 manifest 中全部分类。

处置数量：保留 179、关系化 1、投影索引 1、内容引用 12、共用机制 4、拆分 3、替换 1、归档 6、历史化 7、退役迁移态 1、收缩迁移态 1、中立化 1。表总数不设下降目标；目标物理表总数在 schema contribution 编译后精确产生，不以本清单推算作为上线约束。

**2026-10-24 更正（源表数）**：本清单定稿后，RFC-396 新增 5 张表：`development_designs`、`development_design_revisions`、`development_design_proposals`、`development_design_baselines`、`development_design_links`。II-b 的源合同因此是 **222 张**（plan §6.7「规模」）。这 5 张按实际写入方归 development-automation，处置为保留：R1 的目标 registry 原样复用，V1 冻结的 epoch-1 roster 也逐张列出。处置数量相应为保留 184，其余不变；本文其余各处的「217」指定稿时的基线。之后再有 RFC 新增 epoch-1 表，按 migration §3 同步登记目标 contribution 与转换器支持的源版本。

## 2. 全部源表

| 源表 | 旧 owner / disposition；列数 | 目标 owner | 处置 | 目标与理由 |
| --- | --- | --- | --- | --- |
| `action_template_revisions` | resource-catalog / KEEP；6 | development-automation | 保留 | `action_template_revisions`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `action_templates` | resource-catalog / KEEP；11 | development-automation | 保留 | `action_templates`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `agents` | resource-catalog / KEEP；21 | resource-catalog | 关系化 | `agents + agent_skill_refs + agent_mcp_refs + agent_plugin_refs + agent_dependencies`；正文与端口定义保留；四类独立引用从 JSON 数组移至有序 typed 关系。 |
| `application_configuration` | system-operations / KEEP；4 | system-operations | 保留 | `application_configuration`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `auth_login_policy` | identity-access / KEEP；5 | identity-access | 保留 | `auth_login_policy`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `automation_policies` | resource-catalog / KEEP；10 | development-automation | 保留 | `automation_policies`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `automation_policy_revisions` | resource-catalog / KEEP；6 | development-automation | 保留 | `automation_policy_revisions`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `cached_repos` | source-control / KEEP；12 | source-control | 保留 | `cached_repos`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `capability_templates` | resource-catalog / KEEP；22 | code-capability | 保留 | `capability_templates`；保留能力模板与仓库绑定，校正合同 owner；不迁入通用资源 CRUD。 |
| `clarify_rounds` | collaboration / KEEP；25 | collaboration | 拆分 | `clarify_rounds + clarify_answers + clarify_answer_drafts`；问题快照留 round；最终答案/草稿/归属按 question_id 更新，封口原子。 |
| `code_ai_attempts` | integration / DEFER；12 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `code_artifacts` | integration / ARCHIVE_THEN_OMIT；13 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_findings` | integration / DEFER；23 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `code_fix_attempts` | integration / ARCHIVE_THEN_OMIT；9 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_host_connections` | integration / KEEP；11 | integration | 保留 | `code_host_connections`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `code_mr_leases` | integration / ARCHIVE_THEN_OMIT；5 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_produced_mrs` | integration / ARCHIVE_THEN_OMIT；8 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_publish_intents` | integration / ARCHIVE_THEN_OMIT；9 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_round_stages` | integration / DEFER；10 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `code_trigger_deliveries` | integration / DEFER；17 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `code_work_items` | integration / DEFER；18 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `code_work_observations` | integration / ARCHIVE_THEN_OMIT；8 | code-capability/history | 归档 | `versioned code-history archive`；现合同已 ARCHIVE_THEN_OMIT；双 provider 均归档原 ID/字节/关系，目标在线无表。 |
| `code_work_rounds` | integration / DEFER；12 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `collaboration_gate_artifacts` | collaboration / KEEP；10 | collaboration | 内容引用 | `collaboration_gate_artifacts`；保留人工门/评论的独立关系与状态；正文或制品地址统一为内容引用。 |
| `collaboration_gate_operations` | collaboration / KEEP；22 | collaboration | 保留 | `collaboration_gate_operations`；人工门操作、审核人、协作者、反馈、问题分发保留不同语义；task_questions 不与答案合表。 |
| `committed_event_aggregate_heads` | platform-events / KEEP；6 | platform/committed-events | 保留 | `committed_event_aggregate_heads`；业务提交、aggregate 序号、消费者投递分别保留；跨库转换不重复业务 effect。 |
| `committed_event_deliveries` | platform-events / KEEP；16 | platform/committed-events | 保留 | `committed_event_deliveries`；业务提交、aggregate 序号、消费者投递分别保留；跨库转换不重复业务 effect。 |
| `committed_event_family_cutovers` | platform-events / DEFER；6 | platform/committed-events | 收缩迁移态 | `committed_event_family_cutovers (target routing)`；保留当前家族路由，移除仅迁移阶段的旧 writer 状态；不得整体归档删除。 |
| `committed_events` | platform-events / KEEP；19 | platform/committed-events | 保留 | `committed_events`；业务提交、aggregate 序号、消费者投递分别保留；跨库转换不重复业务 effect。 |
| `cs_event_inbox` | integration / KEEP；11 | integration | 保留 | `cs_event_inbox`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `cs_event_routes` | integration / KEEP；11 | integration | 保留 | `cs_event_routes`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `cs_event_targets` | integration / KEEP；15 | integration | 保留 | `cs_event_targets`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `cs_webhook_verifications` | integration / KEEP；2 | integration | 保留 | `cs_webhook_verifications`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `custom_event_source_definitions` | event-center / KEEP；7 | event-center | 保留 | `custom_event_source_definitions`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `custom_event_source_revisions` | event-center / KEEP；7 | event-center | 保留 | `custom_event_source_revisions`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `development_action_runs` | development-automation / KEEP；17 | development-automation | 保留 | `development_action_runs`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_adapter_definition_revisions` | development-automation / KEEP；6 | development-automation | 保留 | `development_adapter_definition_revisions`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_adapter_definitions` | development-automation / KEEP；11 | development-automation | 保留 | `development_adapter_definitions`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_agent_attempts` | development-automation / KEEP；14 | development-automation | 保留 | `development_agent_attempts`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_approval_sagas` | development-automation / KEEP；20 | development-automation | 保留 | `development_approval_sagas`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_bundle_refs` | development-automation / KEEP；9 | development-automation | 保留 | `development_bundle_refs`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_decisions` | development-automation / KEEP；16 | development-automation | 保留 | `development_decisions`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_deferred_wakes` | development-automation / KEEP；10 | development-automation | 保留 | `development_deferred_wakes`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_effects` | development-automation / KEEP；12 | development-automation | 保留 | `development_effects`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_fact_snapshots` | development-automation / KEEP；8 | development-automation | 保留 | `development_fact_snapshots`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_feedback_ledger` | development-automation / KEEP；12 | development-automation | 保留 | `development_feedback_ledger`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_mission_links` | development-automation / KEEP；18 | development-automation | 保留 | `development_mission_links`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_mission_sources` | development-automation / KEEP；14 | development-automation | 保留 | `development_mission_sources`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_missions` | development-automation / KEEP；41 | development-automation | 保留 | `development_missions`；41 列不是单凭 nullable 数量拆分；source/delivery/终态条件显式化，制品引用统一。 |
| `development_mr_claims` | development-automation / KEEP；10 | development-automation | 保留 | `development_mr_claims`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_object_artifacts` | development-automation / KEEP；5 | development-automation | 内容引用 | `development_object_artifacts`；保留开发业务对象索引，接入同一内容发布/引用机制。 |
| `development_repository_upload_plan_entries` | development-automation / KEEP；11 | development-automation | 保留 | `development_repository_upload_plan_entries`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_repository_upload_plans` | development-automation / KEEP；8 | development-automation | 保留 | `development_repository_upload_plans`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_repository_upload_receipts` | development-automation / KEEP；10 | development-automation | 保留 | `development_repository_upload_receipts`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_step_joins` | development-automation / KEEP；10 | development-automation | 保留 | `development_step_joins`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_step_runs` | development-automation / KEEP；19 | development-automation | 保留 | `development_step_runs`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `development_wake_hints` | development-automation / KEEP；6 | development-automation | 保留 | `development_wake_hints`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `digital_employee_revisions` | digital-employee / KEEP；6 | development-automation | 保留 | `digital_employee_revisions`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `digital_employees` | digital-employee / KEEP；10 | development-automation | 保留 | `digital_employees`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `doc_versions` | resource-catalog / KEEP；23 | collaboration | 内容引用 | `doc_versions`；文档版本与协作关系保留；正文位置统一内容引用，校正 owner。 |
| `employee_approval_sagas` | digital-employee / KEEP；19 | digital-employee | 保留 | `employee_approval_sagas`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_attention_bindings` | digital-employee / KEEP；13 | digital-employee | 保留 | `employee_attention_bindings`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_case_event_origins` | digital-employee / KEEP；4 | digital-employee | 保留 | `employee_case_event_origins`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_case_inbox` | digital-employee / KEEP；19 | digital-employee | 保留 | `employee_case_inbox`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_case_members` | digital-employee / KEEP；5 | digital-employee | 保留 | `employee_case_members`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_case_metering_receipts` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_case_metering_receipts`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_case_workspaces` | digital-employee / KEEP；10 | digital-employee | 保留 | `employee_case_workspaces`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_cases` | digital-employee / KEEP；24 | digital-employee | 保留 | `employee_cases`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_change_candidates` | digital-employee / KEEP；12 | digital-employee | 保留 | `employee_change_candidates`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_channel_results` | digital-employee / KEEP；7 | digital-employee | 保留 | `employee_channel_results`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_channels` | digital-employee / KEEP；9 | digital-employee | 保留 | `employee_channels`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_context_links` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_context_links`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_context_records` | digital-employee / KEEP；10 | digital-employee | 保留 | `employee_context_records`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_context_revisions` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_context_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_definition_revisions` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_definition_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_definitions` | digital-employee / KEEP；12 | digital-employee | 保留 | `employee_definitions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_execution_policy_revisions` | digital-employee / KEEP；5 | digital-employee | 保留 | `employee_execution_policy_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_external_context_bindings` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_external_context_bindings`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_input_uploads` | digital-employee / KEEP；12 | digital-employee | 保留 | `employee_input_uploads`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_invocations` | digital-employee / KEEP；15 | digital-employee | 保留 | `employee_invocations`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_job_template_revisions` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_job_template_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_job_templates` | digital-employee / KEEP；12 | digital-employee | 保留 | `employee_job_templates`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_os_outbox` | digital-employee / KEEP；13 | digital-employee | 保留 | `employee_os_outbox`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_os_settings` | digital-employee / KEEP；3 | digital-employee | 保留 | `employee_os_settings`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_os_writer_state` | digital-employee / DEFER；6 | digital-employee | 退役迁移态 | `migration receipt + target startup configuration`；旧 drain 状态与切换判据入 receipt；未完任务先处置，目标直接以确认后的 OS active 启动。 |
| `employee_reaction_artifacts` | digital-employee / KEEP；5 | digital-employee | 内容引用 | `employee_reaction_artifacts`；保留 Reaction 对制品的领域关系，引用统一内容对象。 |
| `employee_reaction_dispatch` | digital-employee / KEEP；12 | digital-employee | 保留 | `employee_reaction_dispatch`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_reaction_rounds` | digital-employee / KEEP；22 | digital-employee | 保留 | `employee_reaction_rounds`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_round_workspace_states` | digital-employee / KEEP；9 | digital-employee | 保留 | `employee_round_workspace_states`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_tool_registration_revisions` | digital-employee / KEEP；8 | digital-employee | 保留 | `employee_tool_registration_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_tool_registrations` | digital-employee / KEEP；13 | digital-employee | 保留 | `employee_tool_registrations`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_type_packages` | digital-employee / KEEP；6 | digital-employee | 保留 | `employee_type_packages`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `employee_work_scope_revisions` | digital-employee / KEEP；9 | digital-employee | 保留 | `employee_work_scope_revisions`；OS 配置/revision、Case、Reaction、上下文、通道、inbox/outbox 与工作区分层保留；不与 Task 或旧开发配置混表。 |
| `event_automation_work_intents` | event-center / KEEP；19 | event-center | 保留 | `event_automation_work_intents`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_deliveries` | event-center / KEEP；15 | event-center | 保留 | `event_deliveries`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_observer_runs` | event-center / KEEP；14 | event-center | 保留 | `event_observer_runs`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_records` | event-center / KEEP；12 | event-center | 保留 | `event_records`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_response_rules` | event-center / KEEP；17 | event-center | 保留 | `event_response_rules`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_sources` | event-center / KEEP；6 | event-center | 保留 | `event_sources`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_subscriptions` | event-center / KEEP；21 | event-center | 保留 | `event_subscriptions`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `event_type_catalog` | event-center / KEEP；9 | event-center | 保留 | `event_type_catalog`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `external_identities` | identity-access / KEEP；5 | identity-access | 保留 | `external_identities`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `fusions` | resource-catalog / KEEP；22 | knowledge-evolution | 保留 | `fusions`；融合业务记录独立，校正 owner；资源写入复用所属 mutation participant。 |
| `hosted_database_backups` | system-operations / KEEP；14 | system-operations | 保留 | `hosted_database_backups`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `hosted_execution_bindings` | task-execution / KEEP；18 | task-execution | 保留 | `hosted_execution_bindings`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `hosted_execution_control` | system-operations / KEEP；8 | system-operations | 保留 | `hosted_execution_control`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `hosted_execution_events` | task-execution / KEEP；4 | task-execution | 保留 | `hosted_execution_events`；执行事件与来源身份保留；不与业务 committed_events 或外部 event_records 合并。 |
| `hosted_node_event_archives` | task-execution / KEEP；11 | task-execution | 内容引用 | `hosted_node_event_archives`；保留输出端口/归档/分片/托管索引语义；统一内容引用，不合为通用结果大表。 |
| `hosted_object_publications` | system-operations / KEEP；16 | platform/content (system-operations 生命周期) | 中立化 | `content_publications`；演进已有发布账本，保留 owner/logical_key/epoch/attempt/state，不新造平行 journal。 |
| `hosted_recovery_requests` | task-execution / KEEP；11 | task-execution | 保留 | `hosted_recovery_requests`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `hosted_task_archive_entries` | task-execution / KEEP；5 | task-execution | 内容引用 | `hosted_task_archive_entries`；保留输出端口/归档/分片/托管索引语义；统一内容引用，不合为通用结果大表。 |
| `hosted_task_artifacts` | task-execution / KEEP；6 | task-execution | 内容引用 | `hosted_task_artifacts`；保留输出端口/归档/分片/托管索引语义；统一内容引用，不合为通用结果大表。 |
| `hosted_task_workspaces` | source-control / KEEP；6 | source-control | 保留 | `hosted_task_workspaces`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `hosted_workspace_commands` | source-control / KEEP；14 | source-control | 保留 | `hosted_workspace_commands`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `intent_apply_journal` | intent / KEEP；11 | intent | 共用机制 | `intent_apply_journal`；保留 session/client_mutation_id 幂等域，转换 artifact codec；复用唯一 AtomicApply 状态机。 |
| `intent_draft_resolutions` | intent / KEEP；4 | intent | 保留 | `intent_draft_resolutions`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_drafts` | intent / KEEP；9 | intent | 保留 | `intent_drafts`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_provenance` | intent / KEEP；5 | intent | 保留 | `intent_provenance`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_sessions` | intent / KEEP；14 | intent | 保留 | `intent_sessions`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_turn_events` | intent / KEEP；10 | intent | 保留 | `intent_turn_events`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_turns` | intent / KEEP；17 | intent | 保留 | `intent_turns`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `intent_working_set_changes` | intent / KEEP；14 | intent | 保留 | `intent_working_set_changes`；会话、轮次、草稿、来源与变更具有不同生命周期；不合成可变 JSON 大行。 |
| `legacy_code_work_item_links` | integration / DEFER；6 | code-capability/history | 历史化 | `versioned code-history archive + ID index`；历史读者保留；未完工作阻塞预检并逐项转换/收敛；不因 DEFER 直接丢弃。 |
| `lifecycle_alerts` | system-operations / KEEP；7 | system-operations | 保留 | `lifecycle_alerts`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `lifecycle_repair_audit` | system-operations / KEEP；12 | system-operations | 保留 | `lifecycle_repair_audit`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `maintenance_runs` | system-operations / KEEP；22 | system-operations | 保留 | `maintenance_runs`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `maintenance_state` | system-operations / KEEP；3 | system-operations | 保留 | `maintenance_state`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `mcp_probes` | resource-catalog / KEEP；20 | resource-catalog | 保留 | `mcp_probes`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcp_runtime_test_create_receipts` | resource-catalog / KEEP；8 | resource-catalog | 保留 | `mcp_runtime_test_create_receipts`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcp_runtime_test_events` | resource-catalog / KEEP；11 | resource-catalog | 保留 | `mcp_runtime_test_events`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcp_runtime_test_session_leases` | resource-catalog / KEEP；8 | resource-catalog | 保留 | `mcp_runtime_test_session_leases`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcp_runtime_test_sessions` | resource-catalog / KEEP；26 | resource-catalog | 保留 | `mcp_runtime_test_sessions`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcp_runtime_test_turns` | resource-catalog / KEEP；23 | resource-catalog | 保留 | `mcp_runtime_test_turns`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `mcps` | resource-catalog / KEEP；12 | resource-catalog | 保留 | `mcps`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `memories` | knowledge-evolution / KEEP；24 | memory | 保留 | `memories`；记忆条目、提炼任务/事件、范围移动分属不同事实；校正 owner 为 memory。 |
| `memory_distill_events` | knowledge-evolution / KEEP；8 | memory | 保留 | `memory_distill_events`；记忆条目、提炼任务/事件、范围移动分属不同事实；校正 owner 为 memory。 |
| `memory_distill_jobs` | knowledge-evolution / KEEP；19 | memory | 保留 | `memory_distill_jobs`；记忆条目、提炼任务/事件、范围移动分属不同事实；校正 owner 为 memory。 |
| `memory_scope_move_events` | knowledge-evolution / KEEP；13 | memory | 保留 | `memory_scope_move_events`；记忆条目、提炼任务/事件、范围移动分属不同事实；校正 owner 为 memory。 |
| `mission_input_uploads` | development-automation / KEEP；12 | development-automation | 保留 | `mission_input_uploads`；定义/revision、Mission 子事实、步骤、上传、审批与 effect 各有持久恢复边界；保留关系并采用显式 codec。 |
| `node_execution_event_sources` | task-execution / KEEP；2 | task-execution | 保留 | `node_execution_event_sources`；执行事件与来源身份保留；不与业务 committed_events 或外部 event_records 合并。 |
| `node_run_events` | task-execution / KEEP；7 | task-execution | 保留 | `node_run_events`；执行事件与来源身份保留；不与业务 committed_events 或外部 event_records 合并。 |
| `node_run_outputs` | task-execution / KEEP；6 | task-execution | 内容引用 | `node_run_outputs`；保留输出端口/归档/分片/托管索引语义；统一内容引用，不合为通用结果大表。 |
| `node_run_seq_allocations` | task-execution / KEEP；4 | task-execution | 保留 | `node_run_seq_allocations`；继续同事务独立分配；保留高水位与历史负序号，删除运行时 NULL/id fallback。 |
| `node_runs` | task-execution / KEEP；62 | task-execution | 拆分 | `node_runs + task_execution_generations + node_run_selections + node_run_inputs + node_run_configs + node_run_runtime_states + node_run_results + node_run_repo_checkpoints + execution_legacy_evidence`；角色/代/选择/消费边显式化，拆配置/运行态/结果/仓库 checkpoint；源 62 列见 design §5。 |
| `observation_call_models` | run-observability / KEEP；10 | run-observability | 保留 | `observation_call_models`；保留 RFC-371 三表；独立用量/价格保留期，无新增 Task 级联删除。 |
| `observation_calls` | run-observability / KEEP；24 | run-observability | 保留 | `observation_calls`；保留 RFC-371 三表；独立用量/价格保留期，无新增 Task 级联删除。 |
| `observation_prices` | run-observability / KEEP；11 | run-observability | 保留 | `observation_prices`；保留 RFC-371 三表；独立用量/价格保留期，无新增 Task 级联删除。 |
| `observer_activations` | event-center / KEEP；15 | event-center | 保留 | `observer_activations`；事件来源/revision、采集事实、规则、订阅、投递和观察运行保留；不与 committed event 混并。 |
| `oidc_providers` | identity-access / KEEP；24 | identity-access | 保留 | `oidc_providers`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `plugin_artifact_generations` | resource-catalog / KEEP；12 | resource-catalog | 保留 | `plugin_artifact_generations`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `plugins` | resource-catalog / KEEP；16 | resource-catalog | 保留 | `plugins`；配置、探测、playground 会话/事件/租约、安装代保持各自生命周期；只统一 codec 与内容引用。 |
| `reaction_execution_admissions` | resource-catalog / KEEP；12 | task-execution | 保留 | `reaction_execution_admissions`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `recovery_events` | system-operations / KEEP；9 | system-operations | 保留 | `recovery_events`；应用配置、部署执行控制、备份、维护与修复证据分开；备份增加目标合同与内容清单关联。 |
| `repo_capability_config` | source-control / KEEP；12 | code-capability | 保留 | `repo_capability_config`；保留能力模板与仓库绑定，校正合同 owner；不迁入通用资源 CRUD。 |
| `repo_group_nodes` | source-control / KEEP；8 | source-control | 保留 | `repo_group_nodes`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `repo_groups` | source-control / KEEP；8 | source-control | 保留 | `repo_groups`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `repository_employee_assignments` | digital-employee / KEEP；13 | development-automation | 保留 | `repository_employee_assignments`；旧开发员工配置的仓库 assignment；依据实际持久化 owner，不能只按 employee 前缀归 OS。 |
| `repository_transport_connections` | source-control / KEEP；12 | source-control | 保留 | `repository_transport_connections`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `resource_bundle_applies` | resource-catalog / KEEP；10 | resource-catalog | 共用机制 | `resource_bundle_applies`；保留 scope/key 幂等域和 journal；复用唯一 AtomicApply 状态机。 |
| `resource_grants` | identity-access / KEEP；6 | identity-access | 保留 | `resource_grants`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `review_comments` | collaboration / KEEP；14 | collaboration | 内容引用 | `review_comments`；保留人工门/评论的独立关系与状态；正文或制品地址统一为内容引用。 |
| `review_node_reviewers` | collaboration / KEEP；5 | collaboration | 保留 | `review_node_reviewers`；人工门操作、审核人、协作者、反馈、问题分发保留不同语义；task_questions 不与答案合表。 |
| `runtime_session_leases` | task-execution / KEEP；9 | task-execution | 保留 | `runtime_session_leases`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `runtimes` | resource-catalog / KEEP；19 | runtime-management | 保留 | `runtimes`；运行配置注册名仍是产品选择器；冻结到 run 的实际配置独立保留。 |
| `sc_preparation_operations` | source-control / KEEP；11 | source-control | 保留 | `sc_preparation_operations`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `sc_repository_snapshots` | source-control / KEEP；5 | source-control | 保留 | `sc_repository_snapshots`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `sc_repository_sources` | source-control / KEEP；6 | source-control | 保留 | `sc_repository_sources`；来源、冻结快照、缓存、分组、准备和托管命令各自保留；preparation 可早于 Task。 |
| `scheduled_tasks` | resource-catalog / KEEP；16 | integration | 保留 | `scheduled_tasks`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `skill_content_entries` | resource-catalog / KEEP；7 | resource-catalog | 内容引用 | `skill_content_entries`；保留技能、版本与 tree/path 关系；内容经 bytes / 文件 / 对象后端，迁移编码后逐字节校验。 |
| `skill_operation_locks` | resource-catalog / KEEP；3 | resource-catalog | 共用机制 | `skill_operation_locks`；保留技能操作事实与互斥身份；与 AtomicApply 的 restore 场景共用内容准备/恢复机制，不混成其他 saga。 |
| `skill_operations` | resource-catalog / KEEP；15 | resource-catalog | 共用机制 | `skill_operations`；保留技能操作事实与互斥身份；与 AtomicApply 的 restore 场景共用内容准备/恢复机制，不混成其他 saga。 |
| `skill_versions` | resource-catalog / KEEP；11 | resource-catalog | 内容引用 | `skill_versions`；保留技能、版本与 tree/path 关系；内容经 bytes / 文件 / 对象后端，迁移编码后逐字节校验。 |
| `skills` | resource-catalog / KEEP；14 | resource-catalog | 内容引用 | `skills`；保留技能、版本与 tree/path 关系；内容经 bytes / 文件 / 对象后端，迁移编码后逐字节校验。 |
| `task_archive_audit` | task-execution / KEEP；9 | task-execution | 保留 | `task_archive_audit`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `task_collaborators` | collaboration / KEEP；5 | collaboration | 保留 | `task_collaborators`；人工门操作、审核人、协作者、反馈、问题分发保留不同语义；task_questions 不与答案合表。 |
| `task_execution_effect_attempts` | task-execution / KEEP；20 | task-execution | 保留 | `task_execution_effect_attempts`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_effect_fences` | task-execution / KEEP；5 | task-execution | 保留 | `task_execution_effect_fences`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_effects` | task-execution / KEEP；19 | task-execution | 保留 | `task_execution_effects`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_intents` | task-execution / KEEP；20 | task-execution | 保留 | `task_execution_intents`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_lineage_operation_records` | task-execution / KEEP；29 | task-execution | 保留 | `task_execution_lineage_operation_records`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_maintenance_claims` | task-execution / KEEP；11 | task-execution | 保留 | `task_execution_maintenance_claims`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_maintenance_members` | task-execution / KEEP；7 | task-execution | 保留 | `task_execution_maintenance_members`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_execution_owners` | task-execution / KEEP；11 | task-execution | 保留 | `task_execution_owners`；持久意图、执行 owner、effect、attempt、fence、lineage 操作与维护成员职责不同；不并入 AtomicApply。 |
| `task_feedback` | collaboration / KEEP；7 | collaboration | 保留 | `task_feedback`；人工门操作、审核人、协作者、反馈、问题分发保留不同语义；task_questions 不与答案合表。 |
| `task_node_clarify_directives` | task-execution / KEEP；6 | task-execution | 保留 | `task_node_clarify_directives`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `task_questions` | collaboration / KEEP；29 | collaboration | 保留 | `task_questions`；人工门操作、审核人、协作者、反馈、问题分发保留不同语义；task_questions 不与答案合表。 |
| `task_repos` | task-execution / KEEP；21 | task-execution | 替换 | `task_repository_mounts`；稳定 repo_key、ordinal 与 mount_path；合并主仓镜像，保留来源/分支语义。 |
| `task_space_nodes` | task-execution / KEEP；3 | task-execution | 保留 | `task_space_nodes`；冻结目录树，旧版缺省 ancestor closure 在迁移时物化；正常读取无旧版重建回退。 |
| `task_workspace_preparations` | task-execution / KEEP；12 | task-execution | 保留 | `task_workspace_preparations`；保留各自准入/准备/归档/恢复/租约事实，改指新 Task/run/workspace 身份；admission owner 校正。 |
| `tasks` | task-execution / KEEP；70 | task-execution | 拆分 | `tasks + task_definitions + task_launch_contexts + task_workspaces + task_repository_mounts`；保留热生命周期、与生命周期 CAS 同句的可变状态（工作区根、prune、来源终止 fence）与任务树，主体/定义/启动/工作区分离；源 70 列见 design §3.2。 |
| `token_audit` | identity-access / KEEP；12 | identity-access | 保留 | `token_audit`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `token_delete_snapshot` | identity-access / KEEP；6 | identity-access | 保留 | `token_delete_snapshot`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_access_audit` | identity-access / KEEP；12 | identity-access | 保留 | `user_access_audit`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_identities` | identity-access / KEEP；8 | identity-access | 保留 | `user_identities`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_pats` | identity-access / KEEP；10 | identity-access | 保留 | `user_pats`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_permission_grants` | identity-access / KEEP；4 | identity-access | 保留 | `user_permission_grants`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_repository_transport_credentials` | identity-access / KEEP；9 | identity-access | 保留 | `user_repository_transport_credentials`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `user_sessions` | identity-access / KEEP；8 | identity-access | 保留 | `user_sessions`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `users` | identity-access / KEEP；15 | identity-access | 保留 | `users`；身份、配置、session、grant、凭据与审计生命周期不合并；仅迁移显式类型/约束，原功能不扩改。 |
| `verification_profile_revisions` | resource-catalog / KEEP；6 | development-automation | 保留 | `verification_profile_revisions`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `verification_profiles` | resource-catalog / KEEP；10 | development-automation | 保留 | `verification_profiles`；配置身份与不可变 revision 成对保留；不因旧名称与 OS 定义合并。 |
| `webhook_deliveries` | integration / KEEP；18 | integration | 保留 | `webhook_deliveries`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_endpoints` | integration / KEEP；10 | integration | 保留 | `webhook_endpoints`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_mr_control_effects` | integration / KEEP；16 | integration | 保留 | `webhook_mr_control_effects`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_mr_control_targets` | integration / KEEP；8 | integration | 保留 | `webhook_mr_control_targets`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_mr_launch_guards` | integration / KEEP；15 | integration | 保留 | `webhook_mr_launch_guards`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_mr_stream_states` | integration / KEEP；9 | integration | 保留 | `webhook_mr_stream_states`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_trigger_fires` | integration / KEEP；10 | integration | 保留 | `webhook_trigger_fires`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_trigger_streams` | integration / KEEP；6 | integration | 保留 | `webhook_trigger_streams`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `webhook_triggers` | integration / KEEP；24 | integration | 保留 | `webhook_triggers`；触发配置、流状态、去重/投递与 MR effect 保留独立生命周期；scheduled_tasks 校正 owner。 |
| `workflows` | resource-catalog / KEEP；12 | resource-catalog | 投影索引 | `workflows + workflow_dependency_index`；保留 canonical definition JSON；按 revision / reference_path 维护只读依赖索引；保留原 name selector。转换时删除四个宿主占位行（证据入包），目标库不再存在宿主行。 |
| `workgroup_assignments` | task-execution / KEEP；16 | task-execution | 保留 | `workgroup_assignments`；运行中的派工/游标/消息/轮次状态归执行域，和 catalog 定义分开。 |
| `workgroup_member_cursors` | task-execution / KEEP；4 | task-execution | 保留 | `workgroup_member_cursors`；运行中的派工/游标/消息/轮次状态归执行域，和 catalog 定义分开。 |
| `workgroup_members` | task-execution / KEEP；10 | resource-catalog | 保留 | `workgroup_members`；定义与 roster 归 catalog；成员 ID、角色、顺序与合法可空条件保留，不与运行表混合。 |
| `workgroup_messages` | task-execution / KEEP；14 | task-execution | 保留 | `workgroup_messages`；运行中的派工/游标/消息/轮次状态归执行域，和 catalog 定义分开。 |
| `workgroup_task_state` | task-execution / KEEP；8 | task-execution | 保留 | `workgroup_task_state`；运行中的派工/游标/消息/轮次状态归执行域，和 catalog 定义分开。新增运行期配置 `runtime_config_json, config_revision`，承接 `tasks.workgroup_config_json` 中运行中可编辑的部分；`task_definitions` 只保存启动时不变的部分（mode、workgroup id / name、goal、leader）。 |
| `workgroups` | task-execution / KEEP；21 | resource-catalog | 保留 | `workgroups`；定义与 roster 归 catalog；成员 ID、角色、顺序与合法可空条件保留，不与运行表混合。 |

## 3. 新增 / 重建目标集合

以下是本 RFC 明确提出的新增实体，不另外计入源表覆盖率：

| 集合 | 目标表 | owner / 依据 |
| --- | --- | --- |
| Task 分层 | `task_definitions`、`task_launch_contexts`、`task_workspaces` | task-execution；design §3 |
| 仓库与 checkpoint | `task_repository_mounts`、`node_run_repo_checkpoints` | task-execution；design §4 |
| Run 身份与数据分层 | `task_execution_generations`、`node_run_selections`、`node_run_inputs`、`node_run_configs`、`node_run_runtime_states`、`node_run_results`、`execution_legacy_evidence` | task-execution；design §5 |
| 独立协作编辑单元 | `clarify_answers`、`clarify_answer_drafts` | collaboration；design §6.1 |
| 资源依赖 | `agent_skill_refs`、`agent_mcp_refs`、`agent_plugin_refs`、`agent_dependencies`、`workflow_dependency_index` | resource-catalog；design §6.2 |
| 内容机制 | `content_objects`、`content_bytes`、`content_publications`（替代现有 publication 表） | platform/content 提供机制，system-operations 维护其持久生命周期；design §7 |
| 迁移元数据 | `migration_runs`、`migration_chunk_receipts`、`migration_table_receipts`、`migration_row_dispositions`、`migration_artifact_receipts`、`activation_receipts`（由 logical-copy 与 generation 元数据泛化） | system-operations；migration §3；复用现有 logical-copy 与 generation 概念，扩展到 transform 而不是另建第二套激活事实 |
| 旧代码历史 | versioned archive + 原 ID 查找索引 | code-capability 历史查询；不回流当前业务写模型 |

**2026-10-24 更正（迁移元数据的位置）**：上表「迁移元数据」一行不是业务目标表。按 migration §3，这些记录存放在目标库的迁移元数据区：SQLite 目标文件内的 `aw_meta_*` 表，PostgreSQL 的 `agent_workflow_meta` schema。它们由迁移机制创建和写入（R2 的 meta 表机制、V3 的迁移运行），归 system-operations，不进入 R1 的目标 registry 与业务表编译产物。`employee_os_writer_state` 的 drain 状态写入的是这里的激活回执，不是某张业务目标表；转换合同对迁移回执去向与业务表去向分别校验。

## 4. 不属于 217 张源码业务表的存储

- SQLite `sqlite_schema / sqlite_sequence / sqlite_stat*` 与 `__drizzle_migrations`：引擎 / 迁移元数据；按 provider 恢复身份高水位，旧 journal 保存证据，不照搬为目标 baseline。
- PostgreSQL 的 `schema_migrations / schema_contract / logical_copy_operations / logical_copy_chunks / database_generations`：现有五类基础元数据；兼容 reader 保留，目标合并到统一迁移运行 / 激活合同，不能出现两套 active generation 权威。
- 实际库额外表 / 缺失表：逐项登记 source fingerprint 后处理，不能由 217 表 roster 自动忽略；本机样本见 research §3。
- 文件内容、技能树、运行日志 / prompt、对象归档、数据库备份：按内容 manifest 迁移或明确保留原 location，记录引用与 bytes 校验。
- 浏览器 IndexedDB / localStorage：不参与服务端整体搬迁；保持草稿可恢复，必要的 ID / snapshot shape 边界版本升级不得静默清空。

## 5. 明确不合并的集合

`committed_events` 与 `event_records`；Task / Case / Reaction；源仓库 / 冻结快照 / preparation；身份 / session / grant / 审计；Apply journal / Task effect / Development effect / MR effect；观测调用 / 模型用量 / 价格。这些表职责接近但提交边界、生命周期或消费语义不同，合并会重新把区分逻辑推回代码。
