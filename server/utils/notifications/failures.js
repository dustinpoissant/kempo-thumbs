import { and, desc, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { createNotification, markAcknowledged } from 'kempo/server/sdk.js';
import { getFile } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';

/*
  Tells the people who can regenerate thumbnails when one failed, using kempo's notifications (a `notice`: it waits
  in the bell and the history until someone looks, and does not interrupt whatever they are doing).

  One notification covers every failure, not one per file. A broken ffmpeg or a bad batch fails hundreds
  of files at once, and a notification each would bury the person it was meant to help. It is refreshed
  (and re-opened if it had been viewed) each time another thumbnail fails, names the latest file and the
  reason, says how many other files are failing, and is acknowledged once nothing is failing any more. Its
  action re-queues every failed or missing thumbnail, through the same permission-checked route the admin
  screen uses.

  Only 'failed' counts. 'skipped' (an mp3 with no cover art) is nothing to act on and must never notify.
*/

const OWNER = 'kempo-thumbs';
const DEDUPE_KEY = 'failed-thumbnails';
const PERMISSION = 'thumbs:generate';
const RETRY_URL = '/kempo-thumbs/api/thumbnails';
const ADMIN_URL = '/admin/extension/kempo-thumbs/';

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* Whether this file has a failed row right now, read before a run so recovery can be recognised after it */
export const hasFailedRows = async ({ fileId }) => {
  const rows = await db.select({ id: kempoThumbnail.id }).from(kempoThumbnail).where(and(
    eq(kempoThumbnail.sourceFileId, fileId),
    eq(kempoThumbnail.status, 'failed'),
  )).limit(1);
  return rows.length > 0;
};

/*
  Call after a file has been processed. `results` is what generateForFile reported for it, `hadFailed`
  is what hasFailedRows said before the run, and `core` lets a test stand in for kempo's notification
  functions. Never throws: a notification problem must not turn into a thumbnail problem.
*/
export const syncFailureNotification = async ({ fileId, results = [], hadFailed = false, core = { createNotification, markAcknowledged } }) => {
  try {
    const failedNow = results.some(result => result.status === 'failed');
    if(!failedNow && !hadFailed) return;

    const failures = await db.select({ sourceFileId: kempoThumbnail.sourceFileId, label: kempoThumbnail.label, error: kempoThumbnail.error })
      .from(kempoThumbnail)
      .where(eq(kempoThumbnail.status, 'failed'))
      .orderBy(desc(kempoThumbnail.updatedAt));

    if(!failedNow){
      if(!failures.length) await core.markAcknowledged({ owner: OWNER, dedupeKey: DEDUPE_KEY });
      return;
    }

    const mine = failures.filter(row => row.sourceFileId === fileId);
    const others = new Set(failures.filter(row => row.sourceFileId !== fileId).map(row => row.sourceFileId)).size;
    const [, file] = await getFile(fileId);
    const name = clip(file?.name || fileId, 120);
    const reason = clip(mine[0]?.error || 'it could not be generated', 500);

    const [error] = await core.createNotification({
      owner: OWNER,
      type: 'notice',
      subtype: 'error',
      title: others ? `Thumbnails failed for ${others + 1} files` : `Thumbnail failed: ${name}`,
      message: `${name} (${mine.map(row => row.label).join(', ')}): ${reason}${others ? ` ${others} other ${others === 1 ? 'file is' : 'files are'} also failing.` : ''}`,
      permission: PERMISSION,
      dedupeKey: DEDUPE_KEY,
      actions: [
        { label: 'Try again', api: { method: 'POST', url: RETRY_URL, body: { sweep: true } } },
        { label: 'View status', href: ADMIN_URL },
      ],
    });
    if(error) console.error(`[kempo-thumbs] could not raise a failure notification: ${error.msg}`);
  } catch(error){
    console.error(`[kempo-thumbs] failure notification: ${error?.message || error}`);
  }
};
