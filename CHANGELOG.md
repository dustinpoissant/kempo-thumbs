# Changelog

All notable changes to `kempo-thumbs` are documented in this file.

## [Unreleased]

### Added

- **Failure notifications** through kempo's notification system. When a thumbnail fails, holders of `thumbs:generate` get one rolled-up notification (refreshed and re-opened as more fail, closed when nothing is failing) naming the latest file and the reason, with a **Try again** action that calls the existing `POST /kempo-thumbs/api/thumbnails` sweep route as the signed-in user. `skipped` never notifies. **Requires the kempo release that adds notifications**; on an older kempo the integration is off and nothing else changes (feature-detected at runtime, no hard import).

### Fixed

- Audio with no cover art is classified `skipped` by asking ffprobe for a picture stream instead of matching ffmpeg's message, which on some builds is only `Error opening output files: Invalid argument` and was recorded as `failed`.

### Initial release

First release. Automatic thumbnail generation for `kempo-files`, backed by ffmpeg — one tool covering
images, video frames and embedded audio cover art rather than three libraries.

- **Thumbnails are ordinary kempo-files entries**, not a private cache with its own serving route.
  Real names in real folders, with rows in the library, which means they inherit kempo-files'
  permission gate, its `public` flag, its `file:before_download` veto and its `files/` placement for
  free. Deleting or moving one through the library is a supported thing to do rather than
  corruption. The alternative would have meant reimplementing access control for derived files and
  getting it subtly different.
- **A thumbnail is never more visible than its source.** Inheriting `public` at generation time
  covers the ordinary case but not the one that matters: a source made private six months later
  leaves its thumbnails as separate rows with their own flags, still served to anyone holding the
  URL. So a `file:before_download` handler re-runs the library's own rule against the *source* file.
  kempo-files fires that hook after its own gate has passed, so a handler there can only ever narrow
  access — which makes it the right place for the rule, since the worst it can do is refuse.
- **A settings screen, because the sizes needed one.** `sizes` is a nested JSON array; in kempo's
  generic settings table that is a single-line text field, editable in the sense that a hex editor is
  editable and one missing brace from silently generating nothing. `k-thumbs-size-list` gives it a
  row per size with live validation and a worked example of the filename each will produce;
  `k-thumbs-format-picker` groups extensions by what ffmpeg actually has to *do* to them, with a note
  per group, so nobody enables audio and then reports half of them being skipped as a bug. They stay
  ordinary kempo settings underneath and still appear under `/admin/settings`.
- **`thumbs:settings` as its own permission**, so whoever runs the media side of a site can change
  these without `system:settings:update` — which is every setting on the whole installation.
- **Three fit modes, and `contain` never upscales.** Clamped with `min(iw,W)`/`min(ih,H)`: without
  it, thumbnailing a 64px favicon at 1024px produces a blurry file several times the size of its own
  source. `cover` fills and crops; `pad` fits and pads out. Real dimensions are measured off the
  produced file with ffprobe rather than assumed from the request, since `contain` and the no-upscale
  rule both mean the result is routinely smaller than the box — and a `srcset` built on numbers that
  are not true has the browser choosing wrong.
- **A destination relative to the source file**, so thumbnails follow the library's structure
  (`products/hero.jpg` → `products/thumbs/hero-sm.webp`) rather than collecting in one place. `..` is
  refused rather than resolved. Blank writes them alongside the original, which works because
  generated files are recorded as such and so are never treated as sources and thumbnailed in turn.
  Folders are created lazily, so a site that generates nothing grows no empty `thumbs/` folders.
- **This extension never overwrites a file it did not create.** A thumbnail's name is derived from
  its source, so it can genuinely collide with somebody's own upload. The only acceptable evidence
  that the file in the way is ours is a `kempoThumbnail` row pointing at its id — a matching name is
  not evidence. A collision fails that one size, with a message saying why, rather than replacing
  content nobody knew was at risk.
- **Regeneration replaces in place, keeping the thumbnail's id** — so anything already referencing
  the URL (a product page, a cached page, an email that went out last week) goes on working.
- **`failed` and `skipped` are different states.** Most mp3s have no cover art; recording that as a
  failure would fill the admin with red rows describing files working exactly as expected.
  `skipped` also means "do not retry", which is what lets *Generate missing* converge instead of
  re-queueing the same files on every sweep.
- **A bounded in-process queue.** kempo awaits hook handlers one at a time, so anything a
  `file:uploaded` handler does inline is time the uploader spends watching a progress bar, and
  encoding a video is seconds. Deliberately not a job runner, and honest about it: `concurrency`
  caps parallel work, every ffmpeg invocation has a 60-second timeout so a malformed file cannot hold
  a slot forever, and a restart loses what was queued — those rows stay `pending`, which is how the
  admin finds them and how *Generate missing* picks them up.
