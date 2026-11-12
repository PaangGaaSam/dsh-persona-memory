/**
 * Scheduler arithmetic, kept pure so it can be tested without a fake clock.
 *
 * The trigger is a single in-memory cursor: `nextDueAt`. There is deliberately no
 * catch-up and no persisted slot marker — a slot that passes while nothing is
 * watching is *missed*, and the only trace is one warning line in the log. The old
 * design persisted "did anything run today", so a 17:00 run made the 23:30 tick
 * refuse to fire and nothing was logged at all.
 */

/**
 * A slot that is up to ten minutes late still counts as on time.
 *
 * One tick can be swallowed by a busy process or a stalled event loop; losing the
 * whole run to that would be worse than running a few minutes late. Anything
 * beyond this window is reported as missed instead of silently skipped.
 */
export const SLOT_GRACE_MS = 10 * 60 * 1000

/**
 * The first local wall-clock slot strictly after `from`, as a timestamp.
 *
 * Wall clock = local midnight of `from` plus `scheduleMinutes`. Building it from
 * midnight rather than with `Date#setHours` keeps the slot at the same clock time
 * every day; a DST region would see it drift by an hour, which this plugin does
 * not target.
 */
export function nextSlotAfter(from, scheduleMinutes) {
  if (!Number.isFinite(Number(scheduleMinutes))) return NaN
  const date = new Date(from)
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
  const today = midnight.getTime() + Number(scheduleMinutes) * 60000
  // Strictly later: at the exact slot time the *next* one is due, so a run that
  // fires at 23:30:00.000 re-arms to tomorrow instead of firing again at 23:31.
  return today > Number(from) ? today : today + 86400000
}

/**
 * What one tick should do about the armed cursor.
 *
 * Returns `'wait' | 'run' | 'missed'`. A non-finite cursor returns `'missed'`
 * rather than `'wait'`: an unusable cursor must not mean "never run and never say
 * so", which is exactly the failure this whole change is fixing.
 */
export function decideSlot({ now, nextDueAt, graceMs = SLOT_GRACE_MS }) {
  if (!Number.isFinite(Number(nextDueAt))) return 'missed'
  if (Number(now) < Number(nextDueAt)) return 'wait'
  return Number(now) - Number(nextDueAt) <= Number(graceMs) ? 'run' : 'missed'
}
