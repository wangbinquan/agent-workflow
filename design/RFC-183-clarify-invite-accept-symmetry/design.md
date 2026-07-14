# RFC-183 技术设计——反问「邀请 ⟺ 接受」对称收口

## 1. 现状与问题精确定位

### 1.1 谓词现状

- **注入谓词**（`packages/shared/src/prompt.ts:364-373`）：
  `mandatoryAskBack = channel.directive === 'mandatory'`、
  `optionalAskBack = channel.directive === 'optional'`——只有这两档注反问样例；
  followup 渲染同源（`runner.ts:656` 传 `hasClarifyChannel: clarifyMandatory || clarifyOptional`）。
- **接受谓词**（`runner.ts:1163-1260` 信封判定链）：
  `mandatory` 强制 clarify、`stopped` 拒 clarify（RFC-123）、工作组自治经
  `opts.clarifySuppressed?.()` 信封时刻拒（RFC-181 C）——**但 `suppressed` 落进
  `kind === 'clarify'` 的接受分支**（1217 行起）：解析问题 → `clarifyResult` → scheduler
  建 session → park。
- 注入说「不问」，接受说「可以问」——豁口即此。

### 1.2 `'suppressed'` 字面量的两种互斥语义（必须先拆）

| 产生点 | 语义 | 邀请在哪 | 接受权在哪 |
| --- | --- | --- | --- |
| `scheduler.ts:3384-3396`（canvas 组装） | 评审驳回 / iterate 重产出轮：**不邀请** | 无 | runner（本 RFC 改为拒绝） |
| `scheduler.ts:782`（host 派发，工作组/DW 等） | **邀请与接受权都外置** | `workgroupProtocolBlock`（`WG_CLARIFY_BLOCK`，非自治才注） | RFC-181 信封回调 + `scheduler.ts:851` `clarify-no-channel` 检查 |

若按字面量一刀切拒绝，非自治工作组的反问（RFC-172 route 2 全角色可问）会被误杀。
故新增 `'delegated'` 承载 host 语义，`'suppressed'` 收窄为「不邀请 ⇒ 不接受」。

## 2. 接口契约

### 2.1 类型与单一处置分类器（`packages/shared/src/prompt.ts:159`）

```ts
directive: 'mandatory' | 'suppressed' | 'stopped' | 'optional' | 'delegated'
```

**Codex 设计门 P2#2 折入——穷举处置分类器**（G3 的真正结构锁）。此前注入与拒绝是两套
独立的否定式判断（渲染只认 mandatory/optional、runner 各自拒 stopped/suppressed），
未来新增一档 directive 可以编译通过、零样例渲染、却从 runner 判定链缝隙里被接受——
正是本 RFC 要消灭的漂移。改为 shared 单源：

```ts
export type ClarifyDisposition = 'invite-mandatory' | 'invite-optional' | 'reject' | 'external'

export function clarifyDispositionFor(
  directive: 'mandatory' | 'suppressed' | 'stopped' | 'optional' | 'delegated',
): ClarifyDisposition {
  switch (directive) {
    case 'mandatory':
      return 'invite-mandatory'
    case 'optional':
      return 'invite-optional'
    case 'stopped':
    case 'suppressed':
      return 'reject'
    case 'delegated':
      return 'external'
    default: {
      const exhausted: never = directive
      throw new Error(`unreachable clarify directive: ${String(exhausted)}`)
    }
  }
}
```

三方消费同一分类器：

- 渲染（`prompt.ts:368-373`）：`mandatoryAskBack ⟺ disposition === 'invite-mandatory'`、
  `optionalAskBack ⟺ 'invite-optional'`（替换现有按字面量判断，字节零变化）。
- runner：`disposition === 'reject'` 时拒绝 `kind === 'clarify'`（消息措辞仍按 directive
  分 stopped / suppressed 两味，见 §2.3）；`'external'` 走 RFC-181 回调 +
  `clarify-no-channel`，runner 的 directive 判定链对其零裁决。
- golden matrix 测试：**遍历联合类型全体成员**（以分类器的入参类型驱动 case 表），
  新增 directive 不补 golden 行/不选处置就编译红。

- `'delegated'`（新，RFC-183）：本轮的反问**邀请与接受权都不归 renderUserPrompt /
  runner 的 directive 判定管**——邀请由调用方的 `workgroupProtocolBlock` 自带（非自治
  注 `WG_CLARIFY_BLOCK`，自治省略），接受由 RFC-181 信封回调 + scheduler 层
  `clarify-no-channel` 检查裁决。仅 host 派发使用；kind 恒 `'self'`。
