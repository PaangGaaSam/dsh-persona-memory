import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { previewReset } from '../lib/reset.js'
import { runSlash, SLASH_COMMANDS } from '../lib/slash.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-demo-'))
const write = (rel, text) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\s+/g, ' ').trim()
const exists = (rel) => fs.existsSync(path.join(root, rel))

write('profile.md', '# 用户画像\n\n## 稳定偏好\n- [pref-1] 只玩口袋妖怪。\n')
write('persona.md', '# 我认为我是谁\n\n## 现在\n- 还在观察。\n')
write('lessons.md', '# 教训\n\n## 铁律\n- [rule-1] 没查证不下结论。\n')
write('facts.md', '# 事实\n\n## 事实\n- [fact-1] [作用域 本机] DSH 装在 D:\\deepseekharness。\n')
write('identity.json', '{"profileVersion":"abc","generatedAt":"2026-11-12T09:00:00.000Z"}\n')
write('state.json', '{"lastRunDay":"2026-11-12","lastRunAt":1762930616000,"lastPersonaRunDay":"2026-11-10","runs":[{"date":"2026-11-12","ok":true}]}\n')
write('daily/2026-11-10.md', '# 2026-11-10\n\n## 今日摘要\n第一条。\n')
write('daily/2026-11-12.md', '# 2026-11-12\n\n## 今日摘要\n第二条。\n')
write('history/profile-2026-11-10-1.md', '# 用户画像\n旧版本。\n')
write('logs/run-2026-11-12.jsonl', '{"at":"2026-11-12T09:06:13.000Z","level":"info","message":"loaded: v0.3.7"}\n')
write('config.json', '{"schedule":"23:30","notifyOnRun":false}\n')

console.log('=== descriptions ===')
for (const command of SLASH_COMMANDS) {
  console.log(`/${command.name}  hint=${JSON.stringify(command.hint ?? null)}\n  ${command.description}`)
}
console.log(`\nname regex ok: ${SLASH_COMMANDS.every((c) => /^[a-z][a-z0-9_-]*$/.test(c.name))}`)
console.log(`hint non-empty: ${SLASH_COMMANDS.filter((c) => c.hint !== undefined).every((c) => c.hint.trim().length > 0)}`)

const preview = runSlash({ root }, 'new', '', { now: new Date(2026, 10, 13, 17, 7, 20) })
console.log('\n=== /new (preview only) ===')
console.log(preview.text)
console.log(`\n[check] preview wrote nothing: ${previewReset({ root }).files} files still there, profile.md=${exists('profile.md')}`)

console.log('\n=== /backup ===')
console.log(runSlash({ root }, 'backup', '', { now: new Date(2026, 10, 13, 17, 7, 21) }).text)

console.log('\n=== /new confirm ===')
const confirm = runSlash({ root }, 'new', 'confirm', { now: new Date(2026, 10, 13, 17, 7, 26) })
console.log(confirm.text)
console.log(`\n[check] profile.md exists: ${exists('profile.md')}; config.json exists: ${exists('config.json')}`)
console.log(`[check] state.json: ${read('state.json')}`)

console.log('\n=== /reload (newest snapshot = reset-20261113-170726) ===')
const reload = runSlash({ root }, 'reload', '', { now: new Date(2026, 10, 13, 17, 7, 44) })
console.log(reload.text)
console.log(`\n[check] profile.md: ${JSON.stringify(read('profile.md'))}`)
console.log(`[check] state.json: ${read('state.json')}`)
console.log(`[check] daily/2026-11-12.md: ${JSON.stringify(read('daily/2026-11-12.md'))}`)

const safety = reload.text.match(/safety-\d{8}-\d{6}/)[0]
console.log(`\n=== /reload ${safety} (undo the restore) ===`)
const undo = runSlash({ root }, 'reload', safety, { now: new Date(2026, 10, 13, 17, 7, 50) })
console.log(undo.text)
console.log(`\n[check] after undo profile.md exists: ${exists('profile.md')}; state.json: ${read('state.json')}`)

console.log('\n=== /reload backup-20261113-170721 (back to the pre-reset state) ===')
const back = runSlash({ root }, 'reload', 'backup-20261113-170721', { now: new Date(2026, 10, 13, 17, 7, 55) })
console.log(back.text)
console.log(`\n[check] profile.md: ${JSON.stringify(read('profile.md'))}`)
console.log(`[check] state.json: ${read('state.json')}`)

console.log('\n=== backups/ ===')
for (const dirent of fs.readdirSync(path.join(root, 'backups'), { withFileTypes: true })) console.log(`- ${dirent.name}/`)

console.log(`\n[demo root] ${root}`)
fs.rmSync(root, { recursive: true, force: true })
console.log('[demo root removed]')
