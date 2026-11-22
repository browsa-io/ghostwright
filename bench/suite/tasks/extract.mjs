// Extract set: 25 tasks. 22 on local pages written for this bench, 3 on stable public
// read-only sandboxes (books.toscrape.com, quotes.toscrape.com, an English Wikipedia article).
// Difficulty kinds: single values, tables, nested records, links (href), numbers with
// units and separators, frames (same- and cross-origin), shadow DOM, decoy values (old
// price, hidden text), long lists, one section among look-alikes, filtering, and a value
// that is not on the page at all (must come back null, not invented).
import { S, matches, paras } from "./lib.mjs";

const T = [];
const add = (t) =>
  T.push({
    set: "extract",
    start: t.start || `/extract/${t.id}`,
    steps: [{ op: "extract", text: t.text, schema: t.schema }],
    check: ({ results }) => {
      const r = results[results.length - 1];
      if (r?.error) return `extract failed: ${r.error}`;
      return matches(r?.data, t.expect, t.match || {});
    },
    ...t,
  });

// e01 product title and price
add({
  id: "e01-product",
  pages: { "/extract/e01-product": { title: "Kestrel 2 backpack", body: `<nav>Home › Bags</nav><h1>Kestrel 2 Daypack, 24 L</h1><p class="price">€ 89.95</p><p>Free returns within 30 days.</p><h2>You may also like</h2><div class="card">Kestrel 3 Daypack, 30 L — € 109.00</div>` } },
  text: "Get the product name and its price in euros",
  schema: S.obj({ name: S.str(), price: S.num() }),
  expect: { name: "Kestrel 2 Daypack, 24 L", price: 89.95 },
});

// e02 table rows
const staff = [["Inês Duarte", "Head of Product"], ["Kofi Mensah", "Staff Engineer"], ["Yuki Tanaka", "Designer"], ["Olu Adeyemi", "Data Scientist"], ["Sara Lind", "Support Lead"], ["Pavel Novak", "SRE"], ["Hana Kim", "Recruiter"], ["Diego Ruiz", "Engineer"]];
add({
  id: "e02-table",
  pages: { "/extract/e02-table": { title: "Team directory", body: `<h1>Directory</h1><table><thead><tr><th>Name</th><th>Role</th><th>Office</th></tr></thead><tbody>${staff.map(([n, r], i) => `<tr><td>${n}</td><td>${r}</td><td>${["Porto", "Accra", "Osaka"][i % 3]}</td></tr>`).join("")}</tbody></table>` } },
  text: "List every person in the directory with their role",
  schema: S.obj({ people: S.arr(S.obj({ name: S.str(), role: S.str() })) }),
  expect: { people: staff.map(([name, role]) => ({ name, role })) },
});

// e03 nested record (recipe)
add({
  id: "e03-recipe",
  pages: {
    "/extract/e03-recipe": {
      title: "Lemon lentil soup",
      body: `<h1>Lemon lentil soup</h1><p>Serves 4 · 35 minutes</p><h2>Ingredients</h2><ul><li>200 g red lentils</li><li>1 onion</li><li>2 cloves garlic</li><li>1 litre vegetable stock</li><li>1 lemon</li></ul><h2>Method</h2><ol><li>Soften the onion and garlic.</li><li>Add lentils and stock; simmer 20 minutes.</li><li>Blend and finish with lemon juice.</li></ol>`,
    },
  },
  text: "Extract the recipe: servings, total minutes, ingredients and the method steps",
  schema: S.obj({ servings: S.num(), minutes: S.num(), ingredients: S.arr(S.str()), steps: S.arr(S.str()) }),
  expect: {
    servings: 4,
    minutes: 35,
    ingredients: ["200 g red lentils", "1 onion", "2 cloves garlic", "1 litre vegetable stock", "1 lemon"],
    steps: ["Soften the onion and garlic.", "Add lentils and stock; simmer 20 minutes.", "Blend and finish with lemon juice."],
  },
});