- `'suppressed'`（语义收窄）：不邀请 ⇒ 不接受。评审驳回 / iterate 重产出轮专用
  （RFC-122 oracle：`reviewActive && !isClarifyRerun`，见 `clarifyRounds.ts:48-65`）。
- JSDoc 同步改：`prompt.ts:125-143`（ADT 头注释）、`:240-242`（workgroupProtocolBlock
  与 directive 关系）、`:258-260`（渲染等价类加入 `'delegated'`）。

### 2.2 渲染（`packages/shared/src/prompt.ts`，零字节变化）

`'delegated'` 走与 `'suppressed'` 完全相同的分支：`mandatoryAskBack` / `optionalAskBack`
均为 false → trailing = `workgroupProtocolBlock ?? buildProtocolBlock(...)`。**不新增渲染
代码**，只有类型与注释；RFC-148 golden matrix 补一行 `'delegated'` 断言其输出与
`'suppressed'` 逐字节相同。

### 2.3 执行（`packages/backend/src/services/runner.ts`）

派生（`:463-469` 处）改为消费 §2.1 分类器（P2#2）：

```ts
const clarifyMandatory = clarifyWired && clarifyDispositionFor(channel.directive) === 'invite-mandatory'
const clarifyOptional = clarifyWired && clarifyDispositionFor(channel.directive) === 'invite-optional'
const clarifyRejected = clarifyWired && clarifyDispositionFor(channel.directive) === 'reject'
```

（`clarifyStoppedDirective` 变量并入 `clarifyRejected`，消息味道仍按
`channel.directive` 细分。）信封判定链上 RFC-123 的 stopped 分支（`:1186`）改写为
统一的 reject 分支、置于 RFC-181 回调分支（`:1199`）之前；**并新增未接线拒绝**
（Codex 设计门二轮 P2#3 折入，见下）：

```ts
} else if (kind === 'clarify' && !clarifyWired) {
  // P2#3：kind:'none' 的自愿反问此前解析为 status='done' + 空 outputs——主派发路径
  // 靠 scheduler 事后补拒（clarify-no-channel），但分片子运行（scheduler.ts:4872）与
  // 聚合等直调方只看 result.status，空产出会伪装成功甚至合并 worktree。前置到 runner。
  status = 'failed'
  errorMessage = 'clarify-no-channel: agent emitted <workflow-clarify> but this run has no clarify channel; emit <workflow-output>'
} else if (clarifyRejected && kind === 'clarify') {
  status = 'failed'
  failureCode = 'clarify-forbidden'
  errorMessage =
    channel.directive === 'stopped'
      ? `${CLARIFY_FORBIDDEN_PREFIX}: node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>` // RFC-123 措辞逐字节保留
      : `${CLARIFY_FORBIDDEN_PREFIX}: this re-production round does not accept ask-back; apply the review feedback and emit <workflow-output>, not <workflow-clarify>`
}
```

未接线拒绝的语义对齐今天主路径的 scheduler 补拒：无 `failureCode`（不在
`FOLLOWUP_POLICY`，不做同 session followup），按节点重试策略走 attempt 重试后硬失败。
scheduler `:3603-3610` 的补拒**保留**作纵深防御——它裁决的是「ADT 认为接线但图上
解析不到 clarify 节点」这另一条边，与 runner 的 `kind:'none'` 检查不同轴。

- `kind === 'both'` 维持既有 `clarify-and-output-both` 分支（在后，语义不变：suppressed
  轮发 both 仍按 both 报——它的 output 半边本可接受，both 的修复提示更准确）。
- `:1219-1223` 的 RFC-148 注释（"suppressed cross rerun … still parses with the lifted
  cap"）已失真——canvas suppressed 不再进入解析；cap 锚定 `kind === 'cross'` 的代码不动
  （mandatory / optional cross 仍需无上限解析），只改注释。
- followup 渲染入参（`:656`）不变：`'suppressed'` / `'delegated'` 均非 mandatory/optional
  → output-only bullets，正确。

### 2.4 派发（`packages/backend/src/services/scheduler.ts`）

- `:782` → `clarifyChannel: { kind: 'self', directive: 'delegated', injectStopNotice: false }`；
  同步改 `:776` / `:703` 注释。
