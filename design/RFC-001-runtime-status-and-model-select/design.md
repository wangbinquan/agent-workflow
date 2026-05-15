# RFC-001 Design — Runtime status 与 Model 下拉选择

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 总览

新增 2 条后端 HTTP 接口 + 1 个后端 util + 2 个前端组件 + 11 条 i18n key。**不修改 schema、不修改现有路由、不修改 opencode 探测逻辑。**

```
Settings → Runtime 标签
└─ <RuntimeStatusCard />        新增 — GET /api/runtime/opencode
└─ <SectionForm>
   └─ opencodePath  TextInput   现有
   └─ defaultModel  ModelSelect 新增 — GET /api/runtime/models（替代 TextInput）
   └─ ...其它字段保持原样
```

## 2. 后端

### 2.1 新增 util：`packages/backend/src/util/opencode-models.ts`

```ts
export interface OpencodeModel {
  id: string         // "provider/modelID"，与 opencode 输出一致
  provider: string   // "anthropic" / "openai" / "opencode" / ...
  modelID: string    // "claude-sonnet-4-6" / ...
  name?: string      // 取 verbose JSON 的 name 字段；缺失时前端 fallback 用 modelID
}

export interface ListOpencodeModelsResult {
  binary: string
  models: OpencodeModel[]
  cached: boolean
}

export async function listOpencodeModels(
  binary: string,
  opts?: { refresh?: boolean },
): Promise<ListOpencodeModelsResult>

export function clearOpencodeModelsCache(): void  // 测试 hook
```

**实现要点**

- 顶层维护 `let cache: { binary: string; models: OpencodeModel[] } | null = null`。
  - `cache.binary !== binary` 视为未命中（路径变了），自动失效。
  - `opts.refresh === true` 直接清空并重跑。
- spawn 命令：`Bun.spawn([binary, 'models', '--verbose', ...(refresh ? ['--refresh'] : [])])`。
- stdout 解析（对照 opencode 源 `cmd/models.ts:38-46` 的输出格式）：
  - 逐行扫；遇到形如 `^[a-z0-9_-]+/.+$` 的行视为模型 ID 起点；后续每一行 push 进 `currentBlock`，直到遇到下一个模型 ID 行或 EOF。
  - 每段 block 用 `JSON.parse(block.join('\n'))` 解析，失败则该模型只保留 `id/provider/modelID`（无 `name`）。
- exitCode ≠ 0 → 抛 `Error(\`opencode models exited \${code}: \${stderr}\`)`，路由层捕获后回 502。
- 解析得到的列表写入缓存（cached=true 是第二次起；首次为 false）。

### 2.2 新增路由文件：`packages/backend/src/routes/runtime.ts`

```ts
export function mountRuntimeRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/runtime/opencode', async (c) => {
    const cfg = loadConfig(deps.configPath)
    const probe = await probeOpencode(cfg.opencodePath)
    return c.json({
      binary: probe.binary,
      version: probe.version,
      compatible: probe.compatible,
      minVersion: MIN_OPENCODE_VERSION,
    })
  })

  app.get('/api/runtime/models', async (c) => {
    const cfg = loadConfig(deps.configPath)
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true'
    try {
      const result = await listOpencodeModels(cfg.opencodePath ?? 'opencode', { refresh })
      return c.json(result)
    } catch (err) {
      return c.json({ error: 'opencode-models-failed', message: (err as Error).message }, 502)
    }
  })
}
```

挂载位置：`packages/backend/src/server.ts` 现有 `mountConfigRoutes(app, deps)` 调用旁追加 `mountRuntimeRoutes(app, deps)`。两路由均走标准 `/api/*` token 鉴权（无需新增中间件）。

### 2.3 数据契约

```ts
// GET /api/runtime/opencode 200
{
  binary: string,
  version: string | null,
  compatible: boolean,
  minVersion: string,
}

// GET /api/runtime/models?refresh=1 200
{
  binary: string,
  models: { id: string; provider: string; modelID: string; name?: string }[],
  cached: boolean,
}

// GET /api/runtime/models 502
{
  error: 'opencode-models-failed',
  message: string,
}
```

