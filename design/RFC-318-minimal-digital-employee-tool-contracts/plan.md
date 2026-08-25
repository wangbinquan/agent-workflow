# RFC-318 实施计划

## 范围门

- [x] 用户批准九个最小合同、八个内置 Agent 修复及实施推送。
- [x] 只在既有 primary checkout 的 `main` 上工作并核对 `origin/main`。
- [x] 保留现有网络，不增加零网络、沙箱或安全措施。
- [x] 不修改 runner、`startTask` 及其下层执行机制。
- [x] 识别并保留 shared main 上其他并行 WIP。

## 实现

- [x] `development@9` 绑定九个直观 v2 contract。
- [x] 八个 JSON 节点使用最小 direct input/output；方案节点沿用单一 `path<md>`。
- [x] input/result projector 只在现有执行链上层转换业务数据。
- [x] 八个 v2 built-in 使用新 ID、单一 contract 和精简 persona。
- [x] 分类配置只展示问题类型与兜底；岗位流程拥有处理者和顺序。
- [x] 节点卡片、方案辅助卡、协议折叠和内置 Agent 展示名与合同一致。
- [x] v2 拒绝旧 `agent-result` envelope；v1 和历史 Case 保持兼容。

## 验证与发布

- [x] 合同/schema/projector/Agent 定向测试通过。
- [x] 前端节点卡片、配置和职责图定向测试通过。
- [x] development@9 主链、人工评审和直接输出 E2E 通过；冲突路径已完成 RFC-318 动作，当前仅受并发 RFC-321 发布前置条件影响。
- [x] 七轮设计门记录无遗留 P1/P2。
- [x] 唯一一次 `bun run gate:local` 已执行并逐项归因；RFC-318 自身架构红项已修复并定向通过，共享 tree 仍受并发 RFC-319/321 红项影响。
- [x] 实现提交均按 exact path 发布，缓存区无意外文件，并包含正确 co-author trailer。
- [x] 实现已进入 `origin/main`；包含最终 RFC-318 收口提交 `ff1290659` 的 exact SHA `089015b1` 上，CI `32806211369` 31/31 jobs success、visual `32806211353` 1/1 job success。
