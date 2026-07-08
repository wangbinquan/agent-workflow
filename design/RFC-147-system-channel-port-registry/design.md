# RFC-147 · 系统通道端口描述符注册表（design）

## 1. 现场语义矩阵（调研实录）

| #   | 现场                                                 | 端口集                 | 侧向   | `__clarify__` 语义                                 | 用途                                                                                  |
| --- | ---------------------------------------------------- | ---------------------- | ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `shared/clarify.ts isClarifyChannelEdge`             | 5                      | 分侧   | 无条件算通道                                       | 边分类（canvas 级联删除、validator :365 悬空边豁免、scheduler topologicalOrder 破环） |
| 2   | `workflow-sync-diff.ts CHANNEL_PORTS`                | 5                      | 任一侧 | 无条件                                             | sync 差异展示的通道边过滤（防御宽）                                                   |
| 3   | `prompt.ts SYSTEM_PORT_NAMES`                        | 2（response/feedback） | target | 不涉及                                             | auto-append 跳过空 `## __port__` 头                                                   |
| 4   | `scheduler.ts buildScopeUpstreams`                   | 5                      | 分侧   | **target kind==='clarify' 才跳**（cross 保留依赖） | 数据流 DAG（dispatch 门控）                                                           |
| 5   | `dispatchFrontier.ts wrapperExternalUpstreamSources` | 5                      | 分侧   | 同 #4（逐字手抄）                                  | wrapper 外部 provenance 源                                                            |
| 6   | `taskQuestionDispatch.ts isChannelEdge`              | 5                      | 分侧   | 无条件（与 #1 逐字等价）                           | agent-ancestry 频率图                                                                 |

关键判断：

- #6 ≡ #1（代码形状同构，注释论证 agent-ancestry 下均匀跳与 nuanced 等价——两个 agent
  永不经由 cross 节点相连，两跳皆通道边）→ 直接换用共享谓词 + 保留等价性注释。
- #4/#5 是真正的 nuanced 语义（2026-05-22 bug 修复），是「新增端口最容易漏改」的两处
  ——收敛为一个 shared 实现是本 RFC 的核心收益。
- topologicalOrder（#1 的消费者之一）与 #4 的语义差是**有意的**：破环只需保守均匀跳
  （保留 **clarify**→cross 也不成环，均匀跳只是更保守的排序），依赖门控必须 nuanced。
  注册表不抹平这层差——两个投影并存、各自具名。

## 2. 注册表（新 shared/systemChannelPorts.ts）

```ts
import {
  CLARIFY_SOURCE_PORT_NAME, // '__clarify__'
  CLARIFY_RESPONSE_TARGET_PORT_NAME, // '__clarify_response__'
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT, // '__external_feedback__'
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT, // 'to_designer'
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT, // 'to_questioner'
} from './schemas/workflow'

export interface SystemChannelPortSpec {
  /** 该端口在合法通道边上的哪一侧出现。 */
  side: 'source' | 'target'
  /** 内容经 prompt 专属块注入（auto-append 必须跳过 `## <port>` 空头）。 */
  promptInjected: boolean
  /** 数据流依赖语义：never=一律跳边；unless-target-clarify=仅 target 为
   *  RFC-023 clarify 节点才跳（cross-clarify 目标保留为真依赖）。 */
  dataflow: 'never' | 'unless-target-clarify'
}

export const SYSTEM_CHANNEL_PORTS = {
  [CLARIFY_SOURCE_PORT_NAME]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'unless-target-clarify',
  },
  [CLARIFY_RESPONSE_TARGET_PORT_NAME]: { side: 'target', promptInjected: true, dataflow: 'never' },
  [CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT]: {
    side: 'target',
    promptInjected: true,
    dataflow: 'never',
  },
  [CROSS_CLARIFY_OUT_TO_DESIGNER_PORT]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'never',
  },
  [CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'never',
  },
} as const satisfies Record<string, SystemChannelPortSpec>
```

派生投影（全部同文件导出）：

```ts
/** 分侧成员判（家族 A）。isClarifyChannelEdge 的表驱动重实现。 */
export function isSystemChannelEdge(e: Pick<WorkflowEdge, 'source' | 'target'>): boolean

/** 任一侧宽判（家族 B，sync-diff 展示防御）。 */
export function touchesSystemChannelPort(e): boolean

/** prompt 注入集（家族 C）。 */
export const PROMPT_INJECTED_PORT_NAMES: ReadonlySet<string> // 派生自 promptInjected

