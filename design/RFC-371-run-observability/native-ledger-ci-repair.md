# 原生账本组合的 hosted 类型回归修复

加载修复 SOURCE44 已发布 `79231ae62a3b76d8ec0c2b8fd25c7cff996f07fd`，正常七许可退役 `670e8483d1935aa8ea0c7ff1207e22ebf82c279a`，post-fetch main/origin 同步、共享 index 空。正式本机总览重新读取可显示8任务、123,238分类Token和¥0.16583，失败报告保持 failed 到显式重试。

精确 Windows CI37272334390 在 typecheck 失败；完整主 CI37272334371 因后继共享主干提交 cancelled，不能作为新候选绿证据。并行 RFC370 的 fixture readonly cmd 类型错误由其后继430e处理，本批不收编其 WIP。观测四份测试修复：显式声明原v2 measurement/scope/completion的真实合同类型；两个v1修订断言先检查实际 contract，再读priorRevisions。它们保留全部原用例、预算和功能断言。

原新增 partial native 测试把已记录 input3/cacheRead6/cacheWrite10/output未知的 total 写成null。这与生产 recordedUsage 的已收到桶之和定义以及用户“缺口不清空已收到数字”的要求矛盾：正确 total 为19，输出仍null，state仍not-ready，缺口仍在。更正该一个期望值，保留全部三个数字、未知输出、前后两次完成证明和完整状态断言；不改生产求和规则，不通过unknown强转绕过类型错误。

限定格式/lint通过，无本机AW tests/typecheck/build/新service。生产/canonical原产物与规则不在本提交中；在制 history writer 和并行 material workspace 全部排除。独立有限功能门、精确提交与后继 hosted CI另验收，本记录不关闭RFC或启用producer。
