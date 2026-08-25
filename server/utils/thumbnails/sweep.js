import { inArray } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { listFiles } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import { isEligible } from './generate.js';
import { enqueueMany } from './queue.js';

/*
  Catching up a library that already has files in it.

  This is the answer to three separate situations that all look the same from here: the extension
  was installed after the files were uploaded, generation was turned off for a while, or a size was
  added to the settings. In each case some eligible files have no current thumbnail and nothing
  will ever come along to notice — `file:uploaded` only fires for new uploads.

  It also covers the fourth: the queue does not survive a restart, so rows left mid-flight by one
  stay 'pending' — and a pending row counts as missing here, which is what picks them back up
  without needing a separate resume path.

  Nothing is generated inline: every candidate goes onto the same bounded queue an upload uses, so
  a sweep over ten thousand files runs at the configured concurrency rather than all at once.
*/

const PAGE = 200;

/*
  Which files are missing at least one configured size. A file whose rows are all 'failed' counts
  as missing — a failure is worth retrying on demand, which is exactly what this is.

  'skipped' does not count. An mp3 with no cover art has nothing to generate, and re-queueing it on
  every sweep would mean the sweep never converges.
*/
const missingLabels = async (fileIds, labels) => {
  const rows = fileIds.length
    ? await db.select({
        sourceFileId: kempoThumbnail.sourceFileId,
        label: kempoThumbnail.label,
        status: kempoThumbnail.status,
        fileId: kempoThumbnail.fileId,
      }).from(kempoThumbnail).where(inArray(kempoThumbnail.sourceFileId, fileIds))
    : [];

  const settled = new Map();
  for(const row of rows){
    if(row.status === 'skipped' || (row.status === 'ready' && row.fileId)){
      if(!settled.has(row.sourceFileId)) settled.set(row.sourceFileId, new Set());
      settled.get(row.sourceFileId).add(row.label);
    }
  }

  return fileIds.filter(id => {
    const done = settled.get(id);
    return !done || labels.some(label => !done.has(label));
  });
};

/*
  Returns [error, { scanned, queued }]. `force` queues every eligible file rather than only the ones
  missing something — the "regenerate everything" button, for after a settings change that alters
  how existing thumbnails look rather than which ones exist.
*/
export const sweepLibrary = async ({ force = false } = {}) => {
  const config = await readConfig();
  if(!config.sizes.length) return [{ code: 400, msg: 'No thumbnail sizes are configured' }, null];

  const labels = config.sizes.map(size => size.label);

  let offset = 0;
  let scanned = 0;
  let queued = 0;

  for(;;){
    /*
      directoryId is left undefined on purpose — to listFiles that means "anywhere in the library"
      rather than the root folder, which is the whole point of a sweep.
    */
    const [error, data] = await listFiles({ limit: PAGE, offset });
    if(error) return [error, null];
    if(!data.files.length) break;

    scanned += data.files.length;

    const eligible = data.files.filter(file => isEligible(file, config));

    /*
      Files this extension generated are eligible-looking by definition (a webp is an image), so
      they are excluded by the same rows that record them as ours. Without this a sweep would
      thumbnail its own output.
    */
    const generated = eligible.length
      ? new Set((await db.select({ fileId: kempoThumbnail.fileId })
          .from(kempoThumbnail)
          .where(inArray(kempoThumbnail.fileId, eligible.map(file => file.id))))
          .map(row => row.fileId))
      : new Set();

    const candidates = eligible.filter(file => !generated.has(file.id)).map(file => file.id);
    const wanted = force ? candidates : await missingLabels(candidates, labels);

    queued += enqueueMany(wanted.map(fileId => ({ fileId, force })));

    offset += PAGE;
    if(offset >= data.total) break;
  }

  return [null, { scanned, queued }];
};
