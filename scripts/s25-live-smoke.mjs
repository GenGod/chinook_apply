// S25 live smoke (manual, one-shot): reveal the apply panel of ONE live Job
// Bank posting — read-only (GET + one POST), NOTHING is sent anywhere.
// Prints the extracted apply methods. Usage:
//   node scripts/s25-live-smoke.mjs <postingUrl>
const url = process.argv[2];
if (!url || !/^https:\/\/www\.jobbank\.gc\.ca\/jobsearch\/jobposting\/\d+$/.test(url)) {
  console.error('usage: node scripts/s25-live-smoke.mjs https://www.jobbank.gc.ca/jobsearch/jobposting/<id>');
  process.exit(2);
}

const { httpRevealFetch, revealApplyMethods } = await import('../packages/adapters/src/jobbank-apply.ts').catch(
  () => import('@chinook/adapters/jobbank-apply'),
);

const jobId = /(\d+)$/.exec(url)[1];
const outcome = await revealApplyMethods(httpRevealFetch(url), url, jobId);
if (outcome.kind === 'revealed') {
  console.log('REVEALED:');
  console.log(JSON.stringify(outcome.methods, null, 2));
} else {
  console.log(`NOT REVEALED: ${outcome.kind}`);
}