// e04 links of one section, with hrefs
add({
  id: "e04-links",
  pages: {
    "/extract/e04-links": {
      title: "Project",
      body: `<h1>Project home</h1><nav><a href="/">Home</a> <a href="/blog">Blog</a></nav><section><h2>Resources</h2><ul><li><a href="/docs/start">Getting started</a></li><li><a href="/docs/api">API reference</a></li><li><a href="https://status.example.org/">Status page</a></li></ul></section><section><h2>Community</h2><a href="/forum">Forum</a></section>`,
    },
  },
  text: "List the links in the Resources section with their text and full URL",
  schema: S.obj({ links: S.arr(S.obj({ text: S.str(), url: S.url() })) }),
  check: ({ results, fixture }) => {
    const r = results[0];
    if (r?.error) return `extract failed: ${r.error}`;
    const links = r?.data?.links || [];
    const want = [["Getting started", "/docs/start"], ["API reference", "/docs/api"], ["Status page", "https://status.example.org/"]];
    if (links.length !== 3) return `expected 3 links, got ${links.length}`;
    for (let i = 0; i < 3; i++) {
      const [t, u] = want[i];
      if (matches(links[i].text, t) !== true) return `link ${i} text ${JSON.stringify(links[i].text)}`;
      if (!String(links[i].url || "").endsWith(u)) return `link ${i} url ${JSON.stringify(links[i].url)}`;
    }
    return true;
  },
});

// e05 one link href
add({
  id: "e05-single-link",
  pages: { "/extract/e05-single-link": { title: "Annual report", body: `<h1>Annual report 2025</h1><p>${"Our year in numbers. ".repeat(4)}</p><p><a href="/files/annual-2025.pdf">Download the report (PDF, 4 MB)</a> · <a href="/files/annual-2024.pdf">Last year's report</a></p>` } },
  text: "What is the URL of the link that downloads the 2025 report?",
  schema: S.obj({ url: S.url() }),
  check: ({ results }) => (String(results[0]?.data?.url || "").endsWith("/files/annual-2025.pdf") ? true : `url=${JSON.stringify(results[0]?.data?.url ?? results[0]?.error)}`),
});

// e06 numbers with separators and units
add({
  id: "e06-numbers",
  pages: { "/extract/e06-numbers": { title: "Bridge facts", body: `<h1>The Harbour Bridge</h1><dl><dt>Total length</dt><dd>1,149 m</dd><dt>Main span</dt><dd>503 m</dd><dt>Height above water</dt><dd>134 m</dd><dt>Daily crossings</dt><dd>about 160,435 vehicles</dd><dt>Opened</dt><dd>19 March 1932</dd></dl>` } },
  text: "Extract the total length in metres, the main span in metres, and the daily vehicle crossings as numbers",
  schema: S.obj({ length_m: S.num(), span_m: S.num(), daily_vehicles: S.num() }),
  expect: { length_m: 1149, span_m: 503, daily_vehicles: 160435 },
});

// e07 same-origin frame
add({
  id: "e07-iframe",
  pages: {
    "/extract/e07-iframe": { title: "Store locator", body: `<h1>Find a store</h1><iframe src="/extract/e07-iframe/map" width=500 height=200></iframe>` },
    "/extract/e07-iframe/map": { title: "Map", body: `<div class="card"><b>Nearest store:</b> Riverside Mall, Unit 14<br>Open today until 21:00<br>Phone: +351 210 555 014</div>` },
  },
  text: "What is the nearest store, its closing time today and its phone number?",
  schema: S.obj({ store: S.str(), closes: S.str(), phone: S.str() }),
  expect: { store: "Riverside Mall, Unit 14", closes: "21:00", phone: "+351 210 555 014" },
  match: { contains: true },
});

// e08 cross-origin frame
add({
  id: "e08-iframe-xorigin",
  pages: {
    "/extract/e08-iframe-xorigin": { title: "Account", body: `<h1>Your plan</h1><iframe src="{{X}}/extract/e08-iframe-xorigin/billing" width=500 height=180></iframe>` },
    "/extract/e08-iframe-xorigin/billing": { title: "Billing", body: `<p>Plan: <b>Studio</b></p><p>Next charge: <b>$48.00</b> on <b>2027-01-03</b></p>` },
  },
  text: "Get the plan name, the next charge amount and its date",
  schema: S.obj({ plan: S.str(), amount: S.num(), date: S.str() }),
  expect: { plan: "Studio", amount: 48, date: "2027-01-03" },
});

