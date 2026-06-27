# RFC-114 — 运行时感知的模型列表（按运行时二进制取模型，而非写死默认）

状态：**Done**（三件套 + 双 gate 全部上库：Codex 设计 gate 7 findings〔见 design §9〕+ 实现 gate 2 P2 findings〔见 design §10〕全部 fold；`226faa4` PR-A+PR-B〔缓存 Map+收口+路由按二进制+脱敏 / 前端按运行时取模型+新建自由文本+claude 静态提示+错误态〕→ `b5e50bb`〔P2-1 进程组 kill〕→ `6d5379b`〔P2-2 前端查询失效〕；backend opencode-models 12 + runtime-routes 17 + 前端 vitest 2773 全过，CI〔`b5e50bb`〕success）

## 背景

RFC-112 把「运行时」做成命名注册表（自定义 opencode/claude fork 二进制按协议纳管），RFC-113 又把模型/参数搬到运行时上、代理只选运行时。但**模型列表接口 `/api/runtime/models` 仍停留在 RFC-111 的两协议假设**：

- `opencode` 协议：`listOpencodeModels(cfg.opencodePath ?? 'opencode')` —— **永远跑默认 opencode 二进制**，无视运行时注册表里那条自定义二进制（`routes/runtime.ts:68`）。
- `claude` 协议：返回**静态 curated 列表**（Anthropic 模型），无视自定义 claude fork 可能支持的不同模型。

于是出现一个真实缺口：用户用 `multica`/自研脚本基于 opencode 源码定制了一个 fork（二进制改名、甚至改了 provider 配置/默认 config 目录），在「运行时」里登记它、想给它配模型时，**RuntimeFormDialog 的模型下拉拉到的是默认 opencode 的模型，而不是这个 fork 实际能用的模型**。用户原话：「如果是自定义二进制，可能就不会使用默认的配置文件目录了，所以还能不能用模型列表需要看下」。

> 关联：本缺口在排查「claude-code 探测不通过」时一并发现。探测失败的根因是 daemon 进程缺 `HTTP(S)_PROXY`（claude 连不上 api.anthropic.com），与模型列表无关，已单独处理（smoke 分类修复 + 提示用户带代理启动 daemon）。模型列表缺口才是本 RFC 的对象。

## 目标

1. `/api/runtime/models?runtime=<name>` 对 **opencode 协议运行时** 解析**该运行时的二进制**取模型列表（而非默认 `opencode`）；二进制为空的内置 opencode 行回退到 `cfg.opencodePath ?? 'opencode'`（RFC-111 不变）。
2. 模型列表语义清晰：列出**该二进制在其自身配置解析下**能看到的 provider/模型（含自定义 fork 改过的 provider/config-dir）。缓存按二进制路径键控（已具备，需扩展到多二进制并存）。
3. 前端 `RuntimeFormDialog` 的 model `<ModelSelect>` 按**正在编辑的运行时**取列表（编辑态 → 用其二进制）；**新建自定义二进制态不显「默认 opencode 列表」**（会误导存错模型，Codex P1-2 / O1(a)），改走自由文本 + 「先保存、再编辑里按该二进制选模型」提示。
4. claude 协议 fork 的模型列表给出明确的产品取舍 + UI 提示「静态未探测」（见设计 D3 / O2）。
5. 失败可诊断且安全：某 fork 的 `<binary> models` 非零退出/挂死（缺 provider/缺网络/二进制不兼容）→ 进程被 timeout 收口、错误**脱敏后**返回，前端显净化原因、不静默退化成默认列表。

## 非目标

- 不改 opencode/claude 的 driver / spawn / 探测 / 冻结 / 凭据桥接（RFC-111/112 不变）。
- 不引入「运行时级 provider 配置编辑」——本 RFC 只**读**某二进制能看到的模型，不在平台里管理 provider 凭据/配置（那是 opencode/claude 自身的 `~/.config` 范畴）。
- 不解决 claude fork 的动态模型探测（claude CLI 无对应 `models` 子命令的稳定契约时，保持静态列表，见 D3）。
- 不改 RFC-113 的「代理只选运行时」——AgentForm 已无模型字段。`<ModelSelect>` 的**按运行时取列表是新增能力，仅 RuntimeFormDialog 用**；既有调用方（settings 的 `commitPushModel`/`memoryDistillModel`）继续走**无 `?runtime=` 默认 fetch，行为逐字不变**（Codex P2-5——本 RFC 不动它们）。

## 用户故事

- 作为管理员，我登记了一个自研 opencode fork `oc-internal`（二进制 `/opt/oc-internal`，配了公司内网 provider），在运行时配置里给它设默认模型时，模型下拉**列出 `oc-internal` 实际能用的模型**，而不是社区 opencode 的列表。
- 作为管理员，我编辑内置 `opencode` 行的模型时，下拉仍是本机 `opencode`（或我在设置里指定的 `opencodePath`）的模型——行为与今天一致。
- 当某个 fork 二进制跑 `models` 失败（比如它根本不认 `models` 子命令、或缺 provider 配置），对话框给我看到「该运行时取模型失败：<原因>」，而不是悄悄显示一份不属于它的默认列表让我误选。

## 验收标准

1. `/api/runtime/models?runtime=<custom-opencode-name>` 跑的是该运行时 `binaryPath` 的 `<binary> models`，返回结果的 `binary` 字段等于该二进制；缓存命中按二进制区分（两个不同二进制各自缓存、互不串味）。
2. 内置 `opencode`（binaryPath 空）仍回退 `cfg.opencodePath ?? 'opencode'`；内置/未知/无 runtime 参数的旧调用行为完全不变（向后兼容）。
3. claude 协议运行时（含 fork）→ 返回静态 claude 列表（D3 决策）+ `binary` 字段为该运行时二进制；不跑 `<binary> models`。
4. 某二进制 `models` 非零退出 → HTTP 502 + 结构化 `{code:'opencode-models-failed', message, runtime}`；前端 ModelSelect 显示可读错误、不退化默认列表。
5. RuntimeFormDialog 编辑已有 opencode 运行时时，model 下拉来自该运行时二进制；新建时录入二进制后可刷新。
6. 每条改动带测试（路由按 runtime 名解析二进制、缓存多二进制隔离、claude fork 走静态、错误透传；前端 ModelSelect 按运行时取列表 + 错误态）。

## 触发

2026-06-27 用户：「如果是自定义二进制，可能就不会使用默认的配置文件目录了，所以还能不能用模型列表需要看下」→ 选择「立 RFC 规范化」。