- `:3384-3396` canvas 组装不动（`'suppressed'` 继续由
  `resolveEffectiveClarifyChannel === false` 推出）。
- host 后置机制零改动：RFC-181 信封回调（`:784`）、host 建 session（`:798-848`）、
  `clarify-no-channel`（`:851`）、canvas 无接线检查（`:3603-3610`）。

### 2.5 Codex 设计门 P2#1 折入——clarify-answer 血统的进程级重试不得退化为 suppressed

**问题链**（已逐锚点验证）：clarify-answer / cross-questioner 续跑轮（`isClarifyRerun=true`
→ mandatory）发生进程级失败时，重试行以 `cause:'process-retry'` 铸造
（`scheduler.ts:2881-2886`）；`isClarifyRerunCause('process-retry') === false` 是 RFC-098
修订 #11 的**刻意设计**（`nodeRunMint.ts:243-268`——Q&A 上下文走 generation 推导、禁
inline resume，不走该门）。于是 `reviewActive && !isClarifyRerun` → oracle 判
`suppressed`。今天这已是注入向的存量疙瘩（血统正中途反问、用户可能刚点了「继续反问」，
prompt 却零反问字节）；叠加本 RFC 的拒绝后会**硬顶撞用户的 continue 指令**（AC3 精神），
逼产出或耗尽重试。可达路径不止评审中自愿反问一条：任务提问（taskQuestionDispatch 以
`cause:'clarify-answer'` 铸造 handler 续跑）与 RFC-120 延迟派发都可能在 reviewActive
下出现该血统。

**修法——oracle 输入改为持久血统推导，不动 RFC-098 的 mint 门**（Codex 二轮 P2#4
修订：初稿的 attempt 循环内布尔跨不过 daemon 恢复边界——重启把 pending/running 反
`interrupted`〔`orphans.ts`〕、恢复铸 `cause:'revival'`〔`scheduler.ts:2711-2719`，
同样不在 `isClarifyRerunCause` 集合〕，内存态血统即丢失，恢复轮会退化 `suppressed`
被硬拒，违背 AC3b 与用户 continue 指令）：

- 新增纯函数（落 `nodeRunMint.ts`，与 `isClarifyRerunCause` 毗邻）：

  ```ts
  /** 沿「技术性延续」cause（process-retry / revival）回溯到首个实质 cause，
   *  判定本次派发是否延续 clarify 血统。causesNewestFirst[0] 为当前 attempt 的
   *  cause。'stale-redispatch' 等实质 cause 不跳过——它开启新逻辑轮，判 false。 */
  export function continuesClarifyLineage(causesNewestFirst: ReadonlyArray<string | null>): boolean {
    for (const cause of causesNewestFirst) {
      if (cause === 'process-retry' || cause === 'revival') continue
      return isClarifyRerunCause(cause)
    }
    return false
  }
  ```

- 数据来源零新查询：dispatch 帧内已有 `sameNodeIterRuns`（同 task/node/iteration 血统
  行，含 cause，id 序）；组装 `[当前 attempt cause, ...既有行 cause（id 降序）]` 喂入。
  血统按 DB 持久行推导 ⇒ 跨 attempt、跨 daemon 重启、跨 resume 语义一致。
- oracle `resolveEffectiveClarifyChannel` 的 `isClarifyRerun` 入参改喂
  `continuesClarifyLineage(...)`；oracle 本体与 `isClarifyRerunCause` 及其既有调用方
  （inline-resume 门、Q&A generation 推导）**一概不动**。
- 效果：clarify-answer / cross-questioner 血统的 process-retry **与 revival 恢复轮**
  均维持 `mandatory`（样例在、反问收、continue 被尊重）——同时把今天「中途反问却
  零样例」的注入向疙瘩一并修正。
- 对照边界：评审驳回重产出轮自身的 process-retry / revival——回溯落在
  `'review-reject'` 等实质 cause 上 → false → 维持 `suppressed`（拒绝），不扩权。
- optional 模式不经此路（`clarifyOptional` 按 mode 判定、与 cause 无关，重试/恢复
  自然保持 optional）。

## 3. 数据流（改动后）

