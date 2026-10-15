class ChannelEnvironment {
  #channel
  #context
  #configuration
  #releases = new Map()
  #closed = false
  #onControl
  pluginGenerationGc

  constructor(context) {
    this.#context = context
    this.#configuration = JSON.parse(context.configurationJson)
    this.#channel = new BroadcastChannel(this.#configuration.channelName)
    this.#channel.onmessage = (event) => {
      if (event.data.type === 'release-fault') {
        globalThis.postMessage({
          type: 'degraded',
          version: 1,
          at: Date.now(),
          error: 'selected-test-recoverable-fault',
        })
      } else this.#releases.get(event.data.type)?.()
    }
    this.#onControl = (event) => {
      if (event.data?.type === 'drain') this.#post('drain-received')
    }
    globalThis.addEventListener('message', this.#onControl)
    this.pluginGenerationGc = Object.freeze({
      hasCandidates: async () => {
        this.#assertOpen()
        this.#post('gc-has-candidates')
        return true
      },
      collect: async (input) => {
        this.#assertOpen()
        const held = this.#hold('collect', this.#configuration.holdCollect)
        this.#post('gc-collect-entered', {
          references: [...input.referencedCachedPaths],
        })
        await held
        if (this.#configuration.collectFailure) throw new Error('selected-gc-failure')
        this.#post('gc-collected')
        return ['logical:retired-worker-generation']
      },
    })
    Object.freeze(this)
  }

  #assertOpen() {
    if (this.#closed) throw new Error('selected-worker-environment-closed')
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

  async ready() {
    const held = this.#hold('init', this.#configuration.holdInit)
    this.#post('factory-entered')
    await held
    return this
  }

  async dispose() {
    const held = this.#hold('dispose', this.#configuration.holdDispose)
    this.#post('dispose-entered')
    await held
    if (this.#configuration.disposeFailure) throw new Error('selected-worker-dispose-failure')
    this.#closed = true
    this.#post('dispose-completed')
    globalThis.removeEventListener('message', this.#onControl)
    this.#channel.close()
  }
}

export function createEffects(context) {
  return new ChannelEnvironment(context).ready()
}