类型放在 `packages/shared/src/schemas/runtime.ts`（新文件），供前后端 import。

## 3. 前端

### 3.1 新组件：`packages/frontend/src/components/RuntimeStatusCard.tsx`

```tsx
interface RuntimeStatus {
  binary: string
  version: string | null
  compatible: boolean
  minVersion: string
}

export function RuntimeStatusCard(): JSX.Element
```

- 内部 `useQuery({ queryKey: ['runtime', 'opencode'], queryFn: () => api.get('/api/runtime/opencode') })`。
- 三种渲染状态：
  - `isLoading` → 灰色 dot + "Probing opencode…"
  - 数据 `version !== null && compatible` → 绿色 dot + 版本号 + binary 路径 + "≥ {{minVersion}} 可用"
  - 否则 → 红色 dot + 错误描述（区分 "binary 未找到"（version===null）和 "版本过低"（version!==null && !compatible）），并提示检查 `opencodePath`。
- 顶部右侧一个小按钮 "重新探测" → `queryClient.invalidateQueries(['runtime', 'opencode'])`。

### 3.2 新组件：`packages/frontend/src/components/ModelSelect.tsx`

```tsx
interface Props {
  value: string | undefined           // 与 state.defaultModel 对齐
  onChange: (next: string | undefined) => void
}

export function ModelSelect(props: Props): JSX.Element
```

- 内部 `useQuery({ queryKey: ['runtime', 'models'], queryFn: () => api.get('/api/runtime/models'), staleTime: Infinity })`。
- 渲染逻辑：
  - 列表加载中 → 仍然渲染 `<select>` 但只有 `Loading…` 一项，禁用。
  - 加载失败 → 降级为 `<TextInput>` + 错误提示行（i18n `modelLoadFailed`），不阻塞保存。
  - 加载成功 → `<select>` 按 `provider` 分组 `<optgroup>`，每项 `<option value={m.id}>{m.name ?? m.modelID}</option>`；末尾固定 `<option value="__custom__">Custom…</option>`。
- 内部 state：`mode: 'list' | 'custom'` + `customValue: string`。
  - 首次挂载与 props.value 变化时执行 derive：`value` 在 models 列表 → mode=list；`value` 非空但不在列表 → mode=custom 且 customValue=value；`value` 为空 → mode=list 且 select 空字符串选项。
- 旁边 "刷新模型"按钮 → `api.get('/api/runtime/models?refresh=1')` 后 invalidate。loading 时禁用按钮。

### 3.3 接入 `RuntimeTab`

修改 `packages/frontend/src/routes/settings.tsx` 的 `RuntimeTab`：

- 在 `<SectionForm>` 之前渲染 `<RuntimeStatusCard />`。
- 把第 120-126 行的 `defaultModel` Field 中 `<TextInput>` 替换成 `<ModelSelect value={state.defaultModel} onChange={(v) => setState({ ...state, defaultModel: v })} />`。
- `useTabState` 的 mutation `onSuccess` 回调里 invalidate `['runtime', 'opencode']` —— 保存 `opencodePath` 后立刻刷新状态卡片。简单做法：tab 知道当前 keys 含 `opencodePath` 则 invalidate（或者无脑 invalidate，反正开销极小）。

## 4. i18n

`packages/frontend/src/i18n/{en-US.ts, zh-CN.ts}` 在 `settingsForm.*` 命名空间下新增（en-US 示例）：

```
runtimeStatusTitle:        "opencode runtime"
runtimeStatusProbing:      "Probing opencode…"
runtimeStatusOk:           "Compatible — {{version}}"
runtimeStatusIncompatible: "Version {{version}} is below minimum {{minVersion}}"
runtimeStatusNotFound:     "opencode binary not found or not executable"
runtimeStatusBinary:       "Binary: {{path}}"
runtimeStatusReprobe:      "Re-probe"
runtimeStatusMinVersion:   "Minimum {{version}}"
modelLoadFailed:           "Failed to load model list — falling back to text input"
modelRefresh:              "Refresh"
modelCustom:               "Custom…"
modelCustomPlaceholder:    "provider/modelID"
```

