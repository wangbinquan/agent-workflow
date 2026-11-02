# RFC-421 技术设计

路径缩写：

| 缩写 | 路径                       |
| ---- | -------------------------- |
| `S`  | `packages/backend/src`     |
| `TE` | `S/modules/task-execution` |
| `C`  | `TE/composition`           |
| `T`  | `packages/backend/tests`   |

行号以 RFC-420 落库后的源码（`d9a5aefaa`）为准。

## 1. 文件

| 来源                                                                                 | 去向                                                               | 说明                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------- |
| `C/agentInvocationPreparation.ts`（`createAgentInvocationPreparation`）              | `TE/application/agentInvocationPreparation.ts`                     | 原样迁移，名字不变        |
| `C/systemAgentRunFamily.ts`（`composeSystemAgentRunFamily`）                         | `TE/application/systemAgentRun.ts` 的 `createSystemAgentRunFamily` | 原样迁移，改名            |
| `C/runtimeSmokeRunFamily.ts`（`composeRuntimeSmokeRunFamily`）                       | `TE/application/runtimeSmoke.ts` 的 `createRuntimeSmokeRunFamily`  | 原样迁移，改名            |
| `C/runtimeSmoke.ts`（`createRuntimeSmokeMaterialIntent`、`runPreparedRuntimeSmoke`） | `TE/application/runtimeSmoke.ts`                                   | 原样迁移，名字不变        |
| `C/agentInvocation.ts`（`bindNativeAgentInvocation`）                                | `TE/infrastructure/local/agentInvocation.ts`                       | 原样迁移，只改相对 import |
| `C/localAgentInvocationPreparation.ts`（`createLocalAgentInvocationPreparation`）    | `TE/infrastructure/local/agentInvocationPreparation.ts`            | 原样迁移，只改 import     |

六个 composition 文件删除。取用方改 import：

- **composition**：`C/localSystemAgentRunFamily.ts`、`C/localRuntimeSmokeRunFamily.ts`、`C/localTaskAgentRunFamily.ts`、
  `C/crewstationSystemAgentRunFamily.ts`、`C/crewstationRuntimeManagement.ts`；
- **infrastructure**：`TE/infrastructure/local/nativeTaskAgentRun.ts`，原先从 composition 取适配器，迁移后同目录取用，层次倒置消失；
- **legacy 入口**：`S/services/systemAgentRun.ts`、`S/services/runtimeSmoke.ts`；
- **用例**：各 RFC-370 用例与两处读源码的锁。

## 2. 依赖规则

- **`application/agentInvocationPreparation.ts`、`systemAgentRun.ts`、`runtimeSmoke.ts`**：
  - 不 import composition、infrastructure 与 `@/services`；
  - 可 import runtime-management `public/participants` 的类型（application 既有先例）、`@/util/log`、`node:crypto`（`randomBytes`，
    application 既有先例）。
- **`infrastructure/local/agentInvocation.ts`**：保留对 runtime-management 本地基础设施（`agentMaterialCompiler`、`agentMaterialEvidence`）与
  `@/services/runtime/types` 的依赖。这是 RFC-328 账本已记录的 provider 桥接，条目从 composition 改指本文件。
- **`infrastructure/local/agentInvocationPreparation.ts`**：只依赖 application 的准备、同目录的适配器与 runtime-management public 类型。
- **六个 composition 文件**：不再存在（结构锁锁定）。

## 3. 必须保持

| 不变量                                                                                                              | 现有锁 / 用例                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 准备：编译一次、绑定一次，重复绑定报 `agent-invocation-material-already-bound`，清理只在消费方边界                  | `rfc370-agent-invocation-preparation`、各 selected 用例                                                    |
| 系统代理：默认超时 / 事件文本上限、开始时间、调用被拒时释放保留引用（释放失败只记日志，原拒绝原样抛出）             | `rfc370-system-agent-family`、`rfc370-retained-reference-retirement`、系统代理调用方用例                   |
| 冒烟：默认超时、nonce 在打开之后、物化之前分配；材料声明字段                                                        | `rfc370-runtime-smoke-family`、`rfc370-runtime-smoke-selected`、诊断用例                                   |
| 本地调用：命令 / 环境快照、单次执行、进程 effect 先 `beforeSpawn` 再回调、启动回执与 owner 确认、输出解释、结果字段 | `rfc370-agent-invocation-binding`、`opencode-spawn-pwd-env`、`rfc108-stale-process-identity`、任务代理用例 |

## 4. 守卫与账本

- **RFC-328**：
  - 任务 effect 边界登记里的 `C/agentInvocation.ts` 改为 `TE/infrastructure/local/agentInvocation.ts`，负例同改；
  - provider 桥接债的两条（`agentMaterialCompiler`、`agentMaterialEvidence`）改指新文件。
- **RFC-294 预检与 RFC-376**：跨模块边清单中 `C/agentInvocation.ts -> …` 两条改指新文件。
- **读源码的锁**：`opencode-spawn-pwd-env`、`rfc108-stale-process-identity` 改读新文件。
- **guard-manifest 与 Windows**：guard-manifest 新增一条；Windows 两处 `paths:` 中五个被删 composition 路径换成新文件，suite 补上本 RFC
  用例。其余账本按实测更新。

## 5. 测试

- **新增结构锁** `T/architecture/rfc421-agent-invocation-stack.test.ts`，各项都带负例：
  - 被迁符号的 owner 唯一；
  - 六个 composition 文件不存在；
  - 迁入 application 的三个文件不 import composition / infrastructure / `@/services` 等横向层。
- **端口绑定用例** `T/rfc421-port-bindings.test.ts`：
  - 准备的单次绑定与清理；
  - 系统代理核心在调用被拒时释放保留引用，且释放失败不掩盖原拒绝；
  - 冒烟核心的 nonce 与打开 / 物化次序；
  - 冒烟材料声明的字段（有无 `extraArgs`）。
- **搬迁涉及的既有用例**：只改 import 与源码锚点。
