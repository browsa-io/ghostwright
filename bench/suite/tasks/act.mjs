// Act set: 40 single-page tasks, one or two natural-language actions each.
// Written for this bench (own pages, own wording). Each covers one difficulty:
// plain controls, custom widgets, frames (same- and cross-origin, nested), shadow DOM
// (open, closed, mixed with frames), scrolling, hover, new tabs, late content, overlays,
// ambiguous targets, and an impossible instruction that must do nothing.
import { all, kvIs, valueIs, loaded, paras } from "./lib.mjs";

const T = [];
const add = (t) => T.push({ set: "act", ...t, start: t.start || `/act/${t.id}` });
const act = (text, extra = {}) => ({ op: "act", text, ...extra });

// a01 plain button among siblings
add({
  id: "a01-button",
  pages: {
    "/act/a01-button": {
      title: "Post editor",
      body: `<h1>New post</h1><textarea rows=4 cols=50>Draft text</textarea><div>
      <button data-eval-id="save" onclick="__probe.set('action','save')">Save draft</button>
      <button data-eval-id="publish" onclick="__probe.set('action','publish')">Publish</button>
      <button data-eval-id="discard" onclick="__probe.set('action','discard')">Discard</button></div>`,
    },
  },
  steps: [act("Click the Publish button")],
  check: ({ state }) => kvIs(state, "action", "publish"),
});

// a02 text field by label
add({
  id: "a02-type",
  pages: {
    "/act/a02-type": {
      title: "Shipping details",
      body: `<h1>Where should we ship?</h1>
      <label>Full name <input data-eval-id="name" name="name"></label><br>
      <label>City <input data-eval-id="city" name="city"></label><br>
      <label>Postcode <input data-eval-id="zip" name="zip"></label>`,
    },
  },
  steps: [act("Type 'Lisbon' into the City field")],
  check: ({ state }) => all(valueIs(state, "city", "Lisbon"), state.valueOf("name") ? "typed into the wrong field" : true),
});

// a03 native select
const countries = ["Austria", "Belgium", "Croatia", "Denmark", "Estonia", "Finland", "Greece", "Hungary", "Ireland", "Portugal", "Romania", "Spain"];
add({
  id: "a03-select",
  pages: {
    "/act/a03-select": {
      title: "Region",
      body: `<h1>Choose your region</h1><label for="c">Country</label>
      <select id="c" data-eval-id="country" onchange="__probe.set('country', this.value)"><option value="">Select…</option>
      ${countries.map((c) => `<option value="${c.slice(0, 2).toUpperCase()}">${c}</option>`).join("")}</select>`,
    },
  },
  steps: [act("Choose Portugal in the country list")],
  check: ({ state }) => kvIs(state, "country", "PO"),
});

// a04 custom dropdown made of divs
add({
  id: "a04-custom-dropdown",
  css: "",
  pages: {
    "/act/a04-custom-dropdown": {
      title: "T-shirt",
      css: `.dd{position:relative;display:inline-block}.dd ul{display:none;position:absolute;list-style:none;margin:0;padding:4px;border:1px solid #999;background:#fff}.dd.open ul{display:block}.dd li{padding:4px 12px;cursor:pointer}.dd li:hover{background:#eef}`,
      body: `<h1>Classic tee</h1><p>Pick a size before adding to the basket.</p>
      <div class="dd" id="dd"><div role="button" tabindex=0 data-eval-id="dd-toggle" onclick="dd.classList.toggle('open')">Size: <span id="cur">choose</span> ▾</div>
      <ul role="listbox">${["Small", "Medium", "Large", "X-Large"].map((s) => `<li role="option" data-eval-id="size-${s[0]}" onclick="cur.textContent='${s}';dd.classList.remove('open');__probe.set('size','${s}')">${s}</li>`).join("")}</ul></div>`,
    },
  },
  steps: [act("Open the size menu"), act("Pick the Large size")],
  check: ({ state }) => kvIs(state, "size", "Large"),
});

