export const markdownEditorEn = {
  layout: 'Markdown layout',
  edit: 'Edit',
  split: 'Split',
  preview: 'Preview',
  equalSplit: 'Equal split',
  readOnly: 'Markdown · Read only',
  compactHint: 'Use Edit or Preview here. Widen this panel for a split view.',
  resize: 'Resize Markdown editor',
  resizeHint:
    'Drag or use arrow keys to resize. Home/End reach the limits; Enter shows preview only. Double-click to split equally.',
  ratio: 'Editor {{percent}} percent',
}

export type MarkdownEditorMessages = { [Key in keyof typeof markdownEditorEn]: string }

export const markdownEditorZh: MarkdownEditorMessages = {
  layout: 'Markdown 布局',
  edit: '编辑',
  split: '双栏',
  preview: '预览',
  equalSplit: '均分',
  readOnly: 'Markdown · 只读',
  compactHint: '当前空间适合单栏，可切换编辑或预览；加宽后可使用双栏。',
  resize: '调整 Markdown 编辑区宽度',
  resizeHint: '拖动或用左右方向键调整。Home/End 调至边界，Enter 仅显示预览，双击恢复均分。',
  ratio: '编辑区占 {{percent}}%',
}
