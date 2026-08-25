/*
  Browser client, served at /kempo-thumbs/sdk.js.

  Mirrors the server SDK's names and returns the same [error, data] tuples the rest of kempo uses,
  so a call reads the same on either side.
*/

const BASE = '/kempo-thumbs/api';

const request = async (path, options = {}) => {
  try {
    const response = await fetch(`${BASE}${path}`, {
      credentials: 'same-origin',
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) return [{ code: response.status, msg: data.error || response.statusText }, null];
    return [null, data];
  } catch(error){
    return [{ code: 0, msg: error.message }, null];
  }
};

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const query = params => {
  const search = new URLSearchParams();
  for(const [key, value] of Object.entries(params)){
    if(value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

/*
  The thumbnails for one file, or for several at once. Ask for many rather than looping — a listing
  page of twenty products is one request either way, and one query on the server rather than twenty.
*/
export const thumbnailsFor = fileId => request(`/thumbnails${query({ fileId })}`);
export const thumbnailsForMany = fileIds => request(`/thumbnails${query({ fileIds: fileIds.join(',') })}`);

/*
  A page of rows for the admin table. `status` narrows to one of pending/ready/failed/skipped.
*/
export const listThumbnails = (params = {}) => request(`/thumbnails${query(params)}`);

/*
  Queue work. `fileId` regenerates one file; `sweep` walks the whole library for eligible files
  that are missing a size. Both return immediately — generation happens on the server's own queue,
  and the status endpoint is how progress is observed.
*/
export const regenerate = (fileId, { force = true } = {}) => request('/thumbnails', json('POST', { fileId, force }));
export const sweep = ({ force = false } = {}) => request('/thumbnails', json('POST', { sweep: true, force }));

export const removeThumbnails = fileId => request('/thumbnails', json('DELETE', { fileId }));
export const removeOrphans = () => request('/thumbnails', json('DELETE', { orphans: true }));

/*
  Queue depth, per-status counts, and whether ffmpeg is actually reachable — the last being the
  thing worth knowing before wondering why everything failed.
*/
export const getStatus = () => request('/status');

export const getSettings = () => request('/settings');
export const saveSettings = settings => request('/settings', json('PUT', settings));

/*
  Picks the smallest thumbnail that still covers `minWidth`, falling back to the largest available.

  Exists because the alternative — every caller writing its own "which one do I want" — is how a
  site ends up serving a 1024px thumbnail into a 64px avatar on one page and not another.
*/
export const pickThumbnail = (thumbnails, minWidth = 0) => {
  const ready = (thumbnails || [])
    .filter(thumbnail => thumbnail.status === 'ready' && thumbnail.url)
    .sort((a, b) => (a.width || 0) - (b.width || 0));

  if(!ready.length) return null;
  return ready.find(thumbnail => (thumbnail.width || 0) >= minWidth) || ready[ready.length - 1];
};

/*
  A ready-to-use srcset from a file's thumbnails, for a responsive <img>. Only rows that actually
  have a measured width can appear — a `w` descriptor guessed from the requested size rather than
  the produced one would have the browser choosing against numbers that are not true.
*/
export const srcsetFor = thumbnails => (thumbnails || [])
  .filter(thumbnail => thumbnail.status === 'ready' && thumbnail.url && thumbnail.width)
  .sort((a, b) => a.width - b.width)
  .map(thumbnail => `${thumbnail.url} ${thumbnail.width}w`)
  .join(', ');
