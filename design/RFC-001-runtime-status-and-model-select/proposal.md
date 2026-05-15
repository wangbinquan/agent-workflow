# RFC-001 Proposal — Runtime status 与 Model 下拉选择

> 状态：Draft（2026-05-15）
> Owner：—（首个 RFC，同时承担"项目 RFC 约定"模板角色）
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

`/settings` 的 **Runtime** 标签页是用户配置 opencode 运行参数的入口：opencode 二进制路径、默认 model / variant / temperature、并发数、日志等级。

目前页面有两个体验问题：

1. **看不到 opencode 当前的运行状态**。
   - Daemon 启动时调用一次 `opencode --version`（`packages/backend/src/util/opencode.ts` 的 `probeOpencode`），把结果存进 `AppDeps.opencodeVersion`，仅在 `/health` 接口里返回 `opencodeVersion: string | null`。
   - 用户改完 `opencodePath` 保存后，必须重启 daemon 才能在 `/health` 看到新值。Settings 页面本身没有任何可视的状态提示。
   - 当 opencode 不在 PATH、绝对路径写错、或版本低于 `MIN_OPENCODE_VERSION = '1.14.0'` 时，用户得不到反馈，只有等到启动任务失败才发现问题。
2. **`defaultModel` 是裸文本输入**。
   - `packages/frontend/src/routes/settings.tsx:120-125` 用 `<TextInput placeholder="anthropic/claude-sonnet-4-6" />` 让用户手敲完整的 `provider/modelID` 字符串。
   - 用户必须自己记得 provider 前缀（`anthropic/`、`openai/`、`opencode/`…）、模型 ID 格式，以及 opencode 当前到底加载了哪些 provider。
   - opencode CLI 已经能列出当前可用的全部模型（`opencode models [--verbose] [--refresh]`，输出 `provider/modelID` + 可选 JSON 元数据），但平台没有利用这个信息。

## 2. 目标

**做**

- 在 Runtime 标签页顶部展示一个**只读 opencode 状态卡片**：binary 路径、解析到的版本号、是否满足最低版本、错误信息（若探测失败）。卡片自带"重新探测"按钮；保存 `opencodePath` 之后状态自动刷新。
- 把 `defaultModel` 字段从纯文本输入改为**下拉 + 自定义输入**组合控件，下拉项来自 `opencode models` 的实时结果，按 provider 分组。保留一个 `Custom…` 选项，让用户能输入下拉列表里不存在的 model id（例如 opencode 还未识别的新模型）。下拉旁配一个"刷新模型"按钮，触发 `opencode models --refresh`。

**不做（本 RFC 之外）**

- 不改 `Config` schema（`defaultModel` 继续是 `string | undefined`）。
- 不引入 agent 节点级的模型 picker（NodeInspector 的 model overrides 字段保持现状）。
- 不修改 opencode 本身。
- 不替换 `/health` 接口里 `opencodeVersion` 字段（保持向后兼容；新接口与之并存）。
- 不持久化模型列表到磁盘 / DB；daemon 重启即丢失内存缓存。

## 3. 用户故事

- **U1（管理员排错）**：我刚装好 opencode，打开 Settings → Runtime，希望第一眼就能确认平台是否找到了 opencode 以及版本号。如果失败，应能立刻知道是路径错了还是版本太旧。
- **U2（切换 opencode 路径）**：我有多个 opencode 版本，想把 `opencodePath` 指向某个具体路径。保存后我希望看到 Runtime 状态卡片立刻反映新版本，无需重启 daemon。
- **U3（选模型）**：我不记得 provider 前缀。希望看到一个按 provider 分组的下拉列表，里头列出 opencode 当前认得的所有模型。选好直接保存。
- **U4（新模型）**：opencode 列表里还没有我想用的新模型 ID。希望选择 `Custom…` 后手敲完整字符串保存，且下次打开页面能正确回显（自动选中 `Custom…` 并填回输入框）。

## 4. 验收标准

详见 [design.md §测试策略](./design.md#7-测试策略) 与 [plan.md](./plan.md)。核心断言：

1. Runtime 标签页加载时，顶部出现状态卡片：成功 → 绿色 + 版本 + binary 路径；失败 → 红色 + 错误描述 + 提示检查 `opencodePath`。
2. 把 `opencodePath` 改为不存在的路径并保存，状态卡片自动转红；改回正确路径并点"重新探测"，状态恢复绿色。
3. `defaultModel` 字段渲染为按 provider 分组的 `<select>`，末尾固定一个 `Custom…` 项。
4. 选择列表中的项保存 → 刷新页面后下拉正确回显；选择 `Custom…` 输入 `foo/bar` 保存 → 刷新后自动停留在 `Custom…` 且 TextInput 显示 `foo/bar`。
5. "刷新模型"按钮触发 `opencode models --refresh`，daemon 日志可见调用。
6. 模型列表加载失败时，控件降级回纯文本输入 + 错误提示，不阻塞保存。

## 5. 非破坏性

- `Config` schema 不变 → 现有 `~/.agent-workflow/config.json` 完全兼容。
- 现有 agent 节点 / task 启动逻辑零改动。
- `/health` 接口字段不变；新接口走独立路径 `/api/runtime/*`。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `opencode models` 慢（网络 / models.dev 缓存未命中） | 后端内存缓存按 binary 路径分槽；只在第一次打开页面 / 用户手动刷新时调用 |
| opencode 输出格式未来变更 | 解析器写在独立 util 文件 + 单测；解析失败时整体降级为文本输入 |
| 用户改 `opencodePath` 后旧 model 列表过期 | 缓存 key 含 binary 路径，路径变化时自动失效 |
| 实时探测 `--version` 增加请求延迟 | 单次开销 ~几十 ms；前端只在 tab 打开 / 路径保存后触发 |

## 7. 参考

- opencode CLI `models` 子命令：`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/cli/cmd/models.ts`
- 现有探测器：`packages/backend/src/util/opencode.ts`
- Runtime 标签源码：`packages/frontend/src/routes/settings.tsx:96-172`
