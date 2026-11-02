# RFC-422 技术设计

路径缩写：

| 缩写 | 路径                       |
| ---- | -------------------------- |
| `S`  | `packages/backend/src`     |
| `TE` | `S/modules/task-execution` |
| `C`  | `TE/composition`           |
| `T`  | `packages/backend/tests`   |

行号以 RFC-421 落库后的源码（`598054c42`）为准。

## 1. 文件

| composition（保留，只剩配对）          | 打开逻辑迁入                                             | 注入的 provider（取自别的模块）                                                                |
| -------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `C/localSystemAgentRunFamily.ts`       | `TE/infrastructure/local/systemAgentRunFamily.ts`        | RM：系统代理运行时绑定、系统代理保留内容、本地材料定义                                         |
| `C/localRuntimeSmokeRunFamily.ts`      | `TE/infrastructure/local/runtimeSmokeRunFamily.ts`       | RM：材料工作区、本地材料定义、协议绑定                                                         |
| `C/localTaskAgentRunFamily.ts`         | `TE/infrastructure/local/taskAgentRunFamily.ts`          | RM：任务代理运行时绑定、材料工作区、本地材料定义；SC：工作区内容、git 控制面观测；RC：材料引用 |
| `C/crewstationSystemAgentRunFamily.ts` | `TE/infrastructure/crewstation/systemAgentRunFamily.ts`  | RM：托管系统代理内容、系统代理运行时绑定；本地系统代理 family（夹具回退）                      |
| `C/crewstationRuntimeManagement.ts`    | `TE/infrastructure/crewstation/runtimeSmokeRunFamily.ts` | RM：托管系统代理内容                                                                           |

- **入参**：每个打开逻辑接收两个参数——原 composition 函数的入参对象（原样传入，保持「每个值使用时才读」）与一个 provider 袋。主体逐字迁移，
  只把对别的模块函数的调用换成 provider 袋上的同名成员。
- **端口**：provider 袋的类型是 task-execution 自有的结构端口，放在 `TE/infrastructure/local/nativeRunFamilyProviders.ts` 与
  `TE/infrastructure/crewstation/hostedRunFamilyProviders.ts`，只列打开逻辑用到的成员。成员的参数与返回值用别的模块 `public/` 的类型；public 里
  没有的，用打开逻辑自己的使用面描述。
- **其余依赖**：打开逻辑对 task-execution 自身（application、infrastructure）与 `@/services` 的依赖照旧直接 import。R2 只约束
  application / domain / engine / public，infrastructure 取 `@/services` 不入账本。
- **composition**：只调用别的模块的工厂、组装 provider 袋，然后把入参对象与 provider 袋交给 infrastructure；导出名与签名不变。
- **探测预算**：`HOSTED_RUNTIME_PROBE_BUDGET_MS` 随托管冒烟迁入 infrastructure，composition 再导出，保持用例的 import 不变。

## 2. 依赖规则

- **迁入的五个 infrastructure 文件与两个端口文件不 import**：别的模块的 composition / infrastructure，以及本模块的 composition。
- **它们可以 import**：本模块 application / infrastructure、别的模块 `public/`、`@/services`、`@/platform`、`@/util`。
- **五个 composition 文件不再含打开逻辑的记号**：
  - 引用核对的报错文本 `-content-reference-unavailable`；
  - `persona-skill-content-unavailable`、`smoke-skill-unavailable`；
  - `createLocalAgentInvocationPreparation(`、`createHostedAgentInvocationPreparation(`；
  - `nativeFixtureRequest`、`canRelease`。

## 3. 必须保持

| 不变量                                                                                                           | 现有锁 / 用例                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 本地系统代理：引用核对与报错、准备的绑定参数、观测字段、意图字段、夹具结果投影与原生请求映射                     | `rfc370-system-agent-*`、`rfc370-retained-reference-retirement`、系统代理调用方用例                               |
| 本地冒烟：驱动在打开时取、工作区在物化时绑定、编译时的读取顺序与材料选择                                         | `rfc370-runtime-smoke-*`、`rfc370-runtime-diagnostic-family`、诊断用例                                            |
| 本地任务代理：工作区内容 / 输出校验 / 端口产物映射、材料工作区的延迟绑定、材料选择、spawn 诊断与插件加载失败判定 | `rfc370-task-agent-*`、`rfc370-isolation-workspace-bindings`、`rfc370-node-run-prompt-bindings`、任务代理运行用例 |
| 托管系统代理 / 冒烟：调用 ID 派生、可释放判定、意图与 profile、托管准备的参数、探测预算                          | `rfc370-m2-system-agent`、`rfc370-hosted-runtime-probe`                                                           |

## 4. 守卫与账本

- **读源码的锁**：读这五个 composition 文件内部结构的锁改读新文件，或同时读两者。例如 `rfc370-node-run-prompt-bindings` 的调用点检查。
- **跨模块账本**：跨模块边仍在 composition，RFC-328 / RFC-294 / RFC-376 账本不变；若某个 composition 文件不再 import 某个模块，相应条目随之
  删除。
- **guard-manifest 与 Windows**：guard-manifest 新增一条；Windows `paths:` 与 suite 补上新文件与本 RFC 用例。

## 5. 测试

- **新增结构锁** `T/architecture/rfc422-run-family-openers.test.ts`，各项都带负例：
  - 打开逻辑的 owner 唯一；
  - 五个 composition 文件不含 §2 的记号；
  - 迁入文件不 import 别的模块的 composition / infrastructure 与本模块 composition。
- **端口绑定用例** `T/rfc422-port-bindings.test.ts`：
  - 本地系统代理的引用核对报错；
  - 本地冒烟的「打开时取驱动、物化时绑定工作区」次序；
  - 托管系统代理的调用 ID 派生（有无观测需求）与可释放判定；
  - 托管冒烟的探测预算。
- **搬迁涉及的既有用例**：只改 import 与源码锚点。