// a05 select hidden behind a styled menu
add({
  id: "a05-hidden-select",
  pages: {
    "/act/a05-hidden-select": {
      title: "Delivery",
      css: `.menu{border:1px solid #888;display:inline-block;min-width:180px}.menu .opt{padding:6px;display:none;cursor:pointer}.menu.open .opt{display:block}.menu .head{padding:6px;cursor:pointer;background:#f4f4f4}`,
      body: `<h1>Delivery speed</h1>
      <select id="real" name="speed" style="display:none" onchange="__probe.set('speed',this.value)"><option value="std">Standard</option><option value="exp">Express</option><option value="ovn">Overnight</option></select>
      <div class="menu" id="m"><div class="head" data-eval-id="speed-head" onclick="m.classList.toggle('open')"><span id="lbl">Standard</span> ▾</div>
      ${[["std", "Standard (5–7 days)"], ["exp", "Express (2 days)"], ["ovn", "Overnight"]].map(([v, l]) => `<div class="opt" data-eval-id="opt-${v}" onclick="real.value='${v}';real.dispatchEvent(new Event('change'));lbl.textContent='${l}';m.classList.remove('open')">${l}</div>`).join("")}</div>`,
    },
  },
  steps: [act("Set the delivery speed to Express")],
  check: ({ state }) => kvIs(state, "speed", "exp"),
});

// a06 single checkbox
add({
  id: "a06-checkbox",
  pages: {
    "/act/a06-checkbox": {
      title: "Create account",
      body: `<h1>Almost done</h1><p>${"Please review the terms of service before continuing. ".repeat(3)}</p>
      <label><input type="checkbox" data-eval-id="terms" onchange="__probe.set('terms',this.checked)"> I accept the terms of service</label><br>
      <label><input type="checkbox" data-eval-id="news" onchange="__probe.set('news',this.checked)"> Send me product news</label>`,
    },
  },
  steps: [act("Tick the box that accepts the terms of service")],
  check: ({ state }) => all(kvIs(state, "terms", true), state.kv.news ? "ticked the newsletter box too" : true),
});

// a07 two checkboxes in a group
add({
  id: "a07-checkbox-group",
  pages: {
    "/act/a07-checkbox-group": {
      title: "Notifications",
      body: `<h1>How should we reach you?</h1><fieldset><legend>Channels</legend>
      ${["Push", "Email", "SMS", "Phone call"].map((c) => `<label><input type="checkbox" value="${c}" data-eval-id="ch-${c}" onchange="__probe.set('ch-${c}',this.checked)"> ${c}</label><br>`).join("")}</fieldset>`,
    },
  },
  steps: [act("Tick the Email channel"), act("Tick the SMS channel")],
  check: ({ state }) => all(kvIs(state, "ch-Email", true), kvIs(state, "ch-SMS", true), state.kv["ch-Push"] || state.kv["ch-Phone call"] ? "extra channel ticked" : true),
});

// a08 radio button
add({
  id: "a08-radio",
  pages: {
    "/act/a08-radio": {
      title: "Billing",
      body: `<h1>Billing period</h1>
      <label><input type="radio" name="b" value="monthly" checked onchange="__probe.set('billing',this.value)"> Monthly — $12/mo</label><br>
      <label><input type="radio" name="b" value="annual" data-eval-id="annual" onchange="__probe.set('billing',this.value)"> Annual — $120/yr (save 17%)</label>`,
    },
  },
  steps: [act("Select annual billing")],
  check: ({ state }) => kvIs(state, "billing", "annual"),
});

