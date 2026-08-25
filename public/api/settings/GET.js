import { readConfig } from '../../../server/utils/config/settings.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  The settings as the generator actually sees them — validated, defaults filled in, bad entries
  already dropped.

  Deliberately not the raw stored rows. If the screen edited the raw values it would be possible to
  save a `sizes` array the generator then silently ignores, and the admin would have no way to tell
  that had happened. Round-tripping through the same normaliser the generator uses means what the
  screen shows is what will be used.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:settings');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const config = await readConfig();
  response.json({ settings: config });
};
