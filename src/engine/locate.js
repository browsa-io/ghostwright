// Ghostwright locators. Runs in the same isolated world as pageview.js,
// after it. Read-only, like pageview.js: nothing is added to the page.
//
//   __gw.loc(id)        -> locators for an element: css, text, xpath, near, within
//   __gw.find(target)   -> pageview ids matched by each locator
//   __gw.dom(spec)      -> rows read with css + fields (the recipe "extract from page")
//   __gw.pageJson()     -> JSON documents embedded in the page
//   __gw.compileCss(rows, fields) -> css + fields that read the same rows back, or null
(() => {
  'use strict';
  if (globalThis.__gw) return 1;
  const pv = globalThis.__pv;
  const SEP = ' >>> ';
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = el => norm(typeof el.innerText === 'string' ? el.innerText : el.textContent);
  const esc = s => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, c => '\\' + c));
  const qa = (root, sel) => { try { return Array.from(root.querySelectorAll(sel)); } catch (e) { return []; } };
  const numForm = /^-?\d[\d.,]*$/;
  const holdsForm = (text, form) => {
    const f = String(form).toLowerCase();
    if (!numForm.test(f)) return text.includes(f);
    for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) {
      const b = text[i - 1] || ' ', a = text[i + f.length] || ' ';
      if (!/[\d\p{L}-]/u.test(b) && !/\d/.test(a) && !(/[.,]/.test(a) && /\d/.test(text[i + f.length + 1] || ''))) return true;
    }
    return false;
  };
  // the innermost element under root that holds a value, when one selector by tag and class reads
  // it in every row; else null (the value is then read from the row's own text)
  const segOf = e => e.tagName.toLowerCase() + Array.from(e.classList || []).filter(c => stableClass(c)).slice(0, 2).map(c => '.' + esc(c)).join('');
  const leafIn = (row, forms, rows) => {
    let el = row;
    for (let d = 0; d < 30; d++) {
      const next = Array.from(el.children).find(c => forms.some(f => holdsForm(norm(c.textContent).toLowerCase(), f)));
      if (!next) break;
      el = next;
    }
    if (el === row) return null;
    const sel = segOf(el);
    return rows.every(r => qa(r, sel).length === 1) && qa(row, sel)[0] === el ? { sel, el } : null;
  };
  const stableId = v => v && v.length < 64 && !/\d{4,}|^[\d-]|[:.]|^(ember|react|radix|mui|headlessui)/i.test(v);
  const stableClass = c => c && c.length < 40 && !/\d{3,}|^(css|sc|jsx|svelte|tw|_)-?[a-z0-9]{4,}$|^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,}$|hover|focus|active|selected|open|show|visible|hidden/i.test(c);

  // selector of `el` inside its own root (document or shadow root)
  function local(el) {
    const root = el.getRootNode();
    const unique = sel => qa(root, sel).length === 1;
    const tag = el.tagName.toLowerCase();
    if (el.id && stableId(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const sel = tag + '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]';
        if (unique(sel)) return sel;
      }
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n !== el && n.id && stableId(n.id) && qa(root, '#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
      let seg = t;
      const cls = Array.from(n.classList || []).filter(stableClass).slice(0, 2);
      if (cls.length) seg += '.' + cls.map(esc).join('.');
      const p = n.parentElement;
      if (p) {
        const same = Array.from(p.children).filter(c => c.tagName === n.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
      if (t === 'html') break;
    }
    return parts.join(' > ');
  }

  // css that crosses open shadow roots: "host-sel >>> inner-sel"
  function cssFor(el) {
    const segs = [];
    for (let n = el; n; ) {
      segs.unshift(local(n));
      const r = n.getRootNode();
      n = r && r.host ? r.host : null;
    }
    return segs.join(SEP);
  }

  function qsDeep(sel, doc) {
    let roots = [doc || document];
    const parts = String(sel).split(SEP);
    let found = [];
    for (let i = 0; i < parts.length; i++) {
      found = [];
      for (const r of roots) found.push(...qa(r, parts[i]));
      if (i < parts.length - 1) roots = found.map(e => e.shadowRoot).filter(Boolean);
    }
    return found;
  }

  function xpathFor(el) {
    if (el.getRootNode() !== document) return '';
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      const p = n.parentElement;
      let i = 1;
      if (p) for (const c of p.children) { if (c === n) break; if (c.tagName === n.tagName) i++; }
      parts.unshift(t + '[' + i + ']');
    }
    return '/' + parts.join('/');
  }

  // What a control says of itself: its text, label, placeholder, title.
  function ownTexts(el) {
    const out = [textOf(el), el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('title')];
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) out.push(el.value);
    for (const l of Array.from(el.labels || [])) out.push(textOf(l));
    const lab = el.closest && el.closest('label');
    if (lab) out.push(textOf(lab));
    return out.map(norm).filter(Boolean).sort((a, b) => b.length - a.length);
  }
  const kindOf = el => el.tagName + '|' + ((el.getAttribute && el.getAttribute('type')) || '') + '|' + ((el.getAttribute && el.getAttribute('role')) || '') + '|' + (ownTexts(el)[0] || '').toLowerCase();
  // The controls on the page that say the same of themselves as el ("Compare" in every card,
  // "Delete" in every row).
  function alike(el) {
    const root = el.getRootNode();
    const k = kindOf(el);
    const all = qa(root, el.tagName.toLowerCase());
    if (all.length > 400) return null; // too many to tell apart this way
    return all.filter(o => o !== el && kindOf(o) === k);
  }
  const less = (t, own) => { let rest = t; for (const o of own) rest = rest.split(o).join(' '); return norm(rest); };
  // The text of el's own item, beyond what el says of itself: the largest container that holds
  // no other control like it ("Model A 13-inch $999" for the "Compare" box of Model A's card).
  // Empty when no other control is like el: nothing needs telling apart.
  function withinText(el) {
    const like = alike(el);
    if (!like || !like.length) return '';
    let box = null;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (like.some(o => a.contains(o))) break;
      box = a;
    }
    if (!box) return '';
    const rest = less(textOf(box), ownTexts(el));
    return /[\p{L}\p{N}]/u.test(rest) ? rest.slice(0, 120) : '';
  }
  // The text around el now, to compare with a recorded withinText: its item as above, or, when
  // no other control is like it, the smallest container with about as much text as was recorded.
  function aroundText(el, wantLen) {
    const like = alike(el);
    const own = ownTexts(el);
    let box = null;
    if (like && like.length) {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        if (like.some(o => a.contains(o))) break;
        box = a;
      }
    } else {
      let a = el.parentElement;
      for (let i = 0; a && a !== document.documentElement && i < 8; i++, a = a.parentElement) {
        box = a;
        if (less(textOf(a), own).length >= wantLen) break;
      }
    }
    return box ? less(textOf(box), own).slice(0, 2000) : '';
  }
  // visible text of the closest heading, legend or label before the element
  function nearText(el) {
    const hs = qa(document, 'h1,h2,h3,h4,h5,h6,[role=heading],legend,label');
    let best = '';
    for (const h of hs) {
      if (h.contains(el)) continue;
      const pos = h.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) { const t = textOf(h); if (t && t.length <= 60) best = t; }
    }
    return best;
  }

  // the pageview id of el, or of its closest listed ancestor
  function idUp(el) {
    for (let n = el, i = 0; n && i < 6; i++) {
      const id = pv.id(n);
      if (id) return id;
      const r = n.parentNode;
      n = r && r.nodeType === 11 ? r.host : r;
    }
    return 0;
  }

  function* walkDeep(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = w.currentNode; n; n = w.nextNode()) {
      if (n.nodeType === 1) {
        yield n;
        if (n.shadowRoot) yield* walkDeep(n.shadowRoot);
      }
    }
  }

  // what a control says it does: labels, ids, whether it submits, its form (read only)
  const CARD = /(^|[^a-z])(cc-(number|csc|exp)|card.?(number|num|no)|cardnumber|cvc|cvv|csc|security.?code|expir)/i;
  const isSubmit = c => (c.tagName === 'BUTTON' && (!c.getAttribute('type') || c.type === 'submit')) || (c.tagName === 'INPUT' && /^(submit|image)$/i.test(c.type));
  function formOf(c) { return c && (c.form || (c.closest && c.closest('form'))) || null; }
  function cardForm(form) {
    if (!form) return false;
    for (const e of Array.from(form.elements || [])) {
      const s = [e.getAttribute && e.getAttribute('autocomplete'), e.name, e.id, e.getAttribute && e.getAttribute('aria-label'), e.placeholder].join(' ');
      if (CARD.test(s)) return true;
    }
    return false;
  }
  // money is in play for control c: a price in its own label, its form or its close container,
  // card fields in its form, or a checkout, cart, payment, billing or pricing page
  const PRICE = /([$€£¥₩₽]\s?\d|\d[\d.,]*\s?(€|eur|usd|gbp|chf|kr|zł|руб)(?![a-z])|\/\s?(mo|month|yr|year)\b|per (month|year|night|day|week|seat|user)\b|\bbilled (monthly|yearly|annually)\b)/i;
  const MONEY_URL = /(^|[/._-])(checkout|cart|basket|payment|payments|billing|purchase|pricing|plans?|upgrade|premium|order|orders)([/._?-]|$)/i;
  // the page says money is taken now: "will be charged to Visa 4242", "is taken from your card today", "billed today"
  const CHARGE_NOW = /\b(will be|is|are|gets?|being) (charged|taken|billed|debited|deducted|withdrawn)\b|\b(charged|billed|debited) (today|now|immediately)\b|\bdue (today|now)\b|\b(charge|bill|debit)s? (your|my|the) (card|account)\b/i;
  const NO_CHARGE = /\b(not|never|won't|will not|nothing (will be|is)|no) (be )?(charged|billed|taken|debited)\b|\bno charge\b|\bfree\b.{0,20}\b(today|now)\b/i;
  const chargeIn = t => !!t && CHARGE_NOW.test(t) && PRICE.test(t) && !NO_CHARGE.test(t);
  function chargeNowOf(c, form) {
    try {
      if (form) { const t = textOf(form); if (t.length < 3000 && chargeIn(t)) return true; }
      let box = c.parentElement;
      for (let i = 0; box && i < 3 && box !== document.body; i++, box = box.parentElement) { const t = textOf(box); if (t.length > 600) break; if (chargeIn(t)) return true; }
      const t = textOf(document.body);
      return t.length <= 1500 && chargeIn(t);
    } catch (e) { return false; }
  }
  function moneyOf(c, form) {
    if (cardForm(form)) return true;
    try { if (MONEY_URL.test(location.pathname) || (form && MONEY_URL.test(form.getAttribute('action') || ''))) return true; } catch (e) {}
    if (PRICE.test(textOf(c))) return true;
    // its close container (a plan's card, a product's box), never the whole page
    let box = form || c.parentElement;
    for (let i = 0; box && i < 3 && !form && box !== document.body && box !== document.documentElement; i++) { const t = textOf(box); if (t.length > 600) break; if (PRICE.test(t)) return true; box = box.parentElement; }
    if (form) { const t = textOf(form); if (t.length < 3000 && PRICE.test(t)) return true; }
    // a small page that states a price or a total (a confirmation step, a ticket, a top-up): the whole page is the context
    try { const t = textOf(document.body); if (t.length <= 1500 && PRICE.test(t)) return true; } catch (e) {}
    return false;
  }
  // A purchase form that a script submits while an action runs (a click on a box whose handler
  // calls requestSubmit()) is stopped here, before the page's own handlers see the event.
  let armed = null, tripped = '';
  const labelNorm = t => ' ' + String(t || '').toLowerCase().replace(/&/g, ' and ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}$€£¥₩₽]+/gu, ' ').trim() + ' ';
  document.addEventListener('submit', e => {
    if (!armed || Date.now() > armed.until) return;
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    let why = '';
    if (cardForm(form)) why = 'a form with card fields';
    else {
      const subs = Array.from(form.elements || []).filter(isSubmit);
      for (const s of subs) {
        for (const l of [s.getAttribute('aria-label'), s.tagName === 'INPUT' ? s.value : '', textOf(s)]) {
          if (!l || l.length > 90) continue;
          const m = armed.hard.exec(labelNorm(l)) || armed.exact.exec(labelNorm(l));
          if (m) { why = m[0].trim(); break; }
        }
        if (why) break;
      }
      if (!why && !subs.length && armed.action.test(form.getAttribute('action') || '')) why = 'a submit of ' + form.getAttribute('action');
    }
    if (why) { e.preventDefault(); e.stopImmediatePropagation(); tripped = why; }
  }, true);

  function factsOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const c = el.closest ? (el.closest('a,button,[role=button],[role=link],input,summary,label') || el) : el;
    const g = a => c.getAttribute(a) || '';
    const text = textOf(c);
    const form = formOf(c);
    return {
      tag: c.tagName.toLowerCase(), role: g('role'), type: g('type').toLowerCase(),
      labels: [g('aria-label'), c.tagName === 'INPUT' ? (c.value || '') : '', g('title'), g('alt'), text.length <= 90 ? text : ''],
      ids: [c.id || '', g('name'), g('data-testid'), g('data-test')],
      submit: isSubmit(c), cardForm: cardForm(form), money: moneyOf(c, form), chargeNow: chargeNowOf(c, form), inForm: !!form,
      passive: (c.tagName === 'INPUT' && !/^(submit|button|image|reset)$/i.test(c.type)) || c.tagName === 'LABEL' || c.tagName === 'SELECT' || c.tagName === 'TEXTAREA',
      action: form ? (form.getAttribute('action') || '') : '',
      frameId: (c.tagName === 'IFRAME' || c.tagName === 'FRAME') ? pv.id(c) : 0,
    };
  }
  function atPoint(x, y) {
    let e = document.elementFromPoint(x, y);
    for (let i = 0; e && e.shadowRoot && i < 10; i++) {
      const n = e.shadowRoot.elementFromPoint(x, y);
      if (!n || n === e) break;
      e = n;
    }
    return e;
  }
  // the focused element, through shadow roots and same-origin frames; null and
  // unreadable=true when focus is inside a frame this world cannot read
  function deepFocus() {
    let a = document.activeElement;
    for (let i = 0; a && i < 20; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        let d = null; try { d = a.contentDocument; } catch (e) { d = null; }
        if (!d) return { el: a, unreadable: true };
        if (d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; }
      }
      break;
    }
    return { el: a, unreadable: false };
  }

  globalThis.__gw = {
    // facts for the purchase guard: the element (or the focused one), and the submit controls of its form
    facts(id, x, y, withForm) {
      const out = [];
      let el;
      if (id) el = pv.t(id);
      else if (x || y) el = atPoint(x, y);
      else {
        const f = deepFocus();
        if (f.unreadable) return JSON.stringify([{ tag: 'iframe', labels: [], ids: [], unreadableFrame: true, frameId: pv.id(f.el) }]);
        el = f.el;
      }
      const f = factsOf(el);
      if (f) out.push(f);
      if (withForm && el) {
        const form = formOf(el);
        // form.elements: also the controls placed outside the form with form="..."
        const subs = form ? Array.from(form.elements || []).filter(isSubmit) : [];
        for (const s of subs) { const fs = factsOf(s); if (fs) out.push(fs); }
        // Enter in a form with no submit control submits it all the same (implicit submission)
        if (form && !subs.length) {
          const t = textOf(form);
          out.push({ tag: 'form', role: '', type: 'submit', labels: [], ids: [form.id || '', form.getAttribute('name') || ''], submit: true, implicit: true,
            cardForm: cardForm(form), money: t.length < 3000 && PRICE.test(t), chargeNow: chargeNowOf(form, form), action: form.getAttribute('action') || '' });
        }
      }
      return JSON.stringify(out);
    },
    arm(p) {
      try { armed = p ? { hard: new RegExp(p.hard), exact: new RegExp(p.exact), action: new RegExp(p.action, 'i'), until: Date.now() + 10000 } : null; } catch (e) { armed = null; }
      tripped = '';
      return 1;
    },
    tripped() { const t = tripped; tripped = ''; armed = null; return t; },
    loc(id) {
      const el = pv.el(id);
      if (!el) return JSON.stringify(null);
      const t = textOf(el);
      // the css from this world's top document: same-origin frames on the way come first ("iframe >>> button")
      let full = cssFor(el);
      try {
        for (let d = el.ownerDocument, i = 0; d !== document && d.defaultView && d.defaultView.frameElement && i < 8; i++) {
          const fe = d.defaultView.frameElement;
          full = cssFor(fe) + SEP + full;
          d = fe.ownerDocument;
        }
      } catch (e) {}
      return JSON.stringify({
        full,
        css: cssFor(el),
        text: t && t.length <= 60 ? t : '',
        xpath: xpathFor(el),
        near: nearText(el),
        within: withinText(el),
      });
    },
    find(tg) {
      const out = { css: [], text: [], xpath: [], near: [] };
      if (tg.css) out.css = [...new Set(qsDeep(tg.css).map(idUp).filter(Boolean))];
      if (tg.xpath) {
        try {
          const r = document.evaluate(tg.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength; i++) { const id = idUp(r.snapshotItem(i)); if (id) out.xpath.push(id); }
        } catch (e) {}
      }
      if (tg.text) {
        const want = norm(tg.text).toLowerCase();
        const hits = [];
        for (const el of walkDeep(document.documentElement)) {
          if (!pv.id(el)) continue;
          if (textOf(el).toLowerCase() === want) hits.push(el);
        }
        // keep the innermost matches
        out.text = hits.filter(h => !hits.some(o => o !== h && h.contains(o))).map(e => pv.id(e));
      }
      const cands = [...new Set([...out.css, ...out.text, ...out.xpath, ...(tg.among || [])])];
      if (tg.near) {
        const want = norm(tg.near).toLowerCase();
        out.near = cands.filter(id => { const e = pv.el(id); return e && nearText(e).toLowerCase() === want; });
      }
      if (tg.within) {
        // the text around each candidate now, for the caller to compare with the recorded one
        out.within = {};
        for (const id of cands.slice(0, 60)) { const e = pv.el(id); if (e) out.within[id] = aroundText(e, String(tg.within).length); }
      }
      return JSON.stringify(out);
    },
    dom(spec) {
      const pick = (root, s) => {
        let sel = s, at = null;
        const i = s.lastIndexOf('@');
        if (i >= 0 && !s.slice(i).includes(']')) { at = s.slice(i + 1).trim(); sel = s.slice(0, i).trim(); }
        const el = sel === '' || sel === '.' ? root : root.querySelector(sel);
        if (!el) return null;
        if (!at) return textOf(el);
        if ((at === 'href' || at === 'src') && el[at]) return String(el[at]);
        return el.getAttribute(at);
      };
      const roots = spec.css ? qa(document, spec.css).slice(0, spec.limit || 1000) : [document.body];
      if (!spec.fields) return JSON.stringify(roots.map(textOf));
      const elOf = (root, s) => { const i = s.lastIndexOf('@'); const sel = i >= 0 && !s.slice(i).includes(']') ? s.slice(0, i).trim() : s; return sel === '' || sel === '.' ? root : root.querySelector(sel); };
      // the header of the table column a value is read from
      const headerOf = el => {
        const cell = el && el.closest ? el.closest('td,th') : null;
        const table = cell && cell.closest('table');
        if (!table) return '';
        const row = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : (table.rows[0] && table.rows[0].querySelector('th') ? table.rows[0] : null);
        const h = row && row.cells[cell.cellIndex];
        return h && h !== cell ? textOf(h) : '';
      };
      if (spec.wantHeaders) {
        const out = {};
        if (roots[0]) for (const [k, s] of Object.entries(spec.fields)) { const h = headerOf(elOf(roots[0], s)); if (h) out[k] = h; }
        return JSON.stringify(out);
      }
      // a column that now stands under another header is another column: say so, read nothing
      if (spec.headers && roots[0]) {
        for (const [k, want] of Object.entries(spec.headers)) {
          const got = headerOf(elOf(roots[0], spec.fields[k] || '.'));
          if (norm(got).toLowerCase() !== norm(want).toLowerCase()) return JSON.stringify({ __changed: 'the column read for "' + k + '" was under "' + want + '" and is now under "' + got + '"' });
        }
      }
      const rows = roots.map(r => {
        const row = Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, pick(r, s)]));
        for (const [k, n] of Object.entries(spec.nested || {})) row[k] = qa(r, n.css).map(ir => Object.fromEntries(Object.entries(n.fields).map(([f, s]) => [f, pick(ir, s)])));
        return row;
      });
      return JSON.stringify(spec.css ? rows : rows[0]);
    },
    // A list inside each row of a list (the line items of each order). css: the outer rows;
    // inner: for each outer row, its inner rows as { key: texts to look for }. Finds, in every
    // outer row, the innermost element holding each inner row's values; they must be alike, so
    // that one selector relative to the outer row reads them all, in order. A value that is an
    // element of its own gets a selector, else "." (the caller builds a pattern over the row's
    // text). Returns { css, fields, texts } (texts: of the first inner row) or null.
    nest(css, inner, keys) {
      const SKIPT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
      const has = (el, forms) => { const t = norm(el.textContent).toLowerCase(); return forms.some(f => holdsForm(t, f)); };
      const roots = qa(document, css);
      const all = [];
      const seg = e => e.tagName.toLowerCase() + Array.from(e.classList || []).filter(stableClass).slice(0, 2).map(c => '.' + esc(c)).join('');
      let rel = null, firstEl = null;
      for (let i = 0; i < inner.length; i++) {
        const root = roots[i];
        if (!root) return JSON.stringify(null);
        const els = [];
        for (const r of inner[i]) {
          const need = keys.map(k => r[k]).filter(f => f && f.length);
          if (!need.length) return JSON.stringify(null);
          let el = root;
          if (!need.every(f => has(el, f))) return JSON.stringify(null);
          for (let d = 0; d < 40; d++) {
            const next = Array.from(el.children).find(c => !SKIPT.test(c.tagName) && !els.includes(c) && need.every(f => has(c, f)));
            if (!next) break;
            el = next;
          }
          if (el === root || els.includes(el)) return JSON.stringify(null);
          els.push(el);
        }
        all.push(...els);
        if (!els.length) continue;
        if (!rel) { firstEl = els[0]; const p = els[0].parentElement; rel = (p && p !== root ? seg(p) + ' > ' : '') + seg(els[0]); }
        const got = qa(root, rel);
        if (got.length !== els.length || els.some((e, j) => got[j] !== e)) return JSON.stringify(null);
      }
      if (!rel || !firstEl) return JSON.stringify(null);
      const fields = {}, texts = {};
      const first = inner.find(x => x.length)[0];
      for (const k of keys) {
        const leaf = leafIn(firstEl, first[k] || [], all);
        fields[k] = leaf ? leaf.sel : '.';
        texts[k] = textOf(leaf ? leaf.el : firstEl);
      }
      return JSON.stringify({ css: rel, fields, texts });
    },
    // Where values that are only a part of an element's text sit ("Kestrel Sling — $45").
    // rows: for each row, for each key, the texts to look for (a number may be written "45" or
    // "45.00"). One row: the innermost element holding each value, per key. Several rows: the
    // innermost element holding all of a row's values, when those elements are alike (one
    // selector reads them all). Returns { css, fields: {key: css}, texts: {key: text} } with the
    // text of row 0, or null. The caller builds the patterns and checks what they read.
    holders(rows, keys) {
      if (!document.body) return JSON.stringify(null);
      const SKIPT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
      const has = (el, forms) => { const t = norm(el.textContent).toLowerCase(); return forms.some(f => holdsForm(t, f)); };
      const innermost = (need) => {
        let el = document.body;
        if (!need.every(f => has(el, f))) return null;
        for (let d = 0; d < 60; d++) {
          const next = Array.from(el.children).find(c => !SKIPT.test(c.tagName) && need.every(f => has(c, f)));
          if (!next) break;
          el = next;
        }
        return el === document.body ? null : el;
      };
      if (rows.length === 1) {
        const fields = {}, texts = {};
        if (keys.some(k => !rows[0][k] || !rows[0][k].length)) return JSON.stringify(null);
        // values that stand together (one sentence, one card) are read from there: the same text
        // elsewhere on the page (a room's name in the list of rooms) is another thing
        const all = keys.length > 1 ? innermost(keys.map(k => rows[0][k])) : null;
        if (all && textOf(all).length <= 300) {
          for (const k of keys) { fields[k] = cssFor(all); texts[k] = textOf(all); }
          return JSON.stringify({ css: null, fields, texts });
        }
        // else each value on its own, and only when the page says it in one place
        const page = norm(document.body.innerText).toLowerCase();
        for (const k of keys) {
          const forms = rows[0][k];
          const times = Math.max(...forms.map(f => page.split(String(f).toLowerCase()).length - 1));
          if (times !== 1) return JSON.stringify(null);
          const el = innermost([forms]);
          if (!el) return JSON.stringify(null);
          fields[k] = cssFor(el); texts[k] = textOf(el).slice(0, 2000);
        }
        return JSON.stringify({ css: null, fields, texts });
      }
      // rows come in page order, and two rows may say the same ("Albert Einstein" three times): each
      // row takes the first innermost element holding its values that comes after the row before it
      const pool = Array.from(document.body.querySelectorAll('*')).filter(e => !SKIPT.test(e.tagName));
      if (pool.length > 6000) return JSON.stringify(null);
      const poolText = pool.map(e => norm(e.textContent).toLowerCase());
      const els = [];
      let prev = null;
      for (const r of rows) {
        const need = keys.map(k => r[k]).filter(f => f && f.length).map(fs => fs.map(f => String(f).toLowerCase()));
        if (!need.length) return JSON.stringify(null);
        const cands = pool.filter((e, i) => need.every(fs => fs.some(f => holdsForm(poolText[i], f))));
        const leaves = cands.filter(c => !cands.some(o => o !== c && c.contains(o)));
        const el = leaves.find(c => !els.includes(c) && (!prev || (prev.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)));
        if (!el) return JSON.stringify(null);
        els.push(el); prev = el;
      }
      const p = els[0].parentElement;
      if (!p || els.some(e => e.tagName !== els[0].tagName)) return JSON.stringify(null);
      const cls = Array.from(els[0].classList || []).filter(stableClass).filter(c => els.every(e => e.classList.contains(c))).slice(0, 2);
      const own = els[0].tagName.toLowerCase() + (cls.length ? '.' + cls.map(esc).join('.') : '');
      const tries = [];
      if (els.every(e => e.parentElement === p)) tries.push(cssFor(p) + ' > ' + own);
      else {
        // each in a parent of its own: the parents must be alike and share a parent
        const ps = els.map(e => e.parentElement), gp = p.parentElement;
        if (gp && ps.every(x => x && x.parentElement === gp && x.tagName === p.tagName)) {
          const pc = Array.from(p.classList || []).filter(stableClass).filter(c => ps.every(x => x.classList.contains(c))).slice(0, 2);
          tries.push(cssFor(gp) + ' > ' + p.tagName.toLowerCase() + (pc.length ? '.' + pc.map(esc).join('.') : '') + ' > ' + own);
        }
        // or anywhere under the closest container that holds them all
        let box = p;
        while (box && !els.every(e => box.contains(e))) box = box.parentElement;
        if (box) tries.push(cssFor(box) + ' ' + own);
      }
      let css = null;
      for (const t of tries) { const got = qa(document, t); if (got.length >= els.length && els.every((e, i) => got[i] === e)) { css = t; break; } }
      if (!css) return JSON.stringify(null);
      const fields = {}, texts = {};
      for (const k of keys) {
        // a value in an element of its own inside the row (a <p class="cust">) is read from there
        const leaf = rows[0][k] && rows[0][k].length ? leafIn(els[0], rows[0][k], els) : null;
        fields[k] = leaf ? leaf.sel : '.';
        texts[k] = textOf(leaf ? leaf.el : els[0]).slice(0, 2000);
      }
      return JSON.stringify({ css, fields, texts });
    },
    pageJson() {
      const out = [];
      for (const s of qa(document, 'script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]')) {
        const raw = s.textContent || '';
        if (raw.length > 3000000) continue;
        try {
          const sel = s.id ? 'script#' + esc(s.id) : s.type === 'application/ld+json' ? 'script[type="application/ld+json"]' : null;
          if (!sel) continue;
          if (qa(document, sel).length !== 1) continue;
          out.push({ sel, json: JSON.parse(raw) });
        } catch (e) {}
      }
      return JSON.stringify(out);
    },
    // rows: the model's answer (a list of objects, or one object);
    // fields: their keys. Finds an item selector and a field selector per
    // key whose text is the value. The caller checks that reading with
    // them gives the same rows back.
    // the full text of values the view cut short: prefix -> the one page
    // text (or title, alt, aria-label) that starts with it, else null
    complete(prefixes) {
      const texts = new Set();
      for (const el of document.body ? document.body.querySelectorAll('*') : []) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        for (const a of ['title', 'alt', 'aria-label']) { const v = el.getAttribute(a); if (v && v.length < 2000) texts.add(norm(v)); }
        if (el.childElementCount <= 3) { const t = norm(el.textContent); if (t && t.length < 2000) texts.add(t); }
      }
      const out = {};
      for (const p of prefixes) {
        const want = norm(p).toLowerCase();
        const hits = [];
        for (const t of texts) if (t.length > want.length && t.toLowerCase().startsWith(want)) hits.push(t);
        // the shortest that starts with it, when every other hit contains it (a parent's text)
        hits.sort((a, b) => a.length - b.length);
        out[p] = hits.length && hits.every(h => h.startsWith(hits[0])) ? hits[0] : null;
      }
      return JSON.stringify(out);
    },
    compileCss(rows, keys) {
      const list = Array.isArray(rows);
      const items = list ? rows : [rows];
      if (!items.length) return JSON.stringify(null);
      const val = v => norm(v).toLowerCase();
      // page text t holds value v (a value the view cut short with … matches its start)
      const holds = (t, v) => {
        const a = norm(t).toLowerCase(), b = val(v);
        if (a === b) return true;
        const cut = /^(.*?)\s*(?:…|\.\.\.)[\s)\]}"'”’»]*$/.exec(b);
        return !!cut && cut[1].length >= 10 && a.startsWith(cut[1]);
      };
      // smallest elements whose text contains the value
      const holders = v => {
        const want = val(v);
        if (!want) return [];
        const hits = [];
        for (const el of document.body.querySelectorAll('*')) {
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
          const t = textOf(el).toLowerCase();
          if (holds(t, v) || (typeof v === 'number' && t.includes(want))) hits.push(el);
        }
        return hits.filter(h => !hits.some(o => o !== h && h.contains(o)));
      };
      const linkHolder = (v, near) => {
        const all = qa(document, 'a[href]').filter(a => a.href === v || a.getAttribute('href') === v);
        if (near) { const f = all.find(a => a === near || a.contains(near) || near.contains(a) || (near.parentElement && near.parentElement.contains(a))); if (f) return f; }
        return all[0] || null;
      };
      const first = items[0];
      const cells = {};
      for (const k of keys) {
        const v = first[k];
        if (v == null || typeof v === 'object') continue;
        if (typeof v === 'string' && /^https?:\/\//.test(v)) { const a = linkHolder(v); if (a) cells[k] = { el: a, attr: 'href' }; continue; }
        // a full value kept in an attribute (text on the page is often cut short)
        if (typeof v === 'string') {
          let found = null;
          for (const at of ['title', 'alt', 'aria-label']) {
            const el = qa(document, '[' + at + ']').find(e => holds(e.getAttribute(at), v));
            if (el) { found = { el, attr: at }; break; }
          }
          if (found) { cells[k] = found; continue; }
        }
        const hs = holders(v);
        if (hs.length) cells[k] = { el: hs[0] };
      }
      const ks = Object.keys(cells);
      if (!ks.length) return JSON.stringify(null);
      const relSel = (root, el) => {
        if (root === el) return '.';
        const parts = [];
        for (let n = el; n && n !== root; n = n.parentElement) {
          let seg = n.tagName.toLowerCase();
          const cls = Array.from(n.classList).filter(stableClass).slice(0, 2);
          if (cls.length) seg += '.' + cls.map(esc).join('.');
          const p = n.parentElement;
          if (p && p !== root.parentElement) {
            const same = Array.from(p.children).filter(c => c.tagName === n.tagName && (!cls.length || cls.every(x => c.classList.contains(x))));
            if (same.length > 1) seg += ':nth-of-type(' + (Array.from(p.children).filter(c => c.tagName === n.tagName).indexOf(n) + 1) + ')';
          }
          parts.unshift(seg);
        }
        return ':scope > ' + parts.join(' > ');
      };
      if (!list) {
        const fields = {};
        for (const k of ks) fields[k] = cssFor(cells[k].el).split(SEP).pop() + (cells[k].attr ? '@' + cells[k].attr : '');
        return JSON.stringify({ css: null, fields });
      }
      // with two rows: the items are the children of the lowest common
      // ancestor of row 1's and row 2's cell for the same field
      if (items.length > 1) {
        const k0 = ks.find(k => items[1][k] != null && items[1][k] !== items[0][k]);
        if (k0) {
          const c0 = cells[k0];
          const v1 = items[1][k0];
          let el1 = null;
          if (c0.attr && c0.attr !== 'href') el1 = qa(document, '[' + c0.attr + ']').find(e => holds(e.getAttribute(c0.attr), v1)) || null;
          else if (c0.attr === 'href') el1 = linkHolder(v1, null);
          else el1 = holders(v1)[0] || null;
          if (el1 && el1 !== c0.el) {
            let lca = c0.el.parentElement;
            while (lca && !lca.contains(el1)) lca = lca.parentElement;
            const childOf = (anc, e) => { while (e && e.parentElement !== anc) e = e.parentElement; return e; };
            const it0 = lca && childOf(lca, c0.el), it1 = lca && childOf(lca, el1);
            if (it0 && it1 && it0 !== it1 && it0.tagName === it1.tagName && ks.every(k => it0.contains(cells[k].el))) {
              const common = Array.from(it0.classList).filter(c => it1.classList.contains(c) && stableClass(c)).slice(0, 2);
              const sel = cssFor(lca).split(SEP).pop() + ' > ' + it0.tagName.toLowerCase() + (common.length ? '.' + common.map(esc).join('.') : '');
              if (qa(document, sel).length >= items.length) {
                const fields = {};
                for (const k of ks) fields[k] = relSel(it0, cells[k].el) + (cells[k].attr ? '@' + cells[k].attr : '');
                return JSON.stringify({ css: sel, fields });
              }
            }
          }
        }
      }
      // item root: the lowest common ancestor of the first row's cells
      let root = cells[ks[0]].el;
      const containsAll = r => ks.every(k => r.contains(cells[k].el));
      while (root && !containsAll(root)) root = root.parentElement;
      if (!root) return JSON.stringify(null);
      // walk up while the root is the only child of its parent (keeps the
      // selector simple), then build a selector shared by its siblings
      const itemSel = r => {
        const p = r.parentElement;
        if (!p) return null;
        const tag = r.tagName.toLowerCase();
        const cls = Array.from(r.classList).filter(stableClass);
        const base = cssFor(p).split(SEP).pop();
        for (const sel of [cls.length ? tag + '.' + cls.map(esc).join('.') : null, tag]) {
          if (!sel) continue;
          const full = base + ' > ' + sel;
          const n = qa(document, full).length;
          if (n >= items.length) return full;
        }
        return null;
      };
      let sel = null;
      for (let r = root, i = 0; r && r !== document.body && i < 4 && !sel; r = r.parentElement, i++) {
        if (items.length === 1 || (r.parentElement && r.parentElement.children.length > 1)) { sel = itemSel(r); if (sel) root = r; }
      }
      if (!sel) return JSON.stringify(null);
      const fields = {};
      for (const k of ks) fields[k] = relSel(root, cells[k].el) + (cells[k].attr ? '@' + cells[k].attr : '');
      return JSON.stringify({ css: sel, fields });
    },
  };
  return 0;
})()
