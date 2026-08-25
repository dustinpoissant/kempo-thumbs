import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { getFile, urlForFileRow } from '../files/urls.js';
import { kempoThumbnail } from '../../db/schema.js';

/*
  Reading thumbnails back out — for the admin screen, for the browser SDK, and for whatever ends up
  consuming this (an ecommerce product image, a listing page's srcset).

  Every row comes back with a `url`, because that is what a caller actually wants and working it
  out requires knowing kempo-files' alias rule. Resolving it here once means no consumer has to
  learn it.
*/

/*
  The thumbnails for one source file, keyed by label — the shape a template wants:
  `thumbs.sm.url`. Rows that are not 'ready' are included rather than filtered out, so a caller can
  tell "still generating" from "there is no small size configured".
*/
export const thumbnailsFor = async sourceFileId => {
  const rows = await db.select().from(kempoThumbnail)
    .where(eq(kempoThumbnail.sourceFileId, sourceFileId))
    .orderBy(asc(kempoThumbnail.label));

  return [null, { thumbnails: await withUrls(rows) }];
};

/*
  The same thing for many sources at once, so a listing page does not make one query per row.
*/
export const thumbnailsForMany = async sourceFileIds => {
  if(!sourceFileIds?.length) return [null, { bySource: {} }];

  const rows = await db.select().from(kempoThumbnail)
    .where(inArray(kempoThumbnail.sourceFileId, sourceFileIds))
    .orderBy(asc(kempoThumbnail.label));

  const resolved = await withUrls(rows);

  const bySource = {};
  for(const row of resolved){
    (bySource[row.sourceFileId] ||= []).push(row);
  }
  return [null, { bySource }];
};

/*
  A page of rows for the admin table, newest first, optionally narrowed to one status. Failures are
  the reason this screen exists, so being able to ask for only those is the common case.
*/
export const listThumbnails = async ({ status, limit = 50, offset = 0 } = {}) => {
  const where = status ? eq(kempoThumbnail.status, status) : undefined;

  const rows = await db.select().from(kempoThumbnail)
    .where(where)
    .orderBy(desc(kempoThumbnail.updatedAt))
    .limit(Math.min(200, Math.max(1, limit)))
    .offset(Math.max(0, offset));

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql`count(*)::int` })
    .from(kempoThumbnail)
    .where(where);

  return [null, { thumbnails: await withUrls(rows), total: Number(count) || 0, limit, offset }];
};

/*
  How many rows are in each state, for the summary strip. One grouped query rather than four
  counts.
*/
export const statusCounts = async () => {
  const rows = await db
    .select({ status: kempoThumbnail.status, count: sql`count(*)::int` })
    .from(kempoThumbnail)
    .groupBy(kempoThumbnail.status);

  const counts = { pending: 0, ready: 0, failed: 0, skipped: 0 };
  for(const row of rows) counts[row.status] = Number(row.count) || 0;
  return [null, counts];
};

/*
  Attaches the URL and the source's own name to each row.

  Files are looked up once per distinct id rather than once per row — a listing is mostly the same
  handful of sources repeated across labels, and the admin table would otherwise issue a query per
  cell.
*/
const withUrls = async rows => {
  const ids = [...new Set(rows.flatMap(row => [row.fileId, row.sourceFileId].filter(Boolean)))];

  const files = new Map();
  await Promise.all(ids.map(async id => {
    const [error, file] = await getFile(id);
    if(!error) files.set(id, file);
  }));

  return rows.map(row => {
    const file = row.fileId ? files.get(row.fileId) : null;
    const source = files.get(row.sourceFileId) || null;
    return {
      ...row,
      name: file?.name || null,
      url: file ? urlForFileRow(file) : null,
      sourceName: source?.name || null,
    };
  });
};