// a09 untick a pre-ticked box
add({
  id: "a09-uncheck",
  pages: {
    "/act/a09-uncheck": {
      title: "Preferences",
      body: `<h1>Email preferences</h1>
      <label><input type="checkbox" checked onchange="__probe.set('receipts',this.checked)"> Order receipts</label><br>
      <label><input type="checkbox" checked data-eval-id="mkt" onchange="__probe.set('marketing',this.checked)"> Send me marketing emails</label>`,
    },
  },
  steps: [act("Untick 'Send me marketing emails'")],
  check: ({ state }) => all(kvIs(state, "marketing", false), state.kv.receipts === false ? "unticked receipts" : true),
});

// a10 same-origin iframe
add({
  id: "a10-iframe",
  pages: {
    "/act/a10-iframe": { title: "Quote", body: `<h1>Your quote</h1><p>The quote widget is below.</p><iframe src="/act/a10-iframe/frame" width=500 height=200></iframe>` },
    "/act/a10-iframe/frame": { title: "Quote widget", body: `<p>Total: $340</p><button data-eval-id="accept" onclick="__probe.set('quote','accepted')">Accept quote</button><button onclick="__probe.set('quote','declined')">Decline</button>` },
  },
  steps: [act("Accept the quote")],
  check: ({ state }) => kvIs(state, "quote", "accepted"),
});

// a11 cross-origin iframe
add({
  id: "a11-iframe-xorigin",
  pages: {
    "/act/a11-iframe-xorigin": { title: "Launch", body: `<h1>Coming soon</h1><p>Our partner widget handles the waitlist.</p><iframe src="{{X}}/act/a11-iframe-xorigin/frame" width=500 height=160></iframe>` },
    "/act/a11-iframe-xorigin/frame": { title: "Waitlist", body: `<p>Be first in line.</p><button data-eval-id="join" onclick="__probe.set('waitlist',location.origin)">Join waitlist</button>` },
  },
  steps: [act("Click Join waitlist")],
  check: ({ state }) => (String(state.kv.waitlist || "").includes("127.0.0.1") ? true : "waitlist button not clicked"),
});

// a12 nested frames, inner one cross-origin
add({
  id: "a12-iframe-nested",
  pages: {
    "/act/a12-iframe-nested": { title: "Checkout", body: `<h1>Checkout</h1><iframe src="/act/a12-iframe-nested/outer" width=600 height=260></iframe>` },
    "/act/a12-iframe-nested/outer": { title: "Order summary", body: `<p>Order summary: 2 items</p><iframe src="{{X}}/act/a12-iframe-nested/inner" width=520 height=140></iframe>` },
    "/act/a12-iframe-nested/inner": { title: "Promotions", body: `<label>Coupon code <input data-eval-id="coupon" oninput="__probe.set('coupon',this.value)"></label>` },
  },
  steps: [act("Type SPRING25 into the coupon code field")],
  check: ({ state }) => kvIs(state, "coupon", "SPRING25"),
});

// a13 open shadow root
add({
  id: "a13-shadow-open",
  pages: {
    "/act/a13-shadow-open": {
      title: "Help",
      body: `<h1>Help centre</h1><help-widget></help-widget><script>
      customElements.define('help-widget', class extends HTMLElement { connectedCallback(){ const r=this.attachShadow({mode:'open'});
      r.innerHTML='<div style="border:1px solid #aaa;padding:8px"><p>Need a hand?</p><button data-eval-id="chat">Start chat</button></div>';
      r.querySelector('button').onclick=()=>__probe.set('chat',true); } });</script>`,
    },
  },
  steps: [act("Click Start chat")],
  check: ({ state }) => kvIs(state, "chat", true),
});

// a14 closed shadow root
add({
  id: "a14-shadow-closed",
  pages: {
    "/act/a14-shadow-closed": {
      title: "News",
      body: `<h1>Today</h1>${paras(2, 4)}<promo-bar></promo-bar><script>
      customElements.define('promo-bar', class extends HTMLElement { connectedCallback(){ const r=this.attachShadow({mode:'closed'});
      r.innerHTML='<div style="background:#ffe;padding:8px">Get 2 months free! <button>Dismiss</button></div>';
      r.querySelector('button').onclick=()=>{__probe.set('promo','dismissed');this.remove();}; } });</script>`,
    },
  },
  steps: [act("Dismiss the promotion bar")],
  check: ({ state }) => kvIs(state, "promo", "dismissed"),
});

