// Observe set: 12 tasks. The SDK returns candidate elements for an instruction; the harness
// resolves each returned selector in the live page over CDP and reads the element's
// data-eval-id (or its nearest marked ancestor / shadow host). Single-target tasks pass
// when the expected element is among the first 3 candidates; multi-target tasks pass at
// recall >= 0.8 with no more than 2x as many candidates as targets.
const T = [];
const add = (t) =>
  T.push({
    set: "observe",
    start: `/observe/${t.id}`,
    steps: [{ op: "observe", text: t.text }],
    check: ({ results }) => {
      const r = results[0];
      if (r?.error) return `observe failed: ${r.error}`;
      const got = (r?.resolved || []).map((x) => x.eid);
      if (t.many) {
        const hit = t.expect.filter((e) => got.includes(e)).length;
        const recall = hit / t.expect.length;
        if (recall < 0.8) return `recall ${hit}/${t.expect.length} (got ${JSON.stringify(got).slice(0, 160)})`;
        if (got.length > 2 * t.expect.length) return `too many candidates (${got.length})`;
        return true;
      }
      return got.slice(0, 3).some((e) => t.expect.includes(e)) ? true : `top candidates ${JSON.stringify(got.slice(0, 3))}, want ${t.expect.join("|")}`;
    },
    ...t,
    pages: { [`/observe/${t.id}`]: t.page, ...(t.extraPages || {}) },
  });

add({
  id: "o01-cta",
  text: "Find the button that starts a free trial",
  page: { title: "Ledgerly", body: `<header><a href="#" data-eval-id="login">Log in</a></header><h1>Bookkeeping that does itself</h1><button data-eval-id="demo">Book a demo</button><button data-eval-id="trial">Try it free for 14 days</button><p>No card needed.</p>` },
  expect: ["trial"],
});
add({
  id: "o02-search",
  text: "Find the site search input",
  page: { title: "Docs", body: `<header><input data-eval-id="newsletter" placeholder="Email for updates"> <input data-eval-id="search" type="search" placeholder="Search the docs"></header><h1>Docs</h1>` },
  expect: ["search"],
});
add({
  id: "o03-upload",
  text: "Find the control for uploading a CV file",
  page: { title: "Apply", body: `<h1>Apply: Backend engineer</h1><label>Name <input data-eval-id="name"></label><br><label>CV (PDF) <input type="file" data-eval-id="cv" accept=".pdf"></label><br><label>Portfolio link <input data-eval-id="url"></label><br><button data-eval-id="send">Send application</button>` },
  expect: ["cv"],
});
add({
  id: "o04-nav-links",
  text: "Find all the links in the main navigation bar",
  many: true,
  page: { title: "Studio", body: `<nav aria-label="Main">${["Work", "Services", "About", "Journal", "Contact"].map((n) => `<a href="#" data-eval-id="nav-${n}">${n}</a> `).join("")}</nav><h1>We make websites</h1><footer><a href="#" data-eval-id="f1">Privacy</a> <a href="#" data-eval-id="f2">Imprint</a></footer>` },
  expect: ["nav-Work", "nav-Services", "nav-About", "nav-Journal", "nav-Contact"],
});
add({
  id: "o05-iframe",
  text: "Find the subscribe button in the newsletter box",
  page: { title: "Blog", body: `<h1>Blog</h1><p>Posts…</p><button data-eval-id="share">Share</button><iframe src="/observe/o05-iframe/box" width=420 height=140></iframe>` },
  extraPages: { "/observe/o05-iframe/box": { title: "Newsletter", body: `<p>Monthly letter</p><input placeholder="you@example.com" data-eval-id="nl-email"><button data-eval-id="nl-sub">Subscribe</button>` } },
  expect: ["nl-sub"],
});
add({
  id: "o06-shadow",
  text: "Find the button that opens the chat",
  page: {
    title: "Support",
    body: `<h1>Support</h1><button data-eval-id="faq">Read the FAQ</button><chat-launcher data-eval-id="chat-host"></chat-launcher><script>customElements.define('chat-launcher',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML='<button data-eval-id="chat">Chat with us</button>';}})</script>`,
  },
  expect: ["chat", "chat-host"],
});
add({
  id: "o07-form-fields",
  text: "Find all the input fields of the shipping address form",
  many: true,
  page: {
    title: "Checkout",
    body: `<h1>Checkout</h1><form><h2>Shipping address</h2>${["Full name", "Street", "City", "Postcode", "Country"].map((f) => `<label>${f} <input data-eval-id="ship-${f}"></label><br>`).join("")}</form><h2>Promo</h2><input data-eval-id="promo" placeholder="Promo code"><button data-eval-id="pay">Pay</button>`,
  },
  expect: ["ship-Full name", "ship-Street", "ship-City", "ship-Postcode", "ship-Country"],
});
add({
  id: "o08-row-button",
  text: "Find the Remove button for the Blue mug",
  page: {
    title: "Basket",
    body: `<h1>Basket</h1>${["Red mug", "Blue mug", "Green mug"].map((m, i) => `<div class="card">${m} <button data-eval-id="rm-${i}">Remove</button></div>`).join("")}`,
  },
  expect: ["rm-1"],
});
add({
  id: "o09-dialog-close",
  text: "Find the button that closes the dialog",
  page: {
    title: "Offer",
    css: `#d{position:fixed;top:20%;left:20%;background:#fff;border:1px solid #444;padding:16px}`,
    body: `<h1>Shop</h1><button data-eval-id="cart">Cart</button><div id="d" role="dialog" aria-label="Offer"><button data-eval-id="x" aria-label="Close">✕</button><p>10% off your first order</p><button data-eval-id="claim">Claim offer</button></div>`,
  },
  expect: ["x"],
});
add({
  id: "o10-icon-button",
  text: "Find the settings button",
  page: { title: "App", body: `<header><button data-eval-id="bell" aria-label="Notifications">🔔</button><button data-eval-id="gear" aria-label="Settings">⚙</button><button data-eval-id="avatar" aria-label="Account">👤</button></header><h1>Inbox</h1>` },
  expect: ["gear"],
});
add({
  id: "o11-next-page",
  text: "Find the link to the next page of results",
  page: { title: "Results", body: `<h1>Results</h1>${paraList()}<nav><a href="#" data-eval-id="prev">‹ Previous</a> <a href="#" data-eval-id="p1">1</a> <a href="#" data-eval-id="p2">2</a> <a href="#" data-eval-id="p3">3</a> <a href="#" data-eval-id="next">Next ›</a></nav>` },
  expect: ["next"],
});
add({
  id: "o12-tax-fields",
  text: "Find the inputs for gross income and for deductions",
  many: true,
  page: {
    title: "Tax estimate",
    body: `<h1>Estimate your tax</h1><label>Tax year <select data-eval-id="year"><option>2026</option></select></label><br><label>Gross income <input data-eval-id="gross" inputmode="decimal"></label><br><label>Deductions <input data-eval-id="ded" inputmode="decimal"></label><br><label>Dependants <input data-eval-id="dep"></label><br><button data-eval-id="calc">Calculate</button>`,
  },
  expect: ["gross", "ded"],
});

function paraList() {
  return Array.from({ length: 5 }, (_, i) => `<div class="card">Result ${i + 1}</div>`).join("");
}

export default T;
