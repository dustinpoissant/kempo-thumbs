import {
  normaliseFormats, normaliseSizes, normaliseDestination,
} from '../server/utils/config/settings.js';

/*
  Every one of these values is editable from an admin form and stored as free-form JSON, so each
  case below is a way a saved setting could reach the generator meaning something other than what
  was typed. These are the ones with consequences, not a survey of the validator.
*/

export default {
  'normalises extensions to one canonical form': async ({ pass, fail }) => {
    const formats = normaliseFormats(['.PNG', 'png', ' jpg ', 'JPEG']);
    /*
      A leading dot, surrounding whitespace and a capital are three ways of typing the same
      extension. If they survived as three entries, the eligibility check — a plain `includes`
      against the lowercase extension — would match one of them and miss the others.
    */
    if(formats.length !== 3) return fail(`expected 3 unique extensions, got ${JSON.stringify(formats)}`);
    if(!formats.includes('png') || !formats.includes('jpg') || !formats.includes('jpeg')){
      return fail(`unexpected result: ${JSON.stringify(formats)}`);
    }
    pass('extensions collapse to lowercase, dotless and unique');
  },

  'drops extensions that are not extensions': async ({ pass, fail }) => {
    const formats = normaliseFormats(['png', '../etc', 'a b', '', 'toolongextension', 42, null]);
    if(formats.length !== 1 || formats[0] !== 'png'){
      return fail(`expected only png, got ${JSON.stringify(formats)}`);
    }
    pass('junk entries are dropped rather than carried');
  },

  'refuses a size that cannot produce a file': async ({ pass, fail }) => {
    const cases = [
      [{ width: 100, height: 100, fit: 'cover' }, 'no label'],
      [{ label: 'a b', width: 100, height: 100 }, 'label with a space'],
      [{ label: 'sm', width: 0, height: 0 }, 'no dimensions at all'],
      [{ label: 'sm', width: 100, height: 0, fit: 'cover' }, 'cover with only one dimension'],
      [{ label: 'sm', width: 0, height: 100, fit: 'pad' }, 'pad with only one dimension'],
    ];

    const kept = cases.filter(([size]) => normaliseSizes([size]).length);
    if(kept.length) return fail(`kept sizes it should have dropped: ${kept.map(([, why]) => why).join(', ')}`);
    pass('unusable sizes are dropped');
  },

  'allows contain with a single dimension': async ({ pass, fail }) => {
    /*
      This is the fixed-width case — "800 wide, whatever height that works out to" — and it is the
      one shape where a missing dimension is meaningful rather than a mistake.
    */
    const sizes = normaliseSizes([{ label: 'wide', width: 800, height: 0, fit: 'contain' }]);
    if(sizes.length !== 1) return fail('contain with only a width should be kept');
    if(sizes[0].height !== 0) return fail(`height should stay 0, got ${sizes[0].height}`);
    pass('contain accepts one dimension');
  },

  'refuses two sizes sharing a label': async ({ pass, fail }) => {
    /*
      Labels name the file (`hero-sm.webp`), so a duplicate means two encodes writing the same path
      — the second silently replacing the first, forever, with nothing in the UI to explain it.
    */
    const sizes = normaliseSizes([
      { label: 'sm', width: 100, height: 100, fit: 'cover' },
      { label: 'SM', width: 400, height: 400, fit: 'cover' },
    ]);
    if(sizes.length !== 1) return fail(`expected the duplicate to be dropped, got ${JSON.stringify(sizes)}`);
    pass('a duplicate label is dropped, case-insensitively');
  },

  'clamps dimensions rather than trusting them': async ({ pass, fail }) => {
    const [size] = normaliseSizes([{ label: 'huge', width: 999999, height: -5, fit: 'contain' }]);
    if(!size) return fail('the size should have been kept, with its numbers clamped');
    if(size.width !== 8192) return fail(`width should clamp to 8192, got ${size.width}`);
    if(size.height !== 0) return fail(`a negative height should clamp to 0, got ${size.height}`);
    pass('dimensions are clamped into a range ffmpeg can work with');
  },

  'refuses a destination that could climb out of the library': async ({ pass, fail }) => {
    /*
      The destination is resolved relative to the source file's folder and then used to find or
      create real directories. A segment that climbs is a segment that eventually writes outside
      files/ — refused here rather than resolved, since there is no correct interpretation of it.
    */
    const escapes = ['..', '../..', 'a/../../b', './..', '/../etc'];
    const survived = escapes.filter(value => normaliseDestination(value));
    if(survived.length) return fail(`accepted traversal: ${survived.join(', ')}`);
    pass('traversal is refused');
  },

  'tidies a destination without changing what it means': async ({ pass, fail }) => {
    const cases = [
      ['thumbs', 'thumbs'],
      ['/thumbs/', 'thumbs'],
      ['assets\\thumbs', 'assets/thumbs'],
      ['  ', ''],
      ['', ''],
    ];
    const wrong = cases.filter(([input, expected]) => normaliseDestination(input) !== expected);
    if(wrong.length){
      return fail(wrong.map(([input, expected]) => `${JSON.stringify(input)} → ${JSON.stringify(normaliseDestination(input))}, expected ${JSON.stringify(expected)}`).join('; '));
    }
    pass('slashes and whitespace are normalised');
  },
};
