/*
  Server-side entry point, for hooks and other extensions that want thumbnails in process rather
  than over HTTP. The browser-facing client is public/sdk.js, served at /kempo-thumbs/sdk.js.

  This is where the ecommerce extension — or anything else building a product listing — comes in:
  `thumbnailsForMany` takes a page of file ids and hands back every size for each, already carrying
  the URL, in one query rather than one per image.

  As in kempo-files, these are the *data* operations with no permission checks of their own. The
  routes enforce who may do what; anything calling in here is server-side code that has already
  decided it is allowed.
*/

export { thumbnailsFor, thumbnailsForMany, listThumbnails, statusCounts } from './server/utils/thumbnails/list.js';
export { generateForFile, isEligible } from './server/utils/thumbnails/generate.js';
export { removeThumbnails, pruneLabels, removeOrphans } from './server/utils/thumbnails/remove.js';
export { sweepLibrary } from './server/utils/thumbnails/sweep.js';
export { enqueue, enqueueMany, queueStatus } from './server/utils/thumbnails/queue.js';

export { readConfig, normaliseSizes, normaliseFormats, normaliseDestination, OUTPUT_FORMATS, FITS, DEFAULTS } from './server/utils/config/settings.js';
export { resolveFfmpeg, resolveFfprobe, checkBinary } from './server/utils/ffmpeg/binaries.js';
export { thumbName, stemOf, looksGenerated } from './server/utils/names/thumbName.js';
export { urlForFileRow } from './server/utils/files/urls.js';
