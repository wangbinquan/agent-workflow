# RFC-292 实现门（2026-08-12）

## 结论

**通过（PASS）。** RFC-292 已把 Webhook 来源的触发上下文统一为唯一作者语法
`{{trigger.webhook.<field>}}` 与唯一持久化根 `{trigger:{webhook:{...}}}`。Intent、workflow 作者面、agent、
workgroup、review、code-host、scheduler、恢复/重试/sync、child call tree 与 Webhook 三类 launch payload 均消费同一
shared parser、context 和 preflight；没有把 30 个字段铺平到 workflow root inputs、模板根或公开运行参数。

实现门复核发现 2 个 P2 收尾缺口，均已修复并补回归锁；修复后 P0/P1/P2 未决 finding 均为 0。

| Finding                                                                                                                     | 修复                                                                                                               | 回归锁                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Inline clarify 与 review custom injection 同时存在时，外层 prompt 已跳过 trigger，review 模板仍会重复注入并错误要求 context | review custom template 的 trigger ref 与外层 prompt 共用 inline no-reinject 规则；review comments 仍按本轮语义注入 | `rfc292-trigger-namespace.test.ts`  |
| 不可自动迁移的 v1 Webhook payload 经 PUT 修复后仍可能保留 version=1                                                         | PUT 对完整已验证 candidate 写 `template_syntax_version=2`，launch-config CAS 同时比较旧 version                    | `rfc257-webhook-management.test.ts` |

## 覆盖结论

- Shared：30 字段闭集、segment scanner、literal escape、三态 context decoder、workflow/webhook surface inventory、
  v4→v5 与 payload v1→v2 迁移、prompt/call-goal renderer 均由同一中立模块导出。
- Runtime：公开无-source 启动、Webhook source、task 冻结 context、root + closure preflight、child 原子继承、
  resume/retry/dynamic confirm/workflow-sync 的判据一致；framework prompt 显式不做二次展开。
- Code-host：preset required/optional 与 custom path/query/body 使用 canonical refs，在 HTTP 前统一对账并复查最终大小；
  旧私有 trigger 模块已删除。
- Intent/frontend：Intent 原生教授并生成 canonical refs，不生成搬运字段的合成 inputs；所有作者 chips、诊断与预览使用
  同一字段集合和 parser。
- 持久化/暴露：新 task 原子写嵌套 context；历史扁平行与 payload 有版本迁移；损坏行 fail-closed；context 不自动进入
  task API、资源导出、runtime env/config 或 workflow root inputs。

## 验证证据

| 范围                                                                                     | 结果                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared 全量                                                                              | 1996 pass / 0 fail（164 files）                                                                                                                 |
| Frontend 全量                                                                            | 6310 pass / 0 fail（739 files）                                                                                                                 |
| RFC-292 shared 精确回归                                                                  | 16 pass / 0 fail                                                                                                                                |
| Webhook management（含 v1 PUT repair）                                                   | 12 pass / 0 fail                                                                                                                                |
| Webhook dispatch / migration / context atomicity / source locks / code-host + Intent E2E | 46 个唯一 case 全部通过；沙箱内 loopback listen 的 1 个 `EPERM` 已在正常权限下原样复跑 2/2 通过                                                 |
| Intent differential                                                                      | 7 pass / 0 fail                                                                                                                                 |
| 静态门                                                                                   | typecheck、lint、format、depcheck、`git diff --check` 通过                                                                                      |
| 真实链                                                                                   | Intent-generated workflow → Webhook dispatcher → ordinary agent prompt 通过；Webhook → code-host HTTP stub 通过；child context 继承精确回归通过 |

## Backend 全量分片说明

本次没有把并发共享机器上的固定 5 秒 wall-clock timeout 伪报为产品失败，也不声称取得了单次完整 backend 全绿快照：

1. 第一轮四分片除一条已修正的旧 source lock 外，只出现既有 5 秒超时；对应测试独立通过。
2. 第二轮四分片出现 6 条同族 5 秒超时；六条独立运行均在 1.05–2.48 秒内通过。
3. 降为两分片后运行 700.5 秒主动止损；当时仅见
   `rfc098-wrapper-stale-redispatch.test.ts`（5.01 秒）与
   `scheduler-clarify-multiround-aging.test.ts`（6.21 秒）超时，没有 RFC-292 trigger 断言失败。

因此收尾采用“全量尝试 + 每个失败精确归因/独立复跑 + RFC-292 全链定向门”的固定边界，不等待其它 session 停止修改
共享主树，也不无限重启全量分片。

## 交付边界

- 本门验证的是当前共享工作树中的 RFC-292 实现，没有创建 commit、push 或发布。
- 本轮未调用真实外部代码平台；code-host 网络语义由本地 HTTP stub 验证。
