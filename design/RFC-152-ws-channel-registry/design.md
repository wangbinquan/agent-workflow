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
  /** task ?since 回放等 open 附加动作。 */
  onOpenExtra?: (ws, p: P) => Promise<void>
}
const WS_CHANNELS = { task: {...}, 'tasks-list': {...}, ... } as const
  satisfies Record<ChannelKind, ChannelSpec<any, any>>
```

- `gatedSubscribe(ws, spec, parsed)`：统一订阅注册 + hello + per-frame 管线
  （admin 短路→frameGate→出错丢帧——handleOpen :314-447 三段复制块单源）。
- **设计门 high 修订（workflows 双向序）**：acl.updated 需**先 bust 后 gate**
  （同连接刚获授权要收到帧），deleted 需**先读旧缓存后 bust**（此前可见者要
  收到删除帧）——单一 cacheBustOn 槽表达不了相反顺序，**槽删除**，workflows
  的 frameGate 自持完整缓存生命周期（D1「不拍平」的延伸）。回归两格：
  同连接授权后收 acl.updated+update；此前可见者在行删后收 deleted。
- **设计门 medium 修订（memories 逐变体）**：frameGate 契约逐 MemoryWsMessage
  变体指明——candidate.created=帧内 scope；带 memoryId 的六变体=回表；
  **memory.superseded（oldId/newId 无 memoryId）= 保留现行 non-admin 丢帧**
  （迁移零行为变更；「stranger 前端可能 stale」登记已知现状，改良另议）。
  supersede 前置测试：admin 收帧 / scoped user 丢帧 / stranger 丢帧三格。
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
- 6 hook 改薄包装（导出名兼容）+ **BatchImportDialog 的直调 useWebSocket**
  （repo-import 消费点，设计门 medium 补录——非 hook 形态，改走
  WS_PATHS.repoImport + 订阅测试）。
- **实现门修订（high）**：共享池只按 path 键控会让 socket 钉死创建时的
  token/baseUrl——re-login / 切换远端 daemon 后，后挂载订阅者搭旧凭据老连接
  （pre-share 每次新挂载至少拿新 socket）。修法：管理器 `subscribeAuth` 全池
  强制轮换（存量 socket 也随凭据重连，监听注册原位保留）+ close 处理器加
  「被取代 socket 不再调度」守卫防双连。**复门补洞**：CONNECTING 旧 socket
  被延迟关闭（等 open）期间仍会 flush 旧凭据帧——message/open 处理器补
  current-socket 守卫（`conn.socket !== ws || conn.stopped` 即丢）。回归七格：
  token 轮换换 socket 且帧仍达/baseUrl 重指向/轮换后晚挂载共享新 socket/
  退避窗内无幽灵第三连接/CONNECTING 被取代后迟到帧被丢且延迟关闭如期/
  clearToken 拆连等登录、下次 setToken 轮换回连/双轮换仅最新 socket 派发
  （rfc152-ws-auth-rotation.test.tsx）。
- **D5 修订（设计门 high）**：多文档路由不经 ReviewDetailPage——
  MultiDocReviewView 的 useTaskSync 是多文档页**唯一活订阅**，调用点去挂会
  杀掉全部 review.\*/task 失效。改为 **hook 层 socket 共享**：useWsInvalidation
  同 (path) 单 socket 多规则集 refcount（useTaskSync 与 useClarifyWs 天然
  合流；reviews.detail 双挂由共享自然消除）；回归=单双文档路由各自失效面
  不回退 + 同 task 仅一条连接。
- 版本门控（useWorkflowSync onRemoteUpdate）与 draft 回调（useClarifyWs
  onDraftUpdated）是规则表之外的副作用槽——rules 值允许 void（副作用型）。

## 3. 决策记录

- **D1** 三鉴权形态以可选槽表达不拍平（RFC-147 先例）。
- **D2** task 生产者 18 点 broadcast 调用面零改动（注册表只收订阅/分发侧）。
- **D3** P0 admin 门禁语义先行独立修复（682de313），入表时 upgradeGate 承接。
- **D4** repo-import batch 归属校验登记遗留（非本 RFC）。
- **D5（设计门修订翻转）** 双挂消除走 hook 层 socket 共享（refcount）——
  调用点去挂方案被证伪（多文档订阅是唯一活源）。

## 4. 测试策略

注册表穷举锁 + 新增频道改动面 grep 棘轮（server.ts 散装 kind 分支清零白名单）+
既有逐帧对拍群零改动（ws/rfc099/repo-imports/auth-multi-token）+ task stranger
帧级拒绝新格（PR-4 前置）+ 前端 invalidation 表单测 + 双挂消除回归
（reviews.detail 单连接）。

## 5. 任务分解 → plan.md（5 commit，PR-0 已交付）
