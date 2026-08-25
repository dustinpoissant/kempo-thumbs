import { stemOf, thumbName, looksGenerated } from '../server/utils/names/thumbName.js';

/*
  A generated name becomes a real path in the library, alongside files people uploaded themselves.
  What matters here is that it stays readable — a folder of thumbnails should be navigable by
  someone looking for the one belonging to a particular file — and that a name this extension made
  can be recognised again later, since that recognition is what stops it thumbnailing its own
  output.
*/

export default {
  'keeps the original stem and replaces the extension': async ({ pass, fail }) => {
    const cases = [
      ['hero.jpg', 'sm', 'webp', 'hero-sm.webp'],
      ['product.photo.v2.png', 'md', 'jpg', 'product.photo.v2-md.jpg'],
      ['README', 'sm', 'webp', 'README-sm.webp'],
      ['.gitignore', 'sm', 'webp', '.gitignore-sm.webp'],
    ];

    const wrong = cases
      .map(([name, label, format, expected]) => [thumbName(name, label, format), expected])
      .filter(([actual, expected]) => actual !== expected);

    if(wrong.length){
      return fail(wrong.map(([actual, expected]) => `got ${actual}, expected ${expected}`).join('; '));
    }
    pass('names stay recognisable');
  },

  'never leaves two extensions in one name': async ({ pass, fail }) => {
    /*
      `hero.jpg-sm.webp` would be a name where the extension a browser, a CDN or a person reads
      first disagrees with what the file actually is.
    */
    const name = thumbName('hero.jpg', 'sm', 'webp');
    if(name.includes('.jpg')) return fail(`the source extension survived: ${name}`);
    pass('the source extension is dropped');
  },

  'a leading dot is not an extension': async ({ pass, fail }) => {
    if(stemOf('.gitignore') !== '.gitignore') return fail(`got ${stemOf('.gitignore')}`);
    pass('dotfiles keep their whole name');
  },

  'recognises its own output': async ({ pass, fail }) => {
    const labels = ['sm', 'md'];
    const formats = ['webp', 'jpg', 'png'];

    if(!looksGenerated('hero-sm.webp', labels, formats)) return fail('should recognise hero-sm.webp');
    if(!looksGenerated('hero-MD.jpg', labels, formats)) return fail('should match a label case-insensitively');
    pass('generated names are recognised');
  },

  'does not claim files it did not make': async ({ pass, fail }) => {
    const labels = ['sm', 'md'];
    const formats = ['webp', 'jpg', 'png'];

    const wrong = [
      ['hero.webp', 'no label suffix'],
      ['hero-sm.mp4', 'not an output format'],
      ['hero-small.webp', 'a different word that starts the same way'],
      ['sm.webp', 'the label alone, with no separator before it'],
    ].filter(([name]) => looksGenerated(name, labels, formats));

    if(wrong.length) return fail(`wrongly claimed: ${wrong.map(([name, why]) => `${name} (${why})`).join(', ')}`);
    pass('unrelated names are left alone');
  },
};
