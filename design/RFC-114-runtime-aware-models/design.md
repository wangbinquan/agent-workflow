# RFC-114 技术设计 — 运行时感知的模型列表

## 1. 现状（被改对象）

```
GET /api/runtime/models?runtime=<param>        routes/runtime.ts:40-76
  ├─ rtParam==='claude'|'claude-code' 或 resolveRuntimeByName(rtParam).protocol==='claude-code'
  │     → listClaudeModels()  静态 curated（Anthropic）；binary = cfg.claudeCodePath ?? 'claude'
  └─ 否则（opencode 协议 / 无 param）
        → listOpencodeModels(cfg.opencodePath ?? 'opencode', {refresh})   ← 写死默认二进制
```

- `util/opencode-models.ts`：`listOpencodeModels(binary, {refresh?})` 跑 `<binary> models --verbose`，**已接受 binary 参数**；内存缓存 `cache: {binary, models} | null`（单槽，按 binary 命中）。
- opencode 源码已核实（`config/config.ts:417`）：`OPENCODE_CONFIG_DIR` 参与 config 合并、`models` 经 `Provider.Service` 读合并后的 provider；**不设 OPENCODE_CONFIG_DIR 时读全局 `~/.config/opencode`**。
- 唯一前端消费方（RFC-113 后）：`RuntimeFormDialog` 的 `<ModelSelect runtime={isOpencode?'opencode':'claude'}>`（按协议传，不是按运行时）。AgentForm 已无模型字段。

## 2. 决策

- **D1 路由按运行时名解析二进制（优先注册表名、别名仅兜底——Codex P1-1）**：`?runtime=<name>` **先**走 `resolveRuntimeByName(db, name)`：命中已注册运行时 → 用其 `(protocol, binaryPath)`；**仅当注册表无此名**才把 `claude`/`claude-code` 当 RFC-111 传统协议别名（静态 claude）。这样即便有人把运行时命名为 `claude`，编辑它取的是它真实的二进制模型，而非被别名劫持成静态列表。opencode 协议 → `listOpencodeModels(binaryPath ?? cfg.opencodePath ?? 'opencode')`；内置 opencode（binaryPath 空）回退 `cfg.opencodePath ?? 'opencode'`（RFC-111 不变）。**无 `?runtime=` 或未知名 → 默认 opencode（向后兼容、零行为变化）**。
- **D2 模型列表 = 该二进制对全局 provider 配置的视图**：不注入 per-run `OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT`（那是任务派发期的 skills/inline agent，与「有哪些 provider/模型」正交）。即跑 `<binary> models --verbose`、继承 daemon 环境，让二进制按它自己的配置解析报模型。一个把 provider/config 路径改过的 fork 自然报它自己的列表——这正是「自定义二进制可能不用默认配置目录」的正确语义落点。
- **D3 claude 协议（含 fork）保持静态列表 + 明确 UI 提示（Codex P3-7）**：claude CLI 无稳定的 `models` 机器可读子命令契约（RFC-111 已用 curated 静态列表）。fork 即便支持别的模型，v1 不动态探测；`binary` 字段回填该运行时二进制以示区分，列表仍静态。**RuntimeFormDialog 在 claude 协议下显式提示「模型列表为 Anthropic 静态、未按该二进制探测」**（避免管理员误以为这是 fork 实际支持的模型）。动态探测留后续 RFC。
- **D4 缓存升级为多二进制 Map + 失效策略（Codex P3-6）**：`cache` 从单槽 `{binary,models}` 改为 `Map<binary, models>`（否则交替编辑两个不同二进制的运行时会互相清缓存、退化为每次真跑）。**无界增长防护**：运行时 admin-only、基数低（个位数），但仍接两条失效：① `deleteRuntime` / `updateRuntime(binaryPath)` 后清对应 binary 槽（复用注册表已有失效点）；② `clearOpencodeModelsCache()` 清整个 Map（测试钩子语义不变）。`refresh` 仍透传 `--refresh` 并覆盖该 binary 槽。
- **D5 错误结构化 + 进程收口 + 脱敏（Codex P2-3 / P2-4）**：
  - **进程收口**：`listOpencodeModels` 现在裸 `Bun.spawn` 无超时/无输出上限——扩展到任意 admin 二进制前，比照 `runtimeSmoke` 加 **timeout + 进程组 kill 升级 + stdout/stderr 字节上限**（防 fork 挂死/狂吐拖垮 daemon）。
  - **脱敏 + 结构化**：非零退出 → 路由 502 `{ok:false, code:'opencode-models-failed', message: redactSensitiveString(...), runtime:<name>}`（用既有 `util/redact.ts`，避免原始 stderr 泄漏）。
  - **前端不退化**：ModelSelect 取模型失败时显式报错（**初次加载也显净化后的真实原因，不只通用文案**）、**不静默回退默认列表**（避免管理员误把不属于该 fork 的模型选进去）。
