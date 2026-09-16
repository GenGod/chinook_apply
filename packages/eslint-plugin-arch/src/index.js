// @chinook/eslint-plugin-arch — architecture boundary enforcement (PROCESS.md §7)
//
// Design note: implemented as a custom rule instead of eslint-plugin-boundaries
// because specifier/path analysis must stay deterministic under pnpm's strict
// node_modules (cross-package imports are undeclared until a real dependency
// exists, which breaks resolution-based plugins). No filesystem access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

// Repo root = nearest ancestor containing the workspace marker; immune to
// symlinked package resolution (pnpm workspace links) and directory depth.
function findRepoRoot(fromDir) {
  let dir = path.resolve(fromDir);
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found from ' + fromDir);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export { repoRoot };

const ELEMENT_ALLOW = {
  app: ['contracts', 'core', 'adapters'],
  core: ['contracts', 'llm'],
  adapters: ['contracts'],
  llm: ['contracts'],
  contracts: [],
  tooling: [],
  tests: ['app', 'contracts', 'core', 'llm', 'adapters', 'scripts'],
  scripts: [],
};

const PKG_ID = /^@chinook\/(contracts|core|llm|adapters|web|worker)$/;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function elementOfInternalPath(relPosix) {
  if (relPosix.startsWith('apps/')) return 'app';
  if (relPosix.startsWith('packages/contracts')) return 'contracts';
  if (relPosix.startsWith('packages/core')) return 'core';
  if (relPosix.startsWith('packages/llm')) return 'llm';
  if (relPosix.startsWith('packages/adapters')) return 'adapters';
  if (relPosix.startsWith('packages/eslint-plugin-arch')) return 'tooling';
  if (relPosix.startsWith('tests/')) return 'tests';
  if (relPosix.startsWith('scripts/')) return 'scripts';
  return null;
}

function fileElement(filename) {
  // CLI passes absolute paths; Linter.verify may pass virtual relative
  // names — absolutize first so element detection is cwd-independent.
  const abs = path.isAbsolute(filename) ? filename : path.resolve(filename);
  const rel = toPosix(path.relative(repoRoot, abs));
  return { rel, element: elementOfInternalPath(rel) };
}

function normalizeRelative(fromDir, spec) {
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  return joined.startsWith('..') ? null : joined;
}

function targetElementOf(spec, fromDir) {
  const id = PKG_ID.exec(spec)?.[1];
  if (id) return id === 'web' || id === 'worker' ? 'app' : id;
  if (spec.startsWith('.')) {
    const resolved = normalizeRelative(fromDir, spec);
    if (resolved === null) return null; // escapes repo root → external
    return elementOfInternalPath(resolved);
  }
  return null; // external package / builtin
}

function checkSpec(spec, node, context, state) {
  const target = targetElementOf(spec, state.fromDir);
  if (target === null || target === state.element) return;
  const allowed = ELEMENT_ALLOW[state.element] ?? [];
  if (!allowed.includes(target)) {
    context.report({
      node,
      messageId: 'boundary',
      data: {
        from: state.rel,
        fromElement: state.element,
        to: target,
        allowed: allowed.length ? allowed.join(', ') : 'nothing internal',
      },
    });
  }
}

const noBoundaryViolation = {
  meta: {
    type: 'problem',
    docs: { description: 'enforce package boundary rules from DESIGN.md' },
    schema: [],
    messages: {
      boundary:
        "Arch boundary violation: '{{fromElement}}' ({{from}}) must not import '{{to}}'. Allowed internal targets: {{allowed}}.",
    },
  },
  create(context) {
    const { rel, element } = fileElement(context.filename);
    if (!element) return {};
    const state = { rel, element, fromDir: path.posix.dirname(rel) };
    return {
      ImportDeclaration: (node) => checkSpec(node.source.value, node, context, state),
      ImportExpression: (node) =>
        'value' in node.source && typeof node.source.value === 'string'
          ? checkSpec(node.source.value, node, context, state)
          : undefined,
      ExportNamedDeclaration: (node) =>
        node.source ? checkSpec(node.source.value, node, context, state) : undefined,
      ExportAllDeclaration: (node) => checkSpec(node.source.value, node, context, state),
      CallExpression: (node) =>
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal' &&
        typeof node.arguments[0].value === 'string'
          ? checkSpec(node.arguments[0].value, node, context, state)
          : undefined,
    };
  },
};

export const plugin = {
  meta: { name: '@chinook/eslint-plugin-arch', version: '0.0.0' },
  rules: { 'no-boundary-violation': noBoundaryViolation },
};

export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  'tests/e2e/__snapshots__/**',
  'tests/test-results/**',
  'tests/playwright-report/**',
];

export function archOnlyConfig() {
  return [
    {
      ignores,
    },
    {
      files: ['**/*.{js,mjs,cjs,ts,tsx}'],
      languageOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
      plugins: { arch: plugin },
      rules: { 'arch/no-boundary-violation': 'error' },
    },
  ];
}

export function flatConfig() {
  // Same as archOnlyConfig for programmatic tests; the full repo config
  // (root eslint.config.js) layers tseslint recommended on top.
  return archOnlyConfig();
}
