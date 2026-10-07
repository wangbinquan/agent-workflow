# Purpose CI 类型错误修复的配套发布

原 Windows run37555994724、SHA c3857ea5678fd6474ca3b61d6ca4ff473c2be840 终态 failure，停在 Typecheck，尚未运行该作业的功能回归。仅向前恢复 pipeline evidence 的原 lazy native resolver，并通过所选 evidence receiver 等待 materialization ACK；修复两个既有回归的 erased 类型推断，完整 runtime assertions、九操作顺序、旧 native materialization 回归、预算保持。新增实际 pipeline ACK 回归，不先创建 native evidence 目录。

SOURCE5-R1 的原误报 PASS 全文保留并明确不可用于发布；随后独立复核的补充 FAIL 指出新增 fixture 返回 readonly entries。SOURCE5-R2 只复制 entries 为可变数组，完整前三个候选文件不变，范围文档追加失败记录。独立 SOURCE5-R2 有效稳定 PASS，26项首末全文/EOF/metadata/role/path/order，指纹 5f5fbd4cc624c86b9b059a03021f0a1d1b9598f4e6301391a72f3ad6042c713c。Root 已完整消费 PASS及历史 FAIL。

一次原 scoped census 固定完整 committed 79d31c961f858f4aff81543a9f5b70b22c951ccc 加冻结1生产/3测试，四原规则全文不变；13原输出仅写私有证据后正常应用。sourceDigest sha256:678e9adf510a0e9df3f2445433cdaa987b33d5419be0aa67dcecd837b8dad2e7，pure owned classic inbound/outbound 0→0。十二 JSON 的原完整 payload、所有行及顺序、129 ledger 全部 why/值、SPI/targets/SCC/Task库存逐项保持，只使用原生成的 provenance/sourceDigest。没有实际计数增长，没有新增 allowGrowth，没有后继退役需求。原 status 完整采用同一次输出；生成不重跑，原分类与匹配规则不改。

私有 projection 首次读取不存在的 legacy provenance wrapper 失败，发生在任何文件写入之前；保留原工具和错误。正常补正只按实际 wrapper 位置检查原摘要，没有改原生成输出或重新 census。

配套独立功能门、exact-path commit/push、main/origin 同步、新 exact-SHA hosted CI 分别验收。这里只运行 scoped format/lint、纯 AST/byte/JSON、一次静态生成；没有本机 AW tests/typecheck/build/service。共享 STATE/plan 的全部既有字节与并行内容保留，只追加本候选说明；只核验新文档和追加段的格式，不声称历史大文档格式通过。architecture 按原 .prettierignore 排除，保留机器原输出格式。

不带 Task 配置接线和 RFC-371 native usage WIP。旧前端类型失败交由拥有者处理，原旧 CI failure 保留；不能据本有限 PASS 声称整仓绿色、完整 H7/A-T7/A-G 或 RFC完成。当前仍在 Stage A，三个真实根、Task事务与19 handles的执行权闭包仍需实施；随后各层独立 CS adapters 按 M0 首次部署、M1–M4 逐项接管推进，AW 尚未部署到 CS。