// a15 shadow root inside an iframe
add({
  id: "a15-shadow-in-iframe",
  pages: {
    "/act/a15-shadow-in-iframe": { title: "Order delivered", body: `<h1>Your order arrived</h1><iframe src="/act/a15-shadow-in-iframe/frame" width=500 height=180></iframe>` },
    "/act/a15-shadow-in-iframe/frame": {
      title: "Rate",
      body: `<rate-box></rate-box><script>customElements.define('rate-box', class extends HTMLElement { connectedCallback(){ const r=this.attachShadow({mode:'open'});
      r.innerHTML='<p>How was it?</p>'+[1,2,3,4,5].map(n=>'<button data-n="'+n+'">'+n+' star'+(n>1?'s':'')+'</button>').join('');
      r.querySelectorAll('button').forEach(b=>b.onclick=()=>__probe.set('rating',Number(b.dataset.n))); } });</script>`,
    },
  },
  steps: [act("Give the delivery a 5 star rating")],
  check: ({ state }) => kvIs(state, "rating", 5),
});

// a16 iframe inside a shadow root
add({
  id: "a16-iframe-in-shadow",
  pages: {
    "/act/a16-iframe-in-shadow": {
      title: "Address",
      body: `<h1>Confirm your address</h1><addr-panel></addr-panel><script>customElements.define('addr-panel', class extends HTMLElement { connectedCallback(){ const r=this.attachShadow({mode:'open'});
      r.innerHTML='<div style="border:1px dashed #999;padding:6px"><iframe src="/act/a16-iframe-in-shadow/frame" width=460 height=120></iframe></div>'; } });</script>`,
    },
    "/act/a16-iframe-in-shadow/frame": { title: "Address check", body: `<p>12 Harbour Road, Galway</p><button onclick="__probe.set('address','confirmed')">Confirm address</button><button onclick="__probe.set('address','edit')">Edit</button>` },
  },
  steps: [act("Click Confirm address")],
  check: ({ state }) => kvIs(state, "address", "confirmed"),
});

const longPage = (seed) => paras(40, seed);
// a17 scroll to half
add({
  id: "a17-scroll-half",
  pages: { "/act/a17-scroll-half": { title: "Long read", body: `<h1>A long read</h1>${longPage(10)}` } },
  steps: [act("Scroll halfway down the page")],
  check: ({ state }) => {
    const s = state.lastScroll();
    if (!s) return "no scroll";
    return s.frac >= 0.35 && s.frac <= 0.65 ? true : `scrolled to ${(s.frac * 100).toFixed(0)}%`;
  },
});

// a18 scroll to three quarters
add({
  id: "a18-scroll-75",
  pages: { "/act/a18-scroll-75": { title: "Field notes", body: `<h1>Field notes</h1>${longPage(20)}` } },
  steps: [act("Scroll to 75% of the way down the page")],
  check: ({ state }) => {
    const s = state.lastScroll();
    if (!s) return "no scroll";
    return s.frac >= 0.6 && s.frac <= 0.9 ? true : `scrolled to ${(s.frac * 100).toFixed(0)}%`;
  },
});

// a19 scroll down one screen
add({
  id: "a19-scroll-screen",
  pages: { "/act/a19-scroll-screen": { title: "Journal", body: `<h1>Journal</h1>${longPage(30)}` } },
  steps: [act("Scroll down by one screen")],
  check: ({ state }) => {
    const s = state.lastScroll();
    if (!s) return "no scroll";
    return s.y >= 0.6 * s.vh && s.y <= 1.4 * s.vh ? true : `scrolled ${s.y}px with a ${s.vh}px screen`;
  },
});

