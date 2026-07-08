# RFC-152 · WS 频道双端注册表（design）

> 现场行号以 G10 调研全景（origin/main@545ab682 基准）为准。

## 1. ChannelSpec（backend ws/registry.ts）

```ts
interface ChannelSpec<P, M> {
  helloName: string
  pathRe: RegExp
  parse: (m: RegExpMatchArray, url: URL) => P | null   // task 解析 ?since
  broadcaster: TypedBroadcaster<M>
  channelKeyOf: (p: P) => string
  /** (a) 升级时整连接门禁（task=canViewTask；distill-jobs=admin）。 */
  upgradeGate?: (db, actor, p: P) => Promise<true | { code: string; message: string }>
  /** (b) per-frame 过滤（tasks-list/workflows/memories）。 */
  frameGate?: (ctx: { db; actor; cache }, msg: M) => Promise<boolean>
  adminShortCircuit?: boolean
  cacheBustOn?: (msg: M) => string[]                    // workflows acl.updated
  /** task ?since 回放等 open 附加动作。 */
  onOpenExtra?: (ws, p: P) => Promise<void>
}
const WS_CHANNELS = { task: {...}, 'tasks-list': {...}, ... } as const
  satisfies Record<ChannelKind, ChannelSpec<any, any>>
```

- `gatedSubscribe(ws, spec, parsed)`：统一订阅注册 + hello + per-frame 管线
  （admin 短路→cache→frameGate→出错丢帧——handleOpen :314-447 三段复制块单源）。
- server.ts 降为：正则表迭代 parse → upgradeGate → data 构造 → open 时
  `gatedSubscribe` + `onOpenExtra`；safeSend 联合与 ConnectionData 判别从
  spec 类型派生。
- memories 双码路（帧内 scope vs 回表）留在其 frameGate 内部；workflows
  deleted-用旧缓存语义随 cacheBustOn 顺序保证（bust 在 gate 后）。

## 2. 前端（PR-5）

- shared/schemas/ws.ts 补 `WS_PATHS = { task:(id)=>..., tasksList:'/ws/tasks', ... }`
  常量（双端 path 手写清零；后端 pathRe 与其同源派生或互锁测试）。
- `hooks/useWsInvalidation.ts`：`useWsInvalidation(path, rules, ctx?)`；
  `rules: Record<string, (msg, ctx) => readonly QueryKey[] | void>`。
- 6 hook 改薄包装（导出名兼容）：useTaskSync/useClarifyWs 合并为同 socket 的
  规则叠加（消 reviews.detail 双挂——MultiDocReviewView 的 useTaskSync 去重
  由 hook 内 refcount 或调用点去挂，取调用点去挂+注释）。
- 版本门控（useWorkflowSync onRemoteUpdate）与 draft 回调（useClarifyWs
  onDraftUpdated）是规则表之外的副作用槽——rules 值允许 void（副作用型）。

## 3. 决策记录

- **D1** 三鉴权形态以可选槽表达不拍平（RFC-147 先例）。
- **D2** task 生产者 18 点 broadcast 调用面零改动（注册表只收订阅/分发侧）。
- **D3** P0 admin 门禁语义先行独立修复（682de313），入表时 upgradeGate 承接。
- **D4** repo-import batch 归属校验登记遗留（非本 RFC）。
- **D5** 双挂消除取调用点去挂（refcount 复杂度不值当前两处场景）。

## 4. 测试策略

注册表穷举锁 + 新增频道改动面 grep 棘轮（server.ts 散装 kind 分支清零白名单）+
既有逐帧对拍群零改动（ws/rfc099/repo-imports/auth-multi-token）+ task stranger
帧级拒绝新格（PR-4 前置）+ 前端 invalidation 表单测 + 双挂消除回归
（reviews.detail 单连接）。

## 5. 任务分解 → plan.md（5 commit，PR-0 已交付）
