import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { flatConfig, repoRoot } from '../src/index.js';

// ESLint's flat Linter resolves the virtual filename against process.cwd()
// and only matches configs for files inside it — vitest starts us in the
// package dir, so point the process at the repo root first.
process.chdir(repoRoot);

const linter = new Linter({ configType: 'flat' });
const config = flatConfig();

const lint = (code, filePath) =>
  linter.verify(code, config, filePath).filter((m) => m.ruleId === 'arch/no-boundary-violation');

describe('arch boundaries — S0 AC3 (gate must catch violations)', () => {
  it('forbids adapters importing core', () => {
    const msgs = lint(
      "import { CORE_MARKER } from '@chinook/core';\nexport const x = CORE_MARKER;\n",
      'packages/adapters/src/bad.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('forbids llm importing adapters (S3 boundary: llm sees contracts+core only)', () => {
    const msgs = lint(
      "import { jobbankAdapter } from '@chinook/adapters';\nexport const x = jobbankAdapter;\n",
      'packages/llm/src/bad.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('forbids any package importing apps', () => {
    const msgs = lint(
      "import { X } from '../../../apps/web/app/layout';\nexport const y = X;\n",
      'packages/core/src/bad.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('forbids app importing llm directly (must go through core)', () => {
    const msgs = lint(
      "import { LLM_MARKER } from '@chinook/llm';\nexport const z = LLM_MARKER;\n",
      'apps/web/lib/bad.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('allows adapters importing contracts', () => {
    const msgs = lint(
      "import { CONTRACTS_VERSION } from '@chinook/contracts';\nexport const v = CONTRACTS_VERSION;\n",
      'packages/adapters/src/ok.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('allows core importing llm and contracts', () => {
    expect(
      lint("import { LLM_MARKER } from '@chinook/llm';\n", 'packages/core/src/ok.ts'),
    ).toHaveLength(0);
    expect(
      lint("import { CONTRACTS_VERSION } from '@chinook/contracts';\n", 'packages/core/src/ok2.ts'),
    ).toHaveLength(0);
  });

  it('allows apps importing core and adapters', () => {
    expect(
      lint("import { CORE_MARKER } from '@chinook/core';\n", 'apps/web/lib/ok.ts'),
    ).toHaveLength(0);
    expect(
      lint("import { ADAPTERS_MARKER } from '@chinook/adapters';\n", 'apps/worker/src/ok.ts'),
    ).toHaveLength(0);
  });

  it('allows tests importing scripts (pipeline sequencer is a test target)', () => {
    expect(
      lint("import { planStages } from '../../scripts/pipeline.mjs';\n", 'tests/unit/ok.ts'),
    ).toHaveLength(0);
  });
});

it('allows llm importing core (gateway persists via core types, S3)', () => {
  expect(
    lint("import { createDb } from '@chinook/core';\nexport const x = 1;\n", 'packages/llm/src/ok.ts'),
  ).toHaveLength(0);
});
