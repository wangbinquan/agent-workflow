# RFC-370 执行后台生命周期发布与回执退役

源码及 matching 已发布 `5b20b51738c276c4272fc0466b4748d8a2abee2f`，父提交 `3645f05a50e25ca248ebba71abd1205b93c1a1b6`。精确提交25个任务相关路径，commit message 与 Codex co-author 已核对，推送后 main／origin 为0/0、共享索引空。RFC371历史内容及下一批真实根设计 WIP 保留。

SOURCE6-R1有效稳定PASS、0 findings；23项完整646157 bytes，FP `d4e15e29c4bd7bb152a444d9a28d43dc18456cfb583f38943cd9d995290667a2`，回执92905 bytes／SHA256 `b5c1e255149cc14b6df72aeecc26a62ad7d34da9a043db04bc77c3d4930078e2`。3个生产文件和1个新增回归组成唯一原 scoped census 候选；四原规则逐字保持，没有本机 AW tests／typecheck／build／service。

元数据 R1 的99项首次人口遗漏了一个既有D1实际回执 control，完整首末稳定后保留INVALID；R2补齐100项，唯一功能 finding 是最终 authored debt和growth投影的两个provenance.contentDigest仍为raw值，完整首末稳定FAIL保留。R3只改两个摘要字段，完整payload和其余11matching保持；107项完整113850028 bytes，有效稳定PASS、0 findings，FP `8fb9e91065e7ab5da1d453cce7091c6060d8b566eefce97352c5394524ca38bf`，回执330456 bytes／SHA256 `852b5dbe4981497cfcfa7f339dca72cafe222fe29944d3825a49c43be9262e02`。四份治理摘要均按原递归localeCompare排序／JSON2spaces+LF／剔除provenance等记录字段的payload语义独立复算，顶层legacy sourceDigest保持，新canonicalProjection正确。纠正没有重跑census或重签源码。

私有发布检查器首次在stage之前遇到SOURCE与META两类EOF字段名称不同而退出，索引仍空、main／origin0/0；原程序和日志保留。修正器按两份真实完整EOF见证的schema严格核对，再完成发布，未改门回执或仓库候选。

本记录对应紧随 matching 提交的普通后继：仅从 `ledger-baselines.json` 退役已消费的 `rfc294-cross-context-observed-imports`、`rfc294-architecture-exceptions`、`rfc294-module-symbol-owners` 三个一次性allowGrowth及更新它的匹配payload摘要。完整129项有序库存、why、当前baseline6722／5921／27195及全部其它字段保持；原40SPI／69targets、214guard、365background／504ambient、Task ledger及SCC无新差额。生产源码、sourceDigest、原生成规则和其它12matching全文不变，没有新增census。这一后继待有限元数据门与精确发布。

前继诊断SHA `3645f05a50e25ca248ebba71abd1205b93c1a1b6` 主CI `37505158718` 的macOS shard2／ubuntu shard6都实际失败在旧owner一次增长声明未于后继退役；原功能日志及失败保留。本片已退休该旧声明，新三条只用于本次实测上涨，立即在本记录对应后继退役。该诊断SHA Windows `37505158767` 正式success；旧native custom observer拒绝的原始因果仍未知，不复现不记根因修好。

本片源码SHA 的主CI `37513421500` 和Windows `37513420795` 已启动。新18个双provider案例、原生命周期回归及整仓正式运行结果仍等exact-SHA hosted终态；有限源码／元数据PASS不替代CI。没有AW-in-CS部署。

完整H7 authority／早期恢复／执行admission、purpose九命令、真实根选择和A-G继续。各owner的CS adapter在A-G之后按已批准M0先真实控制面部署，再M1～M4逐项接入，不以本片发布或回执退役关闭RFC。
