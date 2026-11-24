# RFC-553 技术设计

落在 knowledge-evolution（融合编排、融合路由）与 task-execution（`public/types`、composition）两个 bounded context，以及 bootstrap 的融合路由
装配；另改两份精确清单、`architecture/counts.json` 与新增一个 RFC-553 用例。数字取 HEAD `f9c709afa`。不改行为。

## 1. 改动

| 位置                                                     | 现状                                                            | 做法                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution `public/types.ts`                         | 不交出 `DirectTaskInitiator`                                    | `export type { DirectTaskInitiator } from '../domain/taskLaunchOrigin'`                                                               |
| task-execution `composition.ts`                          | 投影函数只在 `composition/taskRouteLaunch.ts` 内部用            | 转出 `directTaskInitiatorFromActorSource`（交给 bootstrap 装配别的 context 的路由）                                                   |
| knowledge-evolution `application/fusionOrchestration.ts` | 从 task-execution 的 domain 取 `DirectTaskInitiator`            | 改从 task-execution 的 `public/types` 取                                                                                              |
| knowledge-evolution `inbound/fusionRoutes.ts`            | 从 task-execution 的 inbound 取投影函数，两处 `…(actor.source)` | `FusionRouteDependencies` 多 `directTaskInitiator: (actor: Actor) => DirectTaskInitiator`，两处改调 `deps.directTaskInitiator(actor)` |
| bootstrap `daemonHttpComposition.ts`                     | 融合路由依赖只有 `operations`、`directAuthority`                | 加 `directTaskInitiator: (actor) => directTaskInitiatorFromActorSource(actor.source)`（取 task-execution composition）                |

投影函数本身、它的三个分支与 RFC-301 的单元用例不动；task-execution 的根启动依赖照旧。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 与 `rfc294-architecture-preflight` 的跨 context 内部文件对删去两条，`rfc376-structural-guards` 与
  `rfc294-review-module-layer-rules` 的模块分层违规删去那一条（`MODULE_LAYER_RULE_DEBT` 清空）。
- `architecture/counts.json`：`cross-context-internal-file-pairs` 17 → 15、`module-layer-violations` 1 → 0。
- 新增 `tests/rfc553-knowledge-evolution-task-initiator-port-boundary.test.ts`，登记 guard-manifest：① knowledge-evolution 的生产文件不 import
  task-execution 的 domain / inbound（带负对照）；② 融合编排从 `public/types` 取类型、融合路由的依赖里有 `directTaskInitiator` 且两处改调它；
  ③ bootstrap 用 task-execution composition 交出的投影函数绑定它；④ 绑定的投影把 session 映成 manual、PAT / daemon 映成 api。

## 3. 失败模式

- **bootstrap 漏传依赖**：`FusionRouteDependencies` 的字段必填，`tsc` 认出；路由用例改给依赖。
- **路由用例构造依赖时漏字段**：同上，`tsc` 认出。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：投影仍在 task-execution 的 inbound（RFC-301），经 composition 交给 bootstrap；knowledge-evolution 拥有自己的端口（RFC-399 的 consumer
  自有端口）。**C11**：task-execution 的 public 多一个类型转出（有模块外读者），knowledge-evolution 的 public 不变。**C12**：RFC-553 用例覆盖。
  **C13**：跨 context 内部文件对 17 → 15、模块分层违规 1 → 0，其余计数不升。

## 5. 取舍（可推翻）

1. **投影经装配交入，不从 public 交出**：投影读遗留的 `ActorSource`，public 面不取 `@/auth`；与 task-execution 根启动的依赖同形。
2. **类型经 `public/types`**：启动人类型是 task-execution 启动来历的合同，别的 context 只读它。

## 6. 本步承担的演进与留下的债

- **承担**：S9 第 5 项清偿 2 条跨 context 内部文件对；模块分层违规清零。
- **留下**：其余 15 条跨 context 内部文件对。
