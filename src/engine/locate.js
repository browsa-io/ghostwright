// Ghostwright locators. Runs in the same isolated world as pageview.js,
// after it. Read-only, like pageview.js: nothing is added to the page.
//
//   __gw.loc(id)        -> locators for an element: css, text, xpath, near
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

  // visible text of the closest heading before the element
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
      submit: isSubmit(c), cardForm: cardForm(form),
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
        if (form) for (const s of Array.from(form.elements || [])) if (isSubmit(s)) { const fs = factsOf(s); if (fs) out.push(fs); }
      }
      return JSON.stringify(out);
    },
    loc(id) {
      const el = pv.el(id);
      if (!el) return JSON.stringify(null);
      const t = textOf(el);
      return JSON.stringify({
        css: cssFor(el),
        text: t && t.length <= 60 ? t : '',
        xpath: xpathFor(el),
        near: nearText(el),
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
      if (tg.near) {
        const want = norm(tg.near).toLowerCase();
        const ids = [...out.css, ...out.text, ...out.xpath, ...(tg.among || [])];
        out.near = [...new Set(ids)].filter(id => { const e = pv.el(id); return e && nearText(e).toLowerCase() === want; });
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
      const rows = roots.map(r => Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, pick(r, s)])));
      return JSON.stringify(spec.css ? rows : rows[0]);
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
