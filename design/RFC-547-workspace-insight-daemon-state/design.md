# RFC-547 技术设计

## 1. 现状（HEAD `fc5d5c9c0`，源码实读）

- `infrastructure/deep/scipIndexCache.ts`：`ScipIndexCache` 类，加模块级 `let singleton`、懒建的 `scipIndexCache(deps?)` 与 `resetScipIndexCache()`。
  读者两个：`composition/structuralDeepIndexing.ts` 的 `indexCache: () => scipIndexCache()`，与 `infrastructure/deep/deepStructuralDiff.ts` 的
  `deps.cacheScope.cache ?? scipIndexCache()`——应用层（`taskStructuralDiff.ts`）交的 `cacheScope` 只有任务与仓库键、没有缓存，所以这条回落就是
  实际走的路。
- `application/changeNarrative.ts`：模块级 `generating`、`failures`、`inflightTrigger` 三张表与 `resetChangeNarrativeStateForTests()`；
  `getChangeNarrativeStatus(taskId, artifacts)` 与 `triggerChangeNarrative(deps, task)` 直接读写这三张表。
- 两者都经 `composeTaskWorkspaceInsight` 装配，而它在 `bootstrap/daemonHttpComposition.ts` 只调一次，所以“组合一次”就是“守护进程一份”。

## 2. 机制与落位

落在 workspace-insight（composition、application、infrastructure 各自原地）；不新增跨上下文依赖，模块 public 不变。

### D1 索引缓存归组合

- 删去 `singleton`、`scipIndexCache()` 与 `resetScipIndexCache()`，`scipIndexCache.ts` 只留 `ScipIndexCache` 类。
- `composeStructuralDeepIndexing()` 构造一个 `ScipIndexCache`，`indexCache` 返回它，`computeDeepStructuralDiff` 绑定成把它作为第二个参数交给
  基础设施函数；`deepStructuralDiff.ts` 的回落改为这个参数（调用方自己带的缓存仍然优先）。

### D2 叙述状态归组合

- 新增 `ChangeNarrativeState`（三张表）与 `createChangeNarrativeState()`，删去模块级三张表与重置函数。
- `getChangeNarrativeStatus(state, taskId, artifacts)`；`ChangeNarrativeDeps` 多一个必填 `state`，`triggerChangeNarrative` 读写 `deps.state`。
- `composeTaskWorkspaceInsight` 构造一份状态，交给读取与触发两个用例。

### D3 用例与锁

- 新增 `tests/rfc547-workspace-insight-daemon-state-boundary.test.ts`，登记 guard-manifest：① 两个文件顶层没有 `let` 与重置函数，架构报告的
  模块级可变单例判据为空，删去的名字在生产代码里不出现（语料下限 3,000）；② 行为：同一次组合共用一份索引缓存，两次组合各有各的；叙述状态
  由各自的组合持有，一份状态里的生成中记录不影响另一份；③ 带负对照。
- 随改：`rfc453-workspace-insight-module` 的单例用例改为组合语义并去掉重置；`change-narrative` 用每例一份的状态代替重置，测试助手
  `changeNarrativeSystemAgents` 把 `state` 透传；`rfc239-route-error-codes` 去掉多余的重置（只读状态，没有生成）。

## 3. 清单（退出门）

| 名字                                                      | 之后                                         |
| --------------------------------------------------------- | -------------------------------------------- |
| `singleton` / `resetScipIndexCache`（索引缓存单例）       | 删去；深度索引端口的组合构造一个并交给读者   |
| `resetChangeNarrativeStateForTests`（叙述状态的模块级表） | 删去；workspace-insight 的组合构造一份并交入 |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖深度结构 diff、代码智能与变更叙述的行为。

## 5. 失败模式

- **两个读者拿到两份缓存**：深度 diff 与代码智能各建一份就失去共享。RFC-547 用例钉同一次组合的 `indexCache()` 与 diff 用的是同一份。
- **某个组合点被多次调用**：每次都会新建一份状态；`composeTaskWorkspaceInsight` 只在 daemon 的 HTTP 装配里调一次，RFC-547 用例钉两次组合各有
  各的，提醒多次装配就是多份。

## 6. 取舍（可推翻）

1. **状态交给用例而不是挂在模块上**：与 RFC-535～542 把按对象的侧表归各自实例同一做法；组合根只构造一次，语义与“进程一份”相同。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合构造状态并交给用例。**C11**：模块 public 不变。**C12**：RFC-547 用例覆盖。**C13**：计数不升，模块级可变单例 46 → 43。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十三步（workspace-insight 的 3 条）。
- **留下**：source-control 的守护进程级状态 4 条、schema 历史运行时的登记 2 条；RFC-546 的两类待用户确认。