- **Bulk actions**: *Generate missing* (catch up a library that predates the install), *Regenerate
  everything* (after a change that alters how thumbnails look rather than which exist), and *Clean up
  orphans* (rows whose source is gone — a repair for what happened before the `file:deleted` hook
  existed).
- **EXIF is stripped from every thumbnail** (`-map_metadata -1`). A thumbnail is a derived file that
  tends to end up somewhere more public than its original; inheriting the GPS tag a phone photo
  carries is not a thing to do quietly.
- **`ffmpeg-static` and `@ffprobe-installer/ffprobe` are real dependencies, with no admin-facing
  path setting and no "is it installed" banner — `npm install kempo-thumbs` alone gets you a
  working ffmpeg and ffprobe, guaranteed.** No mainstream OS ships either binary, including the
  `node:18-alpine` base kempo's own Dockerfile builds on, so the original design (look for a system
  install, do nothing if there isn't one — and, for one release, a settings-configurable override
  and a live admin banner for when it wasn't found) left the extension non-functional out of the box
  for essentially every real deployment, while treating a solvable problem as something each site
  had to notice and work around. Confirmed on `node:18-alpine` specifically (true static linking, no
  `libc6-compat` needed for musl) before adopting this. Both packages read the real platform at
  `npm install` time and fetch the matching binary; a Linux server gets a Linux binary, this is not
  tied to any one OS. `FFMPEG_PATH`/`FFPROBE_PATH` environment variables remain as a pure code-level
  override — no settings UI, no database row — for the one case that is still genuinely uncommon: a
  platform/architecture outside the bundled packages' support matrix, or a container staging a
  specific build at a fixed path. Below that, the bare name on `PATH` is the last resort.
- **Found by this exact CI gate, on the first real attempt to publish it: every non-Windows
  `@ffprobe-installer` platform package ships its binary non-executable and relies on its own
  `postinstall` (`chmod u+x ffprobe`) to fix that** — and recent npm added a real `allowScripts`
  allowlist that this package.json already used (for esbuild and puppeteer), which silently blocks
  any lifecycle script for a package not named in it the moment the list exists at all. The result
  was not an install failure — `npm ci` succeeded, ffmpeg generated the thumbnail fine — it was
  ffprobe failing with a plain `Permission denied` and the row landing `ready` with no dimensions
  instead of erroring loudly, on Linux only; Windows binaries need no executable bit, which is why
  this was invisible in local testing. Fixed two ways: the missing platform packages were added to
  `allowScripts`, and `resolveFfprobe`/`resolveFfmpeg` now `chmod` the resolved binary defensively
  on every resolution, so neither this list nor any future `@ffprobe-installer` version bump can
  silently reintroduce it.
- **The suite runs real ffmpeg against real files**, with sources synthesised by ffmpeg's own
  generators so there are no fixtures to keep current. That is what catches the class of bug where an
  argument string reads correctly and the pixels come out wrong — and it found two during
  development: `contain` silently upscaling without the `min()` clamp, and a video shorter than the
  configured seek producing nothing at all, because ffmpeg reports "seeked past the end" by exiting 0
  having written no file.
- **Static tests that the declarations and the code agree** — every permission checked is declared
  and every declared permission is checked; every setting the screen writes is declared, with a
  default matching the code's own fallback. This is the shape of bug kempo-blog shipped, where a
  permission check against a name nobody registered silently denied everyone who was not an
  administrator.
- **The admin screen is three tabs** — Manage, Settings, Recent activity — rather than three
  permission-gated sections stacked on one page. A tab someone lacks permission for does not appear
  in the strip at all, using a new kempo core component built for exactly this: `k-permission-target`
  (`kempo/components/PermissionTarget.js`), a sibling to `k-permission` that hides *other* elements
  by selector instead of wrapping its own children. kempo-ui's `<k-tabs>` finds its `<k-tab>`/
  `<k-tab-content>` with a direct-child query, so a `k-permission`-style wrapper around a `<k-tab>`
  would break tab selection outright, not just hide it — `k-permission-target` reaches in from
  outside `<k-tabs>` instead, leaving the tab and its pane exactly where `<k-tabs>` expects them.

### Requires

- `kempo-files >= 0.1.3` for the `file:deleted` hook (added alongside this release). Without it
  thumbnails outlive their sources until *Clean up orphans* is run.
- `kempo >= 4.2.39` for `k-permission-target`, which the admin screen's tabs use. `4.2.37` fixes the
  json-settings double-encoding bug; below it, this extension's `sizes` and `formats` are stored
  double-encoded on install and read back as JSON text, so the generator sees no configured sizes and
  silently produces nothing. `4.2.35` is enough for the dependency declaration itself, but not for
  the extension to actually work.
- Nothing to install for ffmpeg itself — `ffmpeg-static` and `@ffprobe-installer/ffprobe` ship as
  dependencies and fetch the right binary for the server's own platform at `npm install` time.
