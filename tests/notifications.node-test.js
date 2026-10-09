import { readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { sql, eq } from 'drizzle-orm';
import db from 'kempo/server/db/index.js';
import { user, userGroup, group, groupPermission, permission, notification } from 'kempo/server/db/schema.js';
import { createUser, addUserToGroup, getNotifications, markRead, deleteUser } from 'kempo/server/sdk.js';
import { storeUpload, deleteFile, listFiles, getFile, filePath, FILES_ROOT } from 'kempo-files/sdk';
import { kempoThumbnail } from '../server/db/schema.js';
import { enqueue, queueStatus } from '../server/utils/thumbnails/queue.js';
import { syncFailureNotification } from '../server/utils/notifications/failures.js';
import { resolveFfmpeg, run } from '../server/utils/ffmpeg/binaries.js';

/*
  The failure notification, end to end: a real queue, a real kempo-files library, real ffmpeg, and the
  notification tables of the kempo that is installed.

  Needs a reachable Postgres carrying kempo's schema (including the notification tables), kempo-files'
  and this extension's. Skips itself when there is none, or when the installed kempo predates
  notifications, which is a supported configuration for this extension and has nothing to assert here.
*/

const OWNER = 'test-owner-thumbs-notify';
const GROUP = 'notify-test:operators';
const PERMISSION = 'thumbs:generate';
const EMAILS = ['operator', 'outsider'].map(name => `thumbs-notify-${name}@test.local`);

const databaseReachable = await db.execute(sql`select 1`).then(() => true).catch(() => false);
const coreHasNotifications = databaseReachable && await db.execute(sql`select 1 from "notification" limit 1`).then(() => true).catch(() => false);
const ffmpeg = resolveFfmpeg();

const state = { ids: {}, files: [] };

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const settled = async before => {
  const deadline = Date.now() + 30000;
  while(Date.now() < deadline){
    const status = queueStatus();
    if(status.queued === 0 && status.active === 0 && status.processedSinceStart > before) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('the queue did not settle');
};

const process_ = async (fileId, options = {}) => {
  const before = queueStatus().processedSinceStart;
  expect(enqueue({ fileId, ...options }), 'the file was not accepted by the queue');
  await settled(before);
};

const upload = async (name, data) => {
  const [error, file] = await storeUpload({ name: `zz-notify-${name}`, data, directoryId: null, ownerId: OWNER, public: false });
  expect(!error, `storeUpload: ${error?.msg}`);
  state.files.push(file.id);
  return file;
};

const goodPng = async () => {
  const scratch = path.join(FILES_ROOT(), '.notify-scratch.png');
  const [error] = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=1', '-frames:v', '1', scratch]);
  expect(!error, `could not build a test image: ${error?.msg}`);
  const data = await readFile(scratch);
  await rm(scratch, { force: true });
  return data;
};

const mp3WithoutCover = async () => {
  const scratch = path.join(FILES_ROOT(), '.notify-scratch.mp3');
  const [error] = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', scratch]);
  expect(!error, `could not build a test audio file: ${error?.msg}`);
  const data = await readFile(scratch);
  await rm(scratch, { force: true });
  return data;
};

const notificationRows = () => db.select().from(notification).where(eq(notification.owner, 'kempo-thumbs'));

const listFor = async userId => {
  const [error, result] = await getNotifications({ userId });
  expect(!error, `getNotifications: ${error?.msg}`);
  return result.notifications.filter(n => n.owner === 'kempo-thumbs');
};

const purge = async () => {
  await db.delete(notification).where(eq(notification.owner, 'kempo-thumbs')).catch(() => {});
  await db.delete(kempoThumbnail).catch(() => {});
  const [, listed] = await listFiles({ limit: 500 });
  for(const file of listed?.files || []) if(file.name.startsWith('zz-notify-')) await deleteFile({ id: file.id }).catch(() => {});
  state.files = [];
  for(const email of EMAILS){
    const [row] = await db.select().from(user).where(eq(user.email, email));
    if(!row) continue;
    await db.delete(userGroup).where(eq(userGroup.userId, row.id)).catch(() => {});
    await deleteUser(row.id).catch(() => {});
  }
  await db.delete(groupPermission).where(eq(groupPermission.groupName, GROUP)).catch(() => {});
  await db.delete(group).where(eq(group.name, GROUP)).catch(() => {});
};

const tests = {
  'fixtures: an operator who holds thumbs:generate through a group, and an outsider who does not': async ({ pass }) => {
    await purge();
    await db.insert(permission).values({ name: PERMISSION, description: 'test', owner: 'kempo-thumbs', createdAt: new Date() }).onConflictDoNothing();
    await db.insert(group).values({ name: GROUP, description: 'test', owner: 'notify-test', createdAt: new Date() });
    await db.insert(groupPermission).values({ id: crypto.randomUUID(), groupName: GROUP, permissionName: PERMISSION, createdAt: new Date() });
    for(const name of ['operator', 'outsider']){
      const [error, created] = await createUser({ name, email: `thumbs-notify-${name}@test.local`, password: 'ThumbsNotify123!', emailVerified: true });
      expect(!error, `could not create ${name}: ${error?.msg}`);
      state.ids[name] = created.user.id;
    }
    expect(!(await addUserToGroup(state.ids.operator, GROUP))[0], 'could not add the operator to the group');
    pass();
  },

  'a thumbnail that fails notifies the people who can regenerate it, naming the file and the reason': async ({ pass }) => {
    const broken = await upload('broken.png', Buffer.from('this is not an image at all'));
    await process_(broken.id);

    const [row] = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, broken.id));
    expect(row?.status === 'failed', `the thumbnail should have failed, was ${row?.status}`);

    const rows = await notificationRows();
    expect(rows.length === 1, `expected one notification, got ${rows.length}`);
    expect(rows[0].level === 'error' && rows[0].title.includes('zz-notify-broken.png'), `the title should name the file, got ${rows[0].title}`);
    expect(rows[0].message.includes('zz-notify-broken.png') && rows[0].message.length > 'zz-notify-broken.png (sm): '.length, `the message should name the file and carry a reason, got ${rows[0].message}`);

    const retry = rows[0].actions.find(action => action.api);
    expect(retry && retry.api.method === 'POST' && retry.api.url === '/kempo-thumbs/api/thumbnails' && retry.api.body.sweep === true, `the action should call the existing regenerate route, got ${JSON.stringify(rows[0].actions)}`);
    expect(rows[0].actions.some(action => action.href === '/admin/extension/kempo-thumbs/'), 'and link to the admin screen');

    expect((await listFor(state.ids.operator)).length === 1, 'the operator holds thumbs:generate through the group');
    expect((await listFor(state.ids.outsider)).length === 0, 'the outsider holds nothing and must not be told');
    pass();
  },

  'more failures refresh the same notification and re-open it instead of adding more': async ({ pass }) => {
    const [first] = await notificationRows();
    expect(!(await markRead({ userId: state.ids.operator, notificationId: first.id }))[0], 'could not read the notification');

    const second = await upload('broken-too.png', Buffer.from('also not an image'));
    await process_(second.id);

    const rows = await notificationRows();
    expect(rows.length === 1 && rows[0].id === first.id, `still one notification, got ${rows.length}`);
    expect(rows[0].title.includes('2 files') && rows[0].message.includes('1 other file is also failing'), `it should now say two files are failing, got ${rows[0].title} / ${rows[0].message}`);
    const mine = (await listFor(state.ids.operator))[0];
    expect(mine.readAt === null, 'a read one is re-opened for the new failure');
    pass();
  },

  'a file with nothing to thumbnail is skipped and raises nothing': async ({ pass }) => {
    await db.delete(notification).where(eq(notification.owner, 'kempo-thumbs'));
    await db.delete(kempoThumbnail);

    const audio = await upload('no-cover.mp3', await mp3WithoutCover());
    await process_(audio.id);

    const rows = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, audio.id));
    expect(rows.length > 0 && rows.every(row => row.status === 'skipped'), `audio with no cover art should be skipped, got ${JSON.stringify(rows.map(row => [row.status, row.error]))}`);
    expect((await notificationRows()).length === 0, 'a skipped thumbnail must never notify');
    pass();
  },

  'regenerating successfully closes the notification once nothing is failing': async ({ pass }) => {
    await db.delete(kempoThumbnail);
    const broken = await upload('fixable.png', Buffer.from('not an image yet'));
    await process_(broken.id);
    expect((await notificationRows()).length === 1, 'the failure was reported');
    expect((await listFor(state.ids.operator))[0].handledAt === null, 'and is open');

    const [, file] = await getFile(broken.id);
    const [, location] = await filePath(file);
    await writeFile(location, await goodPng());
    await process_(broken.id, { force: true });

    const [thumbnail] = await db.select().from(kempoThumbnail).where(eq(kempoThumbnail.sourceFileId, broken.id));
    expect(thumbnail.status === 'ready', `the retry should have worked, got ${thumbnail.status}: ${thumbnail.error}`);
    const mine = (await listFor(state.ids.operator))[0];
    expect(mine.handledAt instanceof Date && mine.readAt instanceof Date, 'recovering closes it');
    pass();
  },

  'it stays open while another file is still failing': async ({ pass }) => {
    await db.delete(notification).where(eq(notification.owner, 'kempo-thumbs'));
    await db.delete(kempoThumbnail);
    const stays = await upload('stays-broken.png', Buffer.from('never an image'));
    const fixable = await upload('gets-fixed.png', Buffer.from('not yet'));
    await process_(stays.id);
    await process_(fixable.id);

    const [, file] = await getFile(fixable.id);
    const [, location] = await filePath(file);
    await writeFile(location, await goodPng());
    await process_(fixable.id, { force: true });

    expect((await listFor(state.ids.operator))[0].handledAt === null, 'one file is still failing, so there is still something to do');
    pass();
  },

  'on a kempo without notifications nothing happens and nothing throws': async ({ pass }) => {
    await db.delete(notification).where(eq(notification.owner, 'kempo-thumbs'));
    await syncFailureNotification({ fileId: 'whatever', results: [{ label: 'sm', status: 'failed', error: 'boom' }], core: null });
    expect((await notificationRows()).length === 0, 'a null core is a no-op');

    const throwing = { createNotification: async () => { throw new Error('core exploded'); }, markHandled: async () => {} };
    const original = console.error;
    console.error = () => {};
    try {
      await syncFailureNotification({ fileId: 'whatever', results: [{ label: 'sm', status: 'failed', error: 'boom' }], core: throwing });
    } finally {
      console.error = original;
    }
    pass();
  },
};

export const afterAll = async () => {
  if(databaseReachable && coreHasNotifications) await purge();
};

export default databaseReachable && coreHasNotifications
  ? tests
  : { 'failure notifications (SKIPPED)': async ({ pass }) => pass(`skipped: ${databaseReachable ? 'the installed kempo has no notification tables' : 'no reachable database'}`) };