// a20 scroll up one screen from the bottom
add({
  id: "a20-scroll-up",
  pages: {
    "/act/a20-scroll-up": {
      title: "Changelog",
      body: `<h1>Changelog</h1>${longPage(40)}<script>addEventListener('load',()=>{scrollTo(0,document.documentElement.scrollHeight);setTimeout(()=>__probe.set('_bottom',scrollY),400);});</script>`,
    },
  },
  steps: [{ op: "wait", ms: 800 }, act("Scroll up by one screen")],
  check: ({ state }) => {
    const s = state.lastScroll();
    const bottom = state.kv._bottom;
    if (!s || bottom === undefined) return "no scroll";
    const moved = bottom - s.y;
    return moved >= 0.6 * s.vh && moved <= 1.4 * s.vh ? true : `moved up ${moved}px with a ${s.vh}px screen`;
  },
});

// a21 scroll inside a scrollable box
add({
  id: "a21-scroll-box",
  pages: {
    "/act/a21-scroll-box": {
      title: "Activity",
      body: `<h1>Team activity</h1><div data-eval-id="log" style="height:220px;overflow:auto;border:1px solid #aaa;padding:6px">
      ${Array.from({ length: 80 }, (_, i) => `<div>${String(i + 1).padStart(2, "0")}:00 — build ${1000 + i} finished</div>`).join("")}</div><p>End of activity.</p>`,
    },
  },
  steps: [act("Scroll the activity log box to the bottom")],
  check: ({ state }) => {
    const s = state.lastScroll("log");
    return s && s.frac > 0.9 ? true : `log scrolled to ${s ? (s.frac * 100).toFixed(0) + "%" : "nothing"}`;
  },
});

// a22 link at the very bottom
add({
  id: "a22-footer-link",
  pages: {
    "/act/a22-footer-link": { title: "Acme Tools", body: `<h1>Acme Tools</h1>${longPage(50)}<footer><a href="/act/a22-footer-link/about">About</a> · <a href="/act/a22-footer-link/careers">Careers</a> · <a href="/act/a22-footer-link/press">Press</a></footer>` },
    "/act/a22-footer-link/careers": { title: "Careers", body: `<h1>Careers at Acme</h1>` },
    "/act/a22-footer-link/about": { title: "About", body: `<h1>About</h1>` },
    "/act/a22-footer-link/press": { title: "Press", body: `<h1>Press</h1>` },
  },
  steps: [act("Click the Careers link in the footer")],
  check: ({ state }) => loaded(state, /\/careers$/),
});

// a23 type then press Enter
add({
  id: "a23-enter",
  pages: {
    "/act/a23-enter": {
      title: "Shop search",
      body: `<h1>Find products</h1><form onsubmit="event.preventDefault();__probe.set('search',q.value)"><input id="q" data-eval-id="q" placeholder="Search products" aria-label="Search products"></form>`,
    },
  },
  steps: [act("Type 'wool socks' into the search box"), act("Press Enter to search")],
  check: ({ state }) => kvIs(state, "search", "wool socks"),
});

// a24 menu that opens on hover
add({
  id: "a24-hover-menu",
  pages: {
    "/act/a24-hover-menu": {
      title: "Store",
      css: `nav .m{position:relative;display:inline-block;margin-right:16px}nav .sub{display:none;position:absolute;background:#fff;border:1px solid #999;padding:4px}nav .m:hover .sub{display:block}nav .sub a{display:block;padding:3px 8px}`,
      body: `<nav><div class="m"><span>Products ▾</span><div class="sub"><a href="#" onclick="__probe.set('nav','phones');return false">Phones</a><a href="#" onclick="__probe.set('nav','laptops');return false">Laptops</a><a href="#" onclick="__probe.set('nav','tablets');return false">Tablets</a></div></div>
      <div class="m"><span>Support ▾</span><div class="sub"><a href="#" onclick="__probe.set('nav','repairs');return false">Repairs</a></div></div></nav><h1>Welcome</h1>${paras(2, 7)}`,
    },
  },
  steps: [act("Hover over the Products menu"), act("Click Laptops in the Products menu")],
  check: ({ state }) => kvIs(state, "nav", "laptops"),
});

