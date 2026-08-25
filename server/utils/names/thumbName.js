/*
  What a generated thumbnail is called.

  `hero.jpg` at size `sm` in webp becomes `hero-sm.webp`. Keeping the original stem is the whole
  point — a folder of thumbnails should be readable by a person looking for the one belonging to a
  particular file, which an id-named file is not.

  The source extension is dropped rather than kept (`hero.jpg-sm.webp`) because two extensions in
  one name is exactly the shape that makes a browser, a CDN or a person guess wrong about what the
  file is.
*/

export const stemOf = name => {
  if(typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
};

export const thumbName = (sourceName, label, outputFormat) =>
  `${stemOf(sourceName)}-${label}.${outputFormat}`;

/*
  Whether a name looks like something this extension would have produced, for the one case the
  database cannot answer: a file uploaded straight into the destination folder, which has no
  thumbnail row and would otherwise be treated as a fresh source and thumbnailed in turn.

  A heuristic, and only ever used to *skip* work — never to decide that something is safe to
  overwrite. Ownership of a file is established by a `kempoThumbnail` row pointing at it, nothing
  else.
*/
export const looksGenerated = (name, labels, outputFormats) => {
  const dot = String(name).lastIndexOf('.');
  if(dot <= 0) return false;

  const extension = name.slice(dot + 1).toLowerCase();
  if(!outputFormats.includes(extension)) return false;

  const stem = name.slice(0, dot);
  return labels.some(label => stem.toLowerCase().endsWith(`-${label.toLowerCase()}`));
};
