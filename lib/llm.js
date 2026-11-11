/**
 * The single model call used by every stage.
 *
 * Kept apart from `digest.js` so the identity generator can use it without
 * importing the digest pipeline (which imports the identity generator back).
 */

/** Minimal chunk accumulator used only when the host package cannot be imported (tests). */
class FallbackAssembler {
  constructor() {
    this.finish = null
    this.text = ''
  }
  push(chunk) {
    if (typeof chunk === 'string') this.text += chunk
    else if (chunk !== null && typeof chunk === 'object') {
      if (typeof chunk.text === 'string') this.text += chunk.text
      else if (typeof chunk.delta === 'string') this.text += chunk.delta
    }
  }
  blocks() {
    return this.text.length > 0 ? [{ type: 'text', text: this.text }] : []
  }
}

/** Default per-call ceiling; a hung stream would otherwise pin `inFlight` forever. */
const DEFAULT_LLM_TIMEOUT_MS = 180000

/**
 * One model call, assembled into text/reasoning blocks.
 * The stream is raced against a timeout so a stalled provider cannot wedge the
 * whole scheduler: the caller's stage catches the rejection and moves on.
 */
export async function callLlm(ctx, config, system, user, label) {
  if (typeof ctx.llm?.stream !== 'function') throw new Error('llm service unavailable')
  let Assembler = FallbackAssembler
  try {
    const hostLlm = await import('@deepseek-ai/dsh-llm')
    if (typeof hostLlm.BlockAssembler === 'function') Assembler = hostLlm.BlockAssembler
  } catch {
    // Running outside the host (unit tests): fall back to the local accumulator.
  }
  const assembler = new Assembler()
  const options = {
    provider: config.provider,
    model: config.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: user }] },
    ],
    maxTokens: config.maxOutputTokens,
    temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : undefined,
    purpose: 'persona-memory',
  }
  const timeoutMs = Number(config.llmTimeoutMs) > 0 ? Number(config.llmTimeoutMs) : DEFAULT_LLM_TIMEOUT_MS
  // How long the stream actually took is diagnostic on its own: a cut-off answer
  // that arrives at 170 s of a 180 s ceiling is a stream problem, not a bad model.
  const startedMs = Date.now()
  let timer
  const consume = (async () => {
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  })()
  // The abandoned stream may still settle later; keep it from surfacing as an
  // unhandled rejection once the timeout won the race.
  consume.catch(() => {})
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    await Promise.race([consume, timeout])
  } finally {
    clearTimeout(timer)
  }
  const finish = assembler.finish
  if (finish !== undefined && finish !== null && typeof finish === 'object' && finish.kind === 'error') {
    const failure = finish.failure ?? {}
    throw new Error(`${label}: ${failure.message ?? 'llm error'}`)
  }
  const blocks = assembler.blocks()
  const pick = (type) => blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === type && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  const text = pick('text')
  const reasoning = pick('reasoning')
  if (text.trim().length === 0 && reasoning.trim().length === 0) throw new Error(`${label}: empty model output`)
  // Some models emit their JSON answer at the end of the reasoning text; keep it
  // so the caller can fall back to it when the text block is empty or unusable.
  return { text, reasoning, durationMs: Date.now() - startedMs }
}