// a25 impossible instruction: must not touch the page
add({
  id: "a25-impossible",
  pages: {
    "/act/a25-impossible": {
      title: "Recipes",
      body: `<h1>Weekly recipes</h1>${paras(2, 9)}<input placeholder="Your email" data-eval-id="email"><button data-eval-id="sub" onclick="__probe.set('sub',true)">Subscribe</button>`,
    },
  },
  steps: [act("Book a return flight to the Moon for two adults")],
  expectActFailure: true,
  check: ({ state }) => {
    const n = state.interactions().length;
    return n === 0 ? true : `the page was changed (${n} interactions) for an impossible instruction`;
  },
});

// a26 ordinary link
add({
  id: "a26-link",
  pages: {
    "/act/a26-link": { title: "Notely", body: `<header><a href="/act/a26-link/features">Features</a> | <a href="/act/a26-link/pricing">Pricing</a> | <a href="/act/a26-link/blog">Blog</a></header><h1>Notes that keep up</h1>` },
    "/act/a26-link/pricing": { title: "Pricing", body: `<h1>Pricing</h1>` },
    "/act/a26-link/features": { title: "Features", body: `<h1>Features</h1>` },
    "/act/a26-link/blog": { title: "Blog", body: `<h1>Blog</h1>` },
  },
  steps: [act("Open the Pricing page")],
  check: ({ state }) => loaded(state, /\/pricing$/),
});

// a27 link that opens a new tab, then act there
add({
  id: "a27-new-tab",
  pages: {
    "/act/a27-new-tab": { title: "Dashboard", body: `<h1>Dashboard</h1><p>Version 4.2 is out. <a href="/act/a27-new-tab/notes" target="_blank">Read the release notes</a></p>` },
    "/act/a27-new-tab/notes": { title: "Release notes 4.2", body: `<h1>Release notes 4.2</h1><ul><li>Faster sync</li><li>Dark mode</li></ul><button onclick="__probe.set('notes','read')">Mark as read</button>` },
  },
  steps: [act("Click the link to read the release notes"), act("Click Mark as read")],
  check: ({ state }) => all(loaded(state, /\/notes$/), kvIs(state, "notes", "read")),
});

// a28 icon-only buttons (SVG with titles)
const icon = (name, path) => `<button style="border:none;background:none" onclick="__probe.set('icon','${name}')"><svg width="28" height="28" viewBox="0 0 24 24"><title>${name}</title><path d="${path}" fill="#c33"/></svg></button>`;
add({
  id: "a28-svg-icon",
  pages: {
    "/act/a28-svg-icon": {
      title: "Item",
      body: `<h1>Walnut side table</h1><p>$189</p><div>${icon("Share", "M4 12l16-8v16z")}${icon("Favourite", "M12 21l-1.5-1.3C5 15 2 12 2 8.5 2 6 4 4 6.5 4c1.5 0 3 .7 4 1.9h3C14.5 4.7 16 4 17.5 4 20 4 22 6 22 8.5 22 12 19 15 13.5 19.7z")}${icon("Report", "M4 4h16v16H4z")}</div>`,
    },
  },
  steps: [act("Click the heart icon to save the item to favourites")],
  check: ({ state }) => kvIs(state, "icon", "Favourite"),
});

// a29 date input
add({
  id: "a29-date",
  pages: {
    "/act/a29-date": { title: "Trip", body: `<h1>Plan a trip</h1><label>Departure date <input type="date" data-eval-id="dep" onchange="__probe.set('dep',this.value)" oninput="__probe.set('dep',this.value)"></label>` },
  },
  steps: [act("Set the departure date to 24 December 2026")],
  check: ({ state }) => kvIs(state, "dep", "2026-12-24"),
});

