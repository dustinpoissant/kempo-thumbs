import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getFile } from 'kempo-files/sdk';
import { currentUserHasPermission } from 'kempo/server/sdk.js';
import { kempoThumbnail } from '../server/db/schema.js';

/*
  A thumbnail is never more accessible than the file it was made from.

  Thumbnails inherit `public` at the moment they are generated, which handles the common case. What
  it does not handle is the source changing afterwards: make a product photo private a month later
  and its thumbnails — separate rows, with their own `public` flag — go on being served to anyone
  who has the URL. That is a picture of the private file, served publicly, and nobody who clicked
  "make private" would expect it.

  kempo-files fires `file:before_download` after its own gate has already passed, so a handler here
  can only ever *narrow* access, never widen it. That makes this the right place for the rule: the
  worst it can do is refuse a download, and refusing is the safe direction.

  This runs on every download on the site, so it is one indexed-column lookup and an early return
  for the overwhelming majority of files, which have no thumbnail row at all.
*/
export default async ({ file, request }) => {
  if(!file?.id) return;

  const [row] = await db.select({ sourceFileId: kempoThumbnail.sourceFileId })
    .from(kempoThumbnail)
    .where(eq(kempoThumbnail.fileId, file.id));

  // Not a generated thumbnail — the great majority of downloads end here.
  if(!row) return;

  const [lookupError, source] = await getFile(row.sourceFileId);
  if(lookupError){
    /*
      A thumbnail whose source is gone should have been deleted with it. Reaching this means the
      cleanup did not happen (an older install, an interrupted delete), and there is no longer
      anything to check the access rules against. Refusing is the conservative reading, and the
      admin's orphan cleanup is the fix.
    */
    throw { code: 404, msg: 'File not found' };
  }

  if(source.public) return;

  /*
    Same two checks kempo-files makes for a non-public file, applied to the source instead. Repeated
    rather than delegated because resolveDownload's gate is not exported on its own — and it takes
    the file being served, which is exactly the one thing that must not be consulted here.
  */
  const token = request?.cookies?.session_token;
  if(!token) throw { code: 401, msg: 'Authentication required' };

  const [permError, canDownload] = await currentUserHasPermission(token, 'files:download');
  if(permError) throw { code: permError.code, msg: permError.msg };
  if(!canDownload) throw { code: 403, msg: 'Insufficient permissions' };
};
