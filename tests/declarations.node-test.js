import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SAVEABLE } from '../public/api/settings/PUT.js';
import { DEFAULTS } from '../server/utils/config/settings.js';

/*
  Static checks that what the code asks for is what the extension declares.

  This is the shape of bug kempo-blog shipped: its config declared prefixed permission names while
  its routes checked unprefixed ones, so its "New Post" gate silently denied everyone. A permission
  check against a name nobody registered does not error — it answers no, forever, and only for
  people who are not administrators, which is why it survives testing.

  The settings half is the same idea one layer over: a setting the code reads but never declares
  has no default row, no description on kempo's own settings screen, and no way for an admin to
  discover it exists.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));

const walk = async dir => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for(const entry of entries){
    if(entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else if(entry.name.endsWith('.js')) files.push(full);
  }
  return files;
};

const sources = [
  ...await walk(path.join(root, 'public')),
  ...await walk(path.join(root, 'server')),
  ...await walk(path.join(root, 'hooks')),
];

export default {
  'every permission the code checks is one the extension declares': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    const used = new Map();

    for(const file of sources){
      const text = await readFile(file, 'utf8');
      for(const match of text.matchAll(/(?:currentUserHasPermission|requirePermission)\s*\([^,]+,\s*['"]([^'"]+)['"]/g)){
        used.set(match[1], path.relative(root, file));
      }
    }

    /*
      kempo-files' own permissions are legitimately checked from here — the before_download hook
      re-runs the library's download rule against a thumbnail's source. Those belong to that
      extension's config, not this one's.
    */
    const foreign = new Set(['files:download']);

    const undeclared = [...used].filter(([name]) => !declared.has(name) && !foreign.has(name));
    if(undeclared.length){
      return fail(undeclared.map(([name, file]) => `${name} (checked in ${file})`).join('; '));
    }
    pass(`${used.size} permission checks, all declared`);
  },

  'every declared permission is actually used somewhere': async ({ pass, fail }) => {
    /*
      The other direction. A declared permission nothing checks is one an admin can grant with no
      effect, which is worse than not having it — it reads like a control that does something.
    */
    const text = (await Promise.all(sources.map(file => readFile(file, 'utf8')))).join('\n');
    const unused = config.permissions
      .map(permission => permission.name)
      .filter(name => !text.includes(`'${name}'`) && !text.includes(`"${name}"`));

    if(unused.length) return fail(`declared but never checked: ${unused.join(', ')}`);
    pass('every declared permission is enforced somewhere');
  },

  'the settings screen and the config agree on which settings exist': async ({ pass, fail }) => {
    const declared = new Set(config.settings.map(setting => setting.name));

    const missing = SAVEABLE.filter(name => !declared.has(name));
    if(missing.length){
      return fail(`the settings route writes settings the config never declares: ${missing.join(', ')} — they would have no default, no type and no description`);
    }

    const uneditable = [...declared].filter(name => !SAVEABLE.includes(name));
    if(uneditable.length){
      return fail(`declared but not editable from the extension's own screen: ${uneditable.join(', ')}`);
    }
    pass(`${SAVEABLE.length} settings, declared and editable`);
  },

  'every declared setting has a working default': async ({ pass, fail }) => {
    /*
      An extension should work the moment it is enabled. A declared setting whose stored default
      does not match the fallback the code uses means the behaviour changes the first time someone
      saves the screen without editing anything — which looks like a bug in whatever they *did*
      change.
    */
    const mismatched = [];
    for(const setting of config.settings){
      if(!(setting.name in DEFAULTS)){
        mismatched.push(`${setting.name} has no fallback in DEFAULTS`);
        continue;
      }

      const fallback = DEFAULTS[setting.name];
      const stored = setting.type === 'json'
        ? JSON.parse(setting.value)
        : setting.type === 'number' ? Number(setting.value)
        : setting.type === 'boolean' ? setting.value === 'true'
        : setting.value;

      if(JSON.stringify(stored) !== JSON.stringify(fallback)){
        mismatched.push(`${setting.name}: config says ${JSON.stringify(stored)}, code falls back to ${JSON.stringify(fallback)}`);
      }
    }

    if(mismatched.length) return fail(mismatched.join('; '));
    pass('declared defaults match the code’s own fallbacks');
  },

  'kempo-files is declared as a dependency': async ({ pass, fail }) => {
    /*
      Everything here reads and writes through kempo-files' SDK. Without the declaration, kempo will
      happily enable this extension on a site where the library is not installed, and every route
      fails at import time rather than with anything an admin could act on.
    */
    if(!(config.dependencies || []).includes('kempo-files')){
      return fail('kempo-config.json must declare a dependency on kempo-files');
    }
    pass('the dependency is declared');
  },

  'every declared hook handler exists': async ({ pass, fail }) => {
    const missing = [];
    for(const [event, handler] of Object.entries(config.hooks || {})){
      try {
        await readFile(path.join(root, handler), 'utf8');
      } catch {
        missing.push(`${event} → ${handler}`);
      }
    }
    if(missing.length) return fail(`declared hook handlers that do not exist: ${missing.join(', ')}`);
    pass(`${Object.keys(config.hooks || {}).length} hook handlers, all present`);
  },
};
