import { statusCounts } from '../../../server/utils/thumbnails/list.js';
import { queueStatus } from '../../../server/utils/thumbnails/queue.js';
import { readConfig } from '../../../server/utils/config/settings.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Everything the admin screen needs to say what this extension is doing right now: how many rows
  are in each state, and what the queue is up to.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:view');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const config = await readConfig();
  const [, counts] = await statusCounts();

  response.json({
    counts,
    queue: queueStatus(),
    /*
      Echoed back so the screen can say "no sizes are configured" rather than showing an empty
      table that looks like nothing has been uploaded yet.
    */
    sizes: config.sizes,
    autoGenerate: config.autoGenerate,
  });
};
