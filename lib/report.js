/**
 * The text a finished digest returns to the caller (tool output and panel banner).
 *
 * Pure on purpose: it is the only place that decides how a run is reported, so it
 * lives outside the host module and can be asserted by the test run.
 */

/**
 * @param {object} report - `runDigest`'s return value.
 * @param {{forcePersona?: boolean}} [opts] - the flags the run was started with.
 */
export function formatReport(report, opts = {}) {
  if (report.skipped === true) return `今日（${report.date}）没有可总结的会话：采集到 ${report.sessions} 个会话，但都为空或在窗口外。`
  const lines = [
    `已将 ${report.date} 的 ${report.sessions} 个会话总结为卡片 ${report.cards} 张。`,
    `日报：${report.daily}`,
  ]
  if (report.profile !== null) lines.push(`画像：新增 ${report.profile.applied} 条，合并 ${report.profile.merged} 条（v${report.profile.version}）。`)
  else lines.push('画像：本次未更新（模型未返回建议或 autoApply=false）。')
  if (report.persona !== null) {
    if (typeof report.persona.error === 'string') {
      lines.push(`自述：合并失败（${report.persona.error}），文件未改动，原始输出已写进日志。`)
    } else {
      const moved = []
      if ((report.persona.promoted ?? 0) > 0) moved.push(`晋升 ${report.persona.promoted}`)
      if ((report.persona.demoted ?? 0) > 0) moved.push(`降级 ${report.persona.demoted}`)
      if ((report.persona.superseded ?? 0) > 0) moved.push(`推翻 ${report.persona.superseded}`)
      const suffix = moved.length > 0 ? `，${moved.join('、')}` : ''
      lines.push(`自述：新增 ${report.persona.applied} 条，合并 ${report.persona.merged} 条${suffix}（v${report.persona.version}）。`)
    }
  } else if (opts.forcePersona === true) lines.push('自述：本次未生成新条目（还没有「我的判断」记录，或模型未返回候选）。')
  else lines.push('自述：未到每周合并时间或未更新。')
  if (report.identity !== null && report.identity !== undefined) {
    const identity = report.identity
    if (identity.generated === true) {
      lines.push(`身份块：已按画像 v${identity.identity?.profileVersion ?? '?'} 重算（${identity.identity?.used ?? 0} 条计入 / ${identity.identity?.excluded ?? 0} 条未计入）。`)
    } else if (typeof identity.error === 'string') {
      lines.push(`身份块：本次未更新（${identity.error}），保留上一次结果。`)
    } else {
      lines.push('身份块：画像版本未变，沿用缓存。')
    }
  }
  if (report.lessons !== null && report.lessons !== undefined) {
    const lessons = report.lessons
    if (typeof lessons.error === 'string') {
      lines.push(`教训：本次未更新（${lessons.error}），文件未改动。`)
    } else {
      // A cut-off answer is the one case where "+0" is not a quiet day: it is said
      // first, so the line below can never be read as "nothing worth writing".
      const truncated = lessons.truncated === true
      if (truncated) {
        lines.push(`教训：本次输出被截断，只收下 ${lessons.suggestions ?? 0} 条（日志里有长度和耗时）。`)
      }
      if ((lessons.added ?? 0) + (lessons.pending ?? 0) + (lessons.merged ?? 0) + (lessons.archived ?? 0) === 0) {
        if (!truncated) lines.push('教训：没有新的可写条目。')
      } else {
        const parts = []
        if ((lessons.pending ?? 0) > 0) parts.push(`待确认铁律 ${lessons.pending}`)
        if ((lessons.added ?? 0) > 0) parts.push(`新增时效经验 ${lessons.added}`)
        if ((lessons.merged ?? 0) > 0) parts.push(`合并 ${lessons.merged}`)
        if ((lessons.archived ?? 0) > 0) parts.push(`作废 ${lessons.archived}`)
        lines.push(`教训：${parts.join('、')}（待批准才会生效）。`)
      }
    }
  }
  return lines.join('\n')
}
