// Programmatic scrolls honor the reduced-motion preference explicitly: Chromium already turns a
// smooth scroll into a jump under it, but WebKit keeps animating, and the intermediate scroll
// events of that animation look like the user scrolling away (RFC-319 INTENT-X4).
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function scrollBehaviorForMotionPreference(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
