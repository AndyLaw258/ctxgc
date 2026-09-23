/**
 * Single-process test entry.
 *
 * `node --test` spawns one child process per test file. Inside the DSH file
 * sandbox that spawn is refused (`spawn EPERM`: confined modes cannot open the
 * named pipes a piped stdio needs), so the suite cannot run that way here.
 * This entry imports every test file into ONE process instead.
 *
 * Prefer `node --test tests/*.test.mjs` in an unrestricted shell — it gives
 * per-file isolation, which this entry trades away. Use this file when the
 * sandbox blocks spawning.
 *
 * Run with:  node tests/run-all.mjs
 */
const files = [
    'zstd.test.mjs',
    'usage.test.mjs',
    'lifecycle.test.mjs',
    'simulate.test.mjs',
    'workflow.test.mjs',
    'prompt.test.mjs',
    'adapters.test.mjs',
    'health.test.mjs',
    'discovery.test.mjs'
];

const base = new URL('./', import.meta.url);
for (const file of files) await import(new URL(file, base));
