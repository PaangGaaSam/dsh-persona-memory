// One-shot helper: apply persona suggestions produced by the same prompt the
// plugin's persona stage uses. Kept in test/ as a manual tool, not part of the
// runtime package.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applySuggestions, emptyProfile, PERSONA_SECTIONS } from '../lib/profile.js'

const personaPath = process.argv[2]
const payloadPath = process.argv[3]
const date = process.argv[4] ?? new Date().toISOString().slice(0, 10)

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8').replace(/^\uFEFF/, ''))
const raw = Array.isArray(payload) ? payload : (payload.add ?? [])
const sections = raw
  .filter((s) => s !== null && typeof s === 'object' && typeof s.text === 'string' && s.text.trim().length > 0)
  .map((s) => ({
    section: ['core', 'style', 'candidate'].includes(s.section) ? s.section : 'candidate',
    text: s.text.trim(),
    confidence: Number(s.confidence ?? 0.5),
    evidence: typeof s.evidence === 'string' ? s.evidence : date,
  }))

const current = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : ''
const base = current.trim().length > 0 ? current : emptyProfile(PERSONA_SECTIONS, '助手性格')
const merged = applySuggestions(base, PERSONA_SECTIONS, sections, { date, title: '助手性格' })
fs.mkdirSync(path.dirname(personaPath), { recursive: true })
fs.writeFileSync(personaPath, merged.text, 'utf8')
console.log(JSON.stringify({ applied: merged.applied, merged: merged.merged, version: merged.version }))
