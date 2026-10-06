import type { LangfuseApi } from './langfuse.ts';
import { failures, minConfidence, type Report } from './run.ts';
import type { Summary } from './stats.ts';

/** One case across the runs: each metric passed in how many runs, with its mean score; the plays that passed. */
interface CaseLine {
  id: string;
  metrics: { ok: number; seen: number; mean: number | undefined }[];
  /** The lowest confidence the engine gave, when its answers carry one. */
  confidence: number | undefined;
  passed: number;
  played: number;
}

function caseLine(report: Report, id: string): CaseLine {
  const runs = report.scores[id] ?? [];
  return {
    id,
    metrics: report.metrics.map((m) => {
      // a metric only reported passes every run: count the runs it got right
      const pass = report.thresholds[m] || 1;
      let ok = 0;
      let seen = 0;
      let sum = 0;
      for (const scored of runs) {
        const v = scored.scores?.[m];
        if (v === undefined) continue;
        seen++;
        sum += v;
        if (v >= pass - 1e-9) ok++;
      }
      return { ok, seen, mean: seen > 0 ? sum / seen : undefined };
    }),
    confidence: minConfidence(report, id),
    passed: runs.filter((s) => !s.skipped && s.passed).length,
    played: runs.filter((s) => !s.skipped).length,
  };
}

const left = (text: string, width: number) => text.padEnd(width);
const right = (text: string, width: number) => text.padStart(width);

/**
 * The bench as the terminal shows it: each case, each metric passed in how many runs and its mean score, the
 * lowest confidence the engine gave when its answers carry one, then the runs, what failed and why.
 */
export function renderReport(report: Report, langfuse?: LangfuseApi): string {
  const lines = report.cases.map((id) => caseLine(report, id));
  const conf = lines.some((l) => l.confidence !== undefined);
  const reported = report.metrics.filter((m) => report.thresholds[m] === 0);
  const out: string[] = [];
  out.push(
    '',
    left('case', 32) +
      report.metrics.map((m) => ` ${right(m, 9)} ${right('mean score', 10)}`).join('') +
      (conf ? ` ${right('min conf', 8)}` : '') +
      ` ${right('passed', 7)}`,
  );
  let total = 0;
  let passed = 0;
  for (const l of lines) {
    out.push(
      left(l.id, 32) +
        l.metrics
          .map((m) => ` ${right(`${m.ok}/${m.seen}`, 9)} ${right(m.mean === undefined ? '-' : m.mean.toFixed(2), 10)}`)
          .join('') +
        (conf ? ` ${right(l.confidence === undefined ? '-' : l.confidence.toFixed(2), 8)}` : '') +
        ` ${right(`${l.passed}/${l.played}`, 7)}`,
    );
    total += l.played;
    passed += l.passed;
  }
  out.push(
    '',
    'Each metric: the runs that reached its threshold, of the runs scored, then its mean score',
    "from 0 to 1: a score, not the engine's confidence.",
  );
  if (reported.length > 0) {
    out.push(`${reported.join(', ')}: reported only, fails no case; counts the runs it got right.`);
  }
  if (conf) out.push('min conf: the lowest confidence the engine gave the case, across the runs.');
  out.push('');
  for (const r of report.runs) {
    const url = langfuse ? `: ${langfuse.runUrl(report.dataset, r.id)}` : '';
    out.push(`${r.name}: ${Math.round(r.passRate * 100)} % of cases passed${url}`);
  }
  const failed = failures(report);
  if (failed.length > 0) out.push('', 'Failed:', ...failed.map((l) => `  ${l}`));
  out.push('', `${passed}/${total} passed · ${report.cost.toFixed(5)} USD · ${Math.round(report.durationMs / 1000)} s`);
  if (langfuse) out.push(`Compare the runs: ${langfuse.datasetUrl(report.dataset)}`);
  if (report.cutShort) out.push(`CUT SHORT: the spend reached --max-usd, ${report.skipped} plays were not started.`);
  if (report.langfuseErrors > 0) {
    out.push(
      `Langfuse: ${report.langfuseErrors} calls failed; the results above are computed here and stand without them.`,
    );
  }
  return `${out.join('\n')}\n`;
}

/** The same report in Markdown: a table a case, then what failed. */
export function renderMarkdown(
  report: Report,
  summary: Summary,
  { date, line }: { date: string; line: string },
): string {
  const lines = report.cases.map((id) => caseLine(report, id));
  const conf = lines.some((l) => l.confidence !== undefined);
  const runs = report.runs.length;
  const out: string[] = [
    `# ${report.subject} bench, ${date}`,
    '',
    report.variant,
    '',
    `${report.cases.length} cases × ${runs} ${runs === 1 ? 'run' : 'runs'}. ${line}`,
    '',
    `| case | ${report.metrics.map((m) => `${m} | ${m} mean`).join(' | ')} |${conf ? ' min conf |' : ''} passed |`,
    `|---|${report.metrics.map(() => '---:|---:').join('|')}|${conf ? '---:|' : ''}---:|`,
  ];
  for (const l of lines) {
    out.push(
      `| ${l.id} | ${l.metrics.map((m) => `${m.ok}/${m.seen} | ${m.mean === undefined ? '-' : m.mean.toFixed(2)}`).join(' | ')} |` +
        `${conf ? ` ${l.confidence === undefined ? '-' : l.confidence.toFixed(2)} |` : ''} ${l.passed}/${l.played} |`,
    );
  }
  out.push('');
  for (const r of report.runs) out.push(`- ${r.name}: ${Math.round(r.passRate * 100)} % of cases passed`);
  const failed = failures(report);
  if (failed.length > 0) out.push('', '## Failed', '', ...failed.map((l) => `- ${l}`));
  const total = lines.reduce((n, l) => n + l.played, 0);
  const passed = lines.reduce((n, l) => n + l.passed, 0);
  out.push(
    '',
    `${passed}/${total} passed · ${report.cost.toFixed(5)} USD · ${Math.round(report.durationMs / 1000)} s · ` +
      `p50 ${summary.p50} ms, p90 ${summary.p90} ms`,
  );
  if (report.cutShort) out.push('', `Cut short: the spend reached the cap, ${report.skipped} plays were not started.`);
  return `${out.join('\n')}\n`;
}

/** The JSON report of a run: what it tested, each case's runs, the stats. */
export function reportJson(report: Report, summary: Summary, extra: Record<string, unknown> = {}): unknown {
  return {
    subject: report.subject,
    variant: report.variant,
    ...extra,
    metrics: report.metrics,
    thresholds: report.thresholds,
    runs: report.runs.map(({ name, passRate, error }) => ({ name, pass_rate: passRate, ...(error && { error }) })),
    cost_usd: report.cost,
    duration_ms: report.durationMs,
    cut_short: report.cutShort,
    skipped: report.skipped,
    summary,
    cases: report.cases.map((id) => {
      const scores = report.scores[id] ?? [];
      return {
        id,
        runs: scores.length,
        passed: scores.filter((s) => s.passed).length,
        // each run's scores and reasons: what a failure was, not only that there was one
        results: scores.map(({ skipped, passed, scores: s, reasons }) => ({
          ...(skipped && { skipped }),
          passed,
          scores: s ?? {},
          reasons,
        })),
        reasons: scores.filter((s) => !s.passed && !s.skipped).flatMap((s) => Object.values(s.reasons)),
      };
    }),
  };
}
