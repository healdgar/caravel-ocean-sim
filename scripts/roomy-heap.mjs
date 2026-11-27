// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Node's default heap (about 4 GB) is smaller than a full-grown pack's working set (a sixty-year fir alone is millions of
// needle sheets), and there is no cap on a tree's detail (AGENTS.md rule 3). So an offline bake calls roomyHeap() first:
// it reruns itself, once, with most of the machine's memory, and exits with its child's status.
import os from 'node:os';
import v8 from 'node:v8';
import { spawnSync } from 'node:child_process';

export function roomyHeap(share = 0.6) {
  const want = Math.floor((os.totalmem() * share) / 2 ** 20);
  if (process.env.ROOMY_HEAP || v8.getHeapStatistics().heap_size_limit / 2 ** 20 >= 0.9 * want) return;
  const run = spawnSync(process.execPath, [...process.execArgv, `--max-old-space-size=${want}`, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, ROOMY_HEAP: '1' },
  });
  process.exit(run.status ?? 1);
}
