// Guided tour: a spotlight on one part of the page at a time, with a short
// explanation card. Steps whose target is hidden (no video loaded, no batch)
// fall back to their `alt` target or are shown as a centred card.

const narrow = () => window.innerWidth <= 900;
const touch = () => matchMedia('(pointer: coarse)').matches;

const STEPS = [
  {
    title: 'Welcome to Reefhue',
    body: 'Reefhue brings back the reds and yellows that water takes away. Everything runs on this device: your photos and videos are never uploaded.<br><br>This tour takes about a minute. Use the arrow keys or the buttons to move.',
  },
  {
    target: '#addBtn',
    title: 'Add photos or videos',
    body: () => `Pick JPEG, PNG or WebP photos and MP4, MOV or WebM videos${touch() ? '' : ', or drag them anywhere onto the page'}. Pick several at once to make a batch.`,
  },
  {
    target: '.demo-links',
    title: 'No dive footage at hand?',
    body: 'Load a demo photo or a short demo clip to try everything out.',
  },
  {
    target: '#stageWrap',
    title: 'Before and after',
    body: () => `The left side is your original, the right side the restored version. Drag the divider to compare any part of the picture.${touch() ? '' : ' Hold <kbd>B</kbd> to see the whole original.'}`,
  },
  {
    target: '.toolbar .seg',
    title: 'Compare views',
    body: 'Switch between the split view, the restored picture alone, or the original alone.',
  },
  {
    target: '#transport',
    title: 'Video controls',
    body: 'Play the clip, step one frame at a time with ‹ and ›, or scrub to any moment. The preview updates frame by frame with your settings.',
    onlyIfVisible: true,
  },
  {
    target: '#presets',
    title: 'Water presets',
    body: '<b>Auto</b> measures the water in each photo or frame and corrects it, which is usually all you need. The other presets suit shallow, mid or deep blue water, green water, or a more natural or more vivid result.',
  },
  {
    target: '#looks',
    title: 'Looks',
    body: 'Creative colour grades applied on top of the correction, similar to popular Lightroom underwater presets.',
  },
  {
    target: '.panel.auto',
    title: 'What Auto detected',
    body: 'The water colour and how much red is left. For videos, Auto follows the scene as it changes. Tick <b>Keep this frame’s correction</b> to apply one frame’s correction to the whole clip instead.',
  },
  {
    target: '#sliders .group',
    title: 'Fine-tune',
    body: () => `Every slider updates the preview instantly. ${narrow() ? 'On a phone the preview stays pinned at the top while you scroll the sliders.' : 'More groups below cover light, colour, water and detail.'} Double-${touch() ? 'tap' : 'click'} a slider to reset it.`,
  },
  {
    target: '#readout',
    title: 'Check the result',
    body: 'The colour-cast plot shows how far the brightest parts are from neutral grey (the centre), before and after. The histograms and measures show contrast and colour range.',
  },
  {
    target: '#queue',
    alt: '#addBtn',
    title: 'Batch processing',
    body: () => (document.querySelector('#queue')?.hidden
      ? 'Add several files at once and a batch list appears. Each file uses Auto unless you change its settings; then <b>Process all</b> and <b>Download all (.zip)</b>.'
      : 'Tap a file to preview it and change its settings. Files you haven’t changed use Auto. <b>Process all</b> runs the whole list, then <b>Download all (.zip)</b> saves everything at once.'),
  },
  {
    target: '#thisFile',
    title: 'Settings for this file',
    body: 'Shows whether this file uses Auto or custom settings. <b>Use for all files</b> copies its settings to the rest of the batch.',
    onlyIfVisible: true,
  },
  {
    target: '#exportBtn',
    title: 'Download',
    body: () => `${document.querySelector('#exportBtn')?.hidden ? 'Once you add a photo or video, a <b>Download</b> button appears at the top. It saves' : 'Saves'} the restored file at full resolution. Videos are fully processed first, with the original sound kept, then the download starts.`,
  },
  {
    target: '.panel.foot',
    title: 'Reset and speed test',
    body: '<b>Reset to preset</b> undoes your slider changes. The speed test shows how fast this device can export video.',
  },
  {
    target: '#helpBtn',
    title: 'That’s it',
    body: 'Open this tour again any time with <b>Help</b>. Enjoy your dives!',
  },
];

const visible = (el) => el && !el.closest('[hidden]') && el.getClientRects().length > 0;

export class Tour {
  constructor() {
    this.i = 0;
    this.steps = [];
    this.raf = 0;
    this.onKey = this.onKey.bind(this);
  }

