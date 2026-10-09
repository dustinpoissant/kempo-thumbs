import { and, desc, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getFile } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';

/*
  Tells the people who can regenerate thumbnails when one failed, using kempo's notifications.

  Notifications arrived in a later kempo than this extension supports as a minimum, so nothing here is
  imported at load: `loadCore` asks the installed kempo whether it has them and answers null when it does
  not, and every function below then does nothing. That is what keeps this extension working on an older
  kempo, and why `kempo/server/sdk.js` is imported dynamically and checked rather than named in an import.

  One notification covers every failure, not one per file. A broken ffmpeg or a bad batch fails hundreds
  of files at once, and a notification each would bury the person it was meant to help. It is refreshed
  (and re-opened if it had been read) each time another thumbnail fails, names the latest file and the
  reason, says how many other files are failing, and is closed once nothing is failing any more. Its
  action re-queues every failed or missing thumbnail, through the same permission-checked route the admin
  screen uses.

  Only 'failed' counts. 'skipped' (an mp3 with no cover art) is nothing to act on and must never notify.
*/

const OWNER = 'kempo-thumbs';
const DEDUPE_KEY = 'failed-thumbnails';
const PERMISSION = 'thumbs:generate';
const RETRY_URL = '/kempo-thumbs/api/thumbnails';
const ADMIN_URL = '/admin/extension/kempo-thumbs/';

let corePromise = null;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const loadCore = () => {
  corePromise ||= import('kempo/server/sdk.js')
    .then(sdk => (typeof sdk.createNotification === 'function' && typeof sdk.markHandled === 'function' ? sdk : null))
    .catch(() => null);
  return corePromise;
};

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
  is what hasFailedRows said before the run, and `core` is only for tests that stand in for an older
  kempo. Never throws: a notification problem must not turn into a thumbnail problem.
*/
export const syncFailureNotification = async ({ fileId, results = [], hadFailed = false, core }) => {
  try {
    const sdk = core === undefined ? await loadCore() : core;
    if(!sdk) return;

    const failedNow = results.some(result => result.status === 'failed');
    if(!failedNow && !hadFailed) return;

    const failures = await db.select({ sourceFileId: kempoThumbnail.sourceFileId, label: kempoThumbnail.label, error: kempoThumbnail.error })
      .from(kempoThumbnail)
      .where(eq(kempoThumbnail.status, 'failed'))
      .orderBy(desc(kempoThumbnail.updatedAt));

    if(!failedNow){
      if(!failures.length) await sdk.markHandled({ owner: OWNER, dedupeKey: DEDUPE_KEY });
      return;
    }

    const mine = failures.filter(row => row.sourceFileId === fileId);
    const others = new Set(failures.filter(row => row.sourceFileId !== fileId).map(row => row.sourceFileId)).size;
    const [, file] = await getFile(fileId);
    const name = clip(file?.name || fileId, 120);
    const reason = clip(mine[0]?.error || 'it could not be generated', 500);

    const [error] = await sdk.createNotification({
      owner: OWNER,
      title: others ? `Thumbnails failed for ${others + 1} files` : `Thumbnail failed: ${name}`,
      message: `${name} (${mine.map(row => row.label).join(', ')}): ${reason}${others ? ` ${others} other ${others === 1 ? 'file is' : 'files are'} also failing.` : ''}`,
      level: 'error',
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
