import { pinnedSha } from './github.mjs';

const escapeText = (value) =>
  String(value)
    .replace(/[\\`*_{}[\]()!|~]/g, '\\$&')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '@\u200b');
export function renderReview(result) {
  if (
    !['APPROVE', 'CONDITIONAL', 'REQUEST_CHANGES', 'INCOMPLETE'].includes(result.verdict) ||
    result.mode !== 'advisory' ||
    !/^[a-f0-9-]{36}$/.test(result.id)
  )
    throw new Error('Invalid retained review result');
  const marker = `<!-- inventarch-review:${result.id} -->`;
  // Monochrome status symbols provide scan cues; labels retain the full meaning.
  const verdicts = {
    APPROVE: '✓ Approval recommended',
    CONDITIONAL: '△ Conditional recommendation',
    REQUEST_CHANGES: '× Changes requested',
    INCOMPLETE: '◌ Review incomplete',
  };
  const findings = result.findings ?? [],
    gaps = result.gaps ?? [];
  const stages = [...new Set(result.coverage?.stages ?? [])];
  const blocking = findings.filter((finding) => finding.disposition === 'BLOCKING').length;
  const followUps = findings.filter((finding) => finding.disposition === 'FOLLOW_UP').length;
  const lines = [
    marker,
    '## InventArch review',
    '',
    `**${verdicts[result.verdict]}** · ${findings.length} finding${findings.length === 1 ? '' : 's'} · ${blocking} blocking recommendation${blocking === 1 ? '' : 's'} · ${followUps} follow-up${followUps === 1 ? '' : 's'}`,
    '',
    escapeText(result.summary),
    '',
    ...(gaps.length ? [`*Evidence limited: ${gaps.length} recorded gaps. See review details below.*`, ''] : []),
  ];
  if (findings.length) lines.push('---', '');
  else lines.push('**No actionable findings retained.** See the verdict and evidence limits above.', '');
  for (const [index, f] of findings.entries()) {
    const severity =
      { high: '▲ High severity', medium: '△ Medium severity', low: '○ Low severity' }[f.severity] ??
      escapeText(f.severity ?? 'Severity unrecorded');
    const disposition =
      { BLOCKING: 'Blocking recommendation', FOLLOW_UP: 'Follow-up' }[f.disposition] ?? escapeText(f.disposition);
    const location = `${f.citation.path}:${f.citation.line}${f.citation.endLine && f.citation.endLine !== f.citation.line ? `–${f.citation.endLine}` : ''}`;
    lines.push(
      `### ${index + 1}. ${escapeText(f.title)}`,
      '',
      `${severity} · ${disposition} · ${escapeText(location)} (${escapeText(f.citation.side)})`,
      '',
      `- **Trigger:** ${escapeText(f.trigger)}`,
      `- **Impact:** ${escapeText(f.consequence)}`,
      `- **Fix / verify:** ${escapeText(f.fix)}`,
      '',
    );
  }
  lines.push(
    '---',
    '',
    '<details><summary>Review details — coverage, counter-evidence, and limitations</summary>',
    '',
    `**Scope:** ${result.coverage?.stages ? stages.length : 'Unrecorded'} passes · ${result.coverage?.filesRead ?? 'Unrecorded'} file versions read · ${result.coverage?.fullUnchangedFiles?.length ?? 'Unrecorded'} full unchanged files read`,
    '',
  );
  if (findings.length) {
    lines.push('#### Counter-evidence considered', '');
    for (const [index, f] of findings.entries())
      lines.push(`**${index + 1}. ${escapeText(f.title)}**`, '', escapeText(f.counterEvidence), '');
  }
  if (gaps.length)
    lines.push(`#### Evidence gaps (${gaps.length})`, '', ...gaps.map((gap) => `- ${escapeText(gap)}`), '');
  lines.push(
    '#### Provenance',
    '',
    '| Detail | Recorded evidence |',
    '| :--- | :--- |',
    `| Model | ${escapeText(result.model)} |`,
    `| Review passes | ${escapeText(stages.join(', ') || 'Not recorded')} |`,
    `| Method | ${escapeText(result.method)} |`,
    `| Source packet | ${escapeText(result.subject)} |`,
    '',
    'File versions count each revision separately; reading the base and head of one path counts as two. Pass counts describe recorded work, not a coverage percentage.',
    '',
    'CI execution evidence is retained with the review; restored results and skipped steps are not new execution.',
    '',
    '</details>',
    '',
    `*Advisory review of commit \`${pinnedSha(result.head)}\`. Does not approve or block merging.*`,
  );
  const body = lines.join('\n');
  if (Buffer.byteLength(body) > 60000)
    throw new Error('Review exceeds GitHub comment bound; retained result must be inspected directly');
  return body;
}
