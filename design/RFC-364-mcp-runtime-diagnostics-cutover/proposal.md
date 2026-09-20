# RFC-364：MCP runtime diagnostics 归入 Resource Catalog

- 状态：Draft（2026-09-20；待三件套批准）。
- 母项：RFC-294 W4-E6 与该域 B/D；前置 W4-C 和 RFC-360 / E4b 已 Done。
- 源码基线：`cae3e4ea2579bc1d13ff34008fa011d4073d8b59`，见 [source-baseline.json](./source-baseline.json)。

## 1. 问题与目标

MCP 测试会话持久化、lease 与 profile invalidation 已归 Resource Catalog，但会话编排仍在 `services/mcpRuntimeTest.ts`，HTTP route 依赖大 service，daemon/server 通过 WeakMap 工厂取得实例。Runtime Management effects 和 config route 也仍引用这个 legacy 类型。

本 RFC 将 MCP diagnostics 的 Start/SubmitTurn/Cancel/End、Session/Transcript 编排收回 Resource Catalog，保持当前 session/turn 数据、process effect、HTTP/WS 与 restore/provider 切换行为。Root 显式构造一次并共享，移除这一域的全局缓存。

## 2. 用户故事与能力影响

用户继续从 MCP 页开启多轮测试、查看流与历史、取消当前轮或结束会话；配置变更、runtime profile 变更、服务重启会产生相同的 continuation/cleanup 结果。provider 切换失败时仍可 resume 原实例，未启动 server 的 dispose 不启动后台任务。

不新增或关闭能力，不改 permissions、支持协议、driver eligibility、运行预算或错误文案，不把 diagnostics 迁入 `testing/`。保留现有 session 机制，不增 scheduler 或后台轮询。原限额与部署形态逐项见 design。

不承担 MCP CRUD 全部迁移、runtime driver 全面迁位、Task inventory/provenance、全局 W9 managed background registry 或 physical restore generation。E6 完成不能代表 W9 完成。

## 3. 验收标准

- AC-1：现有七个 HTTP 操作只 decode/call/map，调用 RC public commands/queries，权限与 status/body/error 一致。
- AC-2：session/turn domain + application、tx persistence/lease、process/stream effects 分层，Application 不依赖 Hono、Bun、appHome/configPath 或 service singleton。
- AC-3：幂等创建/消息、并发 turn CAS、取消/结束、lease rotate/reap、capture 限额和配置失效均通过原功能 oracle 与真实双库测试。
- AC-4：SQLite daemon、PG daemon、独立/unstarted server 均一实例；cold dispose、start 失败、pause/resume、provider handover 与 drain 顺序保持。
- AC-5：RM eligibility/reconcile 和 config consumers 改为具名窄合同，由 root 注入；保留 RFC-360 profile/session 同事务，不新增跨域 internal import。
- AC-6：旧 service/lease forwarding、WeakMap 及本域 legacy imports 清零，逐条注销 owned debt；保留 timer 计入 W9，不靠搬目录注销后台债。
- AC-7：最终 exact-SHA Main CI 成功；涉及进程回收的原生平台证据与实际代码范围匹配。
