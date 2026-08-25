import { readConfig } from '../server/utils/config/settings.js';
import { enqueue } from '../server/utils/thumbnails/queue.js';

/*
  Fires after kempo-files has stored an upload, or replaced an existing file's contents.

  This handler does almost nothing on purpose. kempo awaits hook handlers one at a time, in
  registration order, so every millisecond spent here is a millisecond the upload response is held
  open — and thumbnailing a video is seconds. It reads the settings, decides whether there is work,
  and hands the file to the queue.

  `replaced` means the bytes behind an existing file changed. Its thumbnails now show something
  that is no longer there, so that case forces a regeneration rather than seeing 'ready' rows and
  leaving them.
*/
export default async ({ file, replaced = false }) => {
  if(!file?.id) return;

  const config = await readConfig();
  if(!config.autoGenerate) return;

  enqueue({ fileId: file.id, force: Boolean(replaced) });
};
