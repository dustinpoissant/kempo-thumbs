import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html } from '/kempo-ui/lit-all.min.js';
import { getStatus, sweep } from '/kempo-thumbs/sdk.js';
const stat = (value, label, classes = '') => html`<div class="flex"><div class="h2 m0 ${classes}">${value}</div><div class="small tc-muted">${label}</div></div>`;

/*
  Thumbnail generation at a glance, with a button to generate whatever is missing.
*/
export default class ThumbsWidget extends DashboardWidget {
  static properties = {
    ...DashboardWidget.properties,
    counts: { state: true },
    queue: { state: true }
  };

  constructor(){
    super();
    this.counts = {};
    this.queue = {};
    this.cta = { label: 'Generate missing', icon: 'play', permission: 'thumbs:generate', onClick: () => this.generateMissing() };
  }

  /*
    Public Methods
  */

  load = async () => {
    const status = await this.unwrap(getStatus());
    this.counts = status.counts;
    this.queue = status.queue;
  };

  /*
    Event Handlers
  */

  generateMissing = async () => {
    const [error] = await sweep();
    if(error){
      this.failure = error.msg;
      return;
    }
    await this.refresh();
  };

  /*
    Rendering
  */

  renderContent(){
    if(!Object.values(this.counts).some(Boolean) && !(this.queue.queued || this.queue.active)) return html`<p class="tc-muted">No thumbnails yet.</p>`;
    const { ready = 0, pending = 0, failed = 0 } = this.counts;
    const working = (this.queue.queued || 0) + (this.queue.active || 0);
    return html`
      <div class="d-f">
        ${stat(ready, 'Ready')}
        ${stat(pending, 'Pending')}
        ${stat(failed, 'Failed', failed ? 'tc-danger' : '')}
        ${stat(working, 'Working')}
      </div>
    `;
  }
}

customElements.define('k-thumbs-widget', ThumbsWidget);