  start() {
    if (this.root) return;
    this.steps = STEPS.filter((s) => !s.onlyIfVisible || visible(document.querySelector(s.target)));
    this.returnFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourBody">
        <div class="tour-count" id="tourCount"></div>
        <h3 id="tourTitle"></h3>
        <p id="tourBody"></p>
        <div class="tour-nav">
          <button type="button" class="btn ghost small" data-t="close">Skip tour</button>
          <span class="tour-gap"></span>
          <button type="button" class="btn small" data-t="back">Back</button>
          <button type="button" class="btn primary small" data-t="next">Next</button>
        </div>
      </div>`;
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-t]')?.dataset.t;
      if (t === 'close') this.end();
      else if (t === 'back') this.go(this.i - 1);
      else if (t === 'next') this.i === this.steps.length - 1 ? this.end() : this.go(this.i + 1);
    });
    document.body.append(root);
    this.root = root;
    this.spot = root.querySelector('.tour-spot');
    this.card = root.querySelector('.tour-card');
    document.addEventListener('keydown', this.onKey, true);
    this.go(0);
    const loop = () => { this.place(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  end() {
    if (!this.root) return;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    this.root = null;
    try { localStorage.setItem('reefhue-tour-seen', '1'); } catch { /* private mode */ }
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.end(); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest?.('.tour-nav'))) { e.preventDefault(); this.i === this.steps.length - 1 ? this.end() : this.go(this.i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1); }
    else if (e.key === 'Tab') {
      // keep focus inside the card
      const f = [...this.card.querySelectorAll('button')];
      const k = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
    e.stopPropagation();
  }

  target(step) {
    for (const sel of [step.target, step.alt]) {
      const el = sel && document.querySelector(sel);
      if (visible(el)) return el;
    }
    return null;
  }

  go(i) {
    if (i < 0 || i >= this.steps.length) return;
    this.i = i;
    const step = this.steps[i];
    this.el = this.target(step);
    this.root.querySelector('#tourCount').textContent = `${i + 1} of ${this.steps.length}`;
    this.root.querySelector('#tourTitle').textContent = step.title;
    this.root.querySelector('#tourBody').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    this.root.querySelector('[data-t="back"]').disabled = i === 0;
    this.root.querySelector('[data-t="next"]').textContent = i === this.steps.length - 1 ? 'Done' : 'Next';
    this.root.classList.toggle('centred', !this.el);
    if (this.el) this.reveal(this.el);
    this.root.querySelector('[data-t="next"]').focus({ preventScroll: true });
    this.place();
  }

  /** Scroll the target into view, below the pinned preview on phones. */
  reveal(el) {
    const pane = document.getElementById('previewPane');
    const inPane = pane && pane.contains(el);
    if (narrow()) {
      const r = el.getBoundingClientRect();
      const pinned = pane && !inPane && getComputedStyle(pane).position === 'sticky' ? pane.getBoundingClientRect().height : 0;
      const header = 12;
      const card = this.card.getBoundingClientRect().height || 220;
      const room = window.innerHeight - pinned - card - 2 * header;
      const y = r.top + window.scrollY - pinned - header - Math.max(0, (room - r.height) / 2);
      window.scrollTo({ top: inPane ? Math.max(0, r.top + window.scrollY - header) : Math.max(0, y), behavior: 'instant' });
    } else {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }

  place() {
    if (!this.root) return;
    const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12, m = 12;
    const card = this.card;
    if (!this.el || !visible(this.el)) {
      this.spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
      card.style.left = `${Math.max(m, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(m, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    const r = this.el.getBoundingClientRect();
    // clip the spotlight to the viewport so tall targets stay readable
    const x0 = Math.max(4, r.left - pad), y0 = Math.max(4, r.top - pad);
    const x1 = Math.min(vw - 4, r.right + pad), y1 = Math.min(vh - 4, r.bottom + pad);
    this.spot.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.max(0, x1 - x0)}px;height:${Math.max(0, y1 - y0)}px`;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let left, top;
    if (narrow()) {
      // phones: below the target when it fits, otherwise above, otherwise docked at the bottom
      left = (vw - cw) / 2;
      if (y1 + gap + ch <= vh - m) top = y1 + gap;
      else if (y0 - gap - ch >= m) top = y0 - gap - ch;
      else top = vh - ch - m;
    } else {
      const spaces = [
        ['below', vh - y1 - gap - m - ch], ['above', y0 - gap - m - ch],
        ['left', x0 - gap - m - cw], ['right', vw - x1 - gap - m - cw],
      ].sort((a, b) => b[1] - a[1]);
      const side = spaces[0][0];
      if (side === 'below' || side === 'above') {
        left = (x0 + x1) / 2 - cw / 2;
        top = side === 'below' ? y1 + gap : y0 - gap - ch;
      } else {
        top = (y0 + y1) / 2 - ch / 2;
        left = side === 'left' ? x0 - gap - cw : x1 + gap;
      }
    }
    card.style.left = `${Math.round(Math.min(vw - cw - m, Math.max(m, left)))}px`;
    card.style.top = `${Math.round(Math.min(vh - ch - m, Math.max(m, top)))}px`;
  }
}

/** Offer the tour once, on the first visit. */
export function tourSeen() {
  try { return localStorage.getItem('reefhue-tour-seen') === '1'; } catch { return true; }
}
export function markTourSeen() {
  try { localStorage.setItem('reefhue-tour-seen', '1'); } catch { /* private mode */ }
}
