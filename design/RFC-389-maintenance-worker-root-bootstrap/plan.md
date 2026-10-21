# RFC-389 实施计划

**前置**：RFC-388 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-389-T1 | platform Worker 运行时（机制、端口）与中立的系统维护工厂 | design §2.1 |
| RFC-389-T2 | bootstrap Worker 入口根、线程内中立图与 provider 适配表、入口路径模块；托管入口改指；R1 消账 | design §2.2 |
| RFC-389-T3 | 监督器的独立入口改为必填，两个会话显式传入；删除 platform 内写死的入口 | design §2.3 |
| RFC-389-T4 | 构建清单、架构清单、账本（含 `platform-to-modules-file-pairs` 上限下调）、测试与文档里的路径引用 | design §2.4 |
| RFC-389-T5 | 测试（design §4）与 `docs/dev-gotchas.md` 一条：维护 Worker 的根与线程内图在 bootstrap，platform 只放机制 | design §4 |

**依赖**：T1 → T2 → T3 → T4；T5 贯穿。

## 冲突面

- `cli/start.ts`（两个会话构造监督器处）。
- `T/architecture/rfc376-structural-guards.test.ts`。
- `architecture/{commons-debt,counts,guard-manifest}.json`。

以上与 RFC-388、RFC-390～392 串行。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片与 windows-platform）
