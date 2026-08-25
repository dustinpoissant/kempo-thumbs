import { removeThumbnails } from '../server/utils/thumbnails/remove.js';

/*
  Fires after kempo-files has removed a file. If it had thumbnails, they are now pictures of
  something that does not exist — so they go too, files and rows alike.

  Awaited rather than queued: this is a handful of unlinks, and a delete that returns before its
  derivatives are gone is a delete that leaves the library in a state the user did not ask for.
*/
export default async ({ file }) => {
  if(!file?.id) return;
  await removeThumbnails({ sourceFileId: file.id });
};
