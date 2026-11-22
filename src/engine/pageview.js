// Page-side half of the page view engine (Browsa pageview, MIT). It is evaluated once per document
// in an isolated world (Page.createIsolatedWorld) and never in the main world.
//
// Rules this file keeps:
//   - it only READS the page: no attribute, node, style or listener is added
//     to anything the page owns, nothing is scrolled, nothing is focused;
//   - element ids live in a WeakMap of this world (plus id -> WeakRef), never
//     in the document;
//   - the MutationObserver / PerformanceObserver it creates belong to this
//     world; the main world has no API to enumerate them.
(() => {
  'use strict';
  if (globalThis.__pv) return 1;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const NAME_MAX = 80, TEXT_MAX = 4000, CELL_MAX = 40, ROW_CAP = 200, COVER_CAP = 500;

  const idOf = new WeakMap();   // element -> id
  const byId = new Map();       // id -> WeakRef(element)
  const via = new WeakMap();    // hidden checkbox/radio/file -> the label a person clicks
  const tidOf = new WeakMap();  // element -> key for text blocks and rows (never shown)
  const last = new WeakMap();   // element -> {r, n} from the last collect (to name coverers)
  let nextId = 1, nextTid = 1;
  let prevSeen = new Map();     // id -> [sig, sig2], document order, from the last collect

  const set = s => new Set(s.split(' '));
  const SKIP = set('SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK TITLE BASE DATALIST OPTGROUP OPTION WBR SOURCE TRACK PARAM MAP COL COLGROUP');
  const INTERACTIVE = set('link button checkbox radio switch textbox searchbox combobox listbox slider spinbutton tab menuitem menuitemcheckbox menuitemradio option treeitem file color clickable video audio');
  const FROM_CONTENT = set('link button checkbox radio switch tab menuitem menuitemcheckbox menuitemradio option treeitem heading clickable');
  const CONTAINER = set('navigation main banner contentinfo complementary search form region dialog alertdialog group radiogroup toolbar tablist menu menubar tree article feed tabpanel listbox scrollbox');
  const NEEDS_NAME = set('region group tabpanel');
  const LISTKIND = set('list listbox menu tree feed');
  const ITEMROLE = set('listitem option menuitem menuitemcheckbox menuitemradio treeitem article');
  const OTHER_LISTED = set('heading img progressbar meter');
  const INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'file', color: 'color' };

  const norm = (s, max) => {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
    return s;
  };
  const hash = s => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const isect = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  };
  const empty = r => !!r && (r[2] - r[0] < 1 || r[3] - r[1] < 1);
  const tiny = r => !!r && (r[2] - r[0] < 2 || r[3] - r[1] < 2); // text needs more than a pixel
  // The "visually hidden" patterns: clip: rect() with no area, or
  // clip-path: inset(50%).
  const clippedAway = cs => {
    const c = cs.clip;
    if (c && c !== 'auto' && cs.position !== 'static') {
      const m = /^rect\(([^)]*)\)$/.exec(c);
      if (m) {
        const n = m[1].split(/[\s,]+/).map(parseFloat); // top right bottom left
        if (n.length === 4 && (n[1] - n[3] <= 1 || n[2] - n[0] <= 1)) return true;
      }
    }
    const p = cs.clipPath;
    return !!p && p !== 'none' && /^inset\((50|100)%/.test(p);
  };
  const attr = (el, a) => el.getAttribute(a);
  const txt = el => {
    let s = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    if (!s && el.shadowRoot) s = shadowText(el.shadowRoot);
    return s || '';
  };
  const shadowText = root => {
    let s = '';
    for (const n of root.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1 && n.tagName !== 'STYLE' && n.tagName !== 'SCRIPT') s += ' ' + (typeof n.innerText === 'string' ? n.innerText : n.textContent);
    }
    return s;
  };
  // Label text without the text of controls nested in the label.
  const labelText = n => {
    let s = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !/^(SELECT|TEXTAREA|INPUT|BUTTON|SCRIPT|STYLE)$/.test(c.tagName)) s += ' ' + labelText(c);
    }
    return s;
  };
  const composedParent = n => {
    const p = n.parentNode;
    if (!p) return null;
    if (p.nodeType === 11) return p.host || null;
    if (p.nodeType === 9) { try { return p.defaultView ? p.defaultView.frameElement : null; } catch (e) { return null; } }
    return p;
  };
  const composedContains = (a, b) => {
    for (let i = 0; b && i < 400; i++, b = composedParent(b)) if (b === a) return true;
    return false;
  };
  const alive = e => { try { return e.isConnected && !!e.ownerDocument.defaultView; } catch (x) { return false; } };
  const quickVis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    try { return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) : true; } catch (e) { return true; }
  };
  const matches = (el, sel) => { try { return el.matches(sel); } catch (e) { return false; } };
  const isToggle = el => el.tagName === 'INPUT' && /^(checkbox|radio|file)$/.test(el.type);

  const parseColor = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; a && i < 20; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        let d = null; try { d = a.contentDocument; } catch (e) {}
        if (d && d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; }
      }
      break;
    }
    return a;
  }

  // Topmost element at a viewport point, descending into open shadow roots
  // and same-origin frames. Read-only hit test.
  function deepHit(x, y) {
    let e = document.elementFromPoint(x, y), ox = 0, oy = 0;
    for (let i = 0; e && i < 20; i++) {
      if (e.shadowRoot) {
        const n = e.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (n && n !== e && n.getRootNode() === e.shadowRoot) { e = n; continue; }
      }
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
        let d = null; try { d = e.contentDocument; } catch (x2) {}
        if (d) {
          const r = e.getBoundingClientRect();
          const nx = ox + r.left + e.clientLeft, ny = oy + r.top + e.clientTop;
          const n = d.elementFromPoint(x - nx, y - ny);
          if (n) { ox = nx; oy = ny; e = n; continue; }
        }
      }
      break;
    }
    return e;
  }

  // Does a pointer event on `hit` reach `target`? strict: `hit` must be the
  // target or inside it (or its label). Not strict (used when reading, where
  // the probe points are only guesses): a container of the target counts too.
  function related(target, hit, strict) {
    if (!hit) return false;
    if (composedContains(target, hit) || (!strict && composedContains(hit, target))) return true;
    const lab = hit.closest ? hit.closest('label') : null;
    if (lab && lab.control === target) return true;
    if (target.labels) for (const l of target.labels) if (composedContains(l, hit)) return true;
    return false;
  }

  function describe(hit) {
    for (let n = hit, i = 0; n && i < 400; i++, n = composedParent(n)) {
      const id = idOf.get(n), li = last.get(n);
      if (id && li && alive(n)) return { id, role: li.r, name: li.n };
    }
    let d = hit.tagName ? hit.tagName.toLowerCase() : 'node';
    if (hit.id) d += '#' + hit.id;
    else if (hit.classList && hit.classList.length) d += '.' + hit.classList[0];
    return { id: 0, desc: norm(d, 40) };
  }

  function explicitRole(el) {
    let r = attr(el, 'role');
    if (!r) return null;
    r = r.trim().split(/\s+/)[0].toLowerCase();
    if (r === 'presentation') r = 'none';
    if (r === 'image') r = 'img';
    return r;
  }

  function implicitRole(el, tag) {
    switch (tag) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'INPUT': {
        const t = el.type || 'text';
        if (t === 'hidden') return null;
        if (INPUT_ROLE[t]) return INPUT_ROLE[t];
        return el.list ? 'combobox' : 'textbox';
      }
      case 'TEXTAREA': return 'textbox';
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'IMG': return 'img';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'ASIDE': return 'complementary';
      case 'HEADER': return el.closest('article,section,main,aside,nav') ? null : 'banner';
      case 'FOOTER': return el.closest('article,section,main,aside,nav') ? null : 'contentinfo';
      case 'FORM': return 'form';
      case 'SECTION': return 'region';
      case 'ARTICLE': return 'article';
      case 'DIALOG': return 'dialog';
      case 'FIELDSET': return 'group';
      case 'UL': case 'OL': case 'MENU': return 'list';
      case 'LI': return 'listitem';
      case 'SEARCH': return 'search';
      case 'PROGRESS': return 'progressbar';
      case 'METER': return 'meter';
      case 'VIDEO': return 'video';
      case 'AUDIO': return el.controls ? 'audio' : null;
    }
    return null;
  }

  function accName(el, role, tag) {
    let s;
    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const root = el.getRootNode();
      s = norm(lb.split(/\s+/).map(id => { const e = root.getElementById ? root.getElementById(id) : null; return e ? txt(e) : ''; }).join(' '), NAME_MAX);
      if (s) return s;
    }
    s = norm(attr(el, 'aria-label'), NAME_MAX);
    if (s) return s;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'METER' || tag === 'PROGRESS') {
      if (tag === 'INPUT') {
        const t = el.type;
        if (t === 'button' || t === 'submit' || t === 'reset') return norm(el.value, NAME_MAX) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
        if (t === 'image') return norm(el.alt || el.title, NAME_MAX) || 'Submit';
      }
      const ls = el.labels;
      if (ls && ls.length) { s = norm(Array.from(ls).map(labelText).join(' '), NAME_MAX); if (s) return s; }
      return norm(el.placeholder || el.title || '', NAME_MAX);
    }
    if (tag === 'IMG' || tag === 'AREA') return norm(el.alt || el.title, NAME_MAX);
    if (tag === 'FIELDSET') { const l = el.querySelector(':scope > legend'); if (l) return norm(txt(l), NAME_MAX); }
    if (tag === 'TABLE' && el.caption) return norm(txt(el.caption), NAME_MAX);
    if (tag === 'IFRAME' || tag === 'FRAME') return norm(el.title || el.name, NAME_MAX);
    if (FROM_CONTENT.has(role)) {
      s = norm(txt(el), NAME_MAX);
      if (s) return s;
      const im = el.querySelector('img[alt]:not([alt=""])');
      if (im) return norm(im.alt, NAME_MAX);
      const d = el.querySelector('[aria-label],[title],svg title');
      if (d) { s = norm(attr(d, 'aria-label') || attr(d, 'title') || d.textContent, NAME_MAX); if (s) return s; }
    }
    s = norm(attr(el, 'title'), NAME_MAX);
    if (s) return s;
    if (role === 'dialog' || role === 'alertdialog' || role === 'region' || role === 'article') {
      const h = el.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]');
      if (h) return norm(txt(h), NAME_MAX);
    }
    return '';
  }

  function hint(el) {
    const h = attr(el, 'data-testid') || attr(el, 'name') || el.id || (el.classList && el.classList.length ? Array.from(el.classList).slice(0, 2).join('.') : '');
    return norm(h, 30);
  }

  function fillState(el, tag, role, s, win, active) {
    if (tag === 'INPUT') {
      const ty = el.type;
      if (ty === 'checkbox' || ty === 'radio') s.checked = el.indeterminate ? 'mixed' : el.checked;
      else if (ty === 'file') {
        const f = el.files;
        s.files = f && f.length ? norm(Array.from(f).map(x => x.name).join(', '), 80) : '';
        if (el.multiple) s.multiple = true;
        if (el.accept) s.accept = norm(el.accept, 40);
      } else if (ty === 'password') { s.pw = el.value.length; s.type = ty; }
      else if (ty !== 'button' && ty !== 'submit' && ty !== 'reset' && ty !== 'image') {
        s.value = norm(el.value, 80);
        if (ty !== 'text' && ty !== 'color' && ty !== 'range' && ty !== 'search' && ty !== 'number') s.type = ty;
        if (ty === 'range' || ty === 'number' || ty === 'date' || ty === 'time' || ty === 'month' || ty === 'week' || ty === 'datetime-local') {
          if (el.min) s.min = el.min;
          if (el.max) s.max = el.max;
        }
      }
      if (el.maxLength > 0 && el.maxLength < 10000) s.maxlen = el.maxLength;
    } else if (tag === 'TEXTAREA') {
      s.value = norm(el.value, 80);
      s.multiline = true;
      if (el.maxLength > 0 && el.maxLength < 10000) s.maxlen = el.maxLength;
    } else if (tag === 'SELECT') {
      const so = el.selectedOptions;
      s.value = so && so.length ? norm(Array.from(so).map(o => o.text).join(', '), 80) : '';
      s.options = el.options.length;
      if (el.multiple) s.multiple = true;
    } else if (el.isContentEditable && role === 'textbox') {
      s.value = norm(txt(el), 80);
      s.editable = true;
    } else if (tag === 'PROGRESS' || tag === 'METER') {
      s.value = String(el.value);
      if (el.max) s.max = String(el.max);
    } else if (tag === 'DETAILS' || tag === 'SUMMARY') {
      const d = tag === 'SUMMARY' ? el.parentElement : el;
      if (d && d.tagName === 'DETAILS') s.expanded = !!d.open;
    } else if (tag === 'VIDEO' || tag === 'AUDIO') {
      s.paused = !!el.paused;
    }
    if (tag === 'A' || tag === 'AREA') {
      const h = attr(el, 'href');
      if (h && !/^\s*(javascript:|#\s*$)/i.test(h)) {
        try {
          const u = new URL(el.href), loc = win.location;
          if (u.origin === loc.origin) s.href = (u.pathname === loc.pathname && u.search === loc.search && u.hash) ? u.hash : u.pathname + u.search + u.hash;
          else s.href = u.href;
        } catch (e) {}
      }
      if ((el.target || '').toLowerCase() === '_blank') s.newtab = true;
      if (el.hasAttribute('download')) s.download = true;
    }
    let a;
    if ((a = attr(el, 'aria-checked')) && s.checked === undefined) s.checked = a === 'mixed' ? 'mixed' : a === 'true';
    if ((a = attr(el, 'aria-expanded')) && (a === 'true' || a === 'false')) s.expanded = a === 'true';
    if ((a = attr(el, 'aria-pressed')) && a !== 'undefined') s.pressed = a === 'mixed' ? 'mixed' : a === 'true';
    if (attr(el, 'aria-selected') === 'true') s.selected = true;
    if ((a = attr(el, 'aria-current')) && a !== 'false') s.current = true;
    if ((a = attr(el, 'aria-haspopup')) && a !== 'false') s.popup = a === 'true' ? 'menu' : a;
    if ((a = attr(el, 'aria-valuenow')) && s.value === undefined) s.value = norm(attr(el, 'aria-valuetext') || a, 40);
    if (el.disabled === true || attr(el, 'aria-disabled') === 'true' || matches(el, ':disabled')) s.disabled = true;
    if (el.readOnly === true || attr(el, 'aria-readonly') === 'true') s.readonly = true;
    if (el.required === true || attr(el, 'aria-required') === 'true') s.required = true;
    const ai = attr(el, 'aria-invalid');
    const v = el.willValidate ? el.validity : null;
    if ((ai && ai !== 'false') || (v && !v.valid && (!v.valueMissing || matches(el, ':user-invalid')))) {
      let msg = '';
      const em = attr(el, 'aria-errormessage') || (ai && ai !== 'false' ? attr(el, 'aria-describedby') : null);
      if (em) {
        const root = el.getRootNode();
        msg = norm(em.split(/\s+/).map(id => { const e = root.getElementById ? root.getElementById(id) : null; return e ? txt(e) : ''; }).join(' '), 80);
      }
      if (!msg && v && !v.valid) msg = norm(el.validationMessage, 80);
      s.invalid = msg || true;
    }
    if (el === active) s.focused = true;
  }

  function findModal() {
    let best = null;
    let c;
    try { c = document.querySelectorAll('dialog[open],[aria-modal="true"],[role="alertdialog"]'); } catch (e) { return null; }
    for (const e of c) {
      if (!quickVis(e)) continue;
      if (e.tagName === 'DIALOG' && attr(e, 'aria-modal') !== 'true' && !matches(e, ':modal')) continue;
      best = e;
    }
    return best;
  }

  // ---- settle support -----------------------------------------------------
  let lastMut = 0, mutN = 0, lastShift = 0, idleCnt = null, recent = [], churn = new Map();
  const noisy = new WeakSet(), strikes = new WeakMap(), watched = new WeakSet();
  const isNoisy = n => { for (let i = 0; n && i < 4; i++, n = n.parentNode) if (noisy.has(n)) return true; return false; };
  const mo = new MutationObserver(recs => {
    const now = performance.now();
    let rel = 0;
    const seenT = new Set();
    for (const r of recs) {
      const t = r.target;
      if (seenT.has(t)) { rel++; continue; }
      if (isNoisy(t)) continue;
      seenT.add(t);
      rel++;
      if (idleCnt && idleCnt.size < 300) idleCnt.set(t, (idleCnt.get(t) || 0) + 1);
      if (recent.length < 400) recent.push([now, t]);
      // a node that changes again and again for more than half a second
      // is churning on its own (a clock, a ticker): stop waiting for it
      let ch = churn.get(t);
      if (!ch) { if (churn.size < 300) churn.set(t, ch = [0, now]); else continue; }
      if (++ch[0] >= 5 && now - ch[1] >= 600) noisy.add(t);
    }
    if (rel) { lastMut = now; mutN += rel; }
    if (recent.length >= 400) recent = recent.filter(x => now - x[0] < 1000);
  });
  const watch = root => {
    if (!root || watched.has(root)) return;
    watched.add(root);
    try { mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {}
  };
  watch(document);
  try {
    new PerformanceObserver(l => { if (l.getEntries().length) lastShift = performance.now(); }).observe({ type: 'layout-shift', buffered: false });
  } catch (e) {}

  // ---- captcha widgets drawn in the page's own DOM (no vendor frame) ------
  // GeeTest v3/v4 and the AWS WAF puzzle: [{k, v, p, st, q}] with k the vendor, v the GeeTest version, p the
  // puzzle kind, st 'button' | 'puzzle' | 'passed', q the puzzle's question. Read-only class and style lookups.
  function captchaWidgets(d) {
    const out = [];
    const shown = e => { try { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; } catch (x) { return false; } };
    const txt = e => (e && e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    try {
      const g4 = d.querySelector('[class*="geetest_captcha"],[class*="geetest_btn_click"],[class*="geetest_box_wrap"]');
      const g3 = g4 ? null : d.querySelector('.geetest_holder,.geetest_radar_tip,.geetest_panel,.geetest_canvas_bg');
      if (g4) {
        const w = { k: 'geetest', v: 4, p: '', st: 'button', q: '' };
        const box = d.querySelector('.geetest_box_wrap');
        const sub = d.querySelector('.geetest_subitem');
        if (d.querySelector('.geetest_lock_success') || /success/i.test(txt(d.querySelector('.geetest_btn_click')))) w.st = 'passed';
        else if (sub && (!box || shown(box)) && shown(sub)) {
          w.st = 'puzzle';
          const c = sub.classList;
          for (const k of ['slide', 'match', 'winlinze', 'nine', 'svg']) if (c.contains('geetest_' + k)) w.p = k;
          if (!w.p && c.contains('geetest_click')) {
            const bg = sub.querySelector('.geetest_bg');
            const u = bg ? bg.style.backgroundImage || '' : '';
            w.p = /\/word\//.test(u) ? 'word' : /\/phrase\//.test(u) ? 'phrase' : 'icon';
          }
          w.q = txt(d.querySelector('.geetest_text_tips'));
        }
        if (shown(g4) || w.st !== 'button') out.push(w);
      } else if (g3 && shown(g3)) {
        const w = { k: 'geetest', v: 3, p: '', st: 'button', q: '' };
        const holder = d.querySelector('.geetest_holder');
        if (holder && holder.classList.contains('geetest_radar_success')) w.st = 'passed';
        else if (d.querySelector('.geetest_canvas_bg') && shown(d.querySelector('.geetest_canvas_bg'))) w.st = 'puzzle', w.p = 'slide';
        else if (d.querySelector('.geetest_item_img,.geetest_ques_tips')) w.st = 'puzzle', w.p = 'click';
        out.push(w);
      }
      let aws = d.querySelector('.amzn-captcha-root');
      if (!aws) { const h = d.querySelector('awswaf-captcha'); aws = h && h.shadowRoot ? h.shadowRoot.querySelector('.amzn-captcha-root') : h; }
      if (aws && shown(aws)) {
        const r = aws.getRootNode ? aws.getRootNode() : d;
        const cells = r.querySelectorAll ? r.querySelectorAll('.amzn-grid-cell').length : 0;
        out.push({ k: 'aws-waf', v: 0, p: cells ? 'grid' : '', st: cells ? 'puzzle' : 'button', q: txt(r.querySelector && r.querySelector('.amzn-captcha-problem')) });
      }
      // Arkose: a shown frame of its own (at least 120 px each way) is a puzzle; its fc-token field alone is
      // "loaded".
      let ark = false;
      for (const f of d.querySelectorAll('iframe')) {
        if (!/^https?:\/\/([^/]*\.)?(arkoselabs|funcaptcha)\.com(:\d+)?\//i.test(f.src || '') || !shown(f)) continue;
        const r = f.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 120) { ark = true; break; }
      }
      if (ark) out.push({ k: 'arkose', v: 0, p: '', st: 'puzzle', q: '' });
      else if (d.querySelector('input[name="fc-token"]')) out.push({ k: 'arkose', v: 0, p: '', st: 'loaded', q: '' });
    } catch (e) {}
    return out;
  }

  // ---- collect ------------------------------------------------------------
  function collect(o) {
    o = o || {};
    const t0 = performance.now();
    const vw = innerWidth, vh = innerHeight, sx = scrollX, sy = scrollY;
    const view = [0, 0, vw, vh];
    const items = [], fresh = [], frames = [];
    const emitted = new Set(), recOf = new Map(), bgCache = new Map(), canvasCache = new Map();
    const labeled = new WeakSet(); // elements whose aria-label stood in for symbols (★★★★★)
    // elements a :hover rule opens something inside or next to (a menu that shows on hover)
    let hoverBases = null;
    const hoverable = (el) => {
      if (!hoverBases) {
        hoverBases = [];
        const visit = (rules) => {
          for (const r of rules) {
            if (!r.selectorText) { if (r.cssRules) { try { visit(r.cssRules); } catch (e) {} } continue; }
            if (r.selectorText.indexOf(':hover') < 0) continue;
            const st = r.style;
            if (!(st.display || st.visibility || st.opacity || st.maxHeight || st.height || st.transform)) continue;
            for (const part of r.selectorText.split(',')) {
              const i = part.indexOf(':hover');
              if (i <= 0 || !part.slice(i + 6).trim()) continue;
              const base = part.slice(0, i).trim();
              if (base && hoverBases.length < 200) hoverBases.push(base);
            }
          }
        };
        for (const sh of Array.from(document.styleSheets)) { try { visit(sh.cssRules); } catch (e) {} }
      }
      for (const b of hoverBases) { try { if (el.matches(b)) return true; } catch (e) {} }
      return false;
    };
    const modal = findModal();
    const active = deepActive();
    const capPats = o.cap || [];
    const expand = o.expand || 0;

    const posOf = (b, sc) => {
      const reg = isect(view, sc);
      if (!empty(reg) && b[2] > reg[0] && b[0] < reg[2] && b[3] > reg[1] && b[1] < reg[3]) return 1;
      const ref = empty(reg) ? view : reg;
      if (b[3] <= ref[1]) return 2;
      if (b[1] >= ref[3]) return 3;
      return empty(reg) ? 3 : 4;
    };

    // Effective background behind an element: [r,g,b] or null when unknown
    // (an image or gradient is involved).
    // The colour behind everything: white, or the dark canvas when the
    // document opts into a dark colour scheme and the browser prefers one.
    const canvasOf = win => {
      let c = canvasCache.get(win);
      if (c !== undefined) return c;
      c = [255, 255, 255, 1];
      try {
        let sch = win.getComputedStyle(win.document.documentElement).colorScheme || '';
        if (!sch || sch === 'normal') {
          const m = win.document.querySelector('meta[name="color-scheme" i]');
          sch = m ? (m.getAttribute('content') || '') : '';
        }
        if (/dark/.test(sch) && (!/light/.test(sch) || win.matchMedia('(prefers-color-scheme: dark)').matches)) c = [18, 18, 18, 1];
        // a frame is transparent: what is behind it is its parent's
        const fe = win.frameElement;
        if (fe && win.parent && win.parent !== win) c = effBg(fe, win.parent);
      } catch (e) {}
      canvasCache.set(win, c);
      return c;
    };
    const effBg = (el, win) => {
      const chain = [];
      let res;
      for (let n = el; n; ) {
        if (bgCache.has(n)) { res = bgCache.get(n); break; }
        chain.push(n);
        let cs; try { cs = win.getComputedStyle(n); } catch (e) { res = null; break; }
        if (cs.backgroundImage && cs.backgroundImage !== 'none') { res = null; break; }
        const c = parseColor(cs.backgroundColor);
        if (c && c[3] >= 0.5) { res = c; break; }
        const p = n.parentElement;
        if (p) { n = p; continue; }
        const root = n.getRootNode();
        n = root && root.host ? root.host : null; // out of a shadow tree
      }
      if (res === undefined) res = canvasOf(win);
      for (const n of chain) bgCache.set(n, res);
      return res;
    };

    // 0 visible, 1 invisible, 2 same colour as the ancestors' background
    // (decided per text node by looking at what is painted underneath).
    const textInvisible = (el, cs, win) => {
      if (parseFloat(cs.fontSize) < 5) return 1;
      const col = parseColor(cs.color);
      if (!col) return 0;
      if (col[3] < 0.1) return 1;
      const bg = effBg(el, win);
      if (bg && contrast(col, bg) < 1.08) return 2;
      return 0;
    };

    // For same-colour text inside the viewport: is anything painted under
    // it that would make it readable (an image, a video, another colour)?
    const paintedUnder = (x, y, col, c) => {
      let stack;
      try { stack = c.doc.elementsFromPoint(x - c.ox, y - c.oy); } catch (e) { return false; }
      for (const e of stack) {
        const tg = e.tagName;
        if (tg === 'IMG' || tg === 'VIDEO' || tg === 'CANVAS' || tg === 'svg' || tg === 'PICTURE') return true;
        let cs; try { cs = c.win.getComputedStyle(e); } catch (x2) { continue; }
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
        const b = parseColor(cs.backgroundColor);
        if (b && b[3] >= 0.5) return contrast(col, b) >= 1.08;
      }
      return false;
    };

    const newRec = (k, el, role, name, tag, c, b, v, bd) => {
      const rec = { k, el, r: role, n: name, t: tag, s: {}, b, v, P: c.P, ix: c.ix, fr: c.fr, sh: c.sh, bd };
      items.push(rec);
      return rec;
    };
    const identify = (rec, c) => {
      const el = rec.el;
      rec.sig = hash(c.sig + '|' + rec.r + '|' + rec.n);
      rec.sig2 = hash(c.sig + '|' + rec.r);
      const id = idOf.get(el);
      if (id) rec.i = id; else fresh.push(rec);
      emitted.add(el);
      recOf.set(el, rec);
    };

    const flush = blk => {
      const run = blk.run;
      if (!run) return;
      blk.run = null;
      const rec = run.rec;
      const s = norm(run.parts.join(''), TEXT_MAX);
      if (!s || !run.free) { rec.drop = true; return; }
      rec.n = s;
      rec.b = run.b;
      rec.v = run.v;
    };

    const text = (node, c) => {
      const v = node.nodeValue;
      // named === 2: this text is already the name of a button, heading,
      // label… (text inside a link, named === 1, stays in the sentence)
      if (c.noText || !c.vis || c.named === 2) return;
      if (!/\S/.test(v)) { if (c.blk.run && v.length) c.blk.run.parts.push(' '); return; }
      if (c.tinv === undefined) c.tinv = c.cs ? textInvisible(c.el, c.cs, c.win) : 0;
      if (c.tinv === 1) return;
      const rng = c.rng;
      rng.selectNodeContents(node);
      const rs = rng.getClientRects();
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.left < x1) x1 = r.left;
        if (r.top < y1) y1 = r.top;
        if (r.right > x2) x2 = r.right;
        if (r.bottom > y2) y2 = r.bottom;
      }
      if (x1 === Infinity) return;
      const b = [x1 + c.ox, y1 + c.oy, x2 + c.ox, y2 + c.oy];
      if (tiny(isect(b, c.hc))) return;
      if (b[2] <= -sx || b[3] <= -sy) return;
      const p = posOf(b, c.sc);
      if (c.tinv === 2) {
        if (p !== 1) return;
        const vb = isect(isect(b, c.hc), isect(view, c.sc));
        if (!paintedUnder((vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2, parseColor(c.cs.color), c)) return;
      }
      let run = c.blk.run;
      if (!run) {
        const be = c.blk.el;
        let tid = tidOf.get(be);
        if (!tid) { tid = nextTid++; tidOf.set(be, tid); }
        const rec = { k: 'text', el: be, key: 't' + tid + '.' + (c.blk.n++), r: 'text', n: '', s: {}, P: c.P, ix: c.ix, fr: c.fr, sh: c.sh, bd: c.bd };
        items.push(rec);
        run = c.blk.run = { rec, parts: [], free: 0, b: b.slice(), v: p };
      } else {
        const rb = run.b;
        if (b[0] < rb[0]) rb[0] = b[0];
        if (b[1] < rb[1]) rb[1] = b[1];
        if (b[2] > rb[2]) rb[2] = b[2];
        if (b[3] > rb[3]) rb[3] = b[3];
        if (p === 1) run.v = 1;
      }
      let w = v;
      // symbols only (★★★★★, ●●●○○): what the element says it means is its aria-label
      if (!c.named && !/[\p{L}\p{N}]/u.test(v)) {
        const pe = node.parentElement;
        const lab = pe && !labeled.has(pe) && pe.getAttribute('aria-label');
        if (lab && /[\p{L}\p{N}]/u.test(lab)) { labeled.add(pe); w = ' ' + lab + ' ' + v.trim() + ' '; }
      }
      run.parts.push(w);
      if (!c.named && /[\p{L}\p{N}]/u.test(w)) run.free++;
    };

    const kids = (el, c) => {
      const sr = el.shadowRoot;
      if (sr) {
        watch(sr);
        const cc = c.sh ? c : Object.assign({}, c, { sh: 1 });
        for (let n = sr.firstChild; n; n = n.nextSibling) node(n, cc);
        return;
      }
      for (let n = el.firstChild; n; n = n.nextSibling) node(n, c);
    };
    const node = (n, c) => {
      if (n.nodeType === 3) text(n, c);
      else if (n.nodeType === 1) {
        if (n.tagName === 'SLOT') {
          const as = n.assignedNodes({ flatten: true });
          if (as.length) { for (const a of as) node(a, c); return; }
        }
        walk(n, c);
      }
    };

    const table = (el, rec, c, cc) => {
      const rows = el.rows;
      const cap = (expand && rec.i === expand) || o.allRows ? Infinity : ROW_CAP;
      let vis = 0, total = 0, cols = 0;
      for (let i = 0; i < rows.length; i++) {
        const tr = rows[i];
        const r = tr.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        total++;
        if (vis >= cap) continue;
        const b = [r.left + c.ox, r.top + c.oy, r.right + c.ox, r.bottom + c.oy];
        if (empty(isect(b, cc.hc))) continue;
        const cells = [];
        let hdr = tr.cells.length > 0;
        for (const td of tr.cells) { cells.push(norm(td.innerText, CELL_MAX)); if (td.tagName !== 'TH') hdr = false; }
        if (tr.parentElement && tr.parentElement.tagName === 'THEAD') hdr = true;
        if (cells.length > cols) cols = cells.length;
        let tid = tidOf.get(tr);
        if (!tid) { tid = nextTid++; tidOf.set(tr, tid); }
        const row = { k: 'row', el: tr, key: 'r' + tid, r: 'row', n: '', s: {}, cells, hdr, b, v: posOf(b, cc.sc), P: rec, ix: vis, fr: c.fr, sh: c.sh, bd: c.bd };
        items.push(row);
        const rc = Object.assign({}, cc, { noText: true, ix: vis, blk: { el: tr, run: null, n: 0 } });
        for (const td of tr.cells) walk(td, rc);
        vis++;
      }
      rec.s.rows = total;
      rec.s.cols = cols;
    };

    const walk = (el, c) => {
      const tag = el.tagName;
      if (SKIP.has(tag)) return;
      if (tag === 'BR') { if (c.blk.run) c.blk.run.parts.push(' '); return; }
      const win = c.win;
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return; }
      const disp = cs.display;
      if (disp === 'none') return;
      if (attr(el, 'aria-hidden') === 'true') return;
      if (+cs.opacity < 0.05) return;
      if (clippedAway(cs)) return;
      const isSvg = el.namespaceURI === SVGNS;
      const vis = cs.visibility === 'visible';
      let r = el.getBoundingClientRect();
      if ((r.width <= 0 || r.height <= 0) && el.firstElementChild && !isSvg && disp !== 'contents') {
        // an inline wrapper around floated/absolute content: use its children
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, k = 0;
        for (let ch = el.firstElementChild; ch && k < 6; ch = ch.nextElementSibling, k++) {
          const q = ch.getBoundingClientRect();
          if (q.width <= 0 || q.height <= 0) continue;
          x1 = Math.min(x1, q.left); y1 = Math.min(y1, q.top); x2 = Math.max(x2, q.right); y2 = Math.max(y2, q.bottom);
        }
        if (x1 !== Infinity && (cs.overflowX === 'visible' || disp.startsWith('inline'))) r = { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1, synth: 1 };
      }
      const pos = cs.position;
      let hc = c.hc, sc = c.sc;
      if (pos === 'fixed') { hc = c.fhc; sc = c.fsc; }
      else if (pos === 'absolute') { hc = c.ahc; sc = c.asc; }
      const b = [r.left + c.ox, r.top + c.oy, r.right + c.ox, r.bottom + c.oy];
      const hasBox = r.width > 0 && r.height > 0;
      const vb = isect(b, hc);
      const perceivable = vis && hasBox && !tiny(vb) && !(b[2] <= -sx || b[3] <= -sy);
      const inModal = c.inModal || el === modal;
      const inert = c.inert || el.hasAttribute('inert');
      const bd = inert || (modal && !inModal) ? 1 : 0;

      // context for this element's children
      const cc = {
        win, doc: c.doc, rng: c.rng, ox: c.ox, oy: c.oy, el, cs, vis,
        hc, sc, ahc: c.ahc, asc: c.asc, fhc: c.fhc, fsc: c.fsc,
        P: c.P, ix: c.ix, sig: c.sig, named: c.named, inter: c.inter, blk: c.blk,
        fr: c.fr, sh: c.sh, bd, inert, inModal, noText: c.noText,
        list: c.list, inItem: c.inItem, cur: cs.cursor, tinv: undefined,
      };
      const myBd = bd, cIn = c;

      const er = explicitRole(el);
      let role = er && er !== 'none' ? er : implicitRole(el, tag);
      if (er === 'none' && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(tag)) role = null;
      if (el === modal && role !== 'alertdialog') role = 'dialog';

      // clipping for descendants
      const root = el === c.doc.documentElement || el === c.doc.body;
      let scrollBox = false;
      if (!root && hasBox && !r.synth && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
        const scrollable = (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1);
        if (scrollable) cc.sc = isect(sc, b); else cc.hc = isect(hc, b);
        // a box that scrolls on its own (a log, a chat): listed, so it can be scrolled by id
        scrollBox = scrollable && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 && r.height >= 60;
      } else if (!root && !hasBox && cs.overflowX !== 'visible' && cs.overflowY !== 'visible' && disp !== 'contents' && !disp.startsWith('inline')) {
        cc.hc = [0, 0, 0, 0]; // a collapsed box that clips: nothing inside is painted
      }
      if (pos !== 'static' || cs.transform !== 'none') { cc.ahc = cc.hc; cc.asc = cc.sc; }
      if (cs.transform !== 'none') { cc.fhc = cc.hc; cc.fsc = cc.sc; }
      if (scrollBox && !role) role = 'scrollbox';

      const isBlock = !(disp.startsWith('inline') || disp === 'contents');
      if (isBlock) { flush(c.blk); cc.blk = { el, run: null, n: 0 }; }

      // list item index for truncating long lists
      if (c.list && !c.inItem && (role ? ITEMROLE.has(role) : false)) { cc.ix = c.list.count++; cc.inItem = true; }

      let rec = null, descend = true;
      const box = () => [Math.round(b[0]), Math.round(b[1]), Math.round(b[2] - b[0]), Math.round(b[3] - b[1])];

      if (isSvg) {
        if (tag === 'svg' && perceivable && !c.named && !c.inter && !c.noText) {
          const t = el.querySelector(':scope > title');
          const nm = norm(attr(el, 'aria-label') || (t ? t.textContent : ''), NAME_MAX);
          if (nm) { rec = newRec('el', el, 'img', nm, 'svg', cIn, box(), posOf(b, sc), bd); identify(rec, c); }
        }
        if (isBlock) flush(cc.blk);
        return;
      }

      if (tag === 'LEGEND' && el.parentElement && el.parentElement.tagName === 'FIELDSET') {
        cc.named = 2; // the legend is the group's name
      } else if (cs.contentVisibility === 'hidden') {
        descend = false;
      }
      if (tag === 'DETAILS' && !el.open) {
        // a closed <details> paints only its summary
        descend = false;
        const sm = el.querySelector(':scope > summary');
        if (sm) walk(sm, cc);
      } else if (tag === 'LABEL') {
        const ctl = el.control;
        if (ctl && perceivable && isToggle(ctl) && !emitted.has(ctl) && !quickVis(ctl)) {
          // the real control is hidden and the label is what a person clicks
          const cr = implicitRole(ctl, 'INPUT');
          rec = newRec('el', ctl, cr, accName(ctl, cr, 'INPUT'), 'INPUT', cIn, box(), posOf(b, sc), bd);
          fillState(ctl, 'INPUT', cr, rec.s, win, active);
          rec.vb = isect(vb, isect(view, sc));
          rec.tg = el;
          via.set(ctl, el);
          identify(rec, c);
          cc.named = 2;
        } else if (ctl && (emitted.has(ctl) || quickVis(ctl))) cc.named = 2;
      } else if (tag === 'IFRAME' || tag === 'FRAME') {
        descend = false;
        if (perceivable) {
          let d = null;
          try { d = el.contentDocument; } catch (e) {}
          const name = accName(el, 'frame', tag);
          if (d && d.documentElement) {
            rec = newRec('c', el, 'frame', name, tag, cIn, box(), posOf(b, sc), bd);
            identify(rec, c);
            frames.push({ rec, name, same: true });
            watch(d);
            const fx = b[0] + el.clientLeft, fy = b[1] + el.clientTop;
            const fb = [fx, fy, fx + el.clientWidth, fy + el.clientHeight];
            const fsc = isect(sc, fb);
            const fc = {
              win: el.contentWindow, doc: d, rng: d.createRange(), ox: fx, oy: fy, el: d.documentElement, cs: null, vis: true,
              hc, sc: fsc, ahc: hc, asc: fsc, fhc: hc, fsc,
              P: rec, ix: -1, sig: rec.sig, named: false, inter: false, blk: { el: d.documentElement, run: null, n: 0 },
              fr: name || 'frame', sh: 0, bd: myBd, inert, inModal, noText: c.noText, list: null, inItem: false, cur: 'auto', tinv: undefined,
            };
            walk(d.documentElement, fc);
            flush(fc.blk);
          } else {
            let origin = '';
            const src = el.src || '';
            try { origin = src ? new URL(src).origin : ''; } catch (e) {}
            let kind = '';
            for (const p of capPats) if (src.indexOf(p[0]) >= 0) { kind = p[1]; break; }
            rec = newRec('el', el, kind ? 'captcha' : 'frame', kind || name, tag, cIn, box(), posOf(b, sc), bd);
            rec.s.origin = origin || (el.hasAttribute('srcdoc') ? 'srcdoc' : 'about:blank');
            rec.s.size = el.clientWidth + 'x' + el.clientHeight;
            rec.s.opaque = true;
            rec.vb = isect(vb, isect(view, sc));
            identify(rec, c);
            frames.push({ rec, name: kind || name, same: false, origin: rec.s.origin });
          }
        }
      } else if (tag === 'CANVAS') {
        descend = false;
        if (perceivable && r.width >= 8 && r.height >= 8 && !c.noText) {
          rec = newRec('el', el, 'canvas', accName(el, 'canvas', tag), tag, cIn, box(), posOf(b, sc), bd);
          rec.s.size = Math.round(r.width) + 'x' + Math.round(r.height);
          rec.s.opaque = true;
          identify(rec, c);
        }
      } else if (tag === 'SELECT') {
        descend = false;
        if (perceivable) {
          rec = newRec('el', el, role, accName(el, role, tag), tag, cIn, box(), posOf(b, sc), bd);
          fillState(el, tag, role, rec.s, win, active);
          const lim = expand && idOf.get(el) === expand ? 1000 : 50;
          rec.o = [];
          for (let i = 0; i < el.options.length && i < lim; i++) rec.o.push(norm(el.options[i].text, 40));
          rec.vb = isect(vb, isect(view, sc));
          identify(rec, c);
        }
      } else if (tag === 'TABLE' && er !== 'none' && (er === 'table' || er === 'grid' || (!el.querySelector('table') && (el.tHead || el.caption || el.querySelector('th'))))) {
        descend = false;
        if (vis && hasBox) {
          rec = newRec('c', el, 'table', accName(el, 'table', tag), tag, cIn, box(), posOf(b, sc), bd);
          identify(rec, c);
          const tc = Object.assign({}, cc, { P: rec, ix: -1, sig: rec.sig });
          table(el, rec, c, tc);
        }
      } else if (tag === 'IMG') {
        descend = false;
        if (perceivable && !c.named && (!c.noText || cs.cursor === 'pointer')) {
          const nm = accName(el, 'img', tag);
          const click = !c.inter && (cs.cursor === 'pointer' && c.cur !== 'pointer' || el.hasAttribute('onclick'));
          if (nm || click) {
            rec = newRec('el', el, 'img', nm, tag, cIn, box(), posOf(b, sc), bd);
            if (click) { rec.s.clickable = true; rec.vb = isect(vb, isect(view, sc)); if (!nm) rec.s.hint = hint(el); }
            identify(rec, c);
          }
        }
      } else {
        // generic path: interactive elements, headings, containers
        const editable = el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
        if (editable && (!role || !INTERACTIVE.has(role))) role = 'textbox';
        let interactive = role ? INTERACTIVE.has(role) : false;
        if (role === 'listbox' && tag !== 'SELECT') interactive = false;
        let clickable = false;
        if (!interactive && !c.inter && tag !== 'LABEL' && tag !== 'BODY' && tag !== 'HTML' && perceivable) {
          const ti = attr(el, 'tabindex');
          if (el.hasAttribute('onclick') || (ti !== null && +ti >= 0) || (cs.cursor === 'pointer' && c.cur !== 'pointer') || hoverable(el)) {
            if (r.width * r.height < 0.7 * vw * vh) clickable = true;
          }
        }
        if (clickable && (!role || !(CONTAINER.has(role) || LISTKIND.has(role) || OTHER_LISTED.has(role)))) { role = 'clickable'; interactive = true; clickable = false; }

        if (interactive) {
          if (perceivable && !emitted.has(el)) {
            const full = FROM_CONTENT.has(role) ? norm(txt(el)) : '';
            const nm = accName(el, role, tag);
            rec = newRec('el', el, role, nm, tag, cIn, box(), posOf(b, sc), bd);
            fillState(el, tag, role, rec.s, win, active);
            if (!nm) { const h = hint(el); if (h) rec.s.hint = h; }
            rec.vb = isect(vb, isect(view, sc));
            via.delete(el);
            identify(rec, c);
            cc.inter = true;
            cc.sig = rec.sig;
            // the name carries the content only when it carries all of it
            if (FROM_CONTENT.has(role) && full.length <= NAME_MAX) cc.named = role === "link" ? (c.named || 1) : 2;
            if (editable) descend = false;
          }
          if (tag === 'TEXTAREA' || tag === 'INPUT') descend = false;
        } else if (role === 'heading' || role === 'progressbar' || role === 'meter') {
          if (perceivable && !c.noText) {
            const nm = accName(el, role, tag);
            if (nm || role !== 'heading') {
              rec = newRec('el', el, role, nm, tag, cIn, box(), posOf(b, sc), bd);
              if (role === 'heading') { rec.s.level = /^H[1-6]$/.test(tag) ? +tag[1] : +(attr(el, 'aria-level') || 2); if (norm(txt(el)).length <= NAME_MAX) cc.named = 2; }
              else fillState(el, tag, role, rec.s, win, active);
              if (clickable) { rec.s.clickable = true; rec.vb = isect(vb, isect(view, sc)); cc.inter = true; }
              identify(rec, c);
              cc.sig = rec.sig;
            }
          }
        } else if (role && (CONTAINER.has(role) || LISTKIND.has(role))) {
          const nm = accName(el, role, tag);
          if (vis && (nm || !NEEDS_NAME.has(role))) {
            const isList = LISTKIND.has(role);
            rec = newRec(isList ? 'l' : 'c', el, role, nm, tag, cIn, box(), posOf(b, sc), bd);
            if (clickable) { rec.s.clickable = true; }
            if (el === modal) rec.s.modal = true;
            identify(rec, c);
            cc.P = rec; cc.ix = -1; cc.sig = rec.sig;
            if (isList) { cc.list = { count: 0 }; cc.inItem = false; rec.list = cc.list; }
          }
        } else if (tag.indexOf('-') > 0 && !el.shadowRoot && perceivable && !el.firstElementChild && !/\S/.test(el.textContent) && r.width >= 8 && r.height >= 8 && !c.noText) {
          // a custom element that paints something but exposes no tree:
          // most likely a closed shadow root
          rec = newRec('el', el, 'custom', tag.toLowerCase(), tag, cIn, box(), posOf(b, sc), bd);
          rec.s.size = Math.round(r.width) + 'x' + Math.round(r.height);
          rec.s.opaque = true;
          identify(rec, c);
          descend = false;
        }
      }

      if (descend) kids(el, cc);
      if (isBlock) flush(cc.blk);
    };

    const d = document;
    const c0 = {
      win: window, doc: d, rng: d.createRange(), ox: 0, oy: 0, el: d.documentElement, cs: null, vis: true,
      hc: null, sc: null, ahc: null, asc: null, fhc: null, fsc: null,
      P: null, ix: -1, sig: 'root', named: false, inter: false, blk: { el: d.documentElement, run: null, n: 0 },
      fr: '', sh: 0, bd: 0, inert: false, inModal: false, noText: false, list: null, inItem: false, cur: 'auto', tinv: undefined,
    };
    if (d.documentElement) { walk(d.documentElement, c0); flush(c0.blk); }

    // ---- ids: keep, re-associate, or allocate ---------------------------
    const adopt = (rec, id) => { rec.i = id; idOf.set(rec.el, id); byId.set(id, new WeakRef(rec.el)); };
    let rm = 0;
    if (fresh.length && prevSeen.size) {
      const gone = new Map(), gone2 = new Map();
      for (const [id, sg] of prevSeen) {
        const w = byId.get(id), e = w ? w.deref() : null;
        if (e && alive(e)) continue;
        let a = gone.get(sg[0]); if (!a) gone.set(sg[0], a = []); a.push(id);
      }
      if (gone.size) {
        const fg = new Map();
        for (const rec of fresh) { let a = fg.get(rec.sig); if (!a) fg.set(rec.sig, a = []); a.push(rec); }
        for (const [sig, rs] of fg) {
          const g = gone.get(sig);
          if (g && g.length === rs.length) { rs.forEach((rec, i) => adopt(rec, g[i])); rm += rs.length; gone.delete(sig); }
        }
        // same role and place but another name: only when there is exactly one on each side
        for (const [sig, ids] of gone) for (const id of ids) { const s2 = prevSeen.get(id)[1]; let a = gone2.get(s2); if (!a) gone2.set(s2, a = []); a.push(id); }
        const f2 = new Map();
        for (const rec of fresh) if (!rec.i) { let a = f2.get(rec.sig2); if (!a) f2.set(rec.sig2, a = []); a.push(rec); }
        for (const [s2, rs] of f2) { const g = gone2.get(s2); if (g && g.length === 1 && rs.length === 1) { adopt(rs[0], g[0]); rm++; } }
      }
    }
    for (const rec of fresh) if (!rec.i) adopt(rec, nextId++);
    prevSeen = new Map();
    for (const rec of items) if (rec.i && !rec.drop) { prevSeen.set(rec.i, [rec.sig, rec.sig2]); last.set(rec.el, { r: rec.r, n: rec.n }); }
    if (byId.size > 20000) for (const [id, w] of byId) if (!w.deref()) byId.delete(id);

    // ---- covered? (in-viewport interactive elements only) ---------------
    let checks = 0;
    for (const rec of items) {
      if (rec.k !== 'el' || rec.v !== 1 || rec.bd || !rec.vb || empty(rec.vb) || checks >= COVER_CAP) continue;
      checks++;
      const q = rec.vb, tg = rec.tg || rec.el;
      const pts = [[(q[0] + q[2]) / 2, (q[1] + q[3]) / 2], [q[0] + Math.min(4, (q[2] - q[0]) / 2), q[1] + Math.min(4, (q[3] - q[1]) / 2)], [q[2] - Math.min(4, (q[2] - q[0]) / 2), q[3] - Math.min(4, (q[3] - q[1]) / 2)]];
      let hit = null, free = false;
      for (const p of pts) {
        const h = deepHit(p[0], p[1]);
        if (!h || related(tg, h)) { free = true; break; }
        if (!hit) hit = h;
      }
      if (free || !hit) continue;
      let by = null;
      for (let n = hit, i = 0; n && i < 400; i++, n = composedParent(n)) { const rr = recOf.get(n); if (rr && rr.i) { by = rr; break; } }
      if (by) rec.cov = by.i;
      else { const dsc = describe(hit); if (dsc.id) rec.cov = dsc.id; else rec.covd = dsc.desc; }
    }

    // ---- output ---------------------------------------------------------
    const out = [];
    for (const rec of items) {
      if (rec.drop) continue;
      const it = { k: rec.k, r: rec.r, n: rec.n };
      if (rec.i) it.i = rec.i;
      if (rec.key) it.key = rec.key;
      if (rec.t) it.t = rec.t.toLowerCase();
      for (const k in rec.s) { it.s = rec.s; break; }
      if (rec.b) it.b = rec.k === 'text' || rec.k === 'row' ? [Math.round(rec.b[0]), Math.round(rec.b[1]), Math.round(rec.b[2] - rec.b[0]), Math.round(rec.b[3] - rec.b[1])] : rec.b;
      it.v = rec.v;
      if (rec.P && rec.P.i) it.p = rec.P.i;
      if (rec.ix >= 0) it.ix = rec.ix;
      if (rec.fr) it.fr = rec.fr;
      if (rec.sh) it.sh = 1;
      if (rec.bd) it.bd = 1;
      if (rec.cells) it.c = rec.cells;
      if (rec.hdr) it.h = 1;
      if (rec.o) it.o = rec.o;
      if (rec.cov) it.cov = rec.cov;
      if (rec.covd) it.covd = rec.covd;
      if (rec.list) it.cnt = rec.list.count;
      out.push(it);
    }
    const de = d.documentElement, bo = d.body;
    const a = active ? idOf.get(active) : 0;
    return JSON.stringify({
      u: location.href, ti: d.title, sx: Math.round(sx), sy: Math.round(sy), vw, vh,
      pw: Math.max(de ? de.scrollWidth : 0, bo ? bo.scrollWidth : 0), ph: Math.max(de ? de.scrollHeight : 0, bo ? bo.scrollHeight : 0),
      foc: a && recOf.has(active) ? a : 0, modal: modal && recOf.get(modal) ? recOf.get(modal).i : 0,
      rm, ms: Math.round(performance.now() - t0), ld: d.readyState === 'loading' ? 1 : 0, items: out,
      frames: frames.map(f => ({ i: f.rec.i, n: f.name, same: f.same, o: f.origin || '' })),
      cw: captchaWidgets(d),
    });
  }

  // ---- helpers used by actions (all read-only) ----------------------------
  const elOf = id => { const w = byId.get(id); const e = w ? w.deref() : null; return e || null; };

  globalThis.__pv = {
    collect,
    // element to aim at for a click (the label when the control itself is hidden)
    t(id) { const e = elOf(id); if (!e) return null; const l = via.get(e); return l && alive(l) ? l : e; },
    el(id) { return elOf(id); },
    // reverse lookup: the id of an element seen by the last collect, 0 when none
    id(e) { return (e && idOf.get(e)) || 0; },
    // facts needed before acting on an element
    pre(id) {
      const e = elOf(id);
      if (!e) return JSON.stringify({ err: byId.has(id) || id < nextId ? 'element gone' : 'unknown id' });
      if (!alive(e)) return JSON.stringify({ err: 'element gone' });
      const li = last.get(e) || {};
      const tg = via.get(e) && alive(via.get(e)) ? via.get(e) : e;
      const r = tg.getBoundingClientRect();
      const out = { role: li.r || '', name: li.n || '', tag: e.tagName, type: e.type || '' };
      if (r.width <= 0 || r.height <= 0 || !(tg.checkVisibility ? tg.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) : true)) out.err = 'not visible';
      else if (e.disabled === true || attr(e, 'aria-disabled') === 'true' || matches(e, ':disabled')) out.err = 'disabled';
      if (e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')) out.checked = e.checked;
      else if (attr(e, 'aria-checked')) out.checked = attr(e, 'aria-checked') === 'true';
      if (e.tagName === 'SELECT') {
        out.sel = e.selectedIndex; out.multiple = e.multiple;
        out.opts = Array.from(e.options).map(o => ({ t: norm(o.text), v: o.value, d: o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled) }));
      }
      if (typeof e.value === 'string') { out.len = e.value.length; try { out.selAll = e.selectionStart === 0 && e.selectionEnd === e.value.length; } catch (x) {} }
      out.editable = !!e.isContentEditable;
      const act = deepActive();
      out.focused = !!act && (act === e || composedContains(e, act));
      out.mac = /Mac/.test(navigator.platform);
      return JSON.stringify(out);
    },
    // is a click at (x, y) going to land on element `id`? `hit` is the node
    // the browser's own hit test returned, when it could be resolved here.
    hit(id, hit, x, y) {
      const e = elOf(id);
      if (!e) return JSON.stringify({ ok: false, gone: true });
      const tg = via.get(e) && alive(via.get(e)) ? via.get(e) : e;
      if (hit && hit.nodeType !== 1) hit = hit.parentElement;
      if (!hit) hit = deepHit(x, y);
      if (!hit || related(tg, hit, true) || related(e, hit, true)) return JSON.stringify({ ok: true });
      // the point is on a container of the element: the element is not
      // there (it moved, or it does not take pointer events)
      if (composedContains(hit, tg)) return JSON.stringify({ ok: false, miss: true });
      return JSON.stringify({ ok: false, by: describe(hit) });
    },
    // settle support
    q() {
      const now = performance.now();
      let an = 0;
      try {
        for (const a of document.getAnimations()) {
          if (a.playState !== 'running' || !a.effect) continue;
          const t = a.effect.getComputedTiming();
          if (!isFinite(t.endTime)) continue;
          const left = t.endTime - (t.localTime || 0);
          if (left > 0 && left < 1500) an++;
        }
      } catch (e) {}
      return [lastMut ? Math.round(now - lastMut) : -1, mutN, Math.round(scrollX), Math.round(scrollY), lastShift ? Math.round(now - lastShift) : -1, an, document.readyState === 'loading' ? 0 : 1];
    },
    // called right before an action: whatever kept changing while nothing
    // was being done is noise for settle detection from now on
    mark() {
      if (idleCnt) {
        for (const [t, n] of idleCnt) {
          const k = (strikes.get(t) || 0) + 1;
          strikes.set(t, k);
          if (n >= 3 || k >= 2) noisy.add(t);
        }
      }
      idleCnt = null; mutN = 0; lastMut = 0; lastShift = 0; recent = []; churn = new Map();
      return 1;
    },
    idle() { idleCnt = new Map(); return 1; },
    // the cap was hit: what is still changing is noise next time
    capNoisy() { const now = performance.now(); let n = 0; for (const x of recent) if (now - x[0] < 600) { noisy.add(x[1]); n++; } return n; },
    text() { return document.body ? document.body.innerText : ''; },
  };
  return 0;
})()
