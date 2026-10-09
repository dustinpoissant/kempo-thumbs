import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { run } from './binaries.js';
import { thumbnailArgs, probeArgs } from './args.js';

/*
  Runs one ffmpeg invocation and hands back the bytes it produced.

  ffmpeg writes to a temporary file rather than stdout on purpose. The image2 muxer wants a
  seekable output — libwebp in particular needs to go back and write its header — and a pipe is
  not one. Piping works often enough to look correct in testing and then fails on the format the
  site actually chose.

  The temp directory is per-invocation and removed in a finally, so a crashed encode leaves nothing
  behind and two files being processed at once cannot collide on a name.
*/

const EXTENSION = { webp: 'webp', jpg: 'jpg', png: 'png' };

export const renderThumbnail = async ({
  ffmpeg,
  ffprobe,
  kind,
  sourcePath,
  size,
  outputFormat,
  quality,
  videoFrameSeconds = 0,
}) => {
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'kempo-thumbs-'));
  } catch {
    return [{ code: 500, msg: 'Could not create a working directory' }, null];
  }

  const output = join(directory, `thumb.${EXTENSION[outputFormat] || 'webp'}`);

  try {
    /*
      Returns [error, data]. The "no output" case is deliberately folded in with the error cases:
      seeking past the end of a file is one of several things ffmpeg does by exiting 0 having
      written nothing at all, so a caller checking only the exit code would call that a success and
      then store a thumbnail that does not exist.

      An empty file is the same situation with a byte count of zero, and is treated the same way.
    */
    const attempt = async seek => {
      const [error] = await run(ffmpeg, thumbnailArgs({
        kind, source: sourcePath, output, size, outputFormat, quality, seek,
      }));
      if(error) return [error, null];

      let data;
      try {
        data = await readFile(output);
      } catch {
        return [{ code: 500, msg: 'ffmpeg reported success but produced no output' }, null];
      }
      if(!data.length) return [{ code: 500, msg: 'ffmpeg produced an empty file' }, null];

      return [null, data];
    };

    let [error, data] = await attempt(kind === 'video' ? videoFrameSeconds : 0);

    /*
      A video shorter than the seek position yields no frames — ffmpeg seeks past the end and exits
      successfully having written nothing. Retrying from the start is what makes a two-second clip
      work under a default that asks for one second in, without the site having to tune the setting
      per file. This has to trigger on "no output" and not only on a non-zero exit, which is exactly
      what a real short clip does.
    */
    if(error && kind === 'video' && videoFrameSeconds > 0){
      [error, data] = await attempt(0);
    }

    if(error) return [error, null];

    /*
      Dimensions come from the produced file, not from what was asked for. If ffprobe is missing
      the thumbnail is still perfectly good, so this degrades to nulls rather than failing the job.
    */
    const dimensions = await probeDimensions(ffprobe, output);

    return [null, { data, ...dimensions }];
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};

export const probeDimensions = async (ffprobe, path) => {
  const [error, result] = await run(ffprobe, probeArgs(path), { timeout: 15_000 });
  if(error) return { width: null, height: null };

  try {
    const stream = JSON.parse(result.stdout)?.streams?.[0];
    return {
      width: Number.isFinite(stream?.width) ? stream.width : null,
      height: Number.isFinite(stream?.height) ? stream.height : null,
    };
  } catch {
    return { width: null, height: null };
  }
};

/*
  True only when ffprobe ran and found the file has no picture stream. Audio with no cover art is the
  one failure that is not a failure, and the words ffmpeg uses for it differ by version and build (some
  say the output has no stream, others only "Invalid argument"), so asking the file is more reliable
  than matching the message. Any doubt, a missing ffprobe included, answers false.
*/
export const hasNoPictureStream = async (ffprobe, path) => {
  const [error, result] = await run(ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index', '-of', 'json', path], { timeout: 15_000 });
  if(error) return false;
  try {
    return JSON.parse(result.stdout).streams.length === 0;
  } catch {
    return false;
  }
};
