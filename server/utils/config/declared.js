import { createRequire } from 'module';

/*
  The declared settings, read from kempo-config.json itself.

  This exists so the settings route can preserve each setting's type and description when it writes.
  `setSetting` takes both as arguments and stores exactly what it is given — pass null and the
  description shown on kempo's own /admin/settings screen is erased, which is how a perfectly
  working save quietly degrades a screen belonging to somebody else.

  Reading them back out of the config rather than restating them here means there is one list, and
  editing kempo-config.json is enough. A static test checks the two agree.
*/
const require = createRequire(import.meta.url);
const config = require('../../../kempo-config.json');

export const DECLARED_SETTINGS = new Map(
  (config.settings || []).map(setting => [setting.name, setting]),
);

export const typeOf = name => DECLARED_SETTINGS.get(name)?.type || 'string';
export const descriptionOf = name => DECLARED_SETTINGS.get(name)?.description || null;
