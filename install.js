/*
  Nothing to set up.

  Everything this extension needs is declarative — the table comes from kempo-config.json's
  `schema`, the settings and permissions from the same file, and the destination folders are
  created lazily the first time a thumbnail actually needs one, so a site that never generates any
  never grows empty `thumbs/` folders through its library.

  What is worth doing here is telling the person installing it whether ffmpeg is actually reachable,
  since every other symptom of it missing shows up much later as a row full of failures.
*/
import { readConfig } from './server/utils/config/settings.js';
import { resolveFfmpeg, resolveFfprobe, checkBinary } from './server/utils/ffmpeg/binaries.js';

export default async () => {
  const config = await readConfig().catch(() => ({ ffmpegPath: '', ffprobePath: '' }));

  const ffmpeg = await checkBinary(resolveFfmpeg(config.ffmpegPath));
  const ffprobe = await checkBinary(resolveFfprobe(config.ffprobePath));

  if(ffmpeg.available){
    console.log(`[kempo-thumbs] Using ${ffmpeg.version}`);
  } else {
    /*
      ffmpeg-static is a real dependency now, so reaching this means its own npm install step
      genuinely did not produce a usable binary — an unsupported platform/architecture, or
      `npm install --ignore-scripts`, or an ffmpeg_path setting pointing at the wrong place. Worth
      a loud warning specifically because it is no longer the expected case.
    */
    console.warn(`[kempo-thumbs] ffmpeg was not found (${ffmpeg.error}). It ships as a dependency of this extension, so this usually means either the platform is unsupported, install ran with --ignore-scripts, or the ffmpeg_path setting points somewhere wrong.`);
  }

  if(!ffprobe.available){
    console.warn('[kempo-thumbs] ffprobe was not found. Thumbnails will still be generated, but their dimensions will not be recorded.');
  }
};
