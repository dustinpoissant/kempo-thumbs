/*
  Turning a size and an output format into ffmpeg arguments.

  Kept as pure functions with no filesystem or process in sight, because this is the part that is
  easy to get subtly wrong and only notice much later, in the pixels — a `cover` that quietly
  letterboxes, a `contain` that upscales a 64px icon to 1024px and produces a blurry file bigger
  than its own source. Being pure is what lets the tests assert on the actual filter string.
*/

/*
  ffmpeg's own scale filter, per fit mode.

    cover   — fill the box exactly, cropping whatever overflows. Upscales when it has to, because
              there is no way to fill a box with something smaller.
    contain — fit inside the box, keeping the whole image. Clamped with min(iw,W)/min(ih,H) so a
              source smaller than the box is left at its own size: upscaling here would produce a
              blurry thumbnail larger than the original, which is the opposite of the point.
    pad     — contain, then pad out to the exact box. Same no-upscale clamp, so the padding grows
              instead of the picture.

  force_divisible_by=2 keeps the output dimensions even. It costs nothing for an image and avoids
  the odd-dimension errors some encoders raise on a frame pulled out of a video.
*/
export const scaleFilter = ({ width, height, fit }) => {
  if(fit === 'contain'){
    // One dimension may be 0, meaning "whatever preserves the aspect ratio".
    const w = width ? `min(iw,${width})` : -1;
    const h = height ? `min(ih,${height})` : -1;
    return `scale=w='${w}':h='${h}':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  }

  if(fit === 'pad'){
    return [
      `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    ].join(',');
  }

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`,
    `crop=${width}:${height}`,
  ].join(',');
};

/*
  jpg cannot carry an alpha channel, and ffmpeg fails outright rather than flattening one — so an
  RGBA png thumbnailed to jpg needs the conversion asked for explicitly. Everything else keeps its
  alpha, which is most of why webp is the default.
*/
export const formatFilter = outputFormat => (outputFormat === 'jpg' ? 'format=yuv420p' : null);

export const filterChain = (size, outputFormat) =>
  [scaleFilter(size), formatFilter(outputFormat)].filter(Boolean).join(',');

/*
  Encoder settings per output format.

  jpg's -q:v runs 2 (best) to 31 (worst), backwards from the 1-100 quality everyone else uses, so
  it is mapped rather than passed through. png ignores quality entirely — it is lossless, and
  pretending otherwise in the UI would be a lie about what the number does.
*/
export const encoderArgs = (outputFormat, quality) => {
  if(outputFormat === 'webp'){
    return ['-c:v', 'libwebp', '-lossless', '0', '-quality', String(quality), '-preset', 'picture'];
  }
  if(outputFormat === 'jpg'){
    const scaled = Math.round(31 - (Math.min(100, Math.max(1, quality)) / 100) * 29);
    return ['-c:v', 'mjpeg', '-q:v', String(scaled)];
  }
  return ['-c:v', 'png', '-compression_level', '8'];
};

/*
  The whole command line for one thumbnail.

  `kind` is kempo-files' own bucket for the source ('image', 'video', 'audio'), and it decides where
  the single frame comes from:

    video — seek to `seek` seconds *before* -i, which makes ffmpeg jump straight there using the
            container index instead of decoding everything up to that point. A file shorter than
            the seek produces nothing at all, which the caller retries at 0 rather than reporting.
    audio — the attached cover-art picture, if the file has one. -an drops the audio so the only
            stream left is the artwork; a file with no artwork fails here, and that is a 'skipped'
            rather than an error.
    image — the file itself. -frames:v 1 matters for an animated gif or webp, where without it
            ffmpeg would happily write every frame in turn over the same output path.

  -map_metadata -1 strips EXIF, including the GPS coordinates a phone photo carries. A thumbnail is
  a derived artifact that tends to end up somewhere more public than its original, and inheriting
  the original's location data is not a thing to do quietly.
*/
export const thumbnailArgs = ({ kind, source, output, size, outputFormat, quality, seek = 0 }) => {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

  if(kind === 'video' && seek > 0) args.push('-ss', String(seek));

  args.push('-i', source);

  if(kind === 'audio') args.push('-an');

  args.push(
    '-frames:v', '1',
    '-vf', filterChain(size, outputFormat),
    '-sws_flags', 'lanczos',
    '-map_metadata', '-1',
    ...encoderArgs(outputFormat, quality),
    '-f', 'image2',
    output,
  );

  return args;
};

/*
  What ffprobe is asked for after the fact: the dimensions of the file that was actually produced,
  since `contain` and the no-upscale clamp both mean the result is routinely smaller than the box
  that was requested.
*/
export const probeArgs = path => [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height',
  '-of', 'json',
  path,
];
