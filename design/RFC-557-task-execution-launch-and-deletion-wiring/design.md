# RFC-557 技术设计

落在 task-execution（端口经 required-ports 交出、删除选择收参）、resource-catalog（工作组启动资源面的实现与指定 adapter）与 bootstrap（装配）；另改
RFC-294 的目标 DAG、几份精确清单、`architecture/counts.json`、读旧路径的用例与新增一个 RFC-557 用例。数字取 HEAD `e11512bb1`。不改行为。

## 1. 改动

| 位置                                                                                                      | 做法                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| task-execution `infrastructure/workgroupLaunchResourceOperations.ts`                                      | 原样挪到 resource-catalog `infrastructure/`；import 改为 resource-catalog 内部（`legacy/workgroups`、`../composition/resourceAcl`、`executionResourceQueries`、`../public/participants`），端口类型从新 adapter 取 |
| task-execution `composition/workgroupLaunchResources.ts`                                                  | 挪到 resource-catalog `composition/workgroupLaunchResources.ts`（与 `agentLaunchResources.ts` 并排）                                                                                                               |
| task-execution `composition/required-ports.ts`                                                            | 加类型转出 `WorkgroupRouteLaunchResources`（来自 `application/ports/taskRouteLaunch`）                                                                                                                             |
| resource-catalog `application/adapters/task-execution-adapter.ts`（新）                                   | 按类型转出 task-execution 的 `WorkgroupRouteLaunchResources`                                                                                                                                                       |
| bootstrap `daemonModules/taskExecution.ts`；用例与测试助手                                                | `composeWorkgroupLaunchResourceOperations` 改从 resource-catalog 的 composition 取                                                                                                                                 |
| task-execution `composition/taskDeletionEffects.ts`                                                       | `composeLocalTaskDeletionEffects(repositories)`：收 `TaskDeletionEffects['repositories']`，不再取 source-control                                                                                                   |
| bootstrap `standalone.ts`                                                                                 | `composeLocalTaskDeletionEffects(createGitTaskDeletionRepositoryEffects())`                                                                                                                                        |
| `tests/helpers/standaloneTaskDeletionEffects.ts`（新）与原先调 `composeLocalTaskDeletionEffects()` 的用例 | 助手 `composeStandaloneTaskDeletionEffects()` 组合同一对；用例改调它                                                                                                                                               |
| RFC-294 design §3.1 的 Mermaid、`rfc294Target.ts`                                                         | 同批加 `RC -. "implements WorkgroupRouteLaunchResources" .-> TE`                                                                                                                                                   |

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 与 `rfc294-architecture-preflight` 的跨 context 内部文件对删去三条，`counts.json` 10 → 7；`rfc328` 的
  provider-bridge 债务删去两条；`rfc294-design-parity` 的 design 边总数 108 → 109；`rfc231-private-copy` 读工作组启动资源面的路径随改。
- 新增 `tests/rfc557-task-execution-launch-deletion-wiring-boundary.test.ts`，登记 guard-manifest：① task-execution 的生产文件取 resource-catalog /
  source-control 非 public 文件的只有指定 adapter，且只按类型取 `composition/required-ports`（带负对照）；② 工作组启动资源面在 resource-catalog，
  task-execution 下没有它，bootstrap 从 resource-catalog 的 composition 取；③ `composeLocalTaskDeletionEffects` 收一个参数、原样放进仓库参与者，
  standalone bootstrap 交 git 参与者；④ 目标 DAG 有这条虚线边。

## 3. 失败模式

- **task-execution 又取 resource-catalog / source-control 的内部**：RFC-557 用例与跨 context 内部文件对的精确清单都会红。
- **端口签名改了**：resource-catalog 的实现按端口类型标注，编译期报错。

## 4. 取舍（可推翻）

1. **工作组资源面迁入 resource-catalog**：读的全是 resource-catalog 的数据与 ACL；与 RFC-470 迁走的代理孪生同处。
2. **类型经 required-ports + 指定 adapter，而不是像 RFC-470 那样在 resource-catalog 里再写一份同形**：RFC-294 design §3.5 把 required 接口的事实源
   定在 consumer 的 required-ports；代理那份改走同一条路另案处理。
3. **删除选择收参，standalone 的组合交给 bootstrap，用例走测试助手**：跨 context 的选择只在 bootstrap；测试助手组合同一对，用例的调用点只改名。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：资源面实现归数据所有者 resource-catalog，端口事实源在 task-execution 的 required-ports；跨 context 选择只在 bootstrap。**C11**：public 不变。
  **C12**：RFC-557 用例覆盖。**C13**：跨 context 内部文件对 10 → 7，其余计数不升；目标 DAG 多一条虚线 required 边，与 design 的 Mermaid 同批。
