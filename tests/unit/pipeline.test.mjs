import { describe, it, expect } from 'vitest';
import { planStages, runPipeline } from '../../scripts/pipeline.mjs';

describe('pipeline stages — S0 AC2/AC9', () => {
  it('defines the full gate order: lint → arch-lint → typecheck → test → build → e2e', () => {
    expect(planStages(false).map((s) => s.name)).toEqual([
      'lint',
      'arch-lint',
      'typecheck',
      'test',
      'build',
      'e2e',
    ]);
  });

  it('quick mode skips e2e and build (pre-push speed)', () => {
    expect(planStages(true).map((s) => s.name)).toEqual(['lint', 'arch-lint', 'typecheck', 'test']);
  });

  it('stops at the first failing stage (fail-fast)', async () => {
    const ran = [];
    const result = await runPipeline({
      quick: false,
      runner: async (stage) => {
        ran.push(stage.name);
        return stage.name === 'arch-lint' ? 1 : 0;
      },
    });
    expect(result).toEqual({ ok: false, failed: 'arch-lint', ran: 2 });
    expect(ran).toEqual(['lint', 'arch-lint']);
  });

  it('runs everything green in order when all stages pass', async () => {
    const ran = [];
    const result = await runPipeline({
      quick: false,
      runner: async (stage) => {
        ran.push(stage.name);
        return 0;
      },
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(['lint', 'arch-lint', 'typecheck', 'test', 'build', 'e2e']);
  });
});
