import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getFile, filePath, kindForName, extensionOf } from 'kempo-files/sdk';
import { kempoThumbnail } from '../../db/schema.js';
import { readConfig } from '../config/settings.js';
import { resolveFfmpeg, resolveFfprobe } from '../ffmpeg/binaries.js';
import { renderThumbnail } from '../ffmpeg/render.js';
import { thumbName, looksGenerated } from '../names/thumbName.js';
import { writeThumbnail } from './store.js';
import { resolveDestination } from './destination.js';
import { removeThumbnails, pruneLabels } from './remove.js';

/*
  Everything that happens to one source file, start to finish.

  Each size is independent: one failing does not abort the others, and each records its own outcome
  so the admin can see that (say) the small one is fine and the large one ran out of memory. A job
  that gave up wholesale would make that indistinguishable from ffmpeg being missing.
*/

/*
  ffmpeg reports "there was nothing to work with" as a plain failure, indistinguishable at the exit
  code from a real error. For audio that is the overwhelmingly common case — most mp3s have no
  cover art — and reporting it as a failure would fill the admin with red rows describing files
  that are working exactly as expected. These are recorded as 'skipped': nothing to do, and
  retrying will not change that.
*/
const NOTHING_TO_ENCODE = [
  'does not contain any stream',
  'matches no streams',
  'output file is empty',
  /*
    ffmpeg's own way of saying it: exit 0, nothing written. Which of these two messages comes back
    depends on the version and the container, so both are listed rather than picking one.
  */
  'produced no output',
  'produced an empty file',
];

const classify = (message, kind) => {
  const text = String(message || '').toLowerCase();
  if(kind === 'audio' && NOTHING_TO_ENCODE.some(fragment => text.includes(fragment))) return 'skipped';
  return 'failed';
};

/*
  kempo-files buckets by extension; only three of its buckets are things a still image can be
  pulled out of. A .zip is not ineligible because of the `formats` setting — it is ineligible
  because there is no frame in it.
*/
const THUMBNAILABLE_KINDS = new Set(['image', 'video', 'audio']);

export const isEligible = (file, config) => {
  if(!file) return false;
  if(!THUMBNAILABLE_KINDS.has(kindForName(file.name))) return false;
  return config.formats.includes(extensionOf(file.name));
};

const upsertRow = async ({ sourceFileId, label, values }) => {
  const [existing] = await db.select().from(kempoThumbnail).where(and(
    eq(kempoThumbnail.sourceFileId, sourceFileId),
    eq(kempoThumbnail.label, label),
  ));

  if(existing){
    await db.update(kempoThumbnail)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(kempoThumbnail.id, existing.id));
    return { ...existing, ...values };
  }

  const now = new Date();
  const row = {
    id: crypto.randomBytes(8).toString('hex'),
    sourceFileId,
    label,
    fileId: null,
    width: null,
    height: null,
    status: 'pending',
    error: null,
    createdAt: now,
    updatedAt: now,
    ...values,
  };
  await db.insert(kempoThumbnail).values(row);
  return row;
};

/*
  A file this extension generated is not itself a source. Without this, a destination of "" (write
  alongside the original) would have every generated thumbnail immediately thumbnailed in turn.

  The database is the real answer — a row pointing at this file id. The name heuristic covers only
  the case the database cannot: someone uploading a file into the destination folder that happens
  to be named like one of ours.
*/
export const isGenerated = async (file, config) => {
  const rows = await db.select({ id: kempoThumbnail.id })
    .from(kempoThumbnail)
    .where(eq(kempoThumbnail.fileId, file.id));
  if(rows.length) return true;

  return looksGenerated(file.name, config.sizes.map(size => size.label), ['webp', 'jpg', 'png']);
};

/*
  Returns [error, summary]. `force` regenerates sizes that are already 'ready'; without it an
  existing thumbnail is left alone, which is what makes re-running this over a whole library cheap.
*/
export const generateForFile = async ({ fileId, force = false, config: given = null }) => {
  const config = given || await readConfig();

  const [lookupError, file] = await getFile(fileId);
  if(lookupError) return [lookupError, null];

  if(await isGenerated(file, config)){
    return [null, { fileId, skipped: 'is-a-thumbnail', results: [] }];
  }

  if(!isEligible(file, config)){
    /*
      A file that used to be eligible and no longer is (someone removed its extension from the
      settings) should stop having thumbnails, not keep stale ones nobody can explain.
    */
    await removeThumbnails({ sourceFileId: fileId });
    return [null, { fileId, skipped: 'not-eligible', results: [] }];
  }

  if(!config.sizes.length){
    return [null, { fileId, skipped: 'no-sizes-configured', results: [] }];
  }

  const [pathError, sourcePath] = await filePath(file);
  if(pathError) return [pathError, null];

  const [destinationError, directoryId] = await resolveDestination({
    destination: config.destination,
    sourceDirectoryId: file.directoryId,
    ownerId: file.ownerId,
  });
  if(destinationError) return [destinationError, null];

  const ffmpeg = resolveFfmpeg(config.ffmpegPath);
  const ffprobe = resolveFfprobe(config.ffprobePath);
  const kind = kindForName(file.name);

  const results = [];

  for(const size of config.sizes){
    const [existing] = await db.select().from(kempoThumbnail).where(and(
      eq(kempoThumbnail.sourceFileId, fileId),
      eq(kempoThumbnail.label, size.label),
    ));

    if(!force && existing?.status === 'ready' && existing.fileId){
      results.push({ label: size.label, status: 'ready', reused: true });
      continue;
    }

    await upsertRow({ sourceFileId: fileId, label: size.label, values: { status: 'pending', error: null } });

    const [renderError, rendered] = await renderThumbnail({
      ffmpeg,
      ffprobe,
      kind,
      sourcePath,
      size,
      outputFormat: config.outputFormat,
      quality: config.quality,
      videoFrameSeconds: config.videoFrameSeconds,
    });

    if(renderError){
      const status = classify(renderError.msg, kind);
      await upsertRow({
        sourceFileId: fileId,
        label: size.label,
        values: { status, error: renderError.msg, fileId: null, width: null, height: null },
      });
      results.push({ label: size.label, status, error: renderError.msg });
      continue;
    }

    const [writeError, written] = await writeThumbnail({
      name: thumbName(file.name, size.label, config.outputFormat),
      data: rendered.data,
      directoryId,
      ownerId: file.ownerId,
      altText: file.altText,
      /*
        A thumbnail is exactly as public as what it was made from. The file:before_download hook
        enforces this again at serve time, which is what covers the source's visibility changing
        after the fact — but inheriting it here means the common case needs no session at all,
        exactly like the original.
      */
      public: file.public,
      existingFileId: existing?.fileId || null,
    });

    if(writeError){
      await upsertRow({
        sourceFileId: fileId,
        label: size.label,
        values: { status: 'failed', error: writeError.msg, fileId: null },
      });
      results.push({ label: size.label, status: 'failed', error: writeError.msg });
      continue;
    }

    await upsertRow({
      sourceFileId: fileId,
      label: size.label,
      values: {
        status: 'ready',
        error: null,
        fileId: written.id,
        width: rendered.width,
        height: rendered.height,
      },
    });
    results.push({ label: size.label, status: 'ready', fileId: written.id });
  }

  /*
    Sizes removed from the settings leave behind thumbnails nothing will ever refresh. Dropping
    them here means the settings screen is the whole story: what is configured is what exists.
  */
  await pruneLabels({ sourceFileId: fileId, keep: config.sizes.map(size => size.label) });

  return [null, { fileId, results }];
};
