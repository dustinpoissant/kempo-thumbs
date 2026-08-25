import { thumbnailsFor, thumbnailsForMany, listThumbnails } from '../../../server/utils/thumbnails/list.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Three questions, one route, decided by which parameter arrived:

    ?fileId=…   the thumbnails for one source file
    ?fileIds=…  the same for several at once, keyed by source — what a listing page asks
    (neither)   a page of rows for the admin table, newest first, optionally filtered by status

  Gated on thumbs:view rather than being open, for the same reason kempo-files gates its own
  listing: an individual thumbnail may well be public, but the listing is what exposes the shape of
  the whole library at once.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:view');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const { fileId, fileIds, status, limit, offset } = request.query;

  if(fileId){
    const [error, data] = await thumbnailsFor(fileId);
    if(error) return response.status(error.code).json({ error: error.msg });
    return response.json(data);
  }

  if(fileIds){
    /*
      Capped rather than unbounded: this is a convenience for a page of results, and an uncapped
      id list is an invitation to ask for the entire library in one query.
    */
    const ids = String(fileIds).split(',').map(id => id.trim()).filter(Boolean).slice(0, 200);
    const [error, data] = await thumbnailsForMany(ids);
    if(error) return response.status(error.code).json({ error: error.msg });
    return response.json(data);
  }

  const [error, data] = await listThumbnails({
    status: ['pending', 'ready', 'failed', 'skipped'].includes(status) ? status : undefined,
    limit: parseInt(limit, 10) || 50,
    offset: parseInt(offset, 10) || 0,
  });
  if(error) return response.status(error.code).json({ error: error.msg });
  response.json(data);
};
