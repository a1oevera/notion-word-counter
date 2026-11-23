(() => {
  // One counter per page. If another copy is added later (the extension reloaded, or
  // the background script filled in a tab), the newest copy takes over.
  const me = {};
  window.__notionWordCounter = me;
  document.getElementById('notion-word-counter')?.remove();

  let dead = false;
  let observer = null;
  let backstop = null;

  function alive() {
    if (dead) return false;
    let ok = false;
    try {
      ok = window.__notionWordCounter === me && !!chrome.runtime?.id;
    } catch (_) {}
    if (!ok) {
      dead = true;
      host.remove();
      if (observer) observer.disconnect();
      clearInterval(backstop);
    }
    return ok;
  }

  // ---------- counting ----------

  // Split on whitespace and en/em dashes; a token counts as a word if it has a letter or digit.
  const SPLIT = /[\s–—]+/;
  const WORDISH = /[\p{L}\p{N}]/u;
  const READ_WPM = 238; // average adult silent reading speed
  const SPEAK_WPM = 140; // comfortable presentation pace
  const WORDS_PER_PAGE = 500; // single-spaced, 12 pt, 1" margins

  const ABBREV = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e|approx|Fig)\.\s*$/i;
  const sentenceSeg =
    typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

  function stats(text) {
    let words = 0;
    for (const tok of text.split(SPLIT)) if (WORDISH.test(tok)) words++;

    let paragraphs = 0;
    for (const line of text.split('\n')) if (WORDISH.test(line)) paragraphs++;

    let sentences = 0;
    if (sentenceSeg) {
      // The segmenter splits after "Dr." / "Mr." etc.; don't start a new sentence there.
      let prev = '';
      for (const { segment } of sentenceSeg.segment(text)) {
        if (WORDISH.test(segment) && !ABBREV.test(prev)) sentences++;
        prev = segment;
      }
    } else {
      sentences = (text.match(/[.!?…]+(?=\s|$)/g) || []).length;
    }

    return {
      words,
      chars: Array.from(text.replace(/\n/g, '')).length,
      charsNoSpaces: Array.from(text.replace(/\s/g, '')).length,
      paragraphs,
      sentences,
    };
  }

  const fmt = (n) => n.toLocaleString();
  const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

  function fmtPages(words) {
    const p = words / WORDS_PER_PAGE;
    if (p === 0) return '0';
    if (p < 0.1) return '<0.1';
    return p.toFixed(1).replace(/\.0$/, '');
  }

  function fmtTime(words, wpm) {
    const secs = Math.round((words / wpm) * 60);
    if (secs < 60) return `${secs} sec`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  }

  const ROWS = [
    ['Pages (est.)', (s) => fmtPages(s.words)],
    ['Words', (s) => fmt(s.words)],
    ['Characters', (s) => fmt(s.chars)],
    ['Characters excluding spaces', (s) => fmt(s.charsNoSpaces)],
    ['Paragraphs', (s) => fmt(s.paragraphs)],
    ['Sentences', (s) => fmt(s.sentences)],
    ['Reading time', (s) => fmtTime(s.words, READ_WPM)],
    ['Speaking time', (s) => fmtTime(s.words, SPEAK_WPM)],
  ];

  // ---------- reading the Notion page ----------

  // Notion can show several pages at once (split view, side peek, center peek). Each has
  // its own .notion-page-content, and we follow whichever one you're working in.
  function visibleRoots() {
    const all = [...document.querySelectorAll('.notion-page-content')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  }

  // Which page a node belongs to. Walks up until it reaches the pane holding exactly one
  // page, so clicks on a page's title or header count too. Sidebar clicks return null.
  function rootFor(node, roots) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    for (; el; el = el.parentElement) {
      let found = null;
      let n = 0;
      for (const r of roots) if (el.contains(r)) (found = r), n++;
      if (n === 1) return found;
      if (n > 1) return null;
    }
    return null;
  }

  let activeRoot = null;
  const seenRoots = new WeakSet();

  function currentRoot(roots, hint) {
    const fresh = roots.filter((r) => !seenRoots.has(r));
    for (const r of fresh) seenRoots.add(r);

    if (hint) activeRoot = hint;
    // A page that just appeared (opened a peek or split, navigated) becomes the one we follow.
    else if (fresh.length) activeRoot = fresh[fresh.length - 1];

    if (!activeRoot || !roots.includes(activeRoot)) {
      activeRoot =
        roots.find((r) => r.closest('.notion-peek-renderer')) ||
        roots.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a), roots[0]) ||
        null;
    }
    return activeRoot;
  }

  // Clicking or typing in a page makes it the one we count.
  function noteInteraction(e) {
    if (e.target === host) return;
    const r = rootFor(e.target, visibleRoots());
    if (r && r !== activeRoot) {
      activeRoot = r;
      schedule();
    }
  }

  // Block selection (drag across blocks / Esc / Shift+arrows): Notion draws a blue
  // "halo" inside each selected block instead of making a real text selection.
  function blockSelectionText(root) {
    const blocks = new Set();
    for (const halo of root.querySelectorAll('.notion-selectable-halo')) {
      const block = halo.closest('[data-block-id]');
      if (block) blocks.add(block);
    }
    if (!blocks.size) return '';

    // Drop blocks nested inside another selected block so text isn't counted twice.
    const all = [...blocks];
    const top = all.filter((b) => !all.some((o) => o !== b && o.contains(b)));
    return top.map((b) => b.innerText).join('\n');
  }

  function isDarkBackground() {
    if (document.body.classList.contains('notion-dark-theme')) return true;
    for (const el of [document.querySelector('.notion-frame'), document.querySelector('.notion-app-inner'), document.body]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m) continue;
      const [r, g, b, a = 1] = m.map(Number);
      if (a === 0) continue;
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let lastTotalText = null;
  let lastTotalStats = null;

  // Everything the widget and the toolbar popup display.
  function measure() {
    const dark = isDarkBackground();
    const roots = visibleRoots();

    // Find the highlight first: whichever page it's in is the page we total.
    let picked = '';
    let hint = null;
    const s = window.getSelection();
    if (s && !s.isCollapsed) {
      const t = s.toString();
      if (t.trim()) {
        picked = t;
        hint = rootFor(s.anchorNode, roots);
      }
    }
    if (!picked) {
      const ordered = activeRoot && roots.includes(activeRoot) ? [activeRoot, ...roots.filter((r) => r !== activeRoot)] : roots;
      for (const r of ordered) {
        const t = blockSelectionText(r);
        if (t) {
          picked = t;
          hint = r;
          break;
        }
      }
    }

    const root = currentRoot(roots, hint);
    if (!root) return { hasPage: false, selecting: false, dark, rows: [], main: '— words', sub: 'no page open' };

    const text = root.innerText;
    if (text !== lastTotalText) {
      lastTotalText = text;
      lastTotalStats = stats(text);
    }
    const total = lastTotalStats;
    const sel = picked ? stats(picked) : null;

    const rows = ROWS.map(([label, f]) => ({ label, value: sel ? `${f(sel)} of ${f(total)}` : f(total) }));
    const main = sel
      ? `${fmt(sel.words)} of ${fmt(total.words)} ${plural(total.words, 'word')}`
      : `${fmt(total.words)} ${plural(total.words, 'word')}`;
    const sub = sel
      ? `${fmt(sel.chars)} of ${fmt(total.chars)} ${plural(total.chars, 'character')}`
      : `${fmt(total.chars)} ${plural(total.chars, 'character')}`;

    return { hasPage: true, selecting: !!sel, dark, rows, main, sub };
  }

  // ---------- widget ----------

  const host = document.createElement('div');
  host.id = 'notion-word-counter';
  Object.assign(host.style, { position: 'fixed', right: '64px', bottom: '16px', zIndex: '2147483000' });

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .box {
        font: 13px/1.35 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
        padding: 7px 11px;
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        white-space: nowrap;
        background: #fff;
        color: #37352f;
        box-shadow: 0 0 0 1px rgba(15,15,15,.06), 0 3px 8px rgba(15,15,15,.12);
        transition: background .15s, color .15s;
      }
      .box.dark {
        background: #252525;
        color: rgba(255,255,255,.88);
        box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 3px 8px rgba(0,0,0,.4);
      }
      .box.dragging { cursor: grabbing; }

      .main { font-weight: 600; font-variant-numeric: tabular-nums; }
      .sub  { font-size: 11.5px; opacity: .65; font-variant-numeric: tabular-nums; }
      .box.selecting .main { color: #2383e2; }

      .full { display: none; padding: 3px 1px; }
      .box.expanded .compact { display: none; }
      .box.expanded .full { display: block; }

      .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .title { font-weight: 600; }
      .badge {
        font-size: 11px; font-weight: 500; color: #2383e2;
        background: rgba(35,131,226,.12); padding: 1px 6px; border-radius: 4px;
        visibility: hidden;
      }
      .box.selecting .badge { visibility: visible; }

      .grid { display: grid; grid-template-columns: auto auto; column-gap: 20px; row-gap: 5px; }
      .label { opacity: .65; }
      .value { text-align: right; font-weight: 500; font-variant-numeric: tabular-nums; }
      .box.selecting .value { color: #2383e2; }
    </style>
    <div class="box" title="Click for all stats · drag to move">
      <div class="compact">
        <div class="main"></div>
        <div class="sub"></div>
      </div>
      <div class="full">
        <div class="head"><span class="title">Word count</span><span class="badge">Selection</span></div>
        <div class="grid"></div>
      </div>
    </div>`;

  const box = shadow.querySelector('.box');
  const mainEl = shadow.querySelector('.main');
  const subEl = shadow.querySelector('.sub');
  const gridEl = shadow.querySelector('.grid');

  let hidden = false;
  let expanded = false;
  let lastKey = '';

  function render(state) {
    const key = JSON.stringify(state) + expanded;
    if (key === lastKey) return;
    lastKey = key;

    mainEl.textContent = state.main;
    subEl.textContent = state.sub;

    gridEl.replaceChildren();
    if (!state.hasPage) {
      const none = document.createElement('div');
      none.className = 'label';
      none.textContent = 'No page open';
      gridEl.append(none);
    }
    for (const { label, value } of state.rows) {
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'value';
      v.textContent = value;
      gridEl.append(l, v);
    }

    box.classList.toggle('selecting', state.selecting);
    box.classList.toggle('dark', state.dark);
    box.classList.toggle('expanded', expanded);
    applyPos();
  }

  function update() {
    if (!alive()) return;
    if (!host.isConnected) document.body.appendChild(host);
    if (hidden) return;
    render(measure());
  }

  // Throttle: Notion mutates the DOM constantly while you type.
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      update();
    }, 120);
  }

  // ---------- position (anchored bottom-right so the panel grows up and left) ----------

  let anchor = { right: 64, bottom: 16 };

  function applyPos() {
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const right = Math.max(4, Math.min(anchor.right, window.innerWidth - w - 4));
    const bottom = Math.max(4, Math.min(anchor.bottom, window.innerHeight - h - 4));
    host.style.right = `${right}px`;
    host.style.bottom = `${bottom}px`;
  }

  function setExpanded(v) {
    expanded = v;
    chrome.storage.local.set({ expanded });
    update();
  }

  // Keep clicks on the widget from stealing focus or clearing your Notion selection.
  box.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = host.getBoundingClientRect();
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    box.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!dragging) {
        dragging = true;
        box.classList.add('dragging');
      }
      anchor = { right: startRight - dx, bottom: startBottom - dy };
      applyPos();
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      box.classList.remove('dragging');
      if (dragging) {
        anchor = { right: parseFloat(host.style.right), bottom: parseFloat(host.style.bottom) };
        chrome.storage.local.set({ anchor });
      } else {
        setExpanded(!expanded);
      }
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });

  window.addEventListener('resize', applyPos);

  // ---------- settings + toolbar popup ----------

  function applyHidden(v) {
    hidden = !!v;
    host.style.display = hidden ? 'none' : '';
    if (!hidden) {
      lastKey = '';
      update();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hidden) applyHidden(changes.hidden.newValue);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || !alive()) return;
    if (msg.type === 'nwc-ping') reply(true);
    else if (msg.type === 'nwc-stats') reply(measure());
  });

  // ---------- start ----------

  document.body.appendChild(host);
  update();

  chrome.storage.local.get(['anchor', 'hidden', 'expanded'], (saved) => {
    if (saved.anchor) anchor = saved.anchor;
    expanded = !!saved.expanded;
    lastKey = '';
    applyHidden(saved.hidden);
  });

  // The widget lives in a shadow root, so its own text changes don't retrigger this observer.
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener('pointerdown', noteInteraction, true);
  document.addEventListener('focusin', noteInteraction, true);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('pointerup', schedule, true);
  document.addEventListener('keyup', schedule, true);
  // Backstop in case a selection change slips past the events above.
  backstop = setInterval(() => {
    if (document.visibilityState === 'visible') update();
  }, 2000);
})();
