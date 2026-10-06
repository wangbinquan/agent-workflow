# RFC-370 后台生命周期旧 bootstrap fixture 兼容

Windows exact SHA `5b20b51738c276c4272fc0466b4748d8a2abee2f`，run37513420795／job112440144316 正式 failure。运行测试组706pass、3skip、0fail，原生命周期与新增 execution 控制案例通过；整仓 typecheck 报 `TS2345`：旧 bootstrap 测试 `TestSession` 对象未提供 `DaemonProviderRuntimeSession` 新 required `execution` 成员。原功能日志和终态保留，不把有限源码门替代正式CI。

本片仅增加旧 fixture 的所需完整成员和自己的 enabled 状态。它没有后台句柄，running 由原 phase 与 enabled 得出；pause／resume不更改原 phase或旧事件清单。生产执行控制仍由原真实 session suite 覆盖。原每一 test、expect、receiver、bootstrap顺序、事件、错误和预算全文保持，完整逆变换回到原文件；不放松生产类型，也不以 optional 掩盖缺失。

三条本次实测一次性增长声明已于普通后继 `fd72004402bd35d703bd63cd824228455793afc8` 退役。该后继只3个路径，129ordered库存、why、baseline与其它字段不变；新payload摘要独立匹配，其它12matching和四原规则不变。退役门58项、42357594bytes、有效稳定PASS、0 findings，FP `3e3b01d01f3054010d9a49d35f62a01e52092e9648bd05cc37456ae09870dad6`，完整回执240731bytes／SHA256 `f1de389008d9985d8735e1b91da3fbd6052f5f87fa99f6b6d34885611b36aff3`。发布后main／origin0/0、索引空。没有新的生产改动、规则改动或census，也没有本机AW运行门。

前继诊断3645主run37505158718已正式failure。5个历史Markdown引用502与两backend shard旧owner增长声明失败都保留；新引用修复和声明退役不改写该历史终态。旧native observer首次拒绝的原始原因仍未知，之前Windows诊断通过并不记修复完成。

本片待独立有限实现门、精确发布及新 exact-SHA hosted终态。这里只修旧测试 fixture 接线；完整执行权／早期恢复、purpose九命令、真实根选择、A-G和CS M0–M4都未收口。
