// Resolve the selectors an SDK returns from observe() to the fixture's data-eval-id marks.
// Runs in the page over CDP. Handles css, absolute XPath, XPath that walks into same-origin
// iframes, and steps into open shadow roots. Returns one entry per selector.
export const RESOLVE_JS = (selectors) => `(() => {
  const sels = ${JSON.stringify(selectors)};
  const mark = (el) => {
    let n = el;
    while (n) {
      if (n.getAttribute && n.getAttribute('data-eval-id')) return n.getAttribute('data-eval-id');
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;
      else if (n.defaultView && n.defaultView.frameElement) n = n.defaultView.frameElement;
      else n = null;
    }
    return null;
  };
  const kids = (n) => {
    if (n.nodeType === 9) return [n.documentElement];
    const out = [...n.children];
    if (n.shadowRoot) out.push(...n.shadowRoot.children);
    if ((n.tagName === 'IFRAME' || n.tagName === 'FRAME') && n.contentDocument) out.push(n.contentDocument.documentElement);
    return out;
  };
  const stepRe = /^([a-zA-Z*][\\w:-]*|\\*\\[name\\(\\)=['"][^'"]+['"]\\]|[\\w-]+\\(\\))(\\[(\\d+)\\])?$/;
  const walk = (path) => {
    // absolute path of simple steps: /html[1]/body[1]/div[2]...; "//" means "inside a shadow root or frame"
    const parts = path.replace(/^\\//, '').split('/');
    let cur = [document];
    for (let raw of parts) {
      if (raw === '') continue;
      const m = raw.match(stepRe);
      if (!m) return null;
      let name = m[1];
      const nm = name.match(/name\\(\\)=['"]([^'"]+)['"]/);
      if (nm) name = nm[1];
      const idx = m[3] ? Number(m[3]) : null;
      const next = [];
      for (const c of cur) {
        const ks = kids(c).filter((k) => name === '*' || k.localName.toLowerCase() === name.toLowerCase().replace(/^.*:/, ''));
        if (idx) { if (ks[idx - 1]) next.push(ks[idx - 1]); } else next.push(...ks);
      }
      if (!next.length) return null;
      cur = next;
    }
    return cur[0] || null;
  };
  const xp = (doc, path) => {
    try { return doc.evaluate(path, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; }
  };
  // "a >>> b": b inside a's shadow root, or inside the document of iframe a (piercing syntax)
  const pierce = (root, css) => {
    const parts = css.split(/\s*>>>\s*/);
    let scope = root, el = null;
    for (let i = 0; i < parts.length; i++) {
      el = deepCss(scope, parts[i]);
      if (!el) return null;
      if (i < parts.length - 1) {
        scope = el.shadowRoot || (el.tagName === 'IFRAME' || el.tagName === 'FRAME' ? el.contentDocument : null);
        if (!scope) return null;
      }
    }
    return el;
  };
  const deepCss = (root, css) => {
    try { const e = root.querySelector(css); if (e) return e; } catch { return null; }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const e = deepCss(el.shadowRoot, css); if (e) return e; }
      if (el.tagName === 'IFRAME' && el.contentDocument) { const e = deepCss(el.contentDocument, css); if (e) return e; }
    }
    return null;
  };
  return sels.map((s) => {
    if (!s) return { selector: s, eid: null, how: 'empty' };
    let sel = String(s).trim();
    let el = null, how = '';
    if (sel.startsWith('xpath=')) sel = sel.slice(6);
    if (sel.startsWith('css=')) sel = sel.slice(4);
    if (sel.includes('>>>')) { el = pierce(document, sel); how = 'pierce'; }
    else if (sel.startsWith('/') || sel.startsWith('(')) {
      el = xp(document, sel); how = 'xpath';
      if (!el) { el = walk(sel.replace(/\\/\\//g, '/')); how = 'walk'; }
    } else { el = deepCss(document, sel); how = 'css'; }
    return { selector: s, eid: el ? mark(el) : null, found: !!el, how };
  });
})()`;
