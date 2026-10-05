import type { Rate, Report, Spread } from './report.ts';

export function renderReport(report: Report): string {
  const { summary } = report;
  const failing = report.cases.filter((c) => c.passed < c.runs);
  return [
    `# System bench: ${label(report)}`,
    '',
    `${report.implementation} ${report.version} at ${report.base_url}, ${report.engines} engines, ` +
      `concurrency ${report.concurrency}` +
      (report.tag ? `, cases tagged \`${report.tag}\`.` : '.'),
    '',
    table(['Metric', 'Value'], headlineRows([report])),
    '',
    '## Stages',
    '',
    table(
      ['Stage', 'Runs', 'p50', 'p90', 'max', 'Mean cost', 'Total cost'],
      summary.stages.map((s) => [
        s.stage,
        `${s.runs}`,
        ms(s.duration_ms.p50),
        ms(s.duration_ms.p90),
        ms(s.duration_ms.max),
        usd(s.cost_usd.mean),
        usd(s.cost_usd.total),
      ]),
    ),
    '',
    '## Failing cases',
    '',
    failing.length === 0
      ? 'Every case passed on every run.'
      : table(
          ['Case', 'Passed', 'Mismatches'],
          failing.map((c) => [c.id, `${c.passed}/${c.runs}`, c.mismatches.join('<br>')]),
        ),
    '',
  ].join('\n');
}

/** One row per metric: its name, then its value in each report. */
function headlineRows(reports: Report[]): string[][] {
  const row = (metric: string, render: (report: Report) => string) => [metric, ...reports.map(render)];
  return [
    row('Plan', (r) => `${plan(r)}, ${r.started_at.slice(0, 16).replace('T', ' ')} UTC`),
    row('Accuracy', (r) => percent(r.summary.accuracy)),
    row('Price accuracy', (r) => percent(r.summary.price)),
    row('Films accuracy', (r) => percent(r.summary.films)),
    row('Rejection accuracy', (r) => percent(r.summary.rejection)),
    row('Error rate', (r) => percent(r.summary.errors)),
    row('Latency p50 / p90 / max', (r) => spread(r.summary.latency_ms)),
    row('Cost per cart', (r) => usd(r.summary.cost_usd.per_cart)),
    row('Total cost', (r) => usd(r.summary.cost_usd.total)),
  ];
}

function label(report: Report): string {
  return `${report.implementation} · ${report.engines}`;
}

function plan(report: Report): string {
  return `${report.requests} requests (${report.cases.length} cases × ${report.runs} runs)`;
}

function percent({ hits, total, rate }: Rate): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)} % (${hits}/${total})`;
}

function spread({ p50, p90, max }: Spread): string {
  return `${ms(p50)} / ${ms(p90)} / ${ms(max)}`;
}

function ms(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

function usd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(6)}`;
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
