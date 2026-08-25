# kempo-thumbs

Automatic thumbnails for [kempo-files](https://github.com/dustinpoissant/kempo-files). Upload an
image, a video or an audio file and the sizes you configured appear in the library a moment later,
as ordinary files, at ordinary URLs.

One tool does all three kinds: **ffmpeg**. An image is decoded, a video gives up a single frame, and
an audio file contributes its embedded cover art.

---

## Why the thumbnails are just files

Every generated thumbnail is a real `kempo-files` entry — a real name, in a real folder, with a row
in the library. Nothing here has its own storage, its own serving route or its own idea of who is
allowed to see what.

That one decision is what the rest of this rests on:

- **Permissions already work.** A thumbnail goes out through kempo-files' own gate, with its own
  `public` flag and the same `file:before_download` veto every other file gets.
- **They are visible.** They show up in the library, in the picker, in search. You can look at one,
  delete one, move one — and none of that corrupts anything, because the row pointing at it is
  allowed to be wrong.
- **URLs are ordinary.** `/kempo-files/api/files/<id>`, or a bare alias path if you give it one.
  Nothing has to know a thumbnail is a thumbnail to link to it.

The alternative — a private cache directory with a bespoke serving route — would have meant
reimplementing access control for derived files, and getting it subtly different.

---

## A thumbnail is never more visible than its source

A thumbnail inherits its source's `public` flag when it is generated. That covers the ordinary case,
but not the one that matters: make a product photo private six months later and its thumbnails are
separate rows, with their own flags, still being served to anyone holding the URL.

So there is a second rule, enforced at download time. kempo-files fires `file:before_download` *after*
its own gate has passed, which means a handler there can only ever narrow access — and this extension
registers one that re-runs the library's rule against the **source** file. A thumbnail of a private
file needs `files:download`, whatever its own flag says.

It costs one indexed lookup per download, and it means visibility can never drift into a leak.

---

## Install

```bash
npm install kempo-thumbs
```

Then enable it from the admin's Extensions screen. `kempo-files` has to be installed and enabled
first — it is declared as a dependency, so kempo refuses the install until it is, and refuses to
disable or uninstall kempo-files while this is still enabled.

Needs `kempo >= 4.2.37`, `kempo-files >= 0.1.3` and `kempo-server >= 3.3.0`. Below the first of
those, the `sizes` and `formats` settings are stored double-encoded and the generator sees nothing
configured.

### ffmpeg

ffmpeg and ffprobe have to be reachable from the server process. They are looked for in this order:

1. The `ffmpeg_path` / `ffprobe_path` settings, if set
2. The `FFMPEG_PATH` / `FFPROBE_PATH` environment variables
3. `ffmpeg-static` / `ffprobe-static`, if the site happens to have installed them
4. `ffmpeg` / `ffprobe` on `PATH`

Neither static package is a dependency of this one — they download a ~70MB binary in a postinstall
script, and most deployments already have ffmpeg. If a site installs one, it is found and used.

```bash
# Debian/Ubuntu
apt-get install -y ffmpeg

# Alpine (kempo's own Dockerfile is node:18-alpine)
apk add --no-cache ffmpeg

# macOS
brew install ffmpeg
```

**ffprobe is optional.** Without it thumbnails are still generated, but their dimensions are not
recorded — which means no `srcset`. The admin screen says so plainly rather than leaving you to
work it out.

---

## Settings

All of it is on one screen: **Admin → Thumbnails**. They are ordinary kempo settings, so they also
appear under `/admin/settings` grouped by owner — the dedicated screen exists because a nested JSON
array of sizes in a one-line text field is not something anyone should have to edit.

| Setting | Default | What it does |
|---|---|---|
| `auto_generate` | `true` | Generate on upload. With this off, thumbnails are only made when asked for. |
| `formats` | images, video, common audio | Which file extensions are eligible. |
| `sizes` | `sm` 320² cover, `md` 1024² contain | One file is generated per size, per source. |
| `destination` | `thumbs` | A folder relative to the source file's own folder. Blank writes alongside the original. |
| `output_format` | `webp` | `webp`, `jpg` or `png`. |
| `quality` | `82` | 1–100. Ignored for png, which is lossless. |
| `video_frame_seconds` | `1` | How far into a video the captured frame comes from. |
| `concurrency` | `2` | How many files may be processed at once. |
| `ffmpeg_path` / `ffprobe_path` | blank | Blank auto-detects, as above. |

### Sizes

Each size has a **label**, a width, a height and a **fit**. The label becomes part of the filename:
`hero.jpg` at size `sm` in webp is `hero-sm.webp`.

| Fit | Result |
|---|---|
| `cover` | Fills the box exactly, cropping the overflow. Upscales when it has to. |
| `contain` | Fits the whole image inside the box. **Never upscales** — a 64px icon stays 64px. |
| `pad` | Fits inside, then pads out to the exact box. Also never upscales. |

`contain` accepts a single dimension — set the height to 0 for "800 wide, whatever height that works
out to". `cover` and `pad` need both, since they produce an exact box.

### Destination

Relative to the folder the source file is in, so it follows the library's own structure rather than
collecting everything in one place:

```
products/hero.jpg  →  products/thumbs/hero-sm.webp
gallery/2024/x.png →  gallery/2024/thumbs/x-sm.webp
```

Nested paths (`derived/thumbs`) work; `..` is refused rather than resolved. Folders are created the
first time a thumbnail actually needs one, so turning generation off does not scatter empty `thumbs/`
folders through the library.

Leaving it **blank** writes thumbnails alongside their originals. That is supported — generated files
are recorded as such, so they are never treated as sources and thumbnailed in turn.

---

## Using them

Server-side, for another extension (this is what an ecommerce product listing wants):

```javascript
import { thumbnailsFor, thumbnailsForMany } from 'kempo-thumbs/sdk';

const [, { thumbnails }] = await thumbnailsFor(file.id);
// [{ label: 'sm', status: 'ready', url: '/kempo-files/api/files/ab12', width: 320, height: 320, … }]

// A page of products, in one query rather than one per image
const [, { bySource }] = await thumbnailsForMany(files.map(file => file.id));
```

In the browser:

```javascript
import { thumbnailsFor, pickThumbnail, srcsetFor } from '/kempo-thumbs/sdk.js';

const [, { thumbnails }] = await thumbnailsFor(fileId);

const small = pickThumbnail(thumbnails, 200);   // smallest that still covers 200px
const srcset = srcsetFor(thumbnails);           // "…/ab12 320w, …/cd34 1024w"
```

`srcsetFor` only includes sizes whose dimensions were actually measured — a `w` descriptor guessed
from the requested size rather than the produced one would have the browser choosing against numbers
that are not true.

---

## Statuses

| Status | Means |
|---|---|
| `ready` | `fileId` points at a generated thumbnail. |
| `pending` | Queued or running. Also what a server restart leaves behind, since the queue is in-process. |
| `failed` | Something went wrong; `error` says what. Worth retrying. |
| `skipped` | There was nothing to generate, and retrying will not change that — an mp3 with no cover art. |

The distinction between `failed` and `skipped` is the difference between a screen full of red rows
demanding attention and one correctly saying most music files do not have artwork.

---

## The queue

Generation happens on a bounded in-process queue. The `file:uploaded` hook enqueues and returns —
kempo awaits hook handlers one at a time, so anything done inline is time the person uploading spends
watching a progress bar, and encoding a video is seconds.

This is deliberately not a job runner. A site generating thumbnails at volume wants a real one, and
this will not pretend to be it. What it is instead is honest about its limits:

- `concurrency` caps how many files are processed at once, so a bulk upload cannot spawn one ffmpeg
  per file and take the machine down.
- Every ffmpeg invocation has a 60-second timeout, so a malformed file cannot hold a worker slot
  forever.
- **A restart loses whatever was queued.** Those rows stay `pending`, which is how the admin screen
  finds them — and a `pending` row counts as missing to *Generate missing*, which is what picks them
  back up.

---

## Bulk actions

On the admin screen, for anyone holding `thumbs:generate`:

- **Generate missing** — walks the library for eligible files that are missing a configured size.
  This is how you catch up after installing, after turning generation back on, or after adding a
  size. It converges: `skipped` files are not re-queued.
- **Regenerate everything** — re-encodes every eligible file. For after a change that alters how
  existing thumbnails *look* rather than which ones exist (a different format, quality or fit).
- **Clean up orphans** — removes rows whose source file no longer exists. With the `file:deleted`
  hook registered this should never find anything; it repairs what happened before it existed.

---

## Permissions

| Permission | Allows |
|---|---|
| `thumbs:view` | See thumbnail status, and why anything failed. |
| `thumbs:generate` | Generate, regenerate and delete generated thumbnails. |
| `thumbs:settings` | Change the settings above. |

There is one group, `kempo-thumbs:operator` — view and generate, but not settings. Someone who runs
the media side of a site can be given `thumbs:settings` without `system:settings:update`, which would
be every setting on the whole installation.

There is no own/others split, because a thumbnail has no author of its own: it belongs to whatever it
was made from, and kempo-files already decides who may touch that.

---

## Hooks it listens to

| Event | Why |
|---|---|
| `file:uploaded` | Queue the file. `replaced: true` forces a regeneration — the old thumbnail is a picture of bytes that are gone. |
| `file:deleted` | Remove the thumbnails with their source. Requires kempo-files ≥ 0.1.3. |
| `file:before_download` | Refuse a thumbnail whose source is not downloadable by this requester. See above. |

---

## What this does not do

Stated plainly, because each of these looks like a bug if you expect otherwise:

- **No PDF or document thumbnails.** ffmpeg cannot rasterise a PDF; that needs poppler or
  ghostscript, which is a different dependency and a different extension.
- **No SVG thumbnails.** kempo-files refuses SVG uploads outright (it is markup that can carry
  script), so there is nothing to thumbnail.
- **No smart cropping.** `cover` crops from the centre. Face and saliency detection are a real
  feature, not a flag.
- **No on-demand generation.** A URL for a size that was never generated is a 404, not a
  just-in-time encode. Sizes come from the settings, so an arbitrary-size URL would be an open
  invitation to fill the disk.
- **Moving a source file does not move its thumbnails.** They stay where they were and go on
  working. Regenerate to place them under the new folder.
- **Uninstalling deletes every generated thumbnail.** They are derived files and can be rebuilt from
  sources, which are kempo-files' and are never touched. Empty destination folders are left behind
  rather than guessed at.

---

## Development

```bash
npm install
npm run link:local      # kempo, kempo-files, kempo-server and kempo-ui as sibling checkouts
docker compose up -d    # Postgres on 5437
export DATABASE_URL="postgresql://kempo:kempo@localhost:5437/kempo_thumbs_test"
npx drizzle-kit push --force
npm test
```

The suite runs real ffmpeg against real files — sources are synthesised with ffmpeg's own generators,
so there are no fixtures to keep up to date. Tests needing a database or ffmpeg skip themselves with
a note when either is missing, rather than failing; CI installs both, so the coverage is real where it
counts.

---

## License

MIT