- **D6 前端按「正在编辑的运行时」取列表（与 O1(a) 对齐——Codex P1-2）**：`RuntimeFormDialog` 的 ModelSelect——
  - **编辑已有运行时**：`?runtime=<existing.name>`（二进制已知，按其取）。
  - **新建运行时**：name 未落库（`resolveRuntimeByName` 取不到）。**O1(a)：新建态不显「默认 opencode 的模型列表」**（那会误导用户把不属于该自定义二进制的模型存进去——而创建首存就会持久化 model）。改为：新建自定义二进制时模型字段走**自由文本输入 + 「先保存、再编辑里按该二进制选模型」提示**；内置协议默认（未填 binaryPath）仍可用协议默认列表。**不引入 `/api/runtime/models?binaryPath=` 只读旁路**（等于让 read 端点触发任意本机二进制执行，面太大）；若将来要做存前探测，走 admin-only POST（Codex 建议）。

## 3. 接口契约

### 3.1 路由（backend）

```ts
// GET /api/runtime/models?runtime=<name>&refresh=<0|1>
// opencode 协议运行时：
const resolved = rtParam ? await resolveRuntimeByName(db, rtParam) : null
if (resolved?.protocol === 'claude-code' || rtParam==='claude' || rtParam==='claude-code') {
  return claudeModels(binary = resolved?.binaryPath ?? cfg.claudeCodePath ?? 'claude')  // D3 静态
}
const binary = resolved?.binaryPath ?? cfg.opencodePath ?? 'opencode'                    // D1
try { return await listOpencodeModels(binary, {refresh}) }
catch (err) { return 502 { code:'opencode-models-failed', message, runtime: rtParam ?? null } }  // D5
```

### 3.2 缓存（util/opencode-models.ts）

```ts
const cache = new Map<string, OpencodeModel[]>()                 // D4: 多二进制
export function clearOpencodeModelsCache() { cache.clear() }
// listOpencodeModels(binary,{refresh}): 命中 cache.get(binary) 除非 refresh；真跑后 cache.set(binary, models)
```

### 3.3 前端（RuntimeFormDialog）

- ModelSelect 新增/复用一个「runtimeName / binaryPath」驱动的取数：`runtimeQueryKey = ['runtime','models', runtimeNameOrBinary]`。
- 编辑态：`runtime = props.existing.name`。新建态：`runtime = protocol`（默认），加「测试/刷新模型」按钮按当前 binaryPath 重取（`?runtime=` 仍按协议、但 backend 在新建场景拿不到 name → 需要一个**按 binaryPath 直接取**的旁路？见 §5 开放问题 O1）。

## 4. 数据流

```
RuntimeFormDialog(model 下拉)
  → GET /api/runtime/models?runtime=<name|protocol>
    → resolveRuntimeByName → (protocol, binaryPath)
      → opencode: listOpencodeModels(binaryPath ?? default)  → <binary> models --verbose（继承 daemon env）
      → claude:   listClaudeModels()  静态
  ← {binary, models, cached} | 502 {code,message,runtime}
```

## 5. 与现有模块耦合 / 开放问题（Codex gate 后落定）

- **O1〔已定 = (a)〕新建运行时态的模型列表**：name 未落库 → 不显默认 opencode 列表（会误导存错模型，Codex P1-2）。新建自定义二进制走自由文本 + 「先存后编辑选模型」提示；**不引入 `?binaryPath=` 只读旁路**（read 端点触发任意二进制执行、面过大，Codex 同意）。存前探测如确有需要，留后续 admin-only POST。
- **O2〔已定 = 加提示〕claude fork 静态列表**：D3 已落「RuntimeFormDialog claude 协议下显式提示静态未探测」+ §7 加测试。
- **ModelSelect 多消费方（Codex P2-5）**：除 RuntimeFormDialog 外，`settings.tsx` 的 `commitPushModel`/`memoryDistillModel` 仍用 `<ModelSelect>`（无 `?runtime=` → 默认 opencode 列表）。本 RFC 的 ModelSelect 改造**必须保持「无 `?runtime=` 默认 fetch」逐字不变**；§7 显式保留既有默认 ModelSelect 测试。
- 复用 `resolveRuntimeByName`（RFC-112，已有 fail-safe）、`listOpencodeModels`（已接受 binary）、`listClaudeModels`（静态）、`util/redact.ts`（脱敏）。不碰 driver/spawn/冻结/凭据桥接。

## 6. 已知局限

- claude fork 模型仍静态（D3）；动态探测留后续 RFC。
- 模型列表反映「二进制对全局配置的视图」，不含 per-run 注入（D2）——与任务实际派发时的 provider 解析一致（inline config 只加 agent，不加 provider），故无偏差。

## 7. 测试策略（§必写）

