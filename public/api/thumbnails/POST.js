import { enqueue } from '../../../server/utils/thumbnails/queue.js';
import { sweepLibrary } from '../../../server/utils/thumbnails/sweep.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Queues work. Nothing is generated inline — the response says what was accepted, not what was
  produced, and /kempo-thumbs/api/status is where progress is watched.

  Answering 202 rather than 200 is the honest code for it: the request was accepted, the work has
  not happened yet.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:generate');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const { fileId, sweep = false, force = false } = request.body || {};

  if(sweep){
    const [error, result] = await sweepLibrary({ force: Boolean(force) });
    if(error) return response.status(error.code).json({ error: error.msg });
    return response.status(202).json(result);
  }

  if(!fileId) return response.status(400).json({ error: 'A file id is required, or sweep: true' });

  /*
    `false` means the file is already queued or being processed — not an error, and not something
    to retry. Saying so lets the admin show "already running" instead of a second confirmation.
  */
  const queued = enqueue({ fileId, force: Boolean(force) });
  response.status(202).json({ fileId, queued });
};
