# RFC-371：原生预取回归的 CI 类型与登记修复

原提交 `183715b050efe1e876be750160038764ab1f39cf` 的 hosted Typecheck 在原 NULL/空键对照的 `toBe(key)` 报 TS2769；Ubuntu shard17 的唯一失败是原测试调用点账本缺少 `rfc371-native-part-key-prefetch.test.ts: 1`，原结果 867 pass／1 fail。原失败不回写成通过。

NULL 断言先读取同一原 id，再按原参数分别用 `toBeNull()` 与 `toBe(key)`；不使用 cast、skip 或预算放宽，原 NULL 和空字符串的错误前缀、其他断言及生产 reader 保持。原测试库存按字典序登记唯一构造点并附物理格式理由：该构造创建外部 OpenCode SQLite/WAL 文件，既有 `real-file-database` 分类本来就适用，不造 AW provider 库，不新增分类或豁免。

`TEST_ENGINE_HARDCODING_DEBT` 因这一具名实际构造从 338 项变为 339 项。按原 RFC-317 T16/T17 规则，`architecture/ledger-baselines.json` 同批将对应单项 baseline 精确更新为 339，附仅针对 RFC-371 本次外部原生夹具的 `allowGrowth.why`。这是原规则要求的署名一次性登记；其他 129 条 ledger、全部顺序和 why、EXEMPT、OPEN_MIGRATION_DEBT、扫描规则、人口及时间预算保持。下一份不再增长的提交必须删除这项一次性声明；不能留下长期许可，也不能靠删除原测试或移动构造点绕过登记。

先独立 SOURCE 复核这份文档和该条原基线输入，再由原官方 census 在精确提交基线及已审候选上生成一批私有产物，完整匹配差额后精确上库。除该具名登记外，只允许原规范生成的 sourceDigest 与 provenance 变化；不重跑同一候选，不运行本地 AW 产品测试、构建或新服务。新 exact-SHA hosted CI 另验，旧失败和旧候选保持。

重新打开同一范围的正式页面已实测 907ms；37,533 条原明细、16,259 个分组计数及四桶 Token／冻结人民币与原报告一致。该事实不代签本批 CI 或首次约 20.5 秒生成问题解决，也不关闭两个 RFC。
