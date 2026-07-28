// Running jobs on a local-clock schedule.
//
// A thin loop around the pure nextRunAt: sleep until the next occurrence, run, repeat. The
// schedule is pinned to the configured zone, so relocating moves when jobs fire rather than
// shifting them by the new UTC offset.
//
// A job that throws is reported and the loop continues. A scheduled job that dies quietly
// would take reminders offline with no signal at all, which is the specific failure the
// alerting discipline exists to prevent.

const { nextRunAt } = require('./core/schedule.cjs');

// setTimeout cannot be trusted with multi-day delays (it overflows past ~24.8 days and
// drifts when the host sleeps), so long waits are broken into hops that re-check the clock.
const MAX_SLEEP_MS = 60 * 60 * 1000;

function scheduleJob({
  name,
  zone,
  hour,
  weekday = null,
  run,
  onError = () => {},
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  runs = Infinity,
}) {
  return (async () => {
    for (let count = 0; count < runs; count += 1) {
      const due = nextRunAt({ now: now(), zone, hour, weekday });

      while (now().getTime() < due.getTime()) {
        if (signal?.aborted) return;
        await sleep(Math.min(MAX_SLEEP_MS, due.getTime() - now().getTime()));
      }
      if (signal?.aborted) return;

      try {
        await run(due);
      } catch (error) {
        error.message = `scheduled job '${name}' failed: ${error.message}`;
        onError(error);
      }
    }
  })();
}

module.exports = { scheduleJob, MAX_SLEEP_MS };
