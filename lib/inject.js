import { readText } from './util.js'
import { PERSONA_SECTIONS, PROFILE_SECTIONS, renderForInjection, renderPersonaInjection } from './profile.js'

/** Invisible marker so the collector can recognize (and drop) our own injection. */
export const INJECTION_MARKER = '<!-- persona-memory:do-not-digest -->'

/**
 * The persona heading states what it is, because the text under it must not be
 * read as a setting someone chose: it is what the assistant has concluded from
 * past conversations, and later conversations may overturn it.
 */
export const PERSONA_HEADING = '## 我是谁（这些是从对话里长出来的，不是设定）'

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
      const rendered = renderPersonaInjection(persona, PERSONA_SECTIONS, PERSONA_HEADING, Math.floor(budget * 0.3))
      if (rendered.length > 0) parts.push(rendered)
    }
  }
  if (parts.length === 0) return ''
  return `${INJECTION_MARKER}\n${parts.join('\n\n')}`
}
