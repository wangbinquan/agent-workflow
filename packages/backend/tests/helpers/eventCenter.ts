// RFC-379: tests that need a ready Event Center explicitly initialize its passive composition.
import { composeEventCenter as compose } from '../../src/modules/event-center/composition'
export async function composeEventCenter(...args: Parameters<typeof compose>) {
  const module = await compose(...args)
  await module.initialize()
  return module
}
