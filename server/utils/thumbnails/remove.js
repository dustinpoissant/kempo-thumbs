import { and, eq, notInArray } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { deleteFile, getFile } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';

/*
  Deleting generated thumbnails, and the ordering that makes it safe to interrupt.

  Bytes first, row second — the same rule kempo-files uses for its own deletes, for the same
  reason. A row pointing at a file that is gone is a visible, fixable inconsistency the next
  regeneration repairs; a file on disk with no row is invisible, and nothing will ever come looking
  for it again.

  A file already missing is a success: the state being asked for is "not there".
*/

const deleteRowsAndFiles = async rows => {
  let removed = 0;

  for(const row of rows){
    if(row.fileId){
      const [error] = await deleteFile({ id: row.fileId });
      /*
        404 means someone deleted the thumbnail through the library, which is allowed — that is
        part of the point of storing them as ordinary files. Anything else is a real problem, and
        the row stays so the file is not orphaned by the cleanup meant to prevent orphans.
      */
      if(error && error.code !== 404) continue;
    }
    await db.delete(kempoThumbnail).where(eq(kempoThumbnail.id, row.id));
    removed++;
  }

  return removed;
};

/*
  Every thumbnail belonging to one source file. Used when the source is deleted, and when it stops
  being eligible.
*/
export const removeThumbnails = async ({ sourceFileId }) => {
  const rows = await db.select().from(kempoThumbnail)
    .where(eq(kempoThumbnail.sourceFileId, sourceFileId));
  return [null, { removed: await deleteRowsAndFiles(rows) }];
};

/*
  Thumbnails whose size label is no longer configured. `keep` is the current set of labels; an empty
  set would mean "remove everything", which is a different operation and refused here so a
  momentarily unreadable settings value cannot wipe a library's thumbnails.
*/
export const pruneLabels = async ({ sourceFileId, keep }) => {
  if(!Array.isArray(keep) || !keep.length) return [null, { removed: 0 }];

  const rows = await db.select().from(kempoThumbnail).where(and(
    eq(kempoThumbnail.sourceFileId, sourceFileId),
    notInArray(kempoThumbnail.label, keep),
  ));
  return [null, { removed: await deleteRowsAndFiles(rows) }];
};

/*
  Rows whose source file no longer exists.

  With the `file:deleted` hook registered this should never find anything — it is the repair for
  what happened before the hook existed, for a delete that failed halfway, and for anything that
  reached the database without going through kempo-files at all.
*/
export const removeOrphans = async () => {
  const rows = await db.select().from(kempoThumbnail);
  if(!rows.length) return [null, { removed: 0 }];

  /*
    One lookup per distinct source rather than a join: kempo-files owns its own tables and exposes
    them through its SDK, not as a schema other extensions import and query directly. This is a
    maintenance action run by hand, so the extra round trips are worth not reaching across that
    line — see kempo's own extension guidance on going through an extension's SDK.
  */
  const alive = new Map();
  for(const sourceFileId of new Set(rows.map(row => row.sourceFileId))){
    const [error] = await getFile(sourceFileId);
    alive.set(sourceFileId, !error);
  }

  const orphaned = rows.filter(row => !alive.get(row.sourceFileId));
  return [null, { removed: await deleteRowsAndFiles(orphaned) }];
};

/*
  Every thumbnail this extension ever generated, for uninstall.

  Deliberately driven off the rows rather than off what is sitting in the destination folders: the
  rows are the only record of which files in the library are ours. A folder-based sweep would
  delete anything that happened to be in a `thumbs/` folder, including files somebody put there
  themselves.

  The now-empty destination folders are left in place. kempo-files refuses to delete a folder that
  is not empty, and working out which of them this extension created — rather than which it merely
  used — is not something the schema records. An empty folder is a much smaller problem than a
  deleted one that was not ours.
*/
export const removeAll = async () => {
  const rows = await db.select().from(kempoThumbnail);
  return [null, { removed: await deleteRowsAndFiles(rows) }];
};