```
派发方                     directive      prompt 反问字节           runner 对 <workflow-clarify>
────────────────────────────────────────────────────────────────────────────────────────
canvas 接线·首轮/续问      mandatory      仅反问协议+样例            强制（非 clarify 全拒）
canvas 接线·optional       optional       双信封+样例               接受
canvas 接线·stop           stopped        无 + STOP 指令            拒（RFC-123，不变）
canvas 接线·评审重产出     suppressed     无                        ★拒（本 RFC 新增）
canvas 未接线              none           无                        ★runner 前置拒 clarify-no-channel（P2#3：
                                                                    原先仅主路径 scheduler 事后补拒，分片/聚合
                                                                    等直调方会把空产出当成功；scheduler 补拒
                                                                    保留作纵深防御）
host（工作组/DW）          delegated      无（WG 块按自治性自带）    runner 不按 directive 裁决；
                                                                    RFC-181 回调（自治→拒）+
                                                                    scheduler clarify-no-channel（DW→拒）（不变）
```

不变式（G3）：**渲染与 runner 不再各自按字面量判断，统一消费
`clarifyDispositionFor`——注入 ⟺ `invite-*`，接受 ⟺ `invite-*`，拒绝 ⟺ `reject`**；
directive 之外的接受权只存在于 `'external'`（`'delegated'`），且其邀请
（`WG_CLARIFY_BLOCK`）与接受（RFC-181 回调）同源于 `config.autonomous`。新增 directive
不在分类器选边即编译红（never 检查），不补 golden 行即测试红。

血统补丁（§2.5）：evaluated directive 本身由血统感知的 oracle 产出——clarify-answer /
cross-questioner 血统的连续 process-retry 维持 `mandatory`，不再退化 `suppressed`。

## 4. 失败模式

- **F1 误伤 host 反问**：规避于类型拆分——`'delegated'` 不落新拒绝分支；AC5 集成回归
  （非自治成员反问 park / 自治 RFC-181 行为逐字节不变）锁死。
- **F2 判定竞态**：canvas `suppressed` 由派发时的 review 状态决定（`reviewContext`
  随派发冻结），无中途翻转输入；不存在 RFC-181 那种双向竞态面，无需信封时刻回调。
- **F3 滚动升级在途轮**：升级瞬间在途的评审重产出轮按旧语义收（接受）；directive 不
  持久化，daemon 重启后 interrupted 重跑走新代码。与历次行为变更同待遇，可接受。
- **F4 `clarify-forbidden` 复用撞车**：三个下游全在 host 路径——`workgroupRoom.ts:158`
  （note 派生）、`workgroupRunner.ts:1009/:1220`（重提示/耗尽 drop）、`scheduler.ts:822`
  （A2 补偿）——canvas 行不流入任何一处；`FOLLOWUP_POLICY['clarify-forbidden'] →
  'envelope-missing'`（`prompt.ts:886`）正是所需的重索 output 行为；
  `schemas/task.ts:710` 枚举已含该码，零 schema 改动。消息后缀与 RFC-123（stop）/
  RFC-181（autonomous）措辞不同，三者在日志/测试中可分辨。
- **F5 agent 在评审轮真有疑问**：产品拍板的出路——在 `<workflow-output>` 里写明假设，
  评审人下轮驳回时补充；或作者把 clarify 节点改 optional 模式（该路径样例/接受俱全）。
- **F6 未接线前置拒的误伤面**（P2#3 折入引出）：host 轮 kind 恒 `'self'`（wired）不落
  此分支；DW / 工作组的 `clarify-no-channel` 裁决仍在 scheduler `:851`（host 结果处理）
  ——runner 前置拒只覆盖 `kind:'none'` 派发（分片子运行 `:4872`、聚合 `:5249`、canvas
  未接线主路径），三者今天要么伪成功要么事后补拒，前置后行为只收紧不放宽。
- **F7 血统推导的边界**（P2#4 折入引出）：只跳过 `'process-retry'` / `'revival'` 两个
  技术性延续 cause；`'retry-node'`（用户手动重跑）、`'stale-redispatch'`（新逻辑轮）
  等实质 cause 一律终止回溯并判 false——用户主动重跑不继承反问血统，不扩权。

## 5. 与现有模块的耦合点

