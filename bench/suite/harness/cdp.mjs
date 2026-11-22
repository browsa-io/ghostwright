// Minimal CDP helpers for the harness's own checks (independent of the SDK under test).
export async function listPages(cdpUrl) {
  const r = await fetch(`${cdpUrl}/json/list`);
  const all = await r.json();
  return all.filter((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"));
}

export async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket failed"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

/** Evaluate an expression in the page that matches `pick` (url predicate), or the last http(s) page. */
export async function evaluate(cdpUrl, expression, pick) {
  const pages = await listPages(cdpUrl);
  let target = pick ? pages.find((p) => pick(p.url)) : null;
  if (!target) target = pages.find((p) => /^https?:/.test(p.url)) || pages[0];
  if (!target) throw new Error("no page target");
  const s = await openSession(target.webSocketDebuggerUrl);
  try {
    const r = await s.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  } finally {
    s.close();
  }
}

/** Page snapshot used by the bot-wall check: url, title, visible text head, and a status guess. */
export async function pageSnapshot(cdpUrl) {
  return await evaluate(
    cdpUrl,
    `(() => ({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, 6000),
      html: document.documentElement.outerHTML.slice(0, 20000),
    }))()`,
  );
}