// e09 open shadow DOM
add({
  id: "e09-shadow",
  pages: {
    "/extract/e09-shadow": {
      title: "Status",
      body: `<h1>Service status</h1><status-card></status-card><script>customElements.define('status-card',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML='<ul><li>API: <b>Operational</b></li><li>Dashboard: <b>Degraded</b></li><li>Webhooks: <b>Operational</b></li></ul><p>Last incident: 2 days ago</p>';}})</script>`,
    },
  },
  text: "Extract each service and its status",
  schema: S.obj({ services: S.arr(S.obj({ name: S.str(), status: S.str() })) }),
  expect: { services: [{ name: "API", status: "Operational" }, { name: "Dashboard", status: "Degraded" }, { name: "Webhooks", status: "Operational" }] },
});

// e10 decoy: old price and hidden text
add({
  id: "e10-decoy-price",
  pages: {
    "/extract/e10-decoy-price": {
      title: "Headphones",
      body: `<h1>Quiet One headphones</h1><p><s>$249.00</s> <b>$179.00</b> <span>Save $70</span></p><p style="display:none">Price: $99.00 (staff only)</p><p>Ships in 2 days.</p>`,
    },
  },
  text: "What is the current selling price shown to customers?",
  schema: S.obj({ price: S.num() }),
  expect: { price: 179 },
});

// e11 long list
const tools = Array.from({ length: 60 }, (_, i) => `Tool ${String(i + 1).padStart(2, "0")}`);
add({
  id: "e11-long-list",
  pages: { "/extract/e11-long-list": { title: "Catalogue", body: `<h1>All tools</h1><ul>${tools.map((t) => `<li>${t}</li>`).join("")}</ul>` } },
  text: "List the names of all the tools on the page",
  schema: S.obj({ tools: S.arr(S.str()) }),
  expect: { tools },
});

// e12 one section among look-alikes
const branches = [["North", "Mon–Fri 08:00–18:00"], ["Central", "Mon–Sat 09:00–20:00"], ["South", "Tue–Sun 10:00–17:00"]];
add({
  id: "e12-targeted-section",
  pages: { "/extract/e12-targeted-section": { title: "Branches", body: `<h1>Our branches</h1>${branches.map(([b, h]) => `<div class="card"><h2>${b} branch</h2><p>Opening hours: ${h}</p><p>Phone: 555-01${b.length}</p></div>`).join("")}` } },
  text: "What are the opening hours of the Central branch?",
  schema: S.obj({ hours: S.str() }),
  expect: { hours: "Mon–Sat 09:00–20:00" },
});

// e13 contact cards
const cards = [["Rui Moreira", "Partner", "rui@lawfirm.test"], ["Amara Obi", "Associate", "amara@lawfirm.test"], ["Jonas Berg", "Paralegal", "jonas@lawfirm.test"], ["Mei Chen", "Partner", "mei@lawfirm.test"], ["Luca Romano", "Associate", "luca@lawfirm.test"], ["Nadia Haddad", "Office manager", "nadia@lawfirm.test"]];
add({
  id: "e13-cards",
  pages: { "/extract/e13-cards": { title: "People", body: `<h1>People</h1>${cards.map(([n, t, e]) => `<div class="card"><h3>${n}</h3><div>${t}</div><a href="mailto:${e}">${e}</a></div>`).join("")}` } },
  text: "Extract every person with their title and email address",
  schema: S.obj({ people: S.arr(S.obj({ name: S.str(), title: S.str(), email: S.str() })) }),
  expect: { people: cards.map(([name, title, email]) => ({ name, title, email })) },
});

// e14 forecast table with units
const fc = [["Mon", 14, 7], ["Tue", 16, 8], ["Wed", 12, 6], ["Thu", 11, 5], ["Fri", 15, 9]];
add({
  id: "e14-forecast",
  pages: { "/extract/e14-forecast": { title: "Forecast", body: `<h1>5-day forecast</h1><table><tr><th>Day</th><th>High</th><th>Low</th></tr>${fc.map(([d, h, l]) => `<tr><td>${d}</td><td>${h}°C</td><td>${l}°C</td></tr>`).join("")}</table>` } },
  text: "Extract the forecast: day, high and low temperature in °C",
  schema: S.obj({ days: S.arr(S.obj({ day: S.str(), high: S.num(), low: S.num() })) }),
  expect: { days: fc.map(([day, high, low]) => ({ day, high, low })) },
});

