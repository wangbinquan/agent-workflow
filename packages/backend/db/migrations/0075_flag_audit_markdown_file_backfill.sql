-- flag-audit §8 决策（用户 2026-07-07）：node_run_outputs.kind 的 legacy 别名
-- 'markdown_file' 存量清洗为 canonical 'path<md>'。读侧 kindParser 本就把两者
-- 等价折叠（parseKind 的别名分支），因此这是零行为差异的数据整洁化；写入点
-- （services/review.ts approve 路径、services/runner.ts 端口持久化）已同步改为
-- 只写 canonical 形态，别名不再进库。
UPDATE node_run_outputs SET kind = 'path<md>' WHERE kind = 'markdown_file';
