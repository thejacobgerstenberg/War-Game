/**
 * Small shared utilities: SMOKE-mode detection, results writing, and
 * ASCII table / bar-chart helpers for run-script console reports.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** sim/results, resolved relative to this file (works from any cwd). */
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

/**
 * True when env SMOKE is set to a truthy value (anything except '', '0',
 * 'false'). Run scripts should use drastically reduced iteration counts in
 * smoke mode so `SMOKE=1 npm run sim:all` finishes in seconds.
 */
export function isSmoke(): boolean {
  const v = process.env.SMOKE;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Write sim/results/<name>.json (pretty-printed). Returns the full path. */
export function writeResults(name: string, obj: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return path;
}

/** Format a number with fixed decimals; integers stay clean. */
export function fmt(x: number, digits = 2): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

/** Percentage string: pct(0.1234) => '12.3%'. */
export function pct(x: number, digits = 1): string {
  return (100 * x).toFixed(digits) + '%';
}

/** ASCII bar: bar(3, 10, 20) => '██████              '. */
export function bar(value: number, max: number, width = 40): string {
  const n = max > 0 ? Math.round((Math.max(0, Math.min(value, max)) / max) * width) : 0;
  return '█'.repeat(n) + ' '.repeat(width - n);
}

/** Simple padded ASCII table. Cells are stringified with fmt() for numbers. */
export function table(headers: string[], rows: Array<Array<string | number>>): string {
  const cells: string[][] = [
    headers,
    ...rows.map((r) => r.map((c) => (typeof c === 'number' ? fmt(c) : c))),
  ];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n');
}
