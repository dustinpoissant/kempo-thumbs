import { execFile } from 'child_process';
import { createRequire } from 'module';

/*
  Finding ffmpeg, and running it without letting it hang the server.

  Four places are checked in order, most explicit first: the setting, the environment, the bundled
  binary, and finally the bare name on PATH. The setting wins because it is the only one a site
  admin can change without shell access — a shared host where ffmpeg lives somewhere unusual is
  exactly the case that would otherwise need a redeploy.

  ffmpeg-static and @ffprobe-installer/ffprobe are real dependencies, not optional extras: no
  mainstream OS ships either binary (not Linux, not macOS, not Windows — including the node:alpine
  base kempo's own Dockerfile uses), so leaving this to "found if a site happens to have installed
  it" made the extension non-functional out of the box for essentially every real deployment. Both
  packages read the actual platform they are being installed on at `npm install` time — a Linux
  server gets a Linux binary, this is not a Windows-only shortcut — and both were confirmed working
  on node:18-alpine specifically (musl libc, no libc6-compat needed) before being adopted here.

  The bare-name-on-PATH fallback stays as the last resort for whatever the bundled packages cannot
  cover — a platform/architecture combination outside their support matrix, or a site that ran
  `npm install --ignore-scripts` and skipped ffmpeg-static's download.
*/

const require = createRequire(import.meta.url);

const bundled = name => {
  try {
    const resolved = require(name);
    /*
      ffmpeg-static default-exports the path as a string; @ffprobe-installer/ffprobe exports
      { path }. Both shapes are handled rather than picked, since either could in principle be
      swapped for a differently-shaped package via the same require.
    */
    const path = typeof resolved === 'string' ? resolved : resolved?.path || resolved?.default;
    return typeof path === 'string' && path ? path : null;
  } catch {
    return null;
  }
};

export const resolveFfmpeg = configured =>
  configured || process.env.FFMPEG_PATH || bundled('ffmpeg-static') || 'ffmpeg';

export const resolveFfprobe = configured =>
  configured || process.env.FFPROBE_PATH || bundled('@ffprobe-installer/ffprobe') || 'ffprobe';

/*
  A hard ceiling on how long any single ffmpeg invocation may take. A malformed or adversarial
  media file can put a decoder into a very long loop, and this queue runs inside the web server
  process — without a timeout, one bad upload occupies a worker slot forever and every later
  thumbnail queues behind it.
*/
export const DEFAULT_TIMEOUT_MS = 60_000;

/*
  Returns [error, { stdout, stderr }]. Never throws and never uses a shell: arguments go to the
  binary as an array, so a filename containing a quote or a semicolon is just a filename.
*/
export const run = (binary, args, { timeout = DEFAULT_TIMEOUT_MS, maxBuffer = 4 * 1024 * 1024 } = {}) =>
  new Promise(resolve => {
    execFile(binary, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if(error){
        if(error.code === 'ENOENT'){
          return resolve([{ code: 503, msg: `${binary} is not installed or not on PATH` }, null]);
        }
        if(error.killed || error.signal){
          return resolve([{ code: 504, msg: `${binary} timed out after ${Math.round(timeout / 1000)}s` }, null]);
        }
        /*
          ffmpeg's own diagnosis is far more useful than "exit code 1", and with -loglevel error it
          is a line or two rather than a wall of build flags. The last line is the actual failure;
          everything before it is context that rarely helps in an admin table.
        */
        const detail = String(stderr || '').trim().split('\n').filter(Boolean).pop();
        return resolve([{ code: 500, msg: detail || `${binary} exited with code ${error.code}` }, null]);
      }
      resolve([null, { stdout: String(stdout), stderr: String(stderr) }]);
    });
  });

/*
  Whether the binaries are actually there, for the admin screen to say so before someone uploads a
  hundred files and wonders why every one of them failed.
*/
export const checkBinary = async binary => {
  const [error, result] = await run(binary, ['-version'], { timeout: 10_000 });
  if(error) return { path: binary, available: false, error: error.msg };

  const version = (result.stdout.split('\n')[0] || '').trim();
  return { path: binary, available: true, version };
};
