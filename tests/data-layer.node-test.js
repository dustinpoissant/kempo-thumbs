import { readFile, rm, mkdir, writeFile, stat } from 'fs/promises';
import path from 'path';
import { sql, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import {
  storeUpload, getFile, listFiles, deleteFile,
  createDirectory, listDirectories, deleteDirectory,
  filePath, displayPath, FILES_ROOT,
} from 'kempo-files/sdk';
import { kempoThumbnail } from '../server/db/schema.js';
import { generateForFile } from '../server/utils/thumbnails/generate.js';
import { removeThumbnails, removeOrphans } from '../server/utils/thumbnails/remove.js';
import { thumbnailsFor } from '../server/utils/thumbnails/list.js';
import { resolveDestination } from '../server/utils/thumbnails/destination.js';
import { resolveFfmpeg, run, checkBinary } from '../server/utils/ffmpeg/binaries.js';
import { DEFAULTS } from '../server/utils/config/settings.js';

/*
  The whole generator, against a real database, a real kempo-files library and real ffmpeg.

  The unit suites cover the parts in isolation; what only shows up here is everything that involves
  two systems agreeing — a destination folder that has to be found rather than created the second
  time round, a thumbnail that must not overwrite a file somebody uploaded under the same name, a
  source deleted out from under its derivatives.

  Note that this reaches kempo-files only through its SDK, never its tables: only `kempoThumbnail`
  is queried directly, because it is the one table this extension owns. That is the same boundary
  the production code keeps, and testing across it would prove the wrong thing works.

  Requires a reachable Postgres carrying kempo's schema, kempo-files' and this extension's
  (`npx drizzle-kit push --force`). Skips itself when there is none rather than failing.
*/

const OWNER = 'test-owner-thumbs';
const PREFIX = 'zz-test-';

const databaseReachable = await db.execute(sql`select 1`).then(() => true).catch(() => false);
const ffmpeg = resolveFfmpeg('');
const ffmpegAvailable = (await checkBinary(ffmpeg)).available;

const skipped = reason => ({
  'data layer (SKIPPED)': async ({ pass }) => pass(`skipped: ${reason}`),
});

/*
  Settings built by hand rather than read from the database, so a test is not at the mercy of what
  the site's own settings happen to say, and each case can vary exactly one thing.
*/
const config = (over = {}) => ({
  ...DEFAULTS,
  autoGenerate: true,
  formats: DEFAULTS.formats,
  sizes: [{ label: 'sm', width: 100, height: 100, fit: 'cover' }],
  destination: 'thumbs',
  outputFormat: 'webp',
  quality: 82,
  videoFrameSeconds: 1,
  concurrency: 1,
  ffmpegPath: '',
  ffprobePath: '',
  ...over,
});

const purge = async () => {
  await db.delete(kempoThumbnail).catch(() => {});

  const [, files] = await listFiles({ limit: 500 });
  for(const file of files?.files || []) await deleteFile({ id: file.id }).catch(() => {});

  /*
    Deepest first: kempo-files refuses to delete a folder that still has anything in it, which is
    the correct behaviour and means the order here matters.
  */
  const [, directories] = await listDirectories({ all: true });
  const depth = new Map((directories?.directories || []).map(row => [row.id, row]));
  const depthOf = row => {
    let count = 0;
    let current = row;
    while(current?.parentId){ current = depth.get(current.parentId); count++; }
    return count;
  };
  for(const row of (directories?.directories || []).sort((a, b) => depthOf(b) - depthOf(a))){
    await deleteDirectory({ id: row.id }).catch(() => {});
  }

  await rm(FILES_ROOT(), { recursive: true, force: true }).catch(() => {});
  await mkdir(FILES_ROOT(), { recursive: true }).catch(() => {});
};

/*
  A real PNG, made by ffmpeg rather than checked in — nothing to keep up to date, and it is the same
  generator the render suite uses.
*/
const makePng = async (size = '640x360') => {
  const scratch = path.join(FILES_ROOT(), '.scratch.png');
  const [error] = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=1`,
    '-frames:v', '1', scratch,
  ]);
  if(error) throw new Error(`could not build a test image: ${error.msg}`);
  const data = await readFile(scratch);
  await rm(scratch, { force: true });
  return data;
};

const uploadImage = async (name, { directoryId = null, isPublic = false, size } = {}) => {
  const [error, file] = await storeUpload({
    name: `${PREFIX}${name}`,
    data: await makePng(size),
    directoryId,
    ownerId: OWNER,
    public: isPublic,
  });
  if(error) throw new Error(`storeUpload: ${error.msg}`);
  return file;
};

const thumbnailFileOf = async sourceId => {
  const [, listed] = await thumbnailsFor(sourceId);
  const thumbnail = listed.thumbnails[0];
  if(!thumbnail?.fileId) return [thumbnail || null, null];
  const [, file] = await getFile(thumbnail.fileId);
  return [thumbnail, file || null];
};

const tests = {
  'a thumbnail lands in the destination folder as a real library file': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('hero.png');

      const [error, summary] = await generateForFile({ fileId: source.id, config: config() });
      if(error) return fail(`generateForFile: ${error.msg}`);
      if(summary.results[0]?.status !== 'ready') return fail(`expected ready, got ${JSON.stringify(summary.results)}`);

      const [thumbnail, file] = await thumbnailFileOf(source.id);
      if(!file) return fail('the recorded file id does not exist in the library');

      const [, shown] = await displayPath(file);
      if(shown !== `thumbs/${PREFIX}hero-sm.webp`){
        return fail(`expected thumbs/${PREFIX}hero-sm.webp, got ${shown}`);
      }

      const [, absolute] = await filePath(file);
      const bytes = await stat(absolute);
      if(!bytes.size) return fail('the thumbnail on disk is empty');

      /*
        The dimensions are the point of the whole exercise. A row saying 'ready' next to a file that
        is not actually 100x100 is exactly the silent failure this suite exists to catch.
      */
      if(thumbnail.width !== 100 || thumbnail.height !== 100){
        return fail(`recorded ${thumbnail.width}x${thumbnail.height}, expected 100x100`);
      }

      pass(`${shown}, ${bytes.size} bytes, 100x100`);
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'the destination folder is reused, not recreated, for the second file': async ({ pass, fail }) => {
    try {
      await purge();
      /*
        kempo-files' createDirectory refuses a name that is already taken — correct for a person
        creating a folder, and the expected case for every upload after the first. If the reuse path
        is broken, this is where it shows up.
      */
      const first = await uploadImage('one.png');
      const second = await uploadImage('two.png');

      const [firstError] = await generateForFile({ fileId: first.id, config: config() });
      if(firstError) return fail(`first: ${firstError.msg}`);

      const [secondError] = await generateForFile({ fileId: second.id, config: config() });
      if(secondError) return fail(`second: ${secondError.msg}`);

      const [, directories] = await listDirectories({ all: true });
      const folders = directories.directories.filter(row => row.name === 'thumbs');
      if(folders.length !== 1) return fail(`expected one thumbs/ folder, found ${folders.length}`);

      const [thumbnail] = await thumbnailFileOf(second.id);
      if(thumbnail?.status !== 'ready') return fail('the second file did not get a thumbnail');
      pass('one folder, two thumbnails');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a nested destination creates the whole chain': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('deep.png');

      const [error] = await generateForFile({ fileId: source.id, config: config({ destination: 'derived/thumbs' }) });
      if(error) return fail(error.msg);

      const [, file] = await thumbnailFileOf(source.id);
      if(!file) return fail('nothing was generated');

      const [, shown] = await displayPath(file);
      if(shown !== `derived/thumbs/${PREFIX}deep-sm.webp`) return fail(`got ${shown}`);
      pass(shown);
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a blank destination writes alongside the original without recursing': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('flat.png');
      const settings = config({ destination: '' });

      const [error] = await generateForFile({ fileId: source.id, config: settings });
      if(error) return fail(error.msg);

      const [, file] = await thumbnailFileOf(source.id);
      if(!file) return fail('nothing was generated');

      /*
        The thumbnail is now an eligible-looking image sitting in the same folder as its source. If
        it were treated as a source in turn, a library would grow thumbnails of thumbnails forever.
      */
      const [secondError, summary] = await generateForFile({ fileId: file.id, config: settings });
      if(secondError) return fail(secondError.msg);
      if(summary.skipped !== 'is-a-thumbnail'){
        return fail(`a generated thumbnail was treated as a source: ${JSON.stringify(summary)}`);
      }
      pass('generated files are not sources');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'regenerating replaces the thumbnail in place, keeping its id': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('stable.png');

      const [, first] = await generateForFile({ fileId: source.id, config: config() });
      const firstId = first.results[0].fileId;

      const [error, second] = await generateForFile({ fileId: source.id, force: true, config: config() });
      if(error) return fail(error.msg);

      /*
        Keeping the id is what makes a regeneration safe for anything already referencing the
        thumbnail's URL — a product page, a cached page, an email that went out last week.
      */
      if(second.results[0].fileId !== firstId){
        return fail(`the thumbnail's id changed on regeneration: ${firstId} → ${second.results[0].fileId}`);
      }
      pass('the URL survives a regeneration');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'without force, an existing thumbnail is left alone': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('cheap.png');

      await generateForFile({ fileId: source.id, config: config() });
      const [error, second] = await generateForFile({ fileId: source.id, config: config() });
      if(error) return fail(error.msg);

      if(!second.results[0]?.reused){
        return fail('a second pass re-encoded a thumbnail that was already there');
      }
      pass('re-running is cheap');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a file this extension did not generate is never overwritten': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('claimed.png');

      /*
        The collision this extension can genuinely cause: a thumbnail's name is derived from its
        source, so somebody's own upload can already be sitting at it. Refusing is the only safe
        answer — an upload silently replaced by a generated file is content loss nobody would think
        to go looking for.
      */
      const [folderError, folder] = await createDirectory({ name: 'thumbs', ownerId: OWNER });
      if(folderError) return fail(`createDirectory: ${folderError.msg}`);

      const [occupantError, occupant] = await storeUpload({
        name: `${PREFIX}claimed-sm.webp`,
        data: Buffer.from('a file somebody uploaded themselves'),
        directoryId: folder.id,
        ownerId: OWNER,
      });
      if(occupantError) return fail(`storeUpload: ${occupantError.msg}`);

      const [error, summary] = await generateForFile({ fileId: source.id, config: config() });
      if(error) return fail(error.msg);
      if(summary.results[0]?.status !== 'failed'){
        return fail(`expected the collision to fail the size, got ${JSON.stringify(summary.results)}`);
      }

      const [, absolute] = await filePath(occupant);
      const contents = await readFile(absolute, 'utf8');
      if(contents !== 'a file somebody uploaded themselves'){
        return fail('an uploaded file was overwritten by a generated thumbnail');
      }
      pass('the collision was refused and reported');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a thumbnail inherits its source’s visibility': async ({ pass, fail }) => {
    try {
      await purge();
      const publicSource = await uploadImage('open.png', { isPublic: true });
      const privateSource = await uploadImage('closed.png', { isPublic: false });

      await generateForFile({ fileId: publicSource.id, config: config() });
      await generateForFile({ fileId: privateSource.id, config: config() });

      const visibilityOf = async source => {
        const [, file] = await thumbnailFileOf(source.id);
        return file?.public;
      };

      if(await visibilityOf(publicSource) !== true) return fail('a public file’s thumbnail was not public');
      if(await visibilityOf(privateSource) !== false) return fail('a private file’s thumbnail was public');
      pass('visibility is inherited');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'deleting the source removes its thumbnails, files and rows alike': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('doomed.png');

      const [, summary] = await generateForFile({ fileId: source.id, config: config() });
      const thumbnailId = summary.results[0].fileId;
      const [, thumbFile] = await getFile(thumbnailId);
      const [, absolute] = await filePath(thumbFile);

      /*
        Called directly rather than through the hook: the hook is one line that calls this, and
        wiring kempo's hook registry into a unit suite would test the registry, not the cleanup.
      */
      await removeThumbnails({ sourceFileId: source.id });

      const stillOnDisk = await stat(absolute).then(() => true).catch(() => false);
      if(stillOnDisk) return fail('the thumbnail is still on disk');

      const [lookupError] = await getFile(thumbnailId);
      if(!lookupError) return fail('the thumbnail still has a library row');

      const rows = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, source.id));
      if(rows.length) return fail('the thumbnail row survived');
      pass('nothing was left behind');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'orphan cleanup finds rows whose source is gone, and leaves the rest': async ({ pass, fail }) => {
    try {
      await purge();
      const orphaned = await uploadImage('vanishing.png');
      const kept = await uploadImage('staying.png');

      await generateForFile({ fileId: orphaned.id, config: config() });
      await generateForFile({ fileId: kept.id, config: config() });

      /*
        Deleting the source with no `file:deleted` handler registered — which is exactly the state
        an older install, or an interrupted delete, leaves behind, and the state this repair exists
        for.
      */
      await deleteFile({ id: orphaned.id });

      const [error, result] = await removeOrphans();
      if(error) return fail(error.msg);
      if(result.removed !== 1) return fail(`expected to remove 1 orphan, removed ${result.removed}`);

      const survivors = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, kept.id));
      if(survivors.length !== 1) return fail('the healthy thumbnail was removed too');
      pass('one orphan removed, the healthy one untouched');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a file whose extension is not enabled gets nothing': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('ignored.png');

      const [error, summary] = await generateForFile({
        fileId: source.id,
        config: config({ formats: ['jpg'] }),
      });
      if(error) return fail(error.msg);
      if(summary.skipped !== 'not-eligible') return fail(`expected not-eligible, got ${JSON.stringify(summary)}`);
      pass('the formats setting is respected');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'removing a size from the settings removes the thumbnails it made': async ({ pass, fail }) => {
    try {
      await purge();
      const source = await uploadImage('pruned.png');

      const two = config({ sizes: [
        { label: 'sm', width: 100, height: 100, fit: 'cover' },
        { label: 'md', width: 200, height: 200, fit: 'cover' },
      ] });

      await generateForFile({ fileId: source.id, config: two });
      const before = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, source.id));
      if(before.length !== 2) return fail(`expected 2 thumbnails, got ${before.length}`);

      const [error] = await generateForFile({ fileId: source.id, config: config() });
      if(error) return fail(error.msg);

      const after = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, source.id));
      if(after.length !== 1 || after[0].label !== 'sm'){
        return fail(`expected only sm to remain, got ${after.map(row => row.label).join(', ')}`);
      }

      /*
        The row going is not enough — the file it pointed at has to go too, or the library keeps
        accumulating thumbnails at sizes nobody configured and nothing will ever refresh.
      */
      const [, leftovers] = await listFiles({ search: `${PREFIX}pruned-md`, limit: 10 });
      if(leftovers.files.length) return fail('the removed size left its file behind');
      pass('the settings screen is the whole story');
    } catch(e){ fail(e.message); } finally { await purge(); }
  },

  'a destination that cannot be used is reported rather than written around': async ({ pass, fail }) => {
    try {
      await purge();
      /*
        A folder sitting on disk with no library row behind it. Writing into it would mean the
        database describing files whose location it does not actually know, so it is refused — and
        the refusal has to say why rather than surfacing as a generic failure.
      */
      await mkdir(path.join(FILES_ROOT(), 'thumbs'), { recursive: true });
      await writeFile(path.join(FILES_ROOT(), 'thumbs', 'placed-by-hand.txt'), 'x');

      const [error, directoryId] = await resolveDestination({
        destination: 'thumbs',
        sourceDirectoryId: null,
        ownerId: OWNER,
      });

      if(!error) return fail(`an untracked folder was adopted (directoryId ${directoryId})`);
      if(error.code !== 409) return fail(`expected 409, got ${error.code}: ${error.msg}`);
      if(!/without a library record/i.test(error.msg)) return fail(`unhelpful message: ${error.msg}`);
      pass(error.msg);
    } catch(e){ fail(e.message); } finally { await purge(); }
  },
};

export default databaseReachable
  ? (ffmpegAvailable ? tests : skipped('ffmpeg is not installed here'))
  : skipped('no reachable database');
