# RFC-286 — 任务分解（plan）

- T1 F1 死 class 六点 + Checkbox 换用 + join 分隔符 i18n（含 grep 锁与 RTL 断言）。
- T2 F2 bare fetch 三点收敛 + 第二 decoder 删除 + saveBlob 合一。
- T3 F3 shared schema 下沉（后端 parse 对拍先行；前端换 import；OidcProviderRow 核对）。
- T4 F4 WS 关联 queryKey 工厂化（契约锁随迁 + 零字面 key grep 锁）。
- T5 实现门（独立子代理）+ backlog 对账（本轮不修清单中 F1/F2 对应行剔除、
  其余 UI 项保留）+ STATE/索引收尾。

依赖：T1-T4 互独立可并行小步；每批 pin worktree gate 全绿。

## 验收清单

- [ ] AC-1…AC-5（proposal §5）
- [ ] 零视觉基线漂移（或按仓规刷新并注明）
