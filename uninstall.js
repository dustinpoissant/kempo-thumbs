import { removeAll } from './server/utils/thumbnails/remove.js';

/*
  Generated thumbnails are derived files: everything here can be rebuilt from the sources, which are
  kempo-files' and stay untouched. So they go, rather than being left behind as a folder of orphans
  nobody can explain the origin of once the extension that made them is gone.

  This runs *before* kempo drops the table, which is the only order that works — the rows are what
  say which files in the library are ours to delete. Without them, nothing could tell a generated
  `hero-sm.webp` from one somebody uploaded by hand.
*/
export default async () => {
  const [error, result] = await removeAll();
  if(error){
    console.warn(`[kempo-thumbs] Could not remove every generated thumbnail: ${error.msg}`);
    return;
  }
  console.log(`[kempo-thumbs] Removed ${result.removed} generated thumbnail${result.removed === 1 ? '' : 's'}. Source files were not touched.`);
};
