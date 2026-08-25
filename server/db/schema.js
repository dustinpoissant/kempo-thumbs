import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';

/*
  One row per (source file, size label) — including the ones that did not work.

  A failed thumbnail is the interesting case, not an absence: ffmpeg not installed, an audio file
  with no cover art, a video too short to seek into. If the only record were the generated file
  itself, every one of those would be indistinguishable from "not generated yet", and the admin
  would have nothing to show but a gap.

  `fileId` points at a real kempo-files row rather than a path on disk. That is deliberate: a
  thumbnail is an ordinary file in the library, so it inherits kempo-files' permission gate, its
  serving rules and its `files/` placement for free, and deleting one through the library is a
  supported thing to do rather than corruption.
*/
export const kempoThumbnail = pgTable('kempoThumbnail', {
  id: text('id').primaryKey(),

  sourceFileId: text('sourceFileId').notNull(),  // the kempo-files row this was made from
  label: text('label').notNull(),                // the size label from settings, e.g. 'sm'

  /*
    Null until there is something to point at. A pending or failed row still exists so the reason
    survives — see the note above.
  */
  fileId: text('fileId'),

  /*
    Measured off the produced file with ffprobe, not computed from the requested size: `contain`
    and the no-upscale rule both mean the result is routinely smaller than what was asked for, and
    a consumer building a srcset needs the real numbers.
  */
  width: integer('width'),
  height: integer('height'),

  /*
    'pending'  — queued or running
    'ready'    — fileId points at a generated thumbnail
    'failed'   — something went wrong and `error` says what; retryable
    'skipped'  — nothing to generate, and retrying will not change that (an mp3 with no cover art)
  */
  status: text('status').notNull().default('pending'),
  error: text('error'),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});
