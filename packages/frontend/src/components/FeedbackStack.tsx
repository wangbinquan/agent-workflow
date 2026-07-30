import { Children, type ReactElement, type ReactNode } from 'react'

export interface FeedbackStackProps {
  children: ReactNode
  /** `section` reserves the standard gap before the page's primary content. */
  variant?: 'inline' | 'section'
  className?: string
  testid?: string
}

/**
 * Groups transient notices and errors without assigning outer spacing to the
 * banners themselves. That keeps banners reusable in dialogs and layouts that
 * already own their rhythm, while page feedback gets one explicit contract.
 */
export function FeedbackStack(props: FeedbackStackProps): ReactElement | null {
  const children = Children.toArray(props.children)
  if (children.length === 0) return null

  const classes = ['feedback-stack']
  if (props.variant === 'section') classes.push('feedback-stack--section')
  if (props.className !== undefined && props.className !== '') classes.push(props.className)

  return (
    <div className={classes.join(' ')} data-testid={props.testid}>
      {children}
    </div>
  )
}
