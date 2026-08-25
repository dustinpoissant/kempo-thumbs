export { getFile } from 'kempo-files/sdk';

/*
  Where a file is fetched from, server-side.

  kempo-files has this same rule in its *browser* SDK (`urlForFile`), which server code cannot
  import — that file is served to the browser, not exported from the package. Rather than reach
  into it, the rule is restated here, in one place, so every URL this extension hands out is built
  the same way.

  An aliased file gets its bare path; everything else its canonical id URL. Both run the identical
  permission gate on the way out, so the choice only affects how the link reads.
*/
export const urlForFileRow = file => (file?.alias ? `/${file.alias}` : `/kempo-files/api/files/${file.id}`);
