// External complete content selection; controls travel only over BroadcastChannel.
class RecoveryContentScope {
  #environment
  #closed = false
  constructor(environment) {
    this.#environment = environment
    Object.freeze(this)
  }
  #open() {
    if (this.#closed) throw new Error('selected-content-scope-closed')
  }
  async exists(reference) {
    this.#open()
    this.#environment.record('exists', reference)
    return false
  }
  async createDirectory(reference, mode) {
    this.#open()
    this.#environment.record('mkdir', reference, { mode })
  }
  async removeDirectory(reference) {
    this.#open()
    this.#environment.record('remove', reference)
  }
  async move(source, target) {
    this.#open()
    this.#environment.record('move', source, { target })
  }
  async cleanupOperation(reference, publication) {
    this.#open()
    this.#environment.record('cleanup', reference, { publication })
  }
  async swapStaged(reference, publication) {
    this.#open()
    this.#environment.record('swap', reference, { publication })
    return { hadPrevious: false }
  }
  async restoreBackup(reference, publication) {
    this.#open()
    this.#environment.record('restore', reference, { publication })
    return false
  }
  async directoryChainState(root, reference) {
    this.#open()
    this.#environment.record('chain', reference, { root })
    return 'missing'
  }
  async hashRegularTree(reference) {
    this.#open()
    this.#environment.record('hash', reference)
    throw new Error('selected-content-tree-missing')
  }
  async close() {
    this.#open()
    try {
      await this.#environment.closeContent()
    } finally {
      this.#closed = true
    }
  }
}

class RecoveryContentFactory {
  #environment
  constructor(environment) {
    this.#environment = environment
    Object.freeze(this)
  }
  root(id) {
    return `logical:skills/${id}`
  }
  live(id) {
    return `${this.root(id)}/files`
  }
  version(id, version) {
    return `${this.root(id)}/versions/v${version}/files`
  }
  staged(reference, publication) {
    return `${reference}.op-${publication}.staged`
  }
  candidate(reference, publication) {
    return `${reference}.op-${publication}.candidate`
  }
  normalize(reference) {
    this.#environment.record('normalize', reference)
    return reference
  }
  parent(reference) {
    return reference.slice(0, reference.lastIndexOf('/'))
  }
  storedReference(reference) {
    return `logical:${reference}`
  }
  assertManaged(root, reference) {
    this.#environment.record('managed', reference, { root })
  }
  async acquire() {
    this.#environment.acquireContent()
    return new RecoveryContentScope(this.#environment)
  }
}

class ChannelRecoveryEnvironment {
  #channel
  #context
  #configuration
  #releases = new Map()
  #closed = false
  #activeScopes = 0
  #onControl
  resourcePackageRecoveryContent
  constructor(context) {
    this.#context = context
    this.#configuration = JSON.parse(context.configurationJson)
    this.#channel = new BroadcastChannel(this.#configuration.channelName)
    this.#channel.onmessage = (event) => this.#releases.get(event.data.type)?.()
    this.#onControl = (event) => {
      if (event.data?.type === 'drain') this.#post('drain-received')
    }
    globalThis.addEventListener('message', this.#onControl)
    this.resourcePackageRecoveryContent = new RecoveryContentFactory(this)
    Object.freeze(this)
  }
  #assertOpen() {
    if (this.#closed) throw new Error('selected-recovery-environment-closed')
  }
  #post(type, fields = {}) {
    this.#channel.postMessage({ type, instanceRef: this.#context.instanceRef, ...fields })
  }
  #hold(phase, held) {
    if (!held) return Promise.resolve()
    return new Promise((resolve) => {
      this.#releases.set(`release-${phase}`, resolve)
    })
  }
  record(operation, reference, fields = {}) {
    this.#assertOpen()
    this.#post(`recovery-${operation}-entered`, { reference, ...fields })
  }
  acquireContent() {
    this.#assertOpen()
    this.#activeScopes++
    this.#post('content-acquired')
  }
  async closeContent() {
    this.#assertOpen()
    const held = this.#hold('content-close', this.#configuration.holdClose)
    this.#post('content-close-entered')
    try {
      await held
      if (this.#configuration.closeFailure) throw new Error('selected-recovery-close-failed')
      this.#post('content-closed')
    } finally {
      this.#activeScopes--
    }
  }
  async ready() {
    const held = this.#hold('init', this.#configuration.holdInit)
    this.#post('factory-entered')
    await held
    return this
  }
  async dispose() {
    this.#assertOpen()
    if (this.#activeScopes !== 0) throw new Error('selected-content-scope-still-active')
    const held = this.#hold('dispose', this.#configuration.holdDispose)
    this.#post('dispose-entered')
    await held
    this.#post('dispose-completed')
    this.#closed = true
    globalThis.removeEventListener('message', this.#onControl)
    this.#channel.close()
  }
}

export function createEffects(context) {
  return new ChannelRecoveryEnvironment(context).ready()
}
