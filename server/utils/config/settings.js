import { getSetting } from 'kempo/server/sdk.js';

/*
  Reading the settings is separate from validating them, and both live here.

  Everything on this screen is editable from the admin, including two settings that are free-form
  JSON. A malformed `sizes` array must not be able to take the upload path down with it, so every
  value that reaches the generator has been through `normalise*` below and is known-good by the
  time anything acts on it. Bad entries are dropped rather than throwing — a site with one broken
  size should still get its other sizes.
*/

export const OWNER = 'kempo-thumbs';

export const OUTPUT_FORMATS = ['webp', 'jpg', 'png'];
export const FITS = ['cover', 'contain', 'pad'];

export const DEFAULTS = {
  auto_generate: true,
  formats: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff',
    'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi',
    'mp3', 'm4a', 'flac', 'ogg', 'opus',
  ],
  sizes: [
    { label: 'sm', width: 320, height: 320, fit: 'cover' },
    { label: 'md', width: 1024, height: 1024, fit: 'contain' },
  ],
  destination: 'thumbs',
  output_format: 'webp',
  quality: 82,
  video_frame_seconds: 1,
  concurrency: 2,
};

/*
  A label becomes part of a real filename (`hero-sm.webp`), so it is restricted to what is safe in
  one everywhere, and to what cannot be confused for the extension separator.
*/
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/i;

const clampNumber = (value, { min, max, fallback }) => {
  const number = Number(value);
  if(!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

export const normaliseFormats = value => {
  if(!Array.isArray(value)) return [];
  const seen = new Set();
  for(const entry of value){
    if(typeof entry !== 'string') continue;
    /*
      Stored bare, so a settings page that lets someone type ".JPG" or "jpg" both land on the same
      thing the extension check compares against.
    */
    const extension = entry.trim().replace(/^\./, '').toLowerCase();
    if(/^[a-z0-9]{1,12}$/.test(extension)) seen.add(extension);
  }
  return [...seen];
};

/*
  A size with no usable dimension is dropped, not defaulted: guessing 320 for someone who meant
  something else produces files they never asked for and will not think to look for.

  A height of 0 means "whatever preserves the aspect ratio", which is the common case for a fixed
  width. Width 0 does the same in the other direction.
*/
export const normaliseSizes = value => {
  if(!Array.isArray(value)) return [];

  const sizes = [];
  const labels = new Set();

  for(const entry of value){
    if(!entry || typeof entry !== 'object') continue;

    const label = String(entry.label ?? '').trim();
    if(!LABEL_PATTERN.test(label)) continue;
    // Labels name the file, so two of them colliding would mean two sizes writing the same path.
    if(labels.has(label.toLowerCase())) continue;

    const width = clampNumber(entry.width, { min: 0, max: 8192, fallback: 0 });
    const height = clampNumber(entry.height, { min: 0, max: 8192, fallback: 0 });
    if(!width && !height) continue;

    const fit = FITS.includes(entry.fit) ? entry.fit : 'cover';
    /*
      cover and pad both have to produce exactly the requested box, so neither can work from one
      dimension alone.
    */
    if(fit !== 'contain' && (!width || !height)) continue;

    labels.add(label.toLowerCase());
    sizes.push({ label, width, height, fit });
  }

  return sizes;
};

/*
  The destination is a path relative to the source file's own folder, so it is a sequence of plain
  folder names and nothing else. `..` is refused rather than resolved — a destination that can
  climb is a destination that can escape the library, and there is no version of that anyone wants.
*/
export const normaliseDestination = value => {
  if(typeof value !== 'string') return '';

  // Both separators: a destination typed on Windows arrives with backslashes.
  const segments = value.split(/[\\/]+/).map(segment => segment.trim()).filter(Boolean);
  if(!segments.length) return '';
  if(segments.length > 4) return '';
  if(segments.some(segment => segment === '.' || segment === '..')) return '';

  return segments.join('/');
};

/*
  Reads everything at once. The generator holds the result for the length of one file's job, so a
  settings change mid-run cannot produce a half-old, half-new set of thumbnails.
*/
export const readConfig = async () => {
  const read = async (name, fallback) => {
    const [error, value] = await getSetting(OWNER, name, fallback);
    return error ? fallback : value;
  };

  const [
    autoGenerate, formats, sizes, destination,
    outputFormat, quality, videoFrameSeconds, concurrency,
  ] = await Promise.all([
    read('auto_generate', DEFAULTS.auto_generate),
    read('formats', DEFAULTS.formats),
    read('sizes', DEFAULTS.sizes),
    read('destination', DEFAULTS.destination),
    read('output_format', DEFAULTS.output_format),
    read('quality', DEFAULTS.quality),
    read('video_frame_seconds', DEFAULTS.video_frame_seconds),
    read('concurrency', DEFAULTS.concurrency),
  ]);

  return {
    autoGenerate: autoGenerate === true || autoGenerate === 'true',
    formats: normaliseFormats(formats),
    sizes: normaliseSizes(sizes),
    destination: normaliseDestination(destination),
    outputFormat: OUTPUT_FORMATS.includes(outputFormat) ? outputFormat : DEFAULTS.output_format,
    quality: clampNumber(quality, { min: 1, max: 100, fallback: DEFAULTS.quality }),
    videoFrameSeconds: Math.max(0, Number(videoFrameSeconds) || 0),
    concurrency: clampNumber(concurrency, { min: 1, max: 8, fallback: DEFAULTS.concurrency }),
  };
};
