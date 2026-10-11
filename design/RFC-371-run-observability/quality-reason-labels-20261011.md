# RFC-371 既有原生缺口提示补译

原正式页面把 `native-capture-incomplete` 和 `native-step-unfinished` 直接显示为内部 reason。现为这两个既有 reason 各补中文、英文值，列表、关联任务按钮和详情标题继续使用原 `observationGapLabel`。未知 reason 仍显示原字符串；缺口、任务身份、所有数量、四桶 Token 与人民币估值均不改变。

新增回归覆盖两个 reason × 两语言的四个真实 `CompleteQualityDetails` Dialog，以及一个双语未知 reason helper 用例。原组件、helper、旧用例和预算保持；按仓库规则没有运行本机测试、类型检查、构建或 E2E。该片 scoped Prettier、ESLint 通过，TypeScript 纯语法解析无诊断；正式测试由精确提交的 GitHub Actions 验证。

中文正式页已核对两处提示、原 8 类缺口、采集不完整的原 5 个关联任务，以及 Escape 关闭和触发按钮回焦。原固定范围仍为 137 任务、2,630,923 Token（输入 1,189,241；缓存读取 1,255,680；缓存写入 0；输出 186,002），已知人民币 ¥4.078952。该范围并非全库所有验收任务；英文实际页面、整体性能和 RFC 完成未由这份回执认证。

独立有限功能实现门 v321→v322 为 VALID/PASS、零 findings，批准只绑定字典与新增测试的冻结全文。源码两份 SHA256 分别为 `3e32898999f9622aad2fb9af3ac8b1582486573c71c5a90bdb657457cb625647`、`00cbffea7594de2a0f3e8ce2fab31a0cea227b0a4603f70540f33b1bc67829f0`；根已读取 JSON、Markdown 的全部检查与边界并再次核对所有材料。源码门不代签 CI 或部署。

原生页缓存的具体首批计划另见 [persistent-native-page-cache-plan.md](persistent-native-page-cache-plan.md)，v318→v319 独立设计门已通过；其原文保留检视前状态作为候选记录。该计划中的新观察器、迁移、缓存、Worker 协议和生命周期接线仍待实施，不把设计 PASS 当作性能提升已经落地。整个 RFC 继续进行。
