// Live smoke: one real GLM flash call + one cached repeat (S3 AC5).
// Usage: pnpm --filter @chinook/llm run ping
import { createDb, ensureSchema } from '@chinook/core';
import { createLlm, createPgLlmDb } from './index.js';
import process from 'node:process';
import { z } from 'zod';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
await ensureSchema(db);
const llm = createLlm({ db: createPgLlmDb(db) });

const first = await llm.call({
  role: 'flash',
  stage: 'ping',
  system: 'You are a connectivity probe. Reply with JSON only.',
  user: 'Reply exactly: {"pong": true}',
  schema: z.object({ pong: z.boolean() }),
});
console.log('live:', JSON.stringify(first));

const second = await llm.call({
  role: 'flash',
  stage: 'ping',
  system: 'You are a connectivity probe. Reply with JSON only.',
  user: 'Reply exactly: {"pong": true}',
  schema: z.object({ pong: z.boolean() }),
});
console.log('cached:', JSON.stringify(second));
console.log('cache-hit-rate after repeat ping:', second.cached ? '1.0' : '0.0');
await db.destroy();
