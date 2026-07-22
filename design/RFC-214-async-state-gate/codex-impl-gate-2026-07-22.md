# Codex Adversarial Review

Target: branch diff against 34f90b88
Verdict: needs-attention

暂不应发。未发现 home 的 QueryState 迁移或已替换 retry callback 的直接副作用回退，memory 缓存行目前仍走旧的保留数据路径；但“全量收编、唯一 retry 实现”存在现行反例，且 A/B 源码守卫可静默放过多种漂移。

Findings:
- [medium] InboxDrawer 的查询重试未被收编，统一实现仍有现行反例 (packages/frontend/src/components/shell/InboxDrawer.tsx:301-314)
  触发路径：打开 InboxDrawer，任一 feed 查询失败。这里仍通过 ErrorBanner.action 渲染 btn--ghost/btn--xs 按钮；entry.retry 最终调用对应 query.refetch（同文件 163-170），并非 mutation 例外。它绕过统一按钮和源码锁；同时 ErrorBanner 当前没有 retryAriaLabel 接口，直接迁移还会丢失各 feed 已有的专属可访问名称。结果是全量收编声明不成立，且保留用户可见和 a11y 行为分叉。
  Recommendation: 为 ErrorBanner.onRetry 增加 retryAriaLabel（并考虑统一 busy/disabled 状态），随后迁移三个 feed，保持各自 refetch 回调和可访问名称，并保留逐 feed 重试测试。
- [medium] 源码锁按文件放行且依赖脆弱正则，无法构成防漂移闸门 (packages/frontend/tests/async-state-gate-source-guard.test.ts:66-118)
  Lock A/B 先把每个文件压缩为是否命中，再按整文件 allowlist 放行；因此在 grandfather 文件增加第二处违规也会继续通过。Lock A 仍漏掉命名 handler、optional/computed member 等形态；Lock B 要求 className 精确等于 muted，像现存的 className="muted inventory-section__empty" 即不会命中。此外只有 Lock A 校验过期 allowlist，Lock B 的失真登记不会失败。InboxDrawer 的命名 retry 已证明这种盲区能容纳真实查询重试。
  Recommendation: 改为 AST/JSX 检测，或维护按文件加具体 occurrence 指纹与数量的快照；两个锁都做双向诚实性校验，并增加表驱动 mutation cases，覆盖命名 handler、optional/computed refetch、组合 className 及 allowlisted 文件新增第二处违规。

Next steps:
- 修复 InboxDrawer 后，对仓库重新执行查询 retry 与手写 empty-state 的全量扫描。
- 使用真实 QueryClient 补 enabled:false→true 以及缓存数据后台 refetch 失败的集成测试，覆盖 memory 行不闪空和降级重试。
- 重跑 frontend 单测与 RFC-214 两条源码守卫，确认新增的变异样例会先失败再通过。

Codex session ID: 019f8779-e27a-7c41-bd29-0dd4cdd42034
Resume in Codex: codex resume 019f8779-e27a-7c41-bd29-0dd4cdd42034
