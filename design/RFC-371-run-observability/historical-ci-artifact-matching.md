# RFC-371 本次 CI 修复的原投影与发布设计

源码 11 路径与浏览器 3 路径已有独立实现 PASS；原 native 文件构造的 2 路径登记另作有限 SOURCE 门，不能以设计门替代实际 CI。所有既有 CI FAIL 保留。

## 精确原投影

原 `architecture-census.ts --write` 已对 main `976f590e29e165daf945db522c3347c293e0f1b7` 加上述 14 个冻结候选、其他文件只取该提交原件，完整计算 3238 个生产文件，产生原 13 项投影。sourceDigest 为 `sha256:15b742814847f5bed6b938981b594f97016801c29f6bbecff01109b1db4af3dc`。原生成器、人口、算法与约束不改，后续不重复 source census；未传 --write 的第一次仅有只读 report，无 13 项产物，保留为 incomplete 而不是 PASS。

保留原始输出字段／行和全部 129 账本的顺序、id/file/symbol/why、旧不透明名单及 guard 规则。四项 provenance 仅用既有纯函数 withArtifactProvenance 固定到真实生成基线 976f590e；原 status.md 直接采用原渲染输出，不经格式器。当前原投影的全部 baseline 与上一个提交逐条相同。

## 唯一实际登记的配套计数

原历史测试的唯一外部 OpenCode SQLite 磁盘构造登记一行后，用原 ledgerEntryCount 对该完整源码数组测量，从 334 行到 335 行（调用点总数 614 到 615）。只有 rfc359-w5-test-engine-hardcoding 的 baseline 改为 335，保留原 why，并给本次真实增长添加准确的 allowGrowth 原声明；不改其他 128 行，不新增分类／豁免／open，不改原高水位判据。该声明只解释已存在 native fixture 的漏登记，业务测试仍由 describeEachProvider 验证双引擎。

## 紧邻提交与验证

有限配套门必须核原 13 项字节输出、仅纯 provenance 与一项原测量计数的确切差异，逐字复用已批准 SOURCE 候选，并核 docs/STATE/plan 只追加且保留共享内容。同一个短发布临界区先提交本次源码和配套，再用原纯函数只退役这个刚消费的 allowGrowth，保持所有 129 行、335 基线、why、源摘要和生成锚点；两个正常小提交一次 push，让最终无过期声明的精确 SHA 运行 GitHub Actions，避免为两个中间 SHA 排两套 CI。先冻结两份 ledger 文件供有限门核验，不能在提交时构造未审查的新内容。

只有最终远端精确 SHA 的主 CI、Windows 与相关定时 CI 终态才算实际通过。原全部任务类型／内置 Agent 的剩余实际 Git、数字人和计划入口仍未完成，CS 原完整检查／本机部署仍未完成；不 dispatch 已手动关闭的 observability-scale。

配套事实补充：原 raw ledger 的 canonicalProjection.sourceDigest 随本次原完整生成更新到 15b74281，原 129 条账本全字段与提交 976f590e 相同；不能误用整个 raw 对象与旧摘要逐字相等。紧邻退役则保留新的原摘要及生成锚点。后补四处 E2E 原 Task 名称定位和文档只影响测试，不触及冻结的生产输入，按独立有限补门核验，不重复 source census。