// e15 definition list specs
add({
  id: "e15-specs",
  pages: { "/extract/e15-specs": { title: "Specs", body: `<h1>Trail camera X2</h1><dl><dt>Sensor</dt><dd>24 MP</dd><dt>Battery</dt><dd>8 × AA</dd><dt>Weight</dt><dd>410 g</dd><dt>Waterproof</dt><dd>IP66</dd></dl>` } },
  text: "Extract the sensor, battery, weight and waterproof rating",
  schema: S.obj({ sensor: S.str(), battery: S.str(), weight: S.str(), waterproof: S.str() }),
  expect: { sensor: "24 MP", battery: "8 × AA", weight: "410 g", waterproof: "IP66" },
});

// e16 rating and review count
add({
  id: "e16-reviews",
  pages: { "/extract/e16-reviews": { title: "Reviews", body: `<h1>Oak cutting board</h1><div aria-label="Rated 4.6 out of 5">★★★★★</div><a href="#r">1,284 reviews</a><p>92% would recommend</p>` } },
  text: "Get the average rating out of 5 and the number of reviews",
  schema: S.obj({ rating: S.num(), reviews: S.num() }),
  expect: { rating: 4.6, reviews: 1284 },
});

// e17 search results with urls
const results = Array.from({ length: 8 }, (_, i) => [`Guide to composting, part ${i + 1}`, `/guides/compost-${i + 1}`]);
add({
  id: "e17-results",
  pages: { "/extract/e17-results": { title: "Search: compost", body: `<h1>Results for “compost”</h1><div class="card">Sponsored: <a href="/ads/1">Buy a compost bin</a></div>${results.map(([t, u]) => `<div class="card"><a href="${u}">${t}</a><p>${t.toLowerCase()} explained.</p></div>`).join("")}` } },
  text: "List the organic search results (not ads) with title and URL",
  schema: S.obj({ results: S.arr(S.obj({ title: S.str(), url: S.url() })) }),
  check: ({ results: rs }) => {
    const r = rs[0];
    if (r?.error) return `extract failed: ${r.error}`;
    const got = r?.data?.results || [];
    if (got.length !== 8) return `expected 8 results, got ${got.length}`;
    for (let i = 0; i < 8; i++) {
      if (matches(got[i].title, results[i][0]) !== true) return `result ${i} title ${JSON.stringify(got[i].title)}`;
      if (!String(got[i].url).endsWith(results[i][1])) return `result ${i} url ${JSON.stringify(got[i].url)}`;
    }
    return true;
  },
});

// e18 booleans per variant
add({
  id: "e18-stock",
  pages: { "/extract/e18-stock": { title: "Boots", body: `<h1>Ridge boots</h1><table><tr><th>Size</th><th>Availability</th></tr><tr><td>40</td><td>In stock</td></tr><tr><td>41</td><td>Sold out</td></tr><tr><td>42</td><td>In stock</td></tr><tr><td>43</td><td>Sold out</td></tr></table>` } },
  text: "For each size, is it in stock?",
  schema: S.obj({ sizes: S.arr(S.obj({ size: S.str(), in_stock: S.bool() })) }),
  expect: { sizes: [{ size: "40", in_stock: true }, { size: "41", in_stock: false }, { size: "42", in_stock: true }, { size: "43", in_stock: false }] },
});

// e19 notices with ids and dates
const notices = [["PN-2026-118", "Road closure on Elm Street", "2026-11-02"], ["PN-2026-121", "Public hearing: library extension", "2026-11-09"], ["PN-2026-127", "Water main works", "2026-11-15"]];
add({
  id: "e19-notices",
  pages: { "/extract/e19-notices": { title: "Notices", body: `<h1>Public notices</h1>${notices.map(([id, t, d]) => `<article class="card"><small>${id}</small><h3>${t}</h3><time datetime="${d}">${d}</time></article>`).join("")}` } },
  text: "Extract every notice with its reference, title and date",
  schema: S.obj({ notices: S.arr(S.obj({ ref: S.str(), title: S.str(), date: S.str() })) }),
  expect: { notices: notices.map(([ref, title, date]) => ({ ref, title, date })) },
});

