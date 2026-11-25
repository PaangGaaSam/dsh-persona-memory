import fs from 'node:fs'
import path from 'node:path'
import {
  isSnapshotName,
  latestSnapshot,
  previewReset,
  resetMemory,
  restoreSnapshot,
  snapshotMemory,
} from './reset.js'
import { loadState, saveState } from './state.js'

/**
 * The three human commands as one pure-ish state machine: parse `rawInput`,
 * call `lib/reset.js`, render text.
 *
 * Kept out of `lib/index.js` so the command behavior can be tested against a
 * temp directory without a host context — the registration there only forwards
 * `invocation.rawInput` and refreshes the in-process state afterwards.
 */

/**
 * 描述是给宿主的命令面板看的，而宿主的命令 schema 只接受一个纯字符串
 * （`typeof description === 'string'`，没有 locale 字段），所以这里直接写中文。
 * 参数 token 仍是英文：`confirm`、快照目录名。
 */
export const SLASH_COMMANDS = [
  {
    name: 'new',
    description: '清空全部记忆（画像、自述、教训、事实、日报、历史与日志）。不带参数只预览；/new confirm 会先快照再清空',
    hint: '[confirm]',
  },
  {
    name: 'backup',
    description: '立刻把全部记忆快照到 backups/',
  },
  {
    name: 'reload',
    description: '用最新的一份 backup-/reset- 快照恢复记忆，也可指定 backups/ 下的目录名',
    hint: '[<快照目录名>]',
  },
]

/** Long enough for a reply, short enough to stay one message. */
const MAX_LISTED = 20

function listOf(names, none = '（无）') {
  if (names.length === 0) return none
  if (names.length <= MAX_LISTED) return names.join('、')
  return `${names.slice(0, MAX_LISTED).join('、')} 等 ${names.length} 个`
}

function bytesOf(value) {
  return `${value} 字节`
}

/**
 * state.json is part of memory, so `/new confirm` removed it. The defaults live
 * in `lib/state.js`; reading a just-deleted file is how we get them without
 * duplicating the shape here.
 */
function rebuildEmptyState(paths) {
  const stateFile = path.join(paths.root, 'state.json')
  saveState(stateFile, { ...loadState(stateFile), running: false })
}

function renderPreview(preview) {
  const lines = ['这是预览：没有动任何文件。', '']
  for (const entry of preview.entries) {
    const label = entry.type === 'dir' ? `${entry.rel}/` : entry.rel
    lines.push(`- ${label}  ${entry.files} 个文件，${bytesOf(entry.bytes)}`)
  }
  lines.push('', `合计 ${preview.files} 个文件，${bytesOf(preview.bytes)}。`)
  lines.push('config.json 和 backups/ 不在清空范围内。')
  lines.push('state.json 会被重建为空状态（只清运行记录，不影响调度）。')
  lines.push('执行 /new confirm 才会真的清空（会先自动快照到 backups/）。')
  return lines.join('\n')
}

function runNew(paths, input, options) {
  if (input.length === 0) {
    const preview = previewReset(paths)
    if (preview.entries.length === 0) {
      return { kind: 'success', text: '记忆已经是空的，没有可清空的内容。' }
    }
    return { kind: 'success', text: renderPreview(preview) }
  }
  if (input.toLowerCase() !== 'confirm') {
    return {
      kind: 'error',
      text: `/new 只预览，/new confirm 才清空。收到的是「${input}」。`,
    }
  }
  let result
  try {
    result = resetMemory(paths, { now: options.now })
  } catch (error) {
    // Two very different failures: the snapshot itself failed (nothing touched),
    // or the clear failed after a good snapshot (recoverable by name).
    if (error.snapshot !== undefined) {
      return {
        kind: 'error',
        text: `快照已完成（backups/${error.snapshot.name}），但清空没有做完：${error.message}\n`
          + `可以用 /reload ${error.snapshot.name} 回到清空前的状态。`,
      }
    }
    return {
      kind: 'error',
      text: `没有动任何记忆：快照失败（${error.message}）。先修好 backups/ 再试。`,
    }
  }
  try {
    rebuildEmptyState(paths)
  } catch (error) {
    return {
      kind: 'error',
      text: `记忆已清空，快照在 ${result.snapshot.dir}，但 state.json 没能重建：${error.message}`,
    }
  }
  options.onStateChange?.()
  const lines = [
    '已清空记忆。',
    '',
    `快照：${result.snapshot.dir}`,
    `快照内容：${result.snapshot.files} 个文件，${bytesOf(result.snapshot.bytes)}`,
    `清掉：${result.cleared.files} 个文件，${bytesOf(result.cleared.bytes)}`,
    'state.json 已重建为空状态；调度游标在内存里，不受影响。',
    '',
    '想彻底不留痕迹就把 backups/ 里这个目录也删掉：',
    result.snapshot.dir,
  ]
  return { kind: 'success', text: lines.join('\n') }
}

