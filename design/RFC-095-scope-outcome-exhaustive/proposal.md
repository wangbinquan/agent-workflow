# RFC-095 — decideScopeOutcome 抽取 + 状态全集穷举分桶 + canceled 归类落定

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-2**（对应既有
> fortify-then-refactor 队列的「scheduler 抽 decideScopeOutcome」；S-12 / S-22 / S-1 的
> 结构化收尾）。触发：2026-06-11 用户「继续 WP-2」。

## 背景

- **S-12（P2，历史五连漏）**：deriveFrontier 的终态分桶是手工 if/else（scheduler.ts:1183-1185
  只收 awaiting*review / awaiting_human / failed），latest 为 running（不在飞）/ canceled /
  skipped / pending（锚点已耗）的节点**不落任何桶**——scope 静默后统一以无诊断价值的
  `'scheduler stalled' / 'no ready nodes in scope'`（:684-687）收场，连卡住的是哪个节点都
  不说。历史上 awaiting*\*、exhausted、interrupted、canceled 五次漏分类，其中三次发生在
  RFC-053 状态机化**之后**——人工枚举已被证明挡不住；`'skipped'` 在 schema 存在但零铸造点，
  未来任何人启用即落黑洞。现状锁定：`scheduler-audit-s12-status-bucket-universe.test.ts`。
- **S-22（P2）**：canceled 任务允许 retryNode（前端 `canRetryNodeRun` 显式把 canceled 列为
  可重试——设计内 UI 流），但 canceled 行既不可派发（dispatchFrontier.ts isDispatchable
  兜底 false）也不入桶——重试目标跑完后 canceled sibling 永远阻塞 → 不透明 stalled 循环。
  canceled 在「可恢复终态」与「真终态」之间的归类从未被显式决策。现状锁定：
  `scheduler-audit-s22-canceled-retry-stall.test.ts`。
- **S-1 结构收尾**：RFC-092 修了 pending 锚点屏蔽，但 quiescent 块（scheduler.ts:652-687）
  仍是 runScope 内嵌的 if 链，优先级语义（awaiting_human > awaiting_review > failed >
  exhausted > done > stalled）只能靠集成测试间接覆盖，不可表驱动直测。

## 目标

1. **分桶穷举化**：deriveFrontier 对 NodeRunStatus 全集（10 值 + latest 缺失）做穷举
   switch + `never` 编译期检查——新增状态不改这里直接编译失败；Frontier 增加 `blocked`
   诊断桶（nodeId + status + 机器可读 reason），收纳所有「上游已就绪却派不出去、又不属于
   三个停泊桶」的节点。
2. **stalled 可诊断**：`scheduler stalled` 的 detail 附带 blocked 清单（节点 / 状态 / 原因 /
   补救提示），不再是裸的 "no ready nodes in scope"。
3. **decideScopeOutcome 纯函数抽取**：runScope quiescent 块的优先级判定抽到
   dispatchFrontier.ts（纯模块），表驱动单测穷举优先级矩阵；runScope 改为调用。
4. **canceled 归类显式落定**（默认推荐方案 ①，批准时确认）：
   - **方案 ①（推荐）**：canceled 行 = 可重铸信号（与 interrupted 同类——都是「执行被外力
     中止」），**但 review supersede 的 canceled 标记行除外**（`errorMessage` 以稳定前缀
     `superseded-by-review-` 标识，review.ts:1729 注释明言该前缀是 grep 契约）。效果：
     canceled 任务 retryNode 后整个 canceled 子图随调度自然复活、任务能跑到 done（S-22
     根治）；supersede 标记行保持不可派发，封死「supersede 翻 canceled → 铸 rerun 行」
     之间的 await 窗口误派发。
   - **方案 ②**：canceled 维持真终态、retryNode 对 canceled 任务改为 409 拒绝（与
     resumeTask 对齐）——需要同步改前端 `canRetryNodeRun`（产品行为回退），且用户失去
     「取消后从某节点续跑」的能力。
5. 翻转 s12 / s22 两个现状锁定为正确语义锁定。

## 非目标

- 不动 tasks.status 的 CAS / 转移表（WP-4）。
- 不动 isLiveStatus / wrapper 镜像等其他状态消费点的共享化（S-12 建议的 classifyRunStatus
  大一统留给后续重构；本 RFC 先把 deriveFrontier + isDispatchable 两个核心消费点穷举化）。
- 不改 orphans.ts 收割语义（缺口 5 另立）。
- 不改 exhausted / awaiting\_\* / failed 的既有分桶与优先级语义（仅结构化，字节级等价）。

## 用户故事

1. 我的任务卡住失败时，错误信息直接告诉我「卡在节点 X（状态 running，疑似孤儿行，重启
   daemon 可收割）」而不是一句 "scheduler stalled"。
2. 我取消了一个并行任务，改完环境后对失败分支点 retryNode：整个任务从取消点自然续跑到
   done，不再陷入 stalled 循环。
3. 未来有人给 node_runs 加新状态：deriveFrontier 直接编译失败，强迫他显式决策新状态的
   分桶归属，而不是默默掉进黑洞。

## 验收标准

- [ ] `scheduler-audit-s12-*` 翻转：running（不在飞）/ skipped / pending（锚点已耗）落
      `blocked` 桶（带 reason）；canceled（非 supersede）→ ready；supersede 标记行 →
      `blocked(reason: review-superseded)`；全集表保持「每个状态入且仅入一个显式集合」。
- [ ] `scheduler-audit-s22-*` 翻转：retryNode 后 canceled sibling → ready；新增集成断言
      canceled 任务 retryNode 后任务跑到 done。
- [ ] 新增 `rfc095-scope-outcome.test.ts`：decideScopeOutcome 优先级矩阵表驱动；stalled
      detail 含 blocked 诊断；NodeRunStatus 全集 property test（编译期 never + 运行时全集
      扫描双保险）。
- [ ] supersede 窗口回归：iterate 决策的 canceled 标记行在 rerun 行落地前不可派发
      （纯函数面）；`rfc092-midrun-review-iterate.test.ts` 等既有集成全绿。
- [ ] runScope 行为字节级等价改造（优先级不变、detail 增量只加不改），全量套件无未解释红。
- [ ] `bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿；CI 全绿。