// a30 textarea
add({
  id: "a30-textarea",
  pages: { "/act/a30-textarea": { title: "Order notes", body: `<h1>Anything else?</h1><label>Delivery notes<br><textarea rows=4 cols=40 data-eval-id="notes"></textarea></label><br><label>Gift message<br><textarea rows=2 cols=40 data-eval-id="gift"></textarea></label>` } },
  steps: [act("Write 'Leave it at the back door' in the delivery notes")],
  check: ({ state }) => all(valueIs(state, "notes", "Leave it at the back door", { contains: true }), state.valueOf("gift") ? "typed into the gift message" : true),
});

// a31 contenteditable editor
add({
  id: "a31-contenteditable",
  pages: {
    "/act/a31-contenteditable": {
      title: "Message",
      body: `<h1>New message</h1><div>To: team</div><div contenteditable="true" role="textbox" aria-label="Message body" data-eval-id="body" style="border:1px solid #999;min-height:80px;padding:6px"></div>`,
    },
  },
  steps: [act("Type 'Meeting moved to Friday' into the message body")],
  check: ({ state }) => valueIs(state, "body", "Meeting moved to Friday", { contains: true }),
});

// a32 button that becomes enabled late
add({
  id: "a32-late-enable",
  pages: {
    "/act/a32-late-enable": {
      title: "Verify",
      body: `<h1>Checking your details…</h1><button id="b" disabled onclick="__probe.set('cont',true)">Continue</button><script>setTimeout(()=>{b.disabled=false;document.querySelector('h1').textContent='Details checked';},1500)</script>`,
    },
  },
  steps: [act("Click Continue")],
  check: ({ state }) => kvIs(state, "cont", true),
});

// a33 list that loads late
add({
  id: "a33-late-list",
  pages: {
    "/act/a33-late-list": {
      title: "Orders",
      body: `<h1>Your orders</h1><div id="l">Loading…</div><script>setTimeout(()=>{l.innerHTML=[1039,1040,1041,1042,1043].map(n=>'<div class="card"><a href="#" onclick="__probe.set(\\'order\\','+n+');return false">Order #'+n+'</a></div>').join('')},1500)</script>`,
    },
  },
  steps: [{ op: "wait", ms: 1800 }, act("Open order #1042")],
  check: ({ state }) => kvIs(state, "order", 1042),
});

// a34 overlay that blocks the page
add({
  id: "a34-overlay",
  pages: {
    "/act/a34-overlay": {
      title: "Daily news",
      css: `#ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end}#ov .box{background:#fff;padding:16px;width:100%}`,
      body: `<h1>Daily news</h1>${paras(3, 11)}<div id="ov"><div class="box"><p>We use cookies to improve the site.</p><button onclick="__probe.set('cookies','accepted');ov.remove()">Accept all</button><button onclick="__probe.set('cookies','rejected');ov.remove()">Reject all</button><button>Settings</button></div></div>`,
    },
  },
  steps: [act("Close the cookie banner by rejecting all cookies")],
  check: ({ state }) => kvIs(state, "cookies", "rejected"),
});

