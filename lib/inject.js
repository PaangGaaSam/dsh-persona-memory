import { readText } from './util.js'
import { LESSONS_HEADING, lessonsForScope, renderLessonsInjection } from './lessons.js'
import { PERSONA_SECTIONS, PROFILE_SECTIONS, renderForInjection, renderPersonaInjection } from './profile.js'

/** Invisible marker so the collector can recognize (and drop) our own injection. */
export const INJECTION_MARKER = '<!-- persona-memory:do-not-digest -->'

/**
 * The persona heading states what it is, because the text under it must not be
 * read as a setting someone chose: it is what the assistant has concluded from
 * past conversations, and later conversations may overturn it.
 */
export const PERSONA_HEADING = '## 我是谁（这些是从对话里长出来的，不是设定）'

export const PROFILE_HEADING = '## 与用户协作的已知偏好'

/**
 * Baseline split of the prompt budget.
 *
 * 事实 → 教训 → 画像 → 自述 is the order the model reads them in; the numbers are
 * baselines, not reservations. A layer that does not need its share hands it to
 * the layers that were cut off. The only hard ceiling is 教训 40%: it is injected
 * on every turn, so it must stay small enough to leave room for who the user is
 * and who I am.
 */
export const BUDGET_SHARES = { profile: 0.55, lessons: 0.25, persona: 0.2 }
export const LESSONS_BUDGET_CAP = 0.4

/**
 * Hand out the character budget across the layers.
 *
 * `renderers` maps every layer to `(chars) => string`. Each layer is rendered
 * once with plenty of room to learn how much it actually wants, and the
 * allocations are then cut to the baselines. Whatever is left over is offered to
 * the layers that still want more, in priority order (profile, persona, lessons),
 * never past a layer's cap — 教训 stops at 40 %. Renders at the final allocation
 * can still stop on a line boundary a few characters short; that is the only
 * slack left, and it never pushes the sum over the budget.
 *
 * @returns {{profile:number, lessons:number, persona:number}}
 */
export function planBudget(budget, renderers) {
  const total = Math.max(0, Math.floor(Number(budget) || 0))
  const caps = {
    profile: total,
    lessons: Math.floor(total * LESSONS_BUDGET_CAP),
    persona: total,
  }
  const want = {
    // Lessons are never allowed to want more than their ceiling.
    profile: String(renderers.profile(total) ?? '').length,
    lessons: String(renderers.lessons(caps.lessons) ?? '').length,
    persona: String(renderers.persona(total) ?? '').length,
  }
  const allocation = {
    profile: Math.min(want.profile, Math.floor(total * BUDGET_SHARES.profile)),
    lessons: Math.min(want.lessons, Math.floor(total * BUDGET_SHARES.lessons)),
    persona: Math.min(want.persona, Math.floor(total * BUDGET_SHARES.persona)),
  }
  let leftover = total - (allocation.profile + allocation.lessons + allocation.persona)
  for (const key of ['profile', 'persona', 'lessons']) {
    if (leftover <= 0) break
    const unmet = Math.min(want[key] - allocation[key], caps[key] - allocation[key])
    if (unmet <= 0) continue
    const add = Math.min(leftover, unmet)
    allocation[key] += add
    leftover -= add
  }
  return allocation
}

function countBullets(text, prefix) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.split('\n').filter((line) => (prefix === undefined ? line.startsWith('- ') : line.startsWith(prefix))).length
}

/**
 * Render every layer once, with the budget already shared out.
 *
 * The panel and the prompt both read this, so the injected count it shows is the
 * number the model actually receives instead of a second, drifting estimate.
 */
export function renderLayers(paths, config, options = {}) {
  const budget = Math.max(0, Math.floor(Number(config.promptBudgetChars) || 0))
  const cwd = options.cwd
  if (budget === 0) {
    return {
      enabled: false,
      budget: 0,
      allocations: { profile: 0, lessons: 0, persona: 0 },
      layers: {
        lessons: { text: '', chars: 0, count: 0, skipped: 0, conflicts: 0 },
        profile: { text: '', chars: 0, count: 0 },
        persona: { text: '', chars: 0, count: 0 },
      },
    }
  }
  const profileText = readText(paths.profileFile, '')
  const personaText = config.personaEnabled === false ? '' : readText(paths.personaFile, '')
  const lessonsText = readText(paths.lessonsFile, '')
  const scope = lessonsForScope(lessonsText, cwd)
  const personaEmpty = renderPersonaInjection(personaText, PERSONA_SECTIONS, PERSONA_HEADING, budget).length === 0

  const renderers = {
    lessons: (max) => renderLessonsInjection(lessonsText, max, { cwd, askOnConflict: personaEmpty }),
    profile: (max) => renderForInjection(profileText, PROFILE_SECTIONS, PROFILE_HEADING, max),
    persona: (max) => renderPersonaInjection(personaText, PERSONA_SECTIONS, PERSONA_HEADING, max),
  }
  const allocations = planBudget(budget, renderers)
  const lessonsRendered = renderers.lessons(allocations.lessons)
  // Rows that survived the scope filter but not the character budget. The panel
  // says so instead of letting a bigger lessons pool look fully injected.
  const lessonsCount = countBullets(lessonsRendered, '- [铁律') + countBullets(lessonsRendered, '- [时效经验')
  const profileRendered = renderers.profile(allocations.profile)
  const personaRendered = renderers.persona(allocations.persona)
  return {
    enabled: true,
    budget,
    allocations,
    layers: {
      lessons: {
        text: lessonsRendered,
        chars: lessonsRendered.length,
        count: lessonsCount,
        skipped: scope.skipped,
        budgetSkipped: Math.max(0, scope.rows.length - lessonsCount),
        conflicts: scope.conflicts.size,
      },
      profile: { text: profileRendered, chars: profileRendered.length, count: countBullets(profileRendered) },
      persona: { text: personaRendered, chars: personaRendered.length, count: countBullets(personaRendered) },
    },
  }
}

/**
 * Build the prompt section text.
 *
 * Order is fixed: lessons → profile → persona. There is deliberately no facts
 * layer: facts are looked up on demand by the `facts_search` tool and never
 * injected, so the block stays the same size however large the facts store grows.
 * Lessons come before the profile because they constrain what the assistant does,
 * which is read before who it is talking to.
 */
export function buildSectionText(paths, config, options = {}) {
  const budget = Math.max(0, Number(config.promptBudgetChars) || 0)
  if (budget === 0) return ''
  const { layers } = renderLayers(paths, config, options)
  const parts = []
  // 事实层不进这里（v0.3.5 起）：它只通过 facts_search 按需检索，见 lib/facts.js。
  if (layers.lessons.text.length > 0) parts.push(layers.lessons.text)
  if (layers.profile.text.length > 0) parts.push(layers.profile.text)
  if (layers.persona.text.length > 0) parts.push(layers.persona.text)
  if (parts.length === 0) return ''
  return `${INJECTION_MARKER}\n${parts.join('\n\n')}`
}

/** Export for tests and the panel's hint. */
export { LESSONS_HEADING }
