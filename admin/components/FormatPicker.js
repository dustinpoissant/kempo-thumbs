import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html, css } from '/kempo-ui/lit-all.min.js';

/*
  Which file extensions get thumbnails.

  Grouped by what ffmpeg actually has to do to each group, rather than alphabetically, because the
  three cases behave differently and a site turning one on is usually turning on all of it: an
  image is decoded, a video is seeked into for a frame, and an audio file is searched for embedded
  cover art it very often does not have. The per-group note says so, so nobody enables audio and
  then files a bug about half of them being skipped.

  Extensions outside the three groups can still be typed in — kempo-files accepts any file type,
  and this list is not the place to decide ffmpeg cannot read something.
*/

const GROUPS = [
  {
    name: 'Images',
    icon: 'image',
    note: 'Decoded directly. An animated GIF or WebP uses its first frame.',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff'],
  },
  {
    name: 'Video',
    icon: 'video',
    note: 'A single frame is captured from the position set below.',
    extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'ogv'],
  },
  {
    name: 'Audio',
    icon: 'audio',
    note: 'Uses embedded cover art. Files without any are skipped, not failed.',
    extensions: ['mp3', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wav', 'aac'],
  },
];

export default class FormatPicker extends ShadowComponent {
  static properties = {
    formats: { type: Array },
    disabled: { type: Boolean },
    _custom: { state: true },
  };

  constructor(){
    super();
    this.formats = [];
    this.disabled = false;
    this._custom = '';
  }

  emit(formats){
    this.formats = formats;
    this.dispatchEvent(new CustomEvent('change', {
      detail: { formats },
      bubbles: true,
      composed: true,
    }));
  }

  has = extension => this.formats.includes(extension);

  toggle = extension => () => {
    this.emit(this.has(extension)
      ? this.formats.filter(entry => entry !== extension)
      : [...this.formats, extension]);
  };

  toggleGroup = group => () => {
    const all = group.extensions.every(this.has);
    this.emit(all
      ? this.formats.filter(entry => !group.extensions.includes(entry))
      : [...new Set([...this.formats, ...group.extensions])]);
  };

  addCustom = () => {
    // Normalised the same way the server does, so ".JPG" and "jpg" cannot both end up in the list.
    const extension = this._custom.trim().replace(/^\./, '').toLowerCase();
    if(!/^[a-z0-9]{1,12}$/.test(extension) || this.has(extension)) return;
    this._custom = '';
    this.emit([...this.formats, extension]);
  };

  /*
    Anything enabled that none of the groups above lists — either typed in here, or left over from
    an older version of this list. Shown separately so it is visible rather than invisibly active.
  */
  get extras(){
    const known = new Set(GROUPS.flatMap(group => group.extensions));
    return this.formats.filter(extension => !known.has(extension));
  }

  renderChip(extension, { removable = false } = {}){
    return html`
      <label class="chip ${this.has(extension) ? 'on' : ''}">
        <input
          type="checkbox"
          .checked=${this.has(extension)}
          ?disabled=${this.disabled}
          @change=${this.toggle(extension)}
        />
        <span>.${extension}</span>
        ${removable ? html`<k-icon name="close"></k-icon>` : ''}
      </label>
    `;
  }

  render(){
    const extras = this.extras;

    return html`
      ${GROUPS.map(group => html`
        <div class="group">
          <div class="d-f head">
            <k-icon name=${group.icon}></k-icon>
            <strong class="flex">${group.name}</strong>
            <button class="small" ?disabled=${this.disabled} @click=${this.toggleGroup(group)}>
              ${group.extensions.every(this.has) ? 'None' : 'All'}
            </button>
          </div>
          <p class="small tc-muted note">${group.note}</p>
          <div class="chips">${group.extensions.map(extension => this.renderChip(extension))}</div>
        </div>
      `)}

      ${extras.length ? html`
        <div class="group">
          <div class="d-f head"><strong class="flex">Other</strong></div>
          <p class="small tc-muted note">Extensions added by hand. ffmpeg has to be able to read them.</p>
          <div class="chips">${extras.map(extension => this.renderChip(extension, { removable: true }))}</div>
        </div>
      ` : ''}

      <div class="d-f add">
        <input
          type="text"
          placeholder="Add another extension, e.g. heic"
          .value=${this._custom}
          ?disabled=${this.disabled}
          @input=${e => { this._custom = e.target.value; }}
          @keydown=${e => { if(e.key === 'Enter'){ e.preventDefault(); this.addCustom(); } }}
        />
        <button ?disabled=${this.disabled} @click=${this.addCustom}>Add</button>
      </div>
    `;
  }

  static styles = css`
    :host { display: block; }

    .group { margin-bottom: var(--spacer); }
    .head { gap: var(--spacer_h); align-items: center; }
    .note { margin: var(--spacer_q) 0 var(--spacer_h) 0; }

    .chips { display: flex; flex-wrap: wrap; gap: var(--spacer_q); }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--spacer_q);
      padding: var(--spacer_q) var(--spacer_h);
      border: 1px solid var(--c_border);
      border-radius: 999px;
      cursor: pointer;
      user-select: none;
      opacity: 0.55;
    }
    /* The whole chip is the control, so its checkbox is redundant once the state is legible from
       the chip itself. */
    .chip input { position: absolute; opacity: 0; pointer-events: none; }
    .chip.on { opacity: 1; border-color: var(--c_primary); }

    .add { gap: var(--spacer_h); align-items: center; }
    .add input { flex: 1 1 14rem; }
  `;
}

customElements.define('k-thumbs-format-picker', FormatPicker);
