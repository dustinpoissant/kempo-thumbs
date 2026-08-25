import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import '/kempo-ui/components/Spinner.js';
import { html, css } from '/kempo-ui/lit-all.min.js';
import { getStatus } from '/kempo-thumbs/sdk.js';

/*
  Whether this extension is actually working, and what it is doing right now.

  The ffmpeg banner is the reason this component exists. Everything else about a misconfigured
  install looks like "thumbnails just aren't appearing", and the true cause — a binary that is not
  on the server — is invisible from anywhere else in the admin. Saying it plainly at the top of the
  screen is worth more than the counts below it.

  Polls only while there is something in flight. A settings screen sitting open on an idle site
  should not be making a request every two seconds forever.
*/
export default class Status extends ShadowComponent {
  static properties = {
    canGenerate: { type: Boolean, attribute: 'can-generate' },
    _status: { state: true },
    _busy: { state: true },
  };

  constructor(){
    super();
    this.canGenerate = false;
    this._status = null;
    this._busy = false;
  }

  connectedCallback(){
    super.connectedCallback();
    this.refresh();
  }

  disconnectedCallback(){
    super.disconnectedCallback();
    clearTimeout(this._timer);
  }

  refresh = async () => {
    const [error, data] = await getStatus();
    if(!error) this._status = data;

    clearTimeout(this._timer);
    /*
      Two seconds while work is moving, thirty when it is not. The queue is in-process and can drain
      between polls, so the fast cadence is what makes the counts look live rather than stale.
    */
    const working = (data?.queue?.queued || 0) + (data?.queue?.active || 0) > 0;
    this._timer = setTimeout(this.refresh, working ? 2000 : 30000);
  };

  act = (name, body) => async () => {
    this._busy = true;
    try {
      this.dispatchEvent(new CustomEvent(name, { detail: body, bubbles: true, composed: true }));
    } finally {
      this._busy = false;
      // The action queues work rather than doing it, so what changes is the queue depth.
      setTimeout(this.refresh, 250);
    }
  };

  renderFfmpeg(){
    const { ffmpeg, ffprobe } = this._status;

    if(!ffmpeg.available){
      return html`
        <div class="banner error">
          <k-icon name="error"></k-icon>
          <div>
            <strong>ffmpeg was not found.</strong>
            No thumbnails can be generated until it is installed on the server, or until the ffmpeg
            path below points at it.
            <span class="small d-b tc-muted">Tried <code>${ffmpeg.path}</code> — ${ffmpeg.error}</span>
          </div>
        </div>
      `;
    }

    if(!ffprobe.available){
      return html`
        <div class="banner warn">
          <k-icon name="warning"></k-icon>
          <div>
            <strong>ffprobe was not found.</strong>
            Thumbnails are still generated, but their dimensions are not recorded — which means no
            <code>srcset</code>.
          </div>
        </div>
      `;
    }

    return html`
      <p class="small tc-muted mb0"><k-icon name="check_circle"></k-icon> ${ffmpeg.version}</p>
    `;
  }

  renderCount(label, value, tone = ''){
    return html`
      <div class="count ${tone}">
        <span class="value">${value}</span>
        <span class="small tc-muted">${label}</span>
      </div>
    `;
  }

  render(){
    if(!this._status) return html`<k-spinner></k-spinner>`;

    const { counts, queue } = this._status;
    const working = queue.queued + queue.active > 0;

    return html`
      ${this.renderFfmpeg()}

      <div class="counts">
        ${this.renderCount('ready', counts.ready)}
        ${this.renderCount('pending', counts.pending)}
        ${this.renderCount('failed', counts.failed, counts.failed ? 'bad' : '')}
        ${this.renderCount('skipped', counts.skipped)}
      </div>

      ${working ? html`
        <p class="small mb">
          <k-spinner size="xs"></k-spinner>
          Working — ${queue.active} running, ${queue.queued} queued.
        </p>
      ` : ''}

      ${this.canGenerate ? html`
        <div class="d-f actions">
          <button ?disabled=${this._busy} @click=${this.act('generate-missing')}>
            <k-icon name="add"></k-icon> Generate missing
          </button>
          <button ?disabled=${this._busy} @click=${this.act('regenerate-all')}>
            <k-icon name="replay"></k-icon> Regenerate everything
          </button>
          <button ?disabled=${this._busy} @click=${this.act('clean-orphans')}>
            <k-icon name="delete_sweep"></k-icon> Clean up orphans
          </button>
        </div>
      ` : ''}
    `;
  }

  static styles = css`
    :host { display: block; }

    .banner {
      display: flex;
      gap: var(--spacer_h);
      align-items: flex-start;
      padding: var(--spacer_h);
      margin-bottom: var(--spacer);
      border-radius: var(--radius);
      border: 1px solid currentColor;
    }
    /* Literal colors rather than kempo-css utilities: every utility there is !important, so a
       class would win over anything this component's own rules try to say afterwards. */
    .banner.error { color: var(--c_danger); }
    .banner.warn { color: var(--c_warning); }

    .counts { display: flex; flex-wrap: wrap; gap: var(--spacer); margin-bottom: var(--spacer); }
    .count { display: flex; flex-direction: column; }
    .count .value { font-size: 1.6rem; line-height: 1.1; }
    .count.bad .value { color: var(--c_danger); }

    .actions { gap: var(--spacer_h); align-items: center; }
  `;
}

customElements.define('k-thumbs-status', Status);
