// Pipeline sequencer — single source of truth for local, pre-push and CI runs.
// Unit-tested in tests/unit/pipeline.test.mjs (fail-fast, stage order, quick mode).
import { spawn } from 'node:child_process';
import process from 'node:process';

export function planStages(quick) {
  const stages = [
    { name: 'lint', cmd: ['pnpm', 'run', 'lint'] },
    { name: 'arch-lint', cmd: ['pnpm', 'run', 'arch-lint'] },
    { name: 'typecheck', cmd: ['pnpm', 'run', 'typecheck'] },
    { name: 'test', cmd: ['pnpm', 'run', 'test'] },
    { name: 'build', cmd: ['pnpm', 'run', 'build'] },
    { name: 'e2e', cmd: ['pnpm', 'run', 'e2e'] },
  ];
  return quick ? stages.filter((s) => !['build', 'e2e'].includes(s.name)) : stages;
}

async function defaultRunner(stage) {
  return new Promise((resolve) => {
    const child = spawn(stage.cmd.join(' '), { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export async function runPipeline({ quick = false, runner = defaultRunner, log = console.log } = {}) {
  const stages = planStages(quick);
  let index = 0;
  for (const stage of stages) {
    index += 1;
    log(`\n=== [${index}/${stages.length}] ${stage.name} ===`);
    const code = await runner(stage);
    if (code !== 0) {
      log(`\n✗ pipeline failed at stage '${stage.name}' (exit ${code})`);
      return { ok: false, failed: stage.name, ran: index };
    }
  }
  log(`\n✓ pipeline green (${stages.length} stages)`);
  return { ok: true, failed: null, ran: stages.length };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (isMain) {
  const quick = process.argv.includes('--quick');
  const result = await runPipeline({ quick });
  process.exitCode = result.ok ? 0 : 1;
}
