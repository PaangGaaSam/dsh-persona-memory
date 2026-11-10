// Manual check: print exactly what the persona layer would put into the system
// prompt for a given persona.md. Not part of the runtime package.
//
//   node test/inspect-injection.mjs [path/to/persona.md]
//
// The persona block must contain first-person accounts only — no `助手应…`
// stage directions, no `[分区]` tags, no evidence tokens, and nothing from the
// candidate section.
import fs from 'node:fs'
import path from 'node:path'
import { PERSONA_SECTIONS, parseProfile, renderPersonaInjection } from '../lib/profile.js'
import { PERSONA_HEADING } from '../lib/inject.js'

const file = process.argv[2] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'persona-memory', 'persona.md')
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
const budget = Number(process.argv[3] ?? 360)

const state = parseProfile(text, PERSONA_SECTIONS)
const counts = PERSONA_SECTIONS.map((section) => `${section.title} ${(state.get(section.key) ?? []).length}`).join(' / ')
const rendered = renderPersonaInjection(text, PERSONA_SECTIONS, PERSONA_HEADING, budget)
console.log(`file: ${file}`)
console.log(`sections: ${counts}`)
console.log(`budget: ${budget} chars`)
console.log('--- injected ---')
console.log(rendered.length > 0 ? rendered : '(empty — nothing qualifies yet)')
console.log('--- checks ---')
const bad = /助手\s*(?:应该|应当|应|必须|要|需要|保持)/
console.log(`third-person stage directions: ${bad.test(rendered) ? 'FOUND (bad)' : 'none'}`)
console.log(`section tags: ${/\n- \[/.test(rendered) ? 'FOUND (bad)' : 'none'}`)
console.log(`evidence tokens: ${rendered.includes('证据：') ? 'FOUND (bad)' : 'none'}`)
