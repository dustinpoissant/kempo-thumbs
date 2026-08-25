import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html, css } from '/kempo-ui/lit-all.min.js';

/*
  The sizes editor.

  This is the setting that most needed a screen of its own. As raw JSON in kempo's generic settings
  table it is a single-line text field holding a nested array — editable in the sense that a hex
  editor is editable, and one missing brace away from silently generating nothing.

  A control surface, not a store: it holds the working copy while it is being edited and reports
  changes upward. Saving belongs to the page.
*/
export default class SizeList extends ShadowComponent {
  static properties = {
    sizes: { type: Array },
    outputFormat: { type: String, attribute: 'output-format' },
    disabled: { type: Boolean },
  };

  constructor(){
    super();
    this.sizes = [];
    this.outputFormat = 'webp';
    this.disabled = false;
  }

  emit(){
    this.dispatchEvent(new CustomEvent('change', {
      detail: { sizes: this.sizes },
      bubbles: true,
      composed: true,
    }));
  }

  /*
    Not `update` and not `remove`: the first is Lit's own reactive-update lifecycle hook and the
    second is `Element.prototype.remove`. Overriding either compiles and runs perfectly happily —
    and then the component renders nothing at all, with no error anywhere, because Lit calls
    `this.update()` expecting the thing that draws the template.
  */
  setField(index, field, value){
    this.sizes = this.sizes.map((size, i) => (i === index ? { ...size, [field]: value } : size));
    this.emit();
  }

  addSize = () => {
    /*
      A new row starts blank rather than pre-filled with a plausible size. A prefilled 320x320 that
      someone saves without reading is a size they did not choose, and it costs a real encode on
      every file in the library.
    */
    this.sizes = [...this.sizes, { label: '', width: 0, height: 0, fit: 'cover' }];
    this.emit();
  };

  removeAt = index => () => {
    this.sizes = this.sizes.filter((_, i) => i !== index);
    this.emit();
  };

  /*
    The same rules the server enforces, shown while typing rather than as a 400 after saving. The
    server is still the authority — this only means the mistake is visible where it is made.
  */
  problem(size, index){
    if(!String(size.label || '').trim()) return 'Needs a label';
    if(!/^[a-z0-9][a-z0-9_-]{0,23}$/i.test(size.label)) return 'Letters, numbers, - and _ only';
    if(this.sizes.some((other, i) => i !== index && other.label.toLowerCase() === size.label.toLowerCase())){
      return 'Two sizes cannot share a label';
    }
    if(size.fit !== 'contain' && (!size.width || !size.height)) return `${size.fit} needs both a width and a height`;
    if(!size.width && !size.height) return 'Needs a width or a height';
    return null;
  }

  renderRow(size, index){
    const problem = this.problem(size, index);

    return html`
      <div class="row">
        <label class="field label-field">
          <span class="small tc-muted">Label</span>
          <input
            type="text"
            .value=${size.label ?? ''}
            placeholder="sm"
            ?disabled=${this.disabled}
            @input=${e => this.setField(index, 'label', e.target.value)}
          />
        </label>

        <label class="field">
          <span class="small tc-muted">Width</span>
          <input
            type="number" min="0" max="8192"
            .value=${String(size.width ?? 0)}
            ?disabled=${this.disabled}
            @input=${e => this.setField(index, 'width', Number(e.target.value))}
          />
        </label>

        <label class="field">
          <span class="small tc-muted">Height</span>
          <input
            type="number" min="0" max="8192"
            .value=${String(size.height ?? 0)}
            ?disabled=${this.disabled}
            @input=${e => this.setField(index, 'height', Number(e.target.value))}
          />
        </label>

        <label class="field fit-field">
          <span class="small tc-muted">Fit</span>
          <select
            .value=${size.fit || 'cover'}
            ?disabled=${this.disabled}
            @change=${e => this.setField(index, 'fit', e.target.value)}
          >
            <option value="cover">Cover — fill and crop</option>
            <option value="contain">Contain — fit inside</option>
            <option value="pad">Pad — fit and pad out</option>
          </select>
        </label>

        <div class="field remove-field">
          <span class="small tc-muted">&nbsp;</span>
          <button
            class="danger"
            title="Remove this size"
            ?disabled=${this.disabled}
            @click=${this.removeAt(index)}
          ><k-icon name="delete"></k-icon></button>
        </div>

        ${problem ? html`<p class="small problem full mb0">${problem}</p>` : html`
          <p class="small tc-muted example full mb0">
            <code>hero.jpg</code> → <code>hero-${size.label}.${this.outputFormat}</code>${
              size.fit === 'contain'
                ? html` — up to ${size.width || '∞'}×${size.height || '∞'}, never upscaled`
                : html` — exactly ${size.width}×${size.height}`
            }
          </p>
        `}
      </div>
    `;
  }

  render(){
    return html`
      ${this.sizes.length
        ? this.sizes.map((size, index) => this.renderRow(size, index))
        : html`<p class="small tc-muted mb">No sizes are configured, so nothing will be generated.</p>`}

      <button ?disabled=${this.disabled} @click=${this.addSize}>
        <k-icon name="add"></k-icon> Add a size
      </button>
    `;
  }

  static styles = css`
    :host { display: block; }

    /* Wraps rather than scrolls: four fields plus a button is more than a narrow admin column
       holds, and a horizontal scrollbar on a settings form hides the field nobody looked for. */
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacer_h);
      align-items: flex-end;
      padding: var(--spacer_h);
      margin-bottom: var(--spacer_h);
      border: 1px solid var(--c_border);
      border-radius: var(--radius);
    }

    .field { display: flex; flex-direction: column; gap: var(--spacer_q); }
    .field input, .field select { width: 100%; }
    .label-field { flex: 1 1 7rem; }
    .fit-field { flex: 2 1 12rem; }
    .remove-field { flex: 0 0 auto; }
    .field input[type="number"] { width: 6rem; }

    .example, .problem { flex-basis: 100%; }
    /* Literal color, not a utility class: kempo-css utilities are all !important, so a class here
       could not be overridden by anything this component does later. */
    .problem { color: var(--c_danger); }
  `;
}

customElements.define('k-thumbs-size-list', SizeList);
