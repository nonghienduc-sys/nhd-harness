#!/usr/bin/env node
/** Read-only audit counting and idle-gap analysis. No machine-specific defaults. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--db','--since','--until'].includes(argv[i]) || !argv[i + 1])
      throw new Error('Usage: audit-summary.mjs --db <sqlite> --since <ISO> [--until <ISO>]');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  if (!result.db || !result.since || !Number.isFinite(Date.parse(result.since)) ||
      (result.until && !Number.isFinite(Date.parse(result.until))))
    throw new Error('Missing or invalid --db/--since/--until');
  return result;
}
try {
  const a = args(process.argv.slice(2));
  if (!existsSync(a.db)) throw new Error('Database not found.');
  const db = new DatabaseSync(a.db, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id,at,action,detail FROM audit WHERE at>=? AND at<=? ORDER BY at,id')
      .all(a.since, a.until ?? '9999-12-31T23:59:59.999Z');
    const actions = {}, described = {}, invalid = {}, idleGaps = [];
    let previous = null;
    for (const row of rows) {
      actions[row.action] = (actions[row.action] ?? 0) + 1;
      let detail = {};
      try { detail = JSON.parse(row.detail); } catch {}
      if (row.action === 'tool_describe') {
        const key = String(detail.tool ?? '(unknown)');
        described[key] = (described[key] ?? 0) + 1;
      }
      if (row.action === 'tool_invalid_params') {
        const key = String(detail.tool ?? '(unknown)');
        invalid[key] = (invalid[key] ?? 0) + 1;
      }
      if (previous) {
        const seconds = (Date.parse(row.at) - Date.parse(previous.at)) / 1000;
        if (seconds > 30) idleGaps.push({ from: previous.at, to: row.at, seconds });
      }
      previous = row;
    }
    console.log(JSON.stringify({ total: rows.length, actions, tool_describe_by_tool: described,
      tool_invalid_params_by_tool: invalid, idle_gaps_over_30s: idleGaps }, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
