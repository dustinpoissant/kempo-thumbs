import { removeThumbnails, removeOrphans } from '../../../server/utils/thumbnails/remove.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Removes generated thumbnails — either one file's, or every row whose source no longer exists.

  Source files are never touched. Deleting a thumbnail is deleting a derived artifact, which is why
  it takes thumbs:generate (the permission to make them) rather than one of kempo-files' delete
  permissions: whoever may regenerate a thumbnail may equally throw it away, since the two amount
  to the same thing.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:generate');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const { fileId, orphans } = request.body || request.query || {};

  if(orphans === true || orphans === 'true'){
    const [error, result] = await removeOrphans();
    if(error) return response.status(error.code).json({ error: error.msg });
    return response.json(result);
  }

  if(!fileId) return response.status(400).json({ error: 'A file id is required, or orphans: true' });

  const [error, result] = await removeThumbnails({ sourceFileId: fileId });
  if(error) return response.status(error.code).json({ error: error.msg });
  response.json(result);
};