// a35 the right row among identical buttons
add({
  id: "a35-row-action",
  pages: {
    "/act/a35-row-action": {
      title: "Invoices",
      body: `<h1>Invoices</h1><table><tr><th>Invoice</th><th>Amount</th><th></th></tr>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<tr><td>Invoice ${n}</td><td>$${(n * 37.5).toFixed(2)}</td><td><button onclick="__probe.set('deleted',${n})">Delete</button></td></tr>`).join("")}</table>`,
    },
  },
  steps: [act("Delete the row for Invoice 7")],
  check: ({ state }) => kvIs(state, "deleted", 7),
});

// a36 row action by person name
const people = ["Ana Costa", "Ben Okafor", "Maria Silva", "Mario Silvestri", "Lena Park", "Tom Weiss"];
add({
  id: "a36-row-by-name",
  pages: {
    "/act/a36-row-by-name": {
      title: "Team",
      body: `<h1>Team members</h1><table><tr><th>Name</th><th>Role</th><th></th></tr>${people.map((p, i) => `<tr><td>${p}</td><td>${["Admin", "Editor", "Viewer"][i % 3]}</td><td><a href="#" onclick="__probe.set('edit','${p}');return false">Edit</a></td></tr>`).join("")}</table>`,
    },
  },
  steps: [act("Click Edit for Maria Silva")],
  check: ({ state }) => kvIs(state, "edit", "Maria Silva"),
});

// a37 input labelled through aria-labelledby
add({
  id: "a37-aria-label",
  pages: {
    "/act/a37-aria-label": {
      title: "Basket",
      body: `<h1>Basket</h1><div class="card"><div id="pn">Ceramic mug, 350 ml</div><span id="ql">Quantity</span> <input data-eval-id="qty" aria-labelledby="ql pn" value="1" size=3 oninput="__probe.set('qty',this.value)"></div><div class="card">Linen napkins <input value="2" size=3 aria-label="Napkins quantity"></div>`,
    },
  },
  steps: [act("Set the quantity of the ceramic mug to 3")],
  check: ({ state }) => (String(state.kv.qty || "").trim() === "3" ? true : `qty=${JSON.stringify(state.kv.qty)}`),
});

// a38 accordion
add({
  id: "a38-accordion",
  pages: {
    "/act/a38-accordion": {
      title: "FAQ",
      body: `<h1>Questions</h1>${["Payments", "Shipping", "Returns", "Warranty"].map((s) => `<details ontoggle="if(this.open)__probe.set('open','${s}')"><summary>${s}</summary><p>${s} details go here.</p></details>`).join("")}`,
    },
  },
  steps: [act("Expand the Shipping section")],
  check: ({ state }) => kvIs(state, "open", "Shipping"),
});

// a39 tab widget
add({
  id: "a39-tabs",
  pages: {
    "/act/a39-tabs": {
      title: "Camera",
      body: `<h1>Trail camera X2</h1><div role="tablist">${["Overview", "Specifications", "Reviews"].map((t, i) => `<button role="tab" aria-selected="${i === 0}" onclick="__probe.set('tab','${t}');document.querySelectorAll('[role=tab]').forEach(b=>b.setAttribute('aria-selected',b===this))">${t}</button>`).join("")}</div><div role="tabpanel">Overview text.</div>`,
    },
  },
  steps: [act("Show the Specifications tab")],
  check: ({ state }) => kvIs(state, "tab", "Specifications"),
});

// a40 autocomplete suggestion
add({
  id: "a40-autocomplete",
  pages: {
    "/act/a40-autocomplete": {
      title: "Weather",
      css: `#sug div{padding:4px 8px;cursor:pointer;border-bottom:1px solid #eee}`,
      body: `<h1>Weather</h1><input id="c" placeholder="Search a city" aria-label="City search" autocomplete="off"><div id="sug"></div><script>
      const cities=['Bergen','Berlin','Bern','Bermuda','Beirut','Boston'];
      c.addEventListener('input',()=>{const v=c.value.toLowerCase();sug.innerHTML=v?cities.filter(x=>x.toLowerCase().startsWith(v)).map(x=>'<div role="option" onclick="__probe.set(\\'city\\',\\''+x+'\\');sug.innerHTML=\\'\\';c.value=\\''+x+'\\'">'+x+'</div>').join(''):''});</script>`,
    },
  },
  steps: [act("Type 'Ber' into the city search"), act("Pick Berlin from the suggestions")],
  check: ({ state }) => kvIs(state, "city", "Berlin"),
});

export default T;
