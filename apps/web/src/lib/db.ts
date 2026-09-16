import { createDb, DEV_DATABASE_URL, type Database, type Kysely } from '@chinook/core';

let singleton: Kysely<Database> | undefined;

/** Process-wide pg pool for request handlers (web server lifecycle). */
export function getDb(): Kysely<Database> {
  singleton ??= createDb(process.env.DATABASE_URL ?? DEV_DATABASE_URL);
  return singleton;
}
