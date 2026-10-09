# 实际消耗窗口的原架构登记

本批仅为已批准 AW-R06 的实际消耗窗口实现登记原架构投影。原一次候选生成之后，功能复审修正了 Task 来源缺口与历史执行四桶；因此用相同的原官方 assertion-free 生成器为修正后的实际候选重新产生 13 份完整输出，不把旧候选摘要冒充新候选，也没有运行 AW tests、typecheck、build、service 或 E2E。

生成命令使用基线 `8157a5489ea2da0c921d7b33441a3cfe88d31e12`，`--write --snapshot-sha` 与 `--seed-ref` 均绑定该原基线。生成前核对只有本会话冻结的 production 路径存在生产差额；并行 CI 两个测试与文档输出保留。修正候选生产摘要为 `sha256:95d64876fe6c24a095769147f5e21ca2027514e17153c7ba0281e283cd064038`。

原 129 项有序库存及全部旧 why 完整保持，唯一增长是 `rfc294-module-symbol-owners` 的实际 top-level owner 条目 27702→27720，新增 18 条来自发生时间/窗口合同及应用函数、前端时间未确认明细组件。没有新增导入增长或架构例外。以原 `withArtifactProvenance` 纯 JSON 函数登记这一项一次性 allowGrowth，源码提交消费后在紧邻正常后继提交退役，不重写历史、不修改统计人口、扫描规则或治理判据。

其余 12 份原始生成输出保持完整字节；退役只去除该已消费声明并由原函数更新 contentDigest，全部实际 baseline、sourceDigest、canonicalProjection、provenance 来源锚点和原业务 payload 保持。没有为状态 Markdown 作全文件格式归一。

Windows 原 workflow 两处路径过滤与原平台命令各登记 `rfc371-original-consumption-time`、`rfc371-usage-window-owner-provider`、`rfc371-usage-window-http` 三个新测试，共九个新路径引用。删掉这九个新引用可整字节恢复原完整 workflow，所有原命令、并行登记、断言与预算保持；在源码测试提交之后的正常后继同退役一起发布。

独立有限配套复核、精确发布、确切 SHA CI 分别验收；源码或配套复核不能代签真实任务覆盖、性能、CS 部署或整个 RFC。失败回执继续保留。
