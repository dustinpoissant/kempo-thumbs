import { statusCounts } from '../../../server/utils/thumbnails/list.js';
import { queueStatus } from '../../../server/utils/thumbnails/queue.js';
import { readConfig } from '../../../server/utils/config/settings.js';
import { resolveFfmpeg, resolveFfprobe, checkBinary } from '../../../server/utils/ffmpeg/binaries.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Everything the admin screen needs to say whether this extension is working: how many rows are in
  each state, what the queue is doing right now, and — the one that actually explains a wall of
  failures — whether ffmpeg is reachable at all.

  The binary check runs a real `-version` rather than a `stat`, because "the file is there" and
  "it runs on this machine" are different claims and only the second one matters. It is a ~10ms
  process spawn on a screen that is polled every few seconds, which is cheap enough to be worth
  always being current about.
*/
export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:view');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const config = await readConfig();

  const [ffmpeg, ffprobe] = await Promise.all([
    checkBinary(resolveFfmpeg(config.ffmpegPath)),
    checkBinary(resolveFfprobe(config.ffprobePath)),
  ]);

  const [, counts] = await statusCounts();

  response.json({
    counts,
    queue: queueStatus(),
    ffmpeg,
    ffprobe,
    /*
      Echoed back so the screen can say "no sizes are configured" rather than showing an empty
      table that looks like nothing has been uploaded yet.
    */
    sizes: config.sizes,
    autoGenerate: config.autoGenerate,
  });
};
