import { scaleFilter, encoderArgs, filterChain, thumbnailArgs } from '../server/utils/ffmpeg/args.js';

/*
  The filter string is where a thumbnail quietly comes out wrong rather than failing — a `cover`
  that letterboxes, a `contain` that upscales a 64px icon into a blurry 1024px file bigger than its
  own source. None of that throws, and none of it shows up anywhere except in the pixels, so it is
  asserted on directly here.

  These are the invariants, not the exact string: what matters is that cover crops, contain clamps,
  and jpg gets told to drop its alpha channel.
*/

const size = (over = {}) => ({ label: 'sm', width: 320, height: 240, fit: 'cover', ...over });

export default {
  'cover fills the box and crops the overflow': async ({ pass, fail }) => {
    const filter = scaleFilter(size({ fit: 'cover' }));
    if(!filter.includes('force_original_aspect_ratio=increase')){
      return fail(`cover must scale up to fill: ${filter}`);
    }
    if(!filter.includes('crop=320:240')){
      return fail(`cover must crop to the exact box: ${filter}`);
    }
    pass('cover scales to fill, then crops');
  },

  'contain never upscales': async ({ pass, fail }) => {
    /*
      The min(iw,W) clamp is the whole rule. Without it, thumbnailing a 64x64 favicon at 1024x1024
      produces a blurry 1024px file that is larger than the source it came from — technically a
      thumbnail, in no useful sense one.
    */
    const filter = scaleFilter(size({ fit: 'contain', width: 1024, height: 1024 }));
    if(!filter.includes('min(iw,1024)') || !filter.includes('min(ih,1024)')){
      return fail(`contain must clamp to the source's own size: ${filter}`);
    }
    if(!filter.includes('force_original_aspect_ratio=decrease')){
      return fail(`contain must fit inside the box: ${filter}`);
    }
    if(filter.includes('crop=')) return fail(`contain must never crop: ${filter}`);
    pass('contain fits inside and is clamped against upscaling');
  },

  'contain with one dimension leaves the other free': async ({ pass, fail }) => {
    const filter = scaleFilter(size({ fit: 'contain', width: 800, height: 0 }));
    if(!filter.includes('min(iw,800)')) return fail(`width should still be clamped: ${filter}`);
    if(!filter.includes("h='-1'")) return fail(`a height of 0 should become -1 (aspect-preserving): ${filter}`);
    pass('a missing dimension becomes -1');
  },

  'pad fits inside and then pads to the exact box': async ({ pass, fail }) => {
    const filter = scaleFilter(size({ fit: 'pad' }));
    if(!filter.includes('force_original_aspect_ratio=decrease')) return fail(`pad must fit inside first: ${filter}`);
    if(!filter.includes('pad=320:240')) return fail(`pad must pad out to the full box: ${filter}`);
    if(!filter.includes('min(iw,320)')) return fail(`pad must also refuse to upscale: ${filter}`);
    pass('pad fits, then pads');
  },

  'jpg is told to drop its alpha channel': async ({ pass, fail }) => {
    /*
      ffmpeg does not flatten alpha for mjpeg — it fails outright. Every RGBA png would error if
      this were missing, which is most of them.
    */
    const jpg = filterChain(size(), 'jpg');
    if(!jpg.includes('format=yuv420p')) return fail(`jpg needs an explicit pixel format: ${jpg}`);

    const webp = filterChain(size(), 'webp');
    if(webp.includes('format=yuv420p')) return fail(`webp keeps its alpha, so it must not be flattened: ${webp}`);
    pass('alpha is flattened for jpg only');
  },

  'jpg quality is inverted, not passed through': async ({ pass, fail }) => {
    /*
      -q:v runs 2 (best) to 31 (worst) — backwards from the 1-100 the settings screen shows. Passing
      it through unmapped would turn "quality 90" into the worst setting ffmpeg has.
    */
    const readQ = quality => {
      const args = encoderArgs('jpg', quality);
      return Number(args[args.indexOf('-q:v') + 1]);
    };

    const high = readQ(95);
    const low = readQ(10);
    if(!(high < low)) return fail(`higher quality must mean a lower -q:v (got ${high} for 95, ${low} for 10)`);
    if(high < 1 || low > 31) return fail(`-q:v out of ffmpeg's range: ${high}, ${low}`);
    pass(`quality 95 → -q:v ${high}, quality 10 → -q:v ${low}`);
  },

  'png ignores quality entirely': async ({ pass, fail }) => {
    const args = encoderArgs('png', 30);
    if(args.includes('-q:v') || args.includes('-quality')){
      return fail(`png is lossless, so a quality argument is meaningless: ${args.join(' ')}`);
    }
    pass('png takes a compression level, not a quality');
  },

  'a video seek goes before the input, not after': async ({ pass, fail }) => {
    /*
      -ss before -i is a container-index seek: ffmpeg jumps straight there. After -i it decodes
      everything up to that point first, which on a long video is the difference between
      milliseconds and minutes.
    */
    const args = thumbnailArgs({
      kind: 'video', source: 'in.mp4', output: 'out.webp',
      size: size(), outputFormat: 'webp', quality: 82, seek: 5,
    });

    const seekAt = args.indexOf('-ss');
    const inputAt = args.indexOf('-i');
    if(seekAt === -1) return fail('a seek was requested but no -ss was emitted');
    if(seekAt > inputAt) return fail('-ss must come before -i, or ffmpeg decodes the whole file first');
    pass('the seek is a fast one');
  },

  'a seek of zero emits no -ss at all': async ({ pass, fail }) => {
    const args = thumbnailArgs({
      kind: 'video', source: 'in.mp4', output: 'out.webp',
      size: size(), outputFormat: 'webp', quality: 82, seek: 0,
    });
    if(args.includes('-ss')) return fail('seeking to 0 is the same as not seeking');
    pass('no redundant seek');
  },

  'audio drops the audio stream so only the cover art is left': async ({ pass, fail }) => {
    const args = thumbnailArgs({
      kind: 'audio', source: 'in.mp3', output: 'out.webp',
      size: size(), outputFormat: 'webp', quality: 82,
    });
    if(!args.includes('-an')) return fail('without -an the audio stream is what gets encoded');
    pass('audio is dropped');
  },

  'every thumbnail is limited to one frame and stripped of metadata': async ({ pass, fail }) => {
    for(const kind of ['image', 'video', 'audio']){
      const args = thumbnailArgs({
        kind, source: `in.${kind}`, output: 'out.webp',
        size: size(), outputFormat: 'webp', quality: 82,
      });

      /*
        -frames:v 1 matters most for an animated gif, where without it ffmpeg writes every frame in
        turn over the same output path.
      */
      if(args.indexOf('-frames:v') === -1) return fail(`${kind}: must be limited to one frame`);

      /*
        A thumbnail is a derived file that tends to end up somewhere more public than its original.
        Inheriting the original's EXIF — including the GPS tag a phone photo carries — is not
        something to do quietly.
      */
      if(args.indexOf('-map_metadata') === -1) return fail(`${kind}: metadata must be stripped`);
    }
    pass('one frame, no metadata, for every source kind');
  },
};
