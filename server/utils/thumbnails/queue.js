import { readConfig } from '../config/settings.js';
import { generateForFile } from './generate.js';

/*
  A bounded work queue, in process.

  kempo awaits hook handlers one at a time, in registration order — so anything a `file:uploaded`
  handler does inline is time the person uploading spends staring at a progress bar. Thumbnailing a
  video means seeking, decoding and re-encoding, which is seconds, not milliseconds. So the hook
  enqueues and returns, and the work happens after the response has already gone out.

  In process, deliberately. A real job runner (a table polled by a worker, a queue service) is the
  right answer for a site generating thumbnails at volume, and this extension is not going to
  pretend to be one — but it is also not going to make a single-server kempo site stand up a broker
  to get thumbnails. What is here instead is honest about its limits:

    - `concurrency` caps how many files are processed at once, so a bulk upload cannot spawn one
      ffmpeg per file and take the machine down with it.
    - Restarting the server loses whatever was still queued. Those rows stay 'pending', which is
      exactly how the admin screen finds them, and "Generate missing" picks them back up.
*/

const pending = [];
const inFlight = new Set();
let active = 0;
let processed = 0;
let failed = 0;

const pump = async () => {
  if(!pending.length) return;

  const config = await readConfig();
  while(active < config.concurrency && pending.length){
    const job = pending.shift();
    active++;
    runJob(job, config).finally(() => {
      active--;
      inFlight.delete(job.fileId);
      /*
        Kicked from the completion of each job rather than a timer: the queue only ever needs to
        wake up when a slot frees, and nothing is left running when it drains.
      */
      pump();
    });
  }
};

const runJob = async (job, config) => {
  try {
    const [error] = await generateForFile({ fileId: job.fileId, force: job.force, config });
    if(error){
      failed++;
      console.error(`[kempo-thumbs] ${job.fileId}: ${error.msg}`);
    }
  } catch(error){
    /*
      A throw here would be an unhandled rejection inside the web server process. Whatever went
      wrong, one bad file is not a reason to take the site down.
    */
    failed++;
    console.error(`[kempo-thumbs] ${job.fileId}: ${error?.message || error}`);
  } finally {
    processed++;
  }
};

/*
  Returns whether the job was accepted. A file already queued or running is not queued twice: a
  double upload of the same id, or a "regenerate" clicked twice, would otherwise have two ffmpeg
  runs writing the same destination path at the same time.

  A `force` request for something already in flight is dropped rather than upgraded — the run
  already underway is about to produce a current thumbnail either way.
*/
export const enqueue = ({ fileId, force = false }) => {
  if(!fileId || inFlight.has(fileId)) return false;

  inFlight.add(fileId);
  pending.push({ fileId, force });
  pump();
  return true;
};

export const enqueueMany = files => files.reduce(
  (count, file) => count + (enqueue(file) ? 1 : 0),
  0,
);

/*
  What the admin screen shows. Counters are since this process started, which is the only thing an
  in-process queue can honestly claim.
*/
export const queueStatus = () => ({
  queued: pending.length,
  active,
  processedSinceStart: processed,
  failedSinceStart: failed,
});