// e20 fee table with grouped rows
add({
  id: "e20-fees",
  pages: {
    "/extract/e20-fees": {
      title: "Fees",
      body: `<h1>Permit fees</h1><table><tr><th>Permit</th><th>Duration</th><th>Fee</th></tr><tr><td rowspan=2>Parking</td><td>1 month</td><td>$40</td></tr><tr><td>12 months</td><td>$400</td></tr><tr><td rowspan=2>Market stall</td><td>1 day</td><td>$25</td></tr><tr><td>1 season</td><td>$600</td></tr></table>`,
    },
  },
  text: "List every permit option with permit type, duration and fee in dollars",
  schema: S.obj({ options: S.arr(S.obj({ permit: S.str(), duration: S.str(), fee: S.num() })) }),
  expect: { options: [{ permit: "Parking", duration: "1 month", fee: 40 }, { permit: "Parking", duration: "12 months", fee: 400 }, { permit: "Market stall", duration: "1 day", fee: 25 }, { permit: "Market stall", duration: "1 season", fee: 600 }] },
});

// e21 filter while extracting
const grid = [["Cork coaster set", 12], ["Brass bookend", 34], ["Linen tea towel", 9.5], ["Glass carafe", 28], ["Beeswax candle", 14], ["Walnut tray", 46]];
add({
  id: "e21-filter",
  pages: { "/extract/e21-filter": { title: "Gifts", body: `<h1>Gift ideas</h1>${grid.map(([n, p]) => `<div class="card"><b>${n}</b> — $${p.toFixed(2)}</div>`).join("")}` } },
  text: "List only the products that cost less than $20, with name and price",
  schema: S.obj({ items: S.arr(S.obj({ name: S.str(), price: S.num() })) }),
  expect: { items: grid.filter(([, p]) => p < 20).map(([name, price]) => ({ name, price })) },
  match: { unordered: true },
});

// e22 a value that is not on the page
add({
  id: "e22-absent",
  pages: { "/extract/e22-absent": { title: "About us", body: `<h1>About Fernwood Studio</h1>${paras(2, 21)}<p>Founded in 2011 in Leeds. Contact: hello@fernwood.test</p>` } },
  text: "What is the CEO's phone number? Return null if the page does not say.",
  schema: S.obj({ phone: S.nstr() }),
  expect: { phone: null },
});

// e23-e25 live, read-only, stable sandboxes
add({
  id: "e23-live-books",
  live: true,
  start: "https://books.toscrape.com/catalogue/page-1.html",
  text: "Extract the title and price of the first four books listed",
  schema: S.obj({ books: S.arr(S.obj({ title: S.str(), price: S.str() })) }),
  check: ({ results }) => {
    const r = results[0];
    if (r?.error) return `extract failed: ${r.error}`;
    const b = r?.data?.books || [];
    const want = [["A Light in the Attic", 51.77], ["Tipping the Velvet", 53.74], ["Soumission", 50.1], ["Sharp Objects", 47.82]];
    if (b.length < 4) return `got ${b.length} books`;
    for (let i = 0; i < 4; i++) {
      if (matches(b[i].title, want[i][0], { contains: true }) !== true && matches(want[i][0], b[i].title.replace(/\.\.\.$/, ""), { contains: true }) !== true) return `book ${i} title ${JSON.stringify(b[i].title)}`;
      if (matches(b[i].price, want[i][1]) !== true) return `book ${i} price ${JSON.stringify(b[i].price)}`;
    }
    return true;
  },
});
add({
  id: "e24-live-quotes",
  live: true,
  start: "https://quotes.toscrape.com/page/2/",
  text: "List the author of every quote on this page, in order",
  schema: S.obj({ authors: S.arr(S.str()) }),
  expect: { authors: ["Marilyn Monroe", "J.K. Rowling", "Albert Einstein", "Bob Marley", "Dr. Seuss", "Douglas Adams", "Elie Wiesel", "Friedrich Nietzsche", "Mark Twain", "Allen Saunders"] },
});
add({
  id: "e25-live-wikipedia",
  live: true,
  start: "https://en.wikipedia.org/wiki/Mount_Everest",
  text: "From the article's infobox, get the elevation in metres and the date of the first ascent",
  schema: S.obj({ elevation_m: S.num(), first_ascent: S.str() }),
  check: ({ results }) => {
    const r = results[0];
    if (r?.error) return `extract failed: ${r.error}`;
    const d = r?.data || {};
    if (matches(d.elevation_m, 8848.86, { tol: 0.6 }) !== true) return `elevation ${JSON.stringify(d.elevation_m)}`;
    return /29\s*may\s*1953|1953-05-29|may\s*29,?\s*1953/i.test(String(d.first_ascent)) ? true : `first ascent ${JSON.stringify(d.first_ascent)}`;
  },
});

export default T;
