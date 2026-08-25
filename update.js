import install from './install.js';

/*
  Updating is the same job as installing: confirm ffmpeg is still reachable and say so. New
  settings and permissions are added by kempo's own declarative diff before this runs, and existing
  values are never overwritten — so a site that changed its sizes keeps them.
*/
export default async () => {
  await install();
};
