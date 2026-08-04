# RFC-256 · 恢复对机器自有 OpenCode 配置的读取 — plan

状态：**实现完成，待用户在那台 Linux 机上验收**（2026-08-04）

## 任务分解

| 任务       | 内容                                                                                                               | 状态                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| RFC-256-T1 | shared：`inheritMachineOpencodeConfig` 配置键（默认 true）+ 文档化「开放什么 / 仍关什么」                          | ✅                                                                        |
| RFC-256-T2 | `machineConfigEnvOverrides` 单一事实源 + `buildHermeticServerEnv` 继承档（含 `OPENCODE_PURE` 剔除、`auth` 转可选） | ✅                                                                        |
| RFC-256-T3 | `resolveProviderCredential` 继承档兜底（不再因平台无凭据而硬失败）+ `inheritsMachineOpencodeConfig` 读取器         | ✅                                                                        |
| RFC-256-T4 | 三计划面（business / system / mcp-test）接线                                                                       | ✅                                                                        |
| RFC-256-T5 | 探测面（`models.ts` 密封枚举）接线——用户报告的直接症状                                                             | ✅                                                                        |
| RFC-256-T6 | 12 条回归测试（覆盖面、边界、两档差异、开关）                                                                      | ✅                                                                        |
| RFC-256-T7 | 设置页开关 UI                                                                                                      | ⏳ 未做（配置键可经 `PUT /api/config` 设置；默认值即目标行为，UI 非阻塞） |
| RFC-256-T8 | 真机验收：那台 Linux 机上「探测列出模型 → 发起任务成功」                                                           | ⏳ 待用户                                                                 |

## 验收清单

- [x] AC-1 默认开启；env 覆盖恰好三项
- [x] AC-2 仓库配置面仍关；data/state/cache/tmp/config-dir 仍私有
- [x] AC-3 继承档不置 `OPENCODE_PURE`，密封档仍置
- [x] AC-4 继承档允许无 auth；密封档缺凭据仍 `auth-invalid`
- [x] AC-5 平台已有凭据时仍冻结下发
- [x] AC-6 关闭后与本 RFC 之前逐字节相同
- [ ] AC-7 真机验收（T8）

## 用户侧验收步骤

1. 那台 Linux 机更新到含本 RFC 的构建。
2. **不需要任何配置**——`inheritMachineOpencodeConfig` 默认开启，你原有的
   `~/.config/opencode/opencode.json` 直接生效。
3. 打开 设置 → 运行时，确认模型下拉里重新出现你配的模型；点 Test 应通过。
4. 发起一个任务验证端到端。
5. 若某个部署确实需要完全密封：`PUT /api/config {"inheritMachineOpencodeConfig": false}`
   回到 RFC-224 姿态（届时只有平台声明的 runtime 与 RFC-255 录入的网关可用）。
