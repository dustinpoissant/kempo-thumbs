import { execFile } from 'child_process';
import { chmodSync } from 'fs';
import { createRequire } from 'module';

/*
  Finding ffmpeg. ffmpeg-static and @ffprobe-installer/ffprobe are real dependencies — no mainstream
  OS ships either binary (not Linux, not macOS, not Windows — including the node:alpine base kempo's
  own Dockerfile uses), so this extension needs them regardless. Both packages read the actual
  platform they are being installed on at `npm install` time and fetch the matching binary — a
  Linux server gets a Linux binary — confirmed working on node:18-alpine specifically (musl libc, no
  libc6-compat needed) before being adopted here. There is deliberately no setting for this: the
  dependency *is* the ffmpeg this extension uses, not a suggestion a site might need to override.

  Two things can still legitimately move it: the environment, for a platform/architecture outside
  the bundled packages' support matrix, or a container image that stages a specific build at a fixed
  path; and the bare name on PATH, the last resort for whatever neither of those covers — including
  an install that ran with `--ignore-scripts` and skipped ffmpeg-static's own download.
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
    if(typeof path !== 'string' || !path) return null;

    /*
      Every non-Windows @ffprobe-installer platform package ships its binary without the executable
      bit set and relies on its own postinstall (`chmod u+x ffprobe`) to add it. Recent npm added a
      real allowScripts allowlist — package.json already carries one, for esbuild and puppeteer —
      and the moment that list exists at all, any lifecycle script for a package not named in it is
      silently skipped rather than run. Missing one entry here (found via a real CI failure: ffmpeg
      generated the thumbnail fine, ffprobe then failed with a plain 'Permission denied', and the
      row landed with no dimensions instead of erroring loudly) means a binary sitting right there
      on disk that nothing can execute. Redoing the chmod here removes the dependency on that list
      being kept in sync at all — a future @ffprobe-installer platform or version bump can't
      reintroduce this silently. A no-op on Windows, and harmless if the bit was already set.
    */
    try { chmodSync(path, 0o755); } catch { /* best effort — the exec below reports clearly if this mattered */ }

    return path;
  } catch {
    return null;
  }
};

export const resolveFfmpeg = () =>
  process.env.FFMPEG_PATH || bundled('ffmpeg-static') || 'ffmpeg';

export const resolveFfprobe = () =>
  process.env.FFPROBE_PATH || bundled('@ffprobe-installer/ffprobe') || 'ffprobe';

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
  Whether a binary is actually reachable and runs. Not part of the normal request path — the
  dependency is expected to just work — but worth having for the test suite to check before
  deciding whether to run its real-ffmpeg cases or skip them.
*/
export const checkBinary = async binary => {
  const [error, result] = await run(binary, ['-version'], { timeout: 10_000 });
  if(error) return { path: binary, available: false, error: error.msg };

  const version = (result.stdout.split('\n')[0] || '').trim();
  return { path: binary, available: true, version };
};
