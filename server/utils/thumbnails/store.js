import { eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { storeUpload, listFiles, replaceFileContent, getFile } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';

/*
  Writing a generated thumbnail into the library, and the one rule that governs it:

  **this extension never overwrites a file it did not create.**

  A thumbnail's name is derived from its source (`hero-sm.webp`), so it can genuinely collide with
  something a person uploaded under that exact name. kempo-files refuses the collision with a 409
  — correctly, since silently replacing an upload is how a library loses content nobody knew was at
  risk. What is left to decide here is whether the thing in the way is one of ours, and the only
  acceptable evidence is a `kempoThumbnail` row already pointing at that file id. A matching name
  is not evidence.
*/

const findByName = async (directoryId, name) => {
  /*
    listFiles' search is a substring match, so the exact name is picked out afterwards. Passing
    directoryId explicitly matters: undefined means "anywhere in the library" to listFiles, which
    would find a same-named file in a completely different folder.
  */
  const [error, data] = await listFiles({ directoryId, search: name, limit: 100 });
  if(error) return [error, null];
  return [null, data.files.find(file => file.name === name) || null];
};

const isOurs = async fileId => {
  const rows = await db.select({ id: kempoThumbnail.id })
    .from(kempoThumbnail)
    .where(eq(kempoThumbnail.fileId, fileId));
  return rows.length > 0;
};

/*
  Returns [error, file]. `existingFileId` is the thumbnail we generated last time, if there is one —
  replacing it in place keeps its id, so anything that already references the thumbnail URL goes on
  working across a regeneration.
*/
export const writeThumbnail = async ({
  name,
  data,
  directoryId,
  ownerId,
  altText,
  public: isPublic,
  existingFileId,
}) => {
  if(existingFileId){
    const [, existing] = await getFile(existingFileId);
    /*
      Still there, and still where we expect it. A thumbnail someone moved or renamed through the
      library is left alone and a fresh one is written at the canonical name — the moved file is
      now theirs, not ours to clobber.
    */
    if(existing && existing.name === name && (existing.directoryId ?? null) === (directoryId ?? null)){
      const [error, file] = await replaceFileContent({ id: existingFileId, data, actorHasTrustedUpload: true });
      if(error) return [error, null];
      return [null, file];
    }
  }

  const [storeError, stored] = await storeUpload({
    name,
    data,
    directoryId,
    altText,
    ownerId,
    /*
      Generated thumbnails are webp/jpg/png — inert by kempo-files' own reckoning, served with their
      real content type whether trusted or not. Marking them trusted would claim a review that
      never happened, for no benefit.
    */
    trusted: false,
    public: isPublic,
  });
  if(!storeError) return [null, stored];
  if(storeError.code !== 409) return [storeError, null];

  const [findError, occupant] = await findByName(directoryId, name);
  if(findError) return [findError, null];
  if(!occupant){
    /*
      A 409 with nothing in the library under that name means the collision is on disk only — a
      leftover, or a file someone dropped in by hand. Not ours, and not something to write over.
    */
    return [{ code: 409, msg: `"${name}" exists on disk without a library record` }, null];
  }

  if(!await isOurs(occupant.id)){
    return [{ code: 409, msg: `"${name}" is already taken by a file this extension did not generate` }, null];
  }

  const [replaceError, file] = await replaceFileContent({ id: occupant.id, data, actorHasTrustedUpload: true });
  if(replaceError) return [replaceError, null];
  return [null, file];
};
