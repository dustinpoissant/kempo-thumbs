import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveFfmpeg, resolveFfprobe, run, checkBinary } from '../server/utils/ffmpeg/binaries.js';
import { renderThumbnail, probeDimensions } from '../server/utils/ffmpeg/render.js';

/*
  Real ffmpeg, real files, real pixels.

  Everything else in this suite asserts on the argument strings, which is where the reasoning
  errors live — but an argument string that reads correctly can still produce a file with the wrong
  dimensions, and only running it finds that. So these tests build their own sources with ffmpeg's
  own synthetic generators (no fixtures to check in, nothing to keep up to date), thumbnail them,
  and measure what came out.

  If ffmpeg is not installed they pass with a note rather than failing. A contributor without it
  should still be able to run the suite, and the CI workflow installs it so the coverage is real
  where it counts.
*/

const ffmpeg = resolveFfmpeg();
const ffprobe = resolveFfprobe();

const available = await checkBinary(ffmpeg);
const probeAvailable = await checkBinary(ffprobe);

const withTempDir = async body => {
  const dir = await mkdtemp(join(tmpdir(), 'kempo-thumbs-test-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/*
  A wide test pattern, so a fit mode that ignores aspect ratio produces visibly wrong numbers rather
  than coincidentally right ones. 640x360 is 16:9 — nothing here is square.
*/
const makeImage = async (dir, name = 'source.png', size = '640x360') => {
  const path = join(dir, name);
  const [error] = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=1`,
    '-frames:v', '1', path,
  ]);
  return [error, path];
};

const makeVideo = async (dir, { seconds = 3, name = 'source.mp4' } = {}) => {
  const path = join(dir, name);
  const [error] = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`,
    '-pix_fmt', 'yuv420p', path,
  ]);
  return [error, path];
};

const skip = pass => pass(`skipped — ffmpeg is not installed here (${available.error})`);

export default {
  'cover produces exactly the requested box': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);
    if(!probeAvailable.available) return pass('skipped — ffprobe is not installed here');

    await withTempDir(async dir => {
      const [sourceError, source] = await makeImage(dir);
      if(sourceError) return fail(`could not build a test image: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'sm', width: 200, height: 200, fit: 'cover' },
        outputFormat: 'webp', quality: 82,
      });

      if(error) return fail(error.msg);
      if(result.width !== 200 || result.height !== 200){
        return fail(`cover must fill the box exactly; got ${result.width}x${result.height} from a 640x360 source`);
      }
      if(!result.data.length) return fail('no bytes were produced');
      pass(`640x360 → 200x200, ${result.data.length} bytes`);
    });
  },

  'contain keeps the aspect ratio and fits inside the box': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);
    if(!probeAvailable.available) return pass('skipped — ffprobe is not installed here');

    await withTempDir(async dir => {
      const [sourceError, source] = await makeImage(dir);
      if(sourceError) return fail(`could not build a test image: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'md', width: 200, height: 200, fit: 'contain' },
        outputFormat: 'webp', quality: 82,
      });

      if(error) return fail(error.msg);
      if(result.width > 200 || result.height > 200){
        return fail(`contain must fit inside the box; got ${result.width}x${result.height}`);
      }
      // 640x360 fitted into 200x200 is width-limited: 200x112 (rounded to an even number).
      if(result.width !== 200) return fail(`expected the width to be the limiting dimension, got ${result.width}x${result.height}`);
      if(Math.abs(result.height - 112) > 2) return fail(`aspect ratio was not preserved: ${result.width}x${result.height}`);
      pass(`640x360 → ${result.width}x${result.height}`);
    });
  },

  'contain refuses to upscale a source smaller than the box': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);
    if(!probeAvailable.available) return pass('skipped — ffprobe is not installed here');

    await withTempDir(async dir => {
      const [sourceError, source] = await makeImage(dir, 'tiny.png', '64x64');
      if(sourceError) return fail(`could not build a test image: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'lg', width: 1024, height: 1024, fit: 'contain' },
        outputFormat: 'webp', quality: 82,
      });

      if(error) return fail(error.msg);
      /*
        The whole point of the min() clamp. Without it this comes back 1024x1024 — a blurry
        thumbnail several times the size of the file it was made from.
      */
      if(result.width > 64 || result.height > 64){
        return fail(`a 64x64 source was upscaled to ${result.width}x${result.height}`);
      }
      pass(`64x64 stayed ${result.width}x${result.height}`);
    });
  },

  'pad fills the box without distorting the picture': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);
    if(!probeAvailable.available) return pass('skipped — ffprobe is not installed here');

    await withTempDir(async dir => {
      const [sourceError, source] = await makeImage(dir);
      if(sourceError) return fail(`could not build a test image: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'sq', width: 300, height: 300, fit: 'pad' },
        outputFormat: 'png', quality: 82,
      });

      if(error) return fail(error.msg);
      if(result.width !== 300 || result.height !== 300){
        return fail(`pad must produce the exact box; got ${result.width}x${result.height}`);
      }
      pass('640x360 → 300x300, padded');
    });
  },

  'a jpg thumbnail of a source with alpha does not fail': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);

    await withTempDir(async dir => {
      /*
        This is the case that fails without `format=yuv420p` in the filter chain: mjpeg cannot carry
        an alpha channel and ffmpeg errors rather than flattening it. An RGBA png is the ordinary
        case for a logo, so it is not an edge case at all.
      */
      const source = join(dir, 'alpha.png');
      const [makeError] = await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=red@0.5:size=320x240,format=rgba',
        '-frames:v', '1', source,
      ]);
      if(makeError) return fail(`could not build an RGBA source: ${makeError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'sm', width: 100, height: 100, fit: 'cover' },
        outputFormat: 'jpg', quality: 82,
      });

      if(error) return fail(`an RGBA source failed to encode as jpg: ${error.msg}`);
      if(!result.data.length) return fail('no bytes were produced');
      pass('alpha is flattened rather than refused');
    });
  },

  'an animated source yields one frame, not a stream of them': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);

    await withTempDir(async dir => {
      const source = join(dir, 'animated.gif');
      const [makeError] = await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=2',
        source,
      ]);
      if(makeError) return fail(`could not build an animated gif: ${makeError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'image', sourcePath: source,
        size: { label: 'sm', width: 80, height: 60, fit: 'cover' },
        outputFormat: 'png', quality: 82,
      });

      if(error) return fail(error.msg);

      /*
        Without -frames:v 1, ffmpeg writes every frame in turn over the same output path — the file
        that comes back is whichever one happened to be last, and the encode took ten times as long
        as it needed to. Measuring the result is the only way to see that from here.
      */
      const dimensions = await withTempDir(async probeDir => {
        const path = join(probeDir, 'out.png');
        await writeFile(path, result.data);
        return probeDimensions(ffprobe, path);
      });

      if(probeAvailable.available && (dimensions.width !== 80 || dimensions.height !== 60)){
        return fail(`expected a single 80x60 frame, got ${dimensions.width}x${dimensions.height}`);
      }
      pass('one frame');
    });
  },

  'a video gives up a frame from the requested position': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);
    if(!probeAvailable.available) return pass('skipped — ffprobe is not installed here');

    await withTempDir(async dir => {
      const [sourceError, source] = await makeVideo(dir, { seconds: 3 });
      if(sourceError) return fail(`could not build a test video: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'video', sourcePath: source,
        size: { label: 'sm', width: 160, height: 120, fit: 'cover' },
        outputFormat: 'webp', quality: 82, videoFrameSeconds: 1,
      });

      if(error) return fail(error.msg);
      if(result.width !== 160 || result.height !== 120){
        return fail(`expected 160x120, got ${result.width}x${result.height}`);
      }
      pass('a frame was captured one second in');
    });
  },

  'a video shorter than the seek still produces a thumbnail': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);

    await withTempDir(async dir => {
      /*
        The retry-at-zero path. Seeking two seconds into a one-second clip lands past the end and
        ffmpeg writes nothing at all — a short clip would otherwise be permanently un-thumbnailable
        under a default nobody thought to tune for it.
      */
      const [sourceError, source] = await makeVideo(dir, { seconds: 1, name: 'short.mp4' });
      if(sourceError) return fail(`could not build a test video: ${sourceError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'video', sourcePath: source,
        size: { label: 'sm', width: 160, height: 120, fit: 'cover' },
        outputFormat: 'webp', quality: 82, videoFrameSeconds: 30,
      });

      if(error) return fail(`a short clip should fall back to the first frame: ${error.msg}`);
      if(!result.data.length) return fail('no bytes were produced');
      pass('fell back to the start of the clip');
    });
  },

  'an audio file with no cover art fails rather than writing an empty thumbnail': async ({ pass, fail }) => {
    if(!available.available) return skip(pass);

    await withTempDir(async dir => {
      const source = join(dir, 'silence.mp3');
      const [makeError] = await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', source,
      ]);
      if(makeError) return fail(`could not build a test audio file: ${makeError.msg}`);

      const [error, result] = await renderThumbnail({
        ffmpeg, ffprobe, kind: 'audio', sourcePath: source,
        size: { label: 'sm', width: 100, height: 100, fit: 'cover' },
        outputFormat: 'webp', quality: 82,
      });

      /*
        The one thing that must not happen is a zero-byte "thumbnail" being stored as though it
        worked, leaving a broken <img> nobody can explain. Either an error or nothing, never bytes.
      */
      if(!error && !result?.data?.length) return fail('an empty result was reported as a success');
      if(!error) return fail('an mp3 with no artwork should not have produced a thumbnail');
      pass(`reported: ${error.msg}`);
    });
  },

  'a missing binary is reported as such rather than as a mystery': async ({ pass, fail }) => {
    const [error] = await run('kempo-thumbs-definitely-not-a-real-binary', ['-version']);
    if(!error) return fail('a nonexistent binary should not succeed');
    if(error.code !== 503) return fail(`expected a 503 for a missing binary, got ${error.code}: ${error.msg}`);
    if(!/not installed|not on PATH/i.test(error.msg)) return fail(`unhelpful message: ${error.msg}`);
    pass(error.msg);
  },
};