**backend**
- 路由：`?runtime=<custom-opencode>` → `listOpencodeModels` 收到该运行时 binaryPath（spy/mock 断言传入 binary）；内置 opencode（binary 空）→ 收到 `cfg.opencodePath ?? 'opencode'`；无 `?runtime=` → 默认（向后兼容）。
- 路由：**运行时名优先于 `claude` 别名（P1-1）** —— 注册一个名为 `claude` 的 opencode 运行时，`?runtime=claude` 取它的二进制模型、**不**退化静态 claude 列表。
- 路由：claude 协议运行时 → 静态列表 + `binary` 字段为该运行时二进制；不调 `listOpencodeModels`。
- 路由：`listOpencodeModels` 抛错 → 502 `{code:'opencode-models-failed', runtime:<name>}`，**message 经 `redactSensitiveString` 脱敏（P2-4）**——断言含敏感样本的 stderr 被打码。
- **进程收口（P2-3）**：`listOpencodeModels` 有 timeout（超时 → 进程组 kill + 抛错）+ 输出字节上限——挂死/狂吐二进制不拖垮（mock 一个 sleep / 海量输出二进制断言被收口）。
- 缓存：对两个不同 binary 各自缓存、互不清除（D4 回归——单槽实现交替调用会 cached:false）；`refresh` 覆盖对应槽；`deleteRuntime`/`updateRuntime(binaryPath)` 后该 binary 槽失效（P3-6）；`clearOpencodeModelsCache` 清空整个 Map。

**frontend**
- `RuntimeFormDialog` 编辑已有 opencode 运行时 → ModelSelect 取 `?runtime=<name>`（fetch URL 断言）。
- 新建自定义二进制态 → **不**发默认 opencode `?runtime=` 取数、走自由文本 + 提示（O1(a) 断言）。
- claude 协议运行时 → 显「静态未探测」提示（P3-7）。
- `listOpencodeModels` 错误 → ModelSelect 显**净化后的真实原因**（初次加载也是）、不显默认列表（P2-4）。
- **回归保护（P2-5）**：保留既有「默认 ModelSelect 无 `?runtime=` 命中 `/api/runtime/models`、不带 runtime 参数」测试 —— settings 的 commitPush/memoryDistill ModelSelect 行为逐字不变。

## 8. PR 拆分

- **PR-A（数据层 + 路由）**：缓存 Map 化（D4）+ 路由按 runtime 名解析二进制（D1/D2/D3/D5）+ backend 测试。
- **PR-B（前端）**：RuntimeFormDialog ModelSelect 按运行时取列表（D6）+ 错误态 + O1 新建态处理 + 前端测试 + i18n。

## 9. Codex 设计 gate

`codex exec -s read-only`（2026-06-27）跑完，verdict **needs-rework**（核心 D1/D3/D4 方向认可），7 findings **全部 fold**：

| # | 级别 | finding | 处置 |
|---|------|---------|------|
| 1 | P1 | `?runtime=claude` 传统别名与运行时名契约冲突（名为 `claude` 的运行时被静态列表劫持） | **D1 改为先 `resolveRuntimeByName`、别名仅兜底**；§7 加测试 |
| 2 | P1 | O1/D6 自相矛盾（proposal 说录入后刷新、O1 拒 `?binaryPath=`）；新建态显默认列表会存错模型 | **O1 定为 (a)**：新建自定义二进制走自由文本 + 先存后选、**不显默认列表**；proposal §3 同步 |
| 3 | P2 | `listOpencodeModels` 无 timeout/output cap/进程组 kill，扩展到任意 admin 二进制有风险 | **D5 加进程收口**（比照 runtimeSmoke）；§7 加挂死/狂吐测试 |
| 4 | P2 | 原始 stderr 直接进错误 message 返回客户端，可能泄漏 | **D5 用 `util/redact.ts` 脱敏**；前端初次加载也显净化原因；§7 加脱敏测试 |
| 5 | P2 | 「唯一前端消费方」claim 错（settings commitPush/memoryDistill 也用 ModelSelect） | **§5 更正 + §7 保留默认 ModelSelect 逐字不变测试** |
| 6 | P3 | D4 Map 无界（daemon 生命周期） | **D4 加失效**：删运行时/改二进制清槽 + 文档低基数假设 |
| 7 | P3 | O2 claude fork 静态列表易误读 | **D3 加 UI 提示「静态未探测」+ §7 测试** |

## 10. Codex 实现 gate

实现（`226faa4`）后 `codex exec` 实现审查，2 P2 findings **全部 fold**：

| # | 级别 | finding | 处置 |
|---|------|---------|------|
| 1 | P2 | `listOpencodeModels` 超时只 SIGKILL 直接子进程，shell 包装/孙进程持有 stdout 管道 → 排空阻塞到孙进程退出（CI ubuntu 实测跑满 5s） | **改 detached spawn + `killProcessTree` 进程组 kill**（`b5e50bb`，与 runtimeSmoke 一致；本机 3/3 ~225ms） |
| 2 | P2 | 前端运行时模型查询 key 只含 name + `staleTime:Infinity`，改 binaryPath 保存/同名删除重建后复用旧二进制列表（RuntimeList 只 invalidate `['runtimes']`） | **save/delete 后 invalidate `['runtime','models','rt',<name>]`**（`6d5379b`，后端 evict + 前端 invalidate 双侧；回归测试断言失效） |

注：P2-1 在跑实现 gate 前已被 CI 同源暴露并修复（`b5e50bb`），Codex 独立复核确认同一根因。
