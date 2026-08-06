// TemplateVarChips — 模板变量点击插入行。渲染一组 `{{var}}` 小按钮，点击把
// 变量 token 插入目标输入框的光标处（受控组件：commit 新值后异步恢复焦点与
// 光标）。首个调用面是 webhook 触发器三种注入面（workflow 输入映射 / agent
// 提示词 / workgroup 目标）；vars 与文案均由调用方传入，组件本身不绑业务。

import {
  WEBHOOK_TEMPLATE_VARS,
  availableVarsFor,
  type CodeHostEventType,
  type WebhookTemplateVar,
} from '@agent-workflow/shared'

/**
 * 光标处插入的纯函数面。start/end 为 null（拿不到 DOM 选区）时追加到末尾；
 * 有选区时替换选区。返回新值与插入后的光标位。
 */
export function insertAtCursor(
  value: string,
  start: number | null,
  end: number | null,
  token: string,
): { next: string; caret: number } {
  const s = start ?? value.length
  const e = end ?? s
  return { next: value.slice(0, s) + token + value.slice(e), caret: s + token.length }
}

/**
 * webhook 触发器展示顺序：所选事件类型交集可用集（与保存期校验同源，避免
 * 提示出保存必拒的变量），`event_json` 置顶，其余按声明序。空选择 → 空数组
 * （调用方藏行）。
 */
export function webhookVarsForDisplay(
  eventTypes: ReadonlyArray<CodeHostEventType>,
): WebhookTemplateVar[] {
  const available = availableVarsFor(eventTypes)
  const rest = WEBHOOK_TEMPLATE_VARS.filter((v) => v !== 'event_json' && available.has(v))
  return available.has('event_json') ? ['event_json', ...rest] : rest
}

/**
 * 受控输入的插入一条龙：读 el 当前选区 → commit 新值 → 下一帧恢复焦点并把
 * 光标停在 token 之后。恢复必须等 React 把受控 value 写回 DOM 之后（同步
 * setSelectionRange 会被受控写回重置到末尾）。
 */
export function applyTemplateVarInsertion(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  token: string,
  commit: (next: string) => void,
): void {
  const { next, caret } = insertAtCursor(
    value,
    el?.selectionStart ?? null,
    el?.selectionEnd ?? null,
    token,
  )
  commit(next)
  if (el === null) return
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0)
  raf(() => {
    // 回调执行前用户可能已把焦点移到另一个输入位（插入 → 立刻点别的框）；
    // 此时抢回焦点会把用户拽离正在编辑的位置——让位，只在焦点还闲置
    // （body / 按钮）时恢复。
    const active = document.activeElement
    if (
      active !== el &&
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    ) {
      return
    }
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

interface TemplateVarChipsProps {
  vars: ReadonlyArray<string>
  /** 行前导说明，同时作为 group 的可访问名。 */
  label: string
  /** 收到完整 token（`{{var}}`）。 */
  onInsert: (token: string) => void
  /** data-testid per chip: `${testidPrefix}-${var}`。 */
  testidPrefix?: string
}

export function TemplateVarChips({ vars, label, onInsert, testidPrefix }: TemplateVarChipsProps) {
  if (vars.length === 0) return null
  return (
    <div className="template-var-chips" role="group" aria-label={label}>
      <span className="template-var-chips__label">{label}</span>
      {vars.map((name) => {
        const token = `{{${name}}}`
        return (
          <button
            key={name}
            type="button"
            className="btn btn--xs template-var-chips__chip"
            // mousedown 默认会把焦点从目标输入框抢到按钮上，光标选区随之丢失；
            // 阻掉它让插入点保持在用户正在编辑的位置（键盘 Tab 激活不受影响）。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(token)}
            data-testid={testidPrefix === undefined ? undefined : `${testidPrefix}-${name}`}
          >
            {token}
          </button>
        )
      })}
    </div>
  )
}
