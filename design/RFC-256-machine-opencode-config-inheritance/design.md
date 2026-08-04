# RFC-256 · 恢复对机器自有 OpenCode 配置的读取 — design

## 1. 依据：opencode 的两条发现路径是可分离的

`opencode/packages/opencode/src/config/paths.ts:23-40`（本机 checkout 实读）：

```ts
directories = unique([
  Global.Path.config, // ← XDG_CONFIG_HOME/opencode
  ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? up('.opencode', directory) : []), // ← 仓库面
  ...up('.opencode', Global.Path.home), // ← OPENCODE_TEST_HOME ?? homedir()
  ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
])
```

`Global.Path.config` 由 `xdg-basedir` 解析（`packages/core/src/global.ts:11-13`），
`Global.Path.home` 取 `OPENCODE_TEST_HOME ?? os.homedir()`（`:19`）。

**结论**：全局配置面（第 1、3 项）与仓库配置面（第 2 项）由**互不相干的变量**控制，因此
「恢复我机器上的配置」与「继续屏蔽仓库注入」可以同时成立——这正是本 RFC 的切法。

## 2. 实现

### 2.1 单一事实源：`machineConfigEnvOverrides`（`hermetic.ts`）

```ts
{
  ;(HOME, OPENCODE_TEST_HOME, XDG_CONFIG_HOME)
} // 恰好三项，其余一概不动
```

- `XDG_CONFIG_HOME` 优先取 daemon 环境里的值，缺省推导为 `<HOME>/.config`；
- `HOME` 非绝对路径时回退到 `homedir()`，含 NUL 直接不覆盖；
- **不动** `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` / `TMPDIR` /
  `OPENCODE_CONFIG_DIR`：会话库在 data 下，会话归属、store 锁与 resume 全依赖它每链私有。

### 2.2 执行面（`buildHermeticServerEnv`）

新增可选入参 `inheritMachineConfig`。为真时，在私有布局**之后**应用覆盖（后写者胜）。

`OPENCODE_PURE` **保持置位**（实现期范围修正，见 proposal §3.1）：清掉它会连带加载机器配置
里声明的插件，而插件在 server 进程内执行、不受 containment 约束——超出本次授权范围。代价是
那些插件被静默忽略（opencode `plugin/index.ts:177` 在加载前清空 `plugin_origins`，不报错），
故由 `machineConfigDeclaredPluginCount` 读取操作者 config 里的 `plugin` 数组长度，
经 `diagnostics.machineConfigIgnoredPlugins` 报进运行日志——只作诊断，绝不作门。

`auth` 转为可选：继承档下允许缺省（provider 的凭据在操作者自己的配置里）；密封档下缺省
仍是 `execution-identity-auth-invalid`。

### 2.3 凭据解析（`resolveProviderCredential`）

`absent` 分支：继承开启时，三通道解析失败**不再抛**，而是返回 `{}`（交给 OpenCode 自解析）。
关闭时行为逐字节不变。平台**能**解析出凭据时仍以冻结单 provider 条目下发——继承是兜底，
不是替代。

### 2.4 探测面（`models.ts`）

同一套覆盖应用到密封枚举 env。`OPENCODE_DISABLE_PROJECT_CONFIG` 与源指纹守卫保持不变，
所以「枚举时仓库插件可能执行」这一 RFC-224 关切依然被挡住。

### 2.5 开关

`config.inheritMachineOpencodeConfig`（默认 `true`）。读取经
`inheritsMachineOpencodeConfig()`，与凭据解析共用同一 `loadCustomProviderConfig` 测试 seam。

## 3. 与既有机制的关系

| 机制                                               | 影响                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 源指纹守卫（`scanOpencodeProjectSurface`）         | 不变，仓库面继续拒绝                                                                       |
| 二进制冻结 / containment / FFF                     | 不变                                                                                       |
| execution identity digest                          | 不变（故机器配置变更不影响 resume，见 proposal §3.3）                                      |
| provider 准入（`verifySelectedProviderInventory`） | 不变：机器配置来的 provider 以 `source:'config'` 报告，仍走 exactKeys + bundled npm 白名单 |
| RFC-255 平台内录入                                 | 共存；平台条目命中时优先，未命中则回落到机器配置                                           |

## 4. 失败模式

| 场景                                     | 行为                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| 继承开、机器配置里 provider 存在且带 key | 正常运行（本 RFC 的目标场景）                                      |
| 继承开、provider 哪里都没有              | OpenCode 自身报模型/provider 不存在 → boot 后 `provider-untrusted` |
| 继承关、平台无凭据                       | `auth-invalid`（与本 RFC 之前一致）                                |
| 机器配置语法错误                         | OpenCode 自身的配置解析错误 → `bootstrap-failed`                   |
| 仓库内存在 `.opencode`                   | 仍 `project-config-unsupported`（不受影响）                        |

## 5. 测试策略

`packages/backend/tests/rfc256-machine-opencode-config.test.ts`（已落地 12 条）：
覆盖恰好三项、XDG 缺省推导、相对 HOME 回退、继承档三项生效、仓库面仍关、
data/state/cache/tmp/config-dir 仍私有、PURE 两档差异、无 auth 两档差异、
显式凭据仍下发、密封档与改动前逐字节相同、开关默认与可关。

**未做（记入 backlog）**：真机 e2e——在一台配了自定义 provider 的机器上跑通「探测列出模型
→ 发起任务成功」。本地无法构造真实网关，需在用户那台 Linux 机验收。
