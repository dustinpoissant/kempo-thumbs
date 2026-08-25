import { setSetting } from 'kempo/server/sdk.js';
import {
  OWNER, OUTPUT_FORMATS,
  readConfig, normaliseFormats, normaliseSizes, normaliseDestination,
} from '../../../server/utils/config/settings.js';
import { typeOf, descriptionOf } from '../../../server/utils/config/declared.js';
import { requireSession, requirePermission } from '../../../server/utils/permissions/gate.js';

/*
  Saves the settings, one kempo setting per field.

  These are ordinary kempo settings — they also appear under /admin/settings grouped by owner, and
  nothing here is a second store. What this route adds is validation *before* the write and its own
  permission: `thumbs:settings` can be handed to whoever runs the media side of a site without also
  handing them `system:settings:update`, which is every setting on the whole installation.

  Refusing rather than silently correcting is the rule. A `sizes` array where every entry is
  malformed comes back as a 400 saying so, because saving an empty array would look identical to
  deliberately turning thumbnails off and the difference matters a great deal to whoever typed it.
*/

/*
  Every setting this route is allowed to write. Exported so a static test can check it against what
  kempo-config.json declares — a name in one and not the other is a setting that either cannot be
  edited from its own screen, or is written without a type and description.
*/
export const SAVEABLE = [
  'auto_generate', 'formats', 'sizes', 'destination', 'output_format',
  'quality', 'video_frame_seconds', 'concurrency',
];

export default async (request, response) => {
  const [sessionError, session] = await requireSession(request);
  if(sessionError) return response.status(sessionError.code).json({ error: sessionError.msg });

  const [permError] = await requirePermission(session.token, 'thumbs:settings');
  if(permError) return response.status(permError.code).json({ error: permError.msg });

  const body = request.body || {};
  const updates = {};

  if(body.auto_generate !== undefined){
    updates.auto_generate = body.auto_generate === true || body.auto_generate === 'true';
  }

  if(body.formats !== undefined){
    const formats = normaliseFormats(body.formats);
    if(!formats.length && (body.formats?.length ?? 0) > 0){
      return response.status(400).json({ error: 'None of those file extensions are usable' });
    }
    updates.formats = formats;
  }

  if(body.sizes !== undefined){
    const sizes = normaliseSizes(body.sizes);
    if(!sizes.length && (body.sizes?.length ?? 0) > 0){
      return response.status(400).json({ error: 'None of those sizes are usable — each needs a label and a width or height, and cover/pad need both' });
    }
    updates.sizes = sizes;
  }

  if(body.destination !== undefined){
    const destination = normaliseDestination(body.destination);
    if(!destination && String(body.destination).trim()){
      return response.status(400).json({ error: 'That destination is not a valid folder path below the source file' });
    }
    updates.destination = destination;
  }

  if(body.output_format !== undefined){
    if(!OUTPUT_FORMATS.includes(body.output_format)){
      return response.status(400).json({ error: `Output format must be one of: ${OUTPUT_FORMATS.join(', ')}` });
    }
    updates.output_format = body.output_format;
  }

  const numbers = {
    quality: { min: 1, max: 100 },
    video_frame_seconds: { min: 0, max: 3600 },
    concurrency: { min: 1, max: 8 },
  };
  for(const [name, { min, max }] of Object.entries(numbers)){
    if(body[name] === undefined) continue;
    const value = Number(body[name]);
    if(!Number.isFinite(value) || value < min || value > max){
      return response.status(400).json({ error: `${name.replace(/_/g, ' ')} must be between ${min} and ${max}` });
    }
    updates[name] = value;
  }

  if(!Object.keys(updates).length){
    return response.status(400).json({ error: 'Nothing to save' });
  }

  for(const [name, value] of Object.entries(updates)){
    // Belt and braces: nothing reaches setSetting that is not on the list above.
    if(!SAVEABLE.includes(name)) continue;

    /*
      The type and description come from kempo-config.json rather than being restated here.
      setSetting stores exactly what it is handed, so passing null for the description would erase
      the text kempo's own /admin/settings screen shows next to each of these.

      isPublic stays false throughout — none of these are needed by a page render.
    */
    const [error] = await setSetting(OWNER, name, value, typeOf(name), false, descriptionOf(name));
    if(error) return response.status(error.code).json({ error: error.msg });
  }

  /*
    The saved-and-normalised view goes straight back, so the screen renders what the generator will
    actually use rather than what was typed. A `destination` of "thumbs/" comes back as "thumbs".
  */
  const config = await readConfig();
  response.json({ settings: config });
};