zh-CN 同步翻译，沿用 P-5-03 阶段已建立的中文风格。

## 5. 与现有模块的耦合

| 模块 | 耦合点 |
| --- | --- |
| `util/opencode.ts` | `probeOpencode` + `MIN_OPENCODE_VERSION` import，零改动 |
| `routes/config.ts` | 不改 |
| `routes/health.ts` | 不改（`opencodeVersion` 字段继续返回） |
| `Config` schema (`shared/src/schemas/config.ts`) | 不改 |
| `server.ts` | 仅新增一行 `mountRuntimeRoutes(app, deps)` 调用 |
| Frontend `api/client.ts` | 不改（沿用 `api.get` 通用方法） |

## 6. 失败模式

| 场景 | 行为 |
| --- | --- |
| opencode 不在 PATH，`opencodePath` 也未设置 | `probeOpencode` 捕获 spawn error，返回 `{version:null, compatible:false}`。状态卡片红色，提示 "binary not found"。`/api/runtime/models` 同样失败 → ModelSelect 降级文本输入 |
| opencode 版本低于 1.14.0 | 状态卡片红色，文案 "Version {{version}} is below minimum 1.14.0" |
| `opencode models` 返回非 0 exit code | 502，前端 ModelSelect 降级文本输入 + 错误提示 |
| `opencode models` 输出格式被未来版本改变（例如不再吐 `provider/modelID` 行） | 解析得到空列表 → 前端展示 `<select>` 只有 Custom… 一项 + （可选）console warning。降级体验 ≈ 当前手敲 |
| models.dev 不可达 | opencode CLI 自己会处理（要么用本地缓存，要么抛错）。我们透传 |
| 用户保存了一个 `defaultModel` 后续被 opencode 下架 | 回显时 mode=custom 自动接管，TextInput 显示这个失效字符串。用户可手动改为列表项或别的自定义值。**不**主动报错（避免阻塞既有 task） |

## 7. 测试策略

### 7.1 后端单测（`packages/backend/tests/`）

新文件 `tests/runtime-routes.test.ts`：

1. `GET /api/runtime/opencode`：mock `probeOpencode`（注入到 dep 容器 / monkey-patch / 用真实 stub binary）三态 — 成功 / not found / 版本过低 — 响应 schema 全部正确。
2. `GET /api/runtime/models`：用 stub binary（沿用 `e2e/fixtures/stub-opencode.sh` 模式，新增 `models` 子命令吐固定 verbose 输出）验证：
   - 首次请求 cached=false，第二次 cached=true。
   - 改 `opencodePath` 后再请求 cached=false（缓存失效）。
   - `?refresh=1` 一定 cached=false 且 daemon log / spawn args 包含 `--refresh`。
   - exitCode≠0 → 502 + error 字段。

新文件 `tests/opencode-models.test.ts`：直接对 `listOpencodeModels` 解析逻辑做单测（注入伪 stdout 字符串），覆盖正常解析 / 坏 JSON / 空输出 / rename 处理。

### 7.2 手工 E2E

按 [proposal §4 验收标准](./proposal.md#4-验收标准) 顺序在浏览器跑一遍。

### 7.3 回归

- 已有的 `routes/config.test.ts`、`routes/health.test.ts` 应不变化。
- 已有 task 启动流程（agents/skills/tasks 三套测试）应零影响。

## 8. 部署 / 兼容性

无 DB migration。无 schema 改动。无 CLI flag 变更。前后端必须一起更新（新前端打的二进制依赖新后端的两条路由）。这与本项目 monorepo + 单二进制发布的现状一致，不需要特殊兼容窗口。
