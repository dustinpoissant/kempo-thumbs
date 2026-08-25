import { createDirectory, listDirectories } from 'kempo-files/sdk';

/*
  Turning the `destination` setting into a real kempo-files folder.

  The setting is a path relative to the source file's own folder — `thumbs`, or `assets/thumbs`, or
  blank for "alongside the original". Walking it means finding or creating one folder per segment,
  which kempo-files has no single call for: `createDirectory` deliberately refuses a name that is
  already taken rather than reusing it, because for a person creating a folder that collision is a
  mistake worth being told about. Here it is the expected case on every upload after the first.

  Nothing is created until a thumbnail actually needs somewhere to go, so a site that turns
  generation off never grows empty `thumbs/` folders through its library.
*/

const findChild = async (parentId, name) => {
  const [error, data] = await listDirectories({ parentId });
  if(error) return [error, null];
  return [null, data.directories.find(directory => directory.name === name) || null];
};

const ensureChild = async (parentId, name, ownerId) => {
  const [findError, existing] = await findChild(parentId, name);
  if(findError) return [findError, null];
  if(existing) return [null, existing];

  const [createError, created] = await createDirectory({ name, parentId, ownerId });
  if(!createError) return [null, created];

  /*
    409 covers two different things, and both end up here: another upload created the folder
    between the lookup above and this call, or the folder exists on disk with no row behind it.
    Looking again distinguishes them — if a row is there now it was the race and the folder is
    usable; if not, the name is taken on disk by something the library does not know about, and
    writing into it is not this extension's decision to make.
  */
  if(createError.code === 409){
    const [, retried] = await findChild(parentId, name);
    if(retried) return [null, retried];
    return [{ code: 409, msg: `"${name}" exists on disk without a library record` }, null];
  }

  return [createError, null];
};

/*
  Returns [error, directoryId] — null being the library root, same as everywhere else in
  kempo-files. A blank destination resolves to the source file's own folder untouched.
*/
export const resolveDestination = async ({ destination, sourceDirectoryId, ownerId }) => {
  if(!destination) return [null, sourceDirectoryId ?? null];

  let parentId = sourceDirectoryId ?? null;

  for(const segment of destination.split('/')){
    const [error, directory] = await ensureChild(parentId, segment, ownerId);
    if(error) return [error, null];
    parentId = directory.id;
  }

  return [null, parentId];
};