/** 数据流跳边判定（家族 D——#4/#5 的单一实现）。
 *  kindOfTarget: 调用方提供 target nodeId → kind 的查询（scope 内 Map / 全定义 Map 均可）。 */
export function channelEdgeDataflowSkip(
  e: Pick<WorkflowEdge, 'source' | 'target'>,
  kindOfTarget: (nodeId: string) => string | undefined,
): boolean
```

`isClarifyChannelEdge`（clarify.ts）改为 `return isSystemChannelEdge(e)` 的薄别名并加
迁移注释（导出面不动——canvas/validator/topology/barrel 零改动）；或直接在 clarify.ts
内 re-export。取别名薄函数（保留历史 docstring 锚点）。

## 3. 消费面切换

| 现场                                                 | 改法                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| clarify.ts isClarifyChannelEdge                      | 表驱动薄别名（语义字节不变）                                                                                                                                                   |
| workflow-sync-diff.ts                                | 删私有 CHANNEL_PORTS/isChannelEdge，改 `touchesSystemChannelPort`                                                                                                              |
| prompt.ts                                            | 删私有 SYSTEM_PORT_NAMES，改 `PROMPT_INJECTED_PORT_NAMES`                                                                                                                      |
| scheduler.buildScopeUpstreams                        | 手写两段跳边逻辑 → `channelEdgeDataflowSkip(e, kindById.get)`（kindById 既有）                                                                                                 |
| dispatchFrontier.wrapperExternalUpstreamSources      | 同上（删手抄块 + 删 "keep in lockstep" 人肉契约注释）                                                                                                                          |
| taskQuestionDispatch.isChannelEdge                   | 删私有实现，改 `isClarifyChannelEdge` + 等价性注释保留                                                                                                                         |
| **validator 环检跳边（设计门 high 补录=消费点 #7）** | wrapper-loop 内数据环检测的 5 字面量手拆块与家族 A 逐字同构 → `isClarifyChannelEdge`（环检要保守均匀语义，与 topologicalOrder 同队）                                           |
| **validator cross-clarify shape 规则族**             | 端口**个体**结构契约（to_designer 唯一designer/自动边配对等），非家族语义——不查注册表，但 16 处裸字面量比较全部改引 schemas/workflow 常量（谓词形态字面量随棘轮禁绝）          |
| **nodePorts 系统组声明**                             | 5 注册表端口改引常量；注册表↔declaredPorts 加**漂移互锁测试**（遍历注册表键断言 owner kind 系统组包含之，新键 fail-loud）——两表职责不同（家族语义 vs kind 归属），互锁替代合并 |

## 4. 失败模式

- **语义回归风险集中在 #4/#5**：channelEdgeDataflowSkip 的格测试先行提交（红绿序：
  先对现行手写实现写等价格测试→切换→格测试对新实现继续绿）；cross-clarify 集成回归
  （rfc056 泄洪场景）作兜底。
- **新端口漏声明**：satisfies + 表值锁；grep 棘轮两层——五个私有拷贝标识符 +
  **五端口谓词形态字面量比较全仓禁绝**（合法家仅 schemas/workflow.ts 常量定义与
  注册表本体；设计门 high 采纳）；注册表↔declaredPorts 漂移互锁。
- **循环 import**：systemChannelPorts.ts 仅依赖 schemas/workflow（类型+常量），被
  clarify.ts/prompt.ts/workflow-sync-diff.ts 依赖——与现有依赖方向一致，无环。

## 5. 测试策略

1. `rfc147-system-channel-ports.test.ts`（backend tests 惯例位）：
   - 表值锁（逐端口 side/promptInjected/dataflow）；
   - `channelEdgeDataflowSkip` 语义格：`__clarify__`→clarify=skip / →clarify-cross-agent=keep /
     →agent-single（残迹）=keep / response·feedback target=skip / to\_\*·source=skip /
     普通数据边=keep；
   - `isSystemChannelEdge` 分侧格（反侧不命中：source=**clarify_response** 不算）；
   - `touchesSystemChannelPort` 宽判格（任一侧命中）；
   - 派生集一致性（PROMPT_INJECTED = {response, feedback}）；
   - grep 棘轮：`CHANNEL_PORTS`/`SYSTEM_PORT_NAMES` 私有拷贝零再现 + scheduler/
     dispatchFrontier 手写端口字面量块消亡 + 两文件引用共享判定。
2. 既有回归零改动全绿：cross-clarify rfc056 集成群、workflow-sync-diff 测试、prompt
   auto-append 测试、validator 悬空边豁免、canvas 级联删除群。

## 6. 任务分解 → plan.md（单 PR）
