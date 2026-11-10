import { readText } from './util.js'
import { PERSONA_SECTIONS, PROFILE_SECTIONS, renderForInjection } from './profile.js'

/** Invisible marker so the collector can recognize (and drop) our own injection. */
export const INJECTION_MARKER = '<!-- persona-memory:do-not-digest -->'

/**
 * Build the prompt section text: user profile first, companion personality
 * second, both under one character budget (70/30 split).
 */
export function buildSectionText(paths, config) {
  const budget = Math.max(0, Number(config.promptBudgetChars) || 0)
  if (budget === 0) return ''
  const parts = []
  const profile = readText(paths.profileFile, '')
  if (profile.trim().length > 0) {
    const rendered = renderForInjection(profile, PROFILE_SECTIONS, '## 与用户协作的已知偏好', Math.floor(budget * 0.7))
    if (rendered.length > 0) parts.push(rendered)
  }
  if (config.personaEnabled !== false) {
    const persona = readText(paths.personaFile, '')
    if (persona.trim().length > 0) {
      const rendered = renderForInjection(persona, PERSONA_SECTIONS, '## 助手与这位用户的相处性格', Math.floor(budget * 0.3))
      if (rendered.length > 0) parts.push(rendered)
    }
  }
  if (parts.length === 0) return ''
  return `${INJECTION_MARKER}\n${parts.join('\n\n')}`
}
