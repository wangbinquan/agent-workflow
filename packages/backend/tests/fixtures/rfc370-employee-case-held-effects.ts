import type {
  EmployeeCaseWorkspaceEffects,
  EmployeeCaseWorkspaceEffectsFactory,
} from '@/modules/source-control/application/ports/employeeCaseWorkspaceEffects'
import { createFileEmployeeCaseWorkspaceEffectsFactory } from '@/modules/source-control/infrastructure/local/fileEmployeeCaseWorkspaceEffects'

function gates() {
  return {
    claimed: false,
    copyEntered: Promise.withResolvers<void>(),
    copyRelease: Promise.withResolvers<void>(),
    closeEntered: Promise.withResolvers<void>(),
    closeRelease: Promise.withResolvers<void>(),
  }
}
type Gates = ReturnType<typeof gates>

class HeldScope implements EmployeeCaseWorkspaceEffects {
  readonly #native: EmployeeCaseWorkspaceEffects
  readonly #gates: Gates
  #checkpoint = false
  constructor(native: EmployeeCaseWorkspaceEffects, control: Gates) {
    this.#native = native
    this.#gates = control
    Object.freeze(this)
  }
  resolve(...args: Parameters<EmployeeCaseWorkspaceEffects['resolve']>) {
    return this.#native.resolve(...args)
  }
  sibling(...args: Parameters<EmployeeCaseWorkspaceEffects['sibling']>) {
    return this.#native.sibling(...args)
  }
  exists(...args: Parameters<EmployeeCaseWorkspaceEffects['exists']>) {
    return this.#native.exists(...args)
  }
  stat(...args: Parameters<EmployeeCaseWorkspaceEffects['stat']>) {
    return this.#native.stat(...args)
  }
  list(...args: Parameters<EmployeeCaseWorkspaceEffects['list']>) {
    return this.#native.list(...args)
  }
  createDirectory(...args: Parameters<EmployeeCaseWorkspaceEffects['createDirectory']>) {
    return this.#native.createDirectory(...args)
  }
  async copyFile(...args: Parameters<EmployeeCaseWorkspaceEffects['copyFile']>) {
    if (!this.#gates.claimed) {
      this.#gates.claimed = true
      this.#checkpoint = true
      this.#gates.copyEntered.resolve()
      await this.#gates.copyRelease.promise
    }
    await this.#native.copyFile(...args)
  }
  setMode(...args: Parameters<EmployeeCaseWorkspaceEffects['setMode']>) {
    return this.#native.setMode(...args)
  }
  readBytes(...args: Parameters<EmployeeCaseWorkspaceEffects['readBytes']>) {
    return this.#native.readBytes(...args)
  }
  writeText(...args: Parameters<EmployeeCaseWorkspaceEffects['writeText']>) {
    return this.#native.writeText(...args)
  }
  remove(...args: Parameters<EmployeeCaseWorkspaceEffects['remove']>) {
    return this.#native.remove(...args)
  }
  move(...args: Parameters<EmployeeCaseWorkspaceEffects['move']>) {
    return this.#native.move(...args)
  }
  runGit(...args: Parameters<EmployeeCaseWorkspaceEffects['runGit']>) {
    return this.#native.runGit(...args)
  }
  async close() {
    await this.#native.close()
    if (this.#checkpoint) {
      this.#gates.closeEntered.resolve()
      await this.#gates.closeRelease.promise
    }
  }
}

class HeldFactory implements EmployeeCaseWorkspaceEffectsFactory {
  readonly #native = createFileEmployeeCaseWorkspaceEffectsFactory()
  readonly #gates: Gates
  constructor(control: Gates) {
    this.#gates = control
    Object.freeze(this)
  }
  async acquire() {
    return new HeldScope(await this.#native.acquire(), this.#gates)
  }
}

/** A complete prototype receiver around the original native mechanisms. */
export function createHeldEmployeeCaseFactory() {
  const control = gates()
  return { effects: new HeldFactory(control), ...control }
}
