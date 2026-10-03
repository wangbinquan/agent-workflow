class FixtureGc {
  #context
  #closed

  constructor(context, closed) {
    this.#context = context
    this.#closed = closed
    Object.freeze(this)
  }

  async hasCandidates() {
    if (this.#closed()) throw new Error('fixture-effects-disposed')
    return true
  }

  async collect(input) {
    if (this.#closed()) throw new Error('fixture-effects-disposed')
    return [...input.referencedCachedPaths].map(
      (reference) => `${this.#context.instanceRef}:${reference}`,
    )
  }
}

class FixtureEnvironment {
  #disposed = false
  pluginGenerationGc

  constructor(context) {
    this.pluginGenerationGc = new FixtureGc(context, () => this.#disposed)
    Object.freeze(this)
  }

  async dispose() {
    this.#disposed = true
  }
}

export function createEffects(context) {
  return new FixtureEnvironment(context)
}
