# RFC-596 技术设计

记号：`S/` = `packages/backend/src/`，`IG/` = `S/modules/integration/`，`T/` = `packages/backend/tests/`。数字取 HEAD `4daf7840b`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：改动都在 integration。业务层的名字在 `application/ports/crewStationEventInbox.ts`；互译在托管适配器
  `infrastructure/crewstation/`——部署相关的词汇本来就属于这一层（检测器的作用域是 domain / application / engine / inbound / public，不含 infrastructure）。
- **为什么互译而不是改持久值**：`crewstation` 存在收件箱表的 `mode` 列（`infrastructure/persistence/schema.ts`）与 epoch 定义里，也是 CrewStation 事件源配置
  的外部取值。改持久值要走迁移与种子（RFC-398 的规则），改外部合同要牵动部署配置；两者都与本 RFC 的目的（业务层不带部署名字）无关。互译只在适配器里
  一处做，持久值与外部合同原样。
- **偏离项**：无。

## 1. 改动

- `IG/application/ports/crewStationEventInbox.ts`：`CrewStationEventChannel = 'admit' | 'shadow'`，注释写明两种通道的含义与互译的位置。
- 新建 `IG/infrastructure/crewstation/eventChannel.ts`：`CrewStationBindingMode = 'crewstation' | 'shadow'`（配置与表里的取值）、两张以 `satisfies` 钉成全映射的
  对照表，与 `eventChannelOfBindingMode`、`bindingModeOfEventChannel` 两个函数。
- `IG/infrastructure/crewstation/eventContract.ts`：路由出的目标 `channel: eventChannelOfBindingMode(binding.mode)`。
- `IG/infrastructure/crewstation/eventInbox.ts`：写行 `mode: bindingModeOfEventChannel(target.channel)`，读行 `channel: eventChannelOfBindingMode(target.mode)`。
- 两个用例里业务层的目标夹具改用 `admit`（`rfc370-v3-event-ingress-decisions`、`rfc370-m3-event-inbox`）。

## 2. 门、用例与文档

- `counts.json` 的 `deployment-mode-branch-sites` 1 → 0；`rfc376-structural-guards` 的已知清单删掉这一条。
- 新增 `T/rfc596-event-channel-neutral-name-boundary.test.ts`，登记 guard-manifest：① integration 的 domain / application / engine / inbound / public 的全部源码里
  没有 `crewstation` / `standalone` 字符串（字面量类型与值都算；判据带负对照）；② 互译是全的、互逆的（两个方向逐值核对）；③ 三处跨层都经这对函数（配置 →
  目标、目标 → 行、行 → 目标），持久值与配置 schema 仍是 `crewstation` / `shadow`。

## 3. 失败模式

- **有人在业务层重新写部署名字**：用例 ① 与 `deployment-mode-branch-sites` 的计数红。
- **互译漏一个值或方向写反**：用例 ②（以及 `satisfies` 的编译期全映射）红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：部署词汇留在托管适配器，业务层用业务含义的名字。**C12**：RFC-596 用例 ① 覆盖 integration 业务层的全部源码，② ③ 只读三个文件。
  **C13**：`deployment-mode-branch-sites` 1 → 0，§14 “业务层部署模式分支 = 0”成立。