| 模块 | 关系 |
| --- | --- |
| RFC-148 ADT（`prompt.ts`） | 联合类型加一档；渲染等价类不变（golden matrix 补断言） |
| RFC-122 oracle（`clarifyRounds.ts`） | 只读依赖，不改；它是 `suppressed` 的唯一 canvas 产生条件 |
| RFC-123 stop 强制（`runner.ts:1186`） | 同构分支，代码相邻；消息后缀区分 |
| RFC-181 硬压制（`runner.ts:1199` + `scheduler.ts:784`） | host 专用路径原样保留；新分支置于其前但集合不相交 |
| RFC-165 optional（`scheduler.ts:3390`） | 优先级 stopped > optional > mandatory/suppressed 不变，评审轮 optional 不受影响 |
| RFC-172 工作组全角色反问 | `'delegated'` 保全其接受路径；`WG_CLARIFY_BLOCK` 注入条件不动 |
| 前端 | 无消费 `'suppressed'` / directive 字面量（已全仓 grep），零改动 |

## 6. 测试策略（随改动同 commit 落地）

新文件 `packages/backend/tests/rfc183-clarify-invite-accept-symmetry.test.ts`：

1. **红→绿主证**（AC1）：mandatory 接线 + reviewContext（驳回重产出）派发 → mock 运行时
   发合法 `<workflow-clarify>` → 断言 node_run `failed` / `failure_code='clarify-forbidden'`
   / errorMessage 前缀与新后缀、无 clarify_sessions 行、任务不进 `awaiting_human`、
   followup 以 envelope-missing 形态重索 output。
2. **cross 同拒**（AC2）：cross 接线同场景 → 无 cross session、不触发 answerer。
3. **clarify-answer 续跑不受影响**（AC3）：`isClarifyRerun=true` → directive `mandatory`。
   **AC3b（P2#1）**：clarify-answer 轮进程级失败 → process-retry 重试轮 directive 仍
   `mandatory`（样例在、反问收）；连续两次 process-retry 仍成立；cross-questioner 血统
   同断言；对照组——评审驳回重产出轮自身的 process-retry 维持 `suppressed`（拒绝）。
   **AC3c（P2#4）**：daemon 重启路径——clarify-answer 轮 `interrupted` → `revival`
   恢复轮仍 `mandatory`；`process-retry` → interrupted → `revival` 链同断言；
   `continuesClarifyLineage` 纯函数单测覆盖跳过集 / 实质 cause 终止 / 全技术 cause /
   空表五类输入。
   **未接线前置拒**（P2#3）：`kind:'none'` 派发（分片子运行形态）发合法
   `<workflow-clarify>` → runner 直接 `failed` + `clarify-no-channel` 消息、无
   failureCode、无 followup、无 session；直调方不再见到空 outputs 的伪 `done`。
4. **optional 评审轮不受影响**（AC4）：优先级锁（directive `'optional'`、双信封样例在、
   反问接受）。
5. **host 回归**（AC5）：非自治 `'delegated'` 反问照收并 park；自治走 RFC-181 拒绝——
   现有 `rfc181-autonomous-hardening.test.ts` / `rfc164-workgroup-*` 保持全绿即为证。
6. **源码文本锁**（AC7）：scheduler host 派发段不得含 `directive: 'suppressed'`
   （表级 grep 断言，锚 `runHostNode` 段落）。
7. **分类器单测**（P2#2）：`clarifyDispositionFor` 全枚举断言 + golden matrix 的 case 表
   以联合类型全体成员驱动（`satisfies Record<Directive, …>` 一类的编译期完备性锚），
   RFC-123 stopped 措辞逐字节锁定不漂移。

存量锁改写（见 plan T3）：

- `packages/backend/tests/rfc148-adt-contracts.test.ts`：
  - 渲染矩阵补 `'delegated'` = `'suppressed'` 字节等同（AC6）；
  - `:148` 「cap 不看 directive——suppressed cross 仍无上限」锁改写为「cap 锚
    `kind==='cross'`，对 mandatory/optional cross 成立；suppressed cross 已在解析前
    被拒（指向本 RFC）」。
- `rfc148-prompt-golden-matrix.test.ts`：suppressed 行不变，补 delegated 行。
- `rfc123-stop-enforcement.test.ts` / `rfc165-optional-clarify.test.ts` /
  `rfc122-clarify-directive-*.test.ts`：预期全绿不改；若有对 suppressed 接受路径的
  正向断言（实现时全量 grep `suppressed` 测试锁清点），逐条改写并在注释标注
  RFC-183。

## 7. 实现顺序与门槛

见 `plan.md`。门槛：`bun run typecheck && bun run lint && bun run test &&
bun run format:check` + `bun run build:binary` smoke + push 后查 CI（按仓规）。