function runBackup(paths, input, options) {
  if (input.length > 0) {
    return { kind: 'error', text: '/backup 不接受参数；直接发 /backup。' }
  }
  const preview = previewReset(paths)
  if (preview.files === 0) {
    return { kind: 'error', text: '记忆还是空的（没有可备份的文件），没有生成快照。' }
  }
  try {
    const snapshot = snapshotMemory(paths, 'backup', options.now)
    return {
      kind: 'success',
      text: `已备份到 ${snapshot.dir}\n${snapshot.files} 个文件，${bytesOf(snapshot.bytes)}。`,
    }
  } catch (error) {
    return { kind: 'error', text: `备份失败：${error.message}` }
  }
}

function runReload(paths, input, options) {
  let name = input
  if (input.length === 0) {
    const latest = latestSnapshot(paths)
    if (latest === undefined) {
      return {
        kind: 'error',
        text: 'backups/ 里还没有可恢复的快照：先用 /backup 或 /new confirm 生成一份。',
      }
    }
    name = latest.name
  }
  if (!isSnapshotName(name)) {
    return {
      kind: 'error',
      text: `/reload 需要一个 backups/ 下的快照目录名（如 backup-20261113-170726），收到的是「${name}」。`,
    }
  }
  let isDirectory = false
  try {
    isDirectory = fs.statSync(path.join(paths.root, 'backups', name)).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    return { kind: 'error', text: `backups/ 里没有 ${name}，没有恢复。` }
  }
  let result
  try {
    result = restoreSnapshot(paths, name, options.now)
  } catch (error) {
    return { kind: 'error', text: `没有恢复：${error.message}` }
  }
  // The restored state.json is what the next run reads; the in-process copy is
  // refreshed by the caller so /status does not lie until the next run.
  options.onStateChange?.()
  const lines = [
    `已用 backups/${result.name} 恢复。`,
    '',
    `覆盖 ${result.files} 个文件：${listOf(result.restored)}`,
  ]
  if (result.mirror) {
    // safety-* 是镜像恢复：它代表"恢复前那一刻"的完整状态，用来撤销上一次恢复。
    lines.push(`删除（快照里没有）：${listOf(result.removed, '（无）')}`)
  } else {
    lines.push(`保留（快照里没有）：${listOf(result.kept)}`)
  }
  lines.push(
    `安全快照：${result.safetyDir}`,
    `想撤销这次恢复：/reload ${result.safety}`,
  )
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * One command invocation. Never throws: the registry would turn a throw into a
 * generic error, and these failures carry actionable text.
 * @returns {{kind:'success'|'error', text:string}}
 */
export function runSlash(paths, name, rawInput, options = {}) {
  const input = String(rawInput ?? '').trim()
  if (name === 'new') return runNew(paths, input, options)
  if (name === 'backup') return runBackup(paths, input, options)
  if (name === 'reload') return runReload(paths, input, options)
  return { kind: 'error', text: `未知命令：/${name}` }
}
