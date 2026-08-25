import { execFile } from 'child_process';
import { createRequire } from 'module';

/*
  Finding ffmpeg, and running it without letting it hang the server.

  Four places are checked in order, most explicit first: the setting, the environment, a bundled
  static binary if one happens to be installed, and finally the bare name on PATH. The setting wins
  because it is the only one a site admin can change without shell access — a shared host where
  ffmpeg lives somewhere unusual is exactly the case that would otherwise need a redeploy.

  ffmpeg-static / ffprobe-static are *optional*: they are not declared as dependencies, because
  they download a ~70MB binary in a postinstall script and most deployments already have ffmpeg.
  If a site installs one, it is found and used; if not, nothing here notices.
*/

const require = createRequire(import.meta.url);

const bundled = name => {
  try {
    const resolved = require(name);
    /*
      ffmpeg-static default-exports the path as a string; ffprobe-static exports { path }. Both
      shapes are handled rather than picked, since which one a site installed is not knowable here.
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
  configured || process.env.FFPROBE_PATH || bundled('ffprobe-static') || 'ffprobe';

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
