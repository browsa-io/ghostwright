// Flow set: 20 multi-step flows on local apps written for this bench.
// Used twice:
//   - repeat runs: each flow 10 times on the same pages (variant v1). A tool that keeps
//     what it learned should need few or no model calls on runs 2-10.
//   - drift: run once on v1 (to learn), then once on v2, where labels, element types,
//     markup and order changed but the user's intent did not. Instructions are written in
//     intent terms, so they stay valid on v2.
// Checks read app state (window.__probe.set and server-side state), never the DOM text.
import { S, matches, all, kvIs } from "./lib.mjs";

const T = [];
const act = (text) => ({ op: "act", text });
const ext = (text, schema) => ({ op: "extract", text, schema });
const add = (t) => T.push({ set: "flow", start: `/flow/${t.id}`, ...t });
const lastData = (results) => {
  const r = results.filter((x) => x.op === "extract").pop();
  return r?.error ? { __error: r.error } : r?.data;
};
const extIs = (results, expected, opts) => {
  const d = lastData(results);
  if (d?.__error) return `extract failed: ${d.__error}`;
  return matches(d, expected, opts);
};
// Variant helpers: v2 changes labels, markup depth, element ids/classes and order.
const V = (ctx) => {
  const v2 = ctx.variant === "v2";
  return {
    v2,
    lab: (a, b) => (v2 ? b : a),
    wrap: (h) => (v2 ? `<div class="x-shell"><div class="x-inner"><section>${h}</section></div></div>` : h),
    id: (s) => (v2 ? `n${s.length}-${s.split("").reverse().join("")}` : s),
    order: (arr) => (v2 ? [...arr].reverse() : arr),
    banner: v2 ? `<div style="background:#eef;padding:6px">What's new: we refreshed the design. <a href="#" onclick="this.parentNode.remove();return false">Hide</a></div>` : "",
  };
};
// used inside double-quoted HTML attributes: keys use single quotes
const kv = (k, v) => `__probe.set('${k}',${v})`;

// f01 search, product, option, cart
const lamps = [["arc", "Arc desk lamp", 49], ["dome", "Dome floor lamp", 129], ["clip", "Clip reading light", 19], ["orb", "Orb table lamp", 64]];
add({
  id: "f01-shop",
  pages: {
    "/flow/f01-shop": (ctx) => {
      const v = V(ctx);
      return { title: "Lumen store", body: v.banner + v.wrap(`<h1>Lumen</h1><form action="/flow/f01-shop/results"><input name="q" id="${v.id("q")}" placeholder="${v.lab("Search the store", "What are you looking for?")}" aria-label="${v.lab("Search", "Search products")}"><button>${v.lab("Search", "Go")}</button></form>`) };
    },
    "/flow/f01-shop/results": (ctx) => {
      const v = V(ctx);
      const q = (ctx.query.get("q") || "").toLowerCase();
      const hits = lamps.filter(([, n]) => q.split(/\s+/).some((w) => w && n.toLowerCase().includes(w.replace(/s$/, ""))));
      return { title: "Results", body: v.wrap(`<h1>Results for “${q}”</h1>${v.order(hits).map(([s, n, p]) => (v.v2 ? `<div class="card"><div>${n}</div><div>$${p}</div><a href="/flow/f01-shop/p/${s}">View</a></div>` : `<div class="card"><a href="/flow/f01-shop/p/${s}">${n}</a> — $${p}</div>`)).join("")}`) };
    },
    ...Object.fromEntries(
      lamps.map(([s, n, p]) => [
        `/flow/f01-shop/p/${s}`,
        (ctx) => {
          const v = V(ctx);
          const colours = ["White", "Black", "Brass"];
          const picker = v.v2
            ? `<div>Finish: ${colours.map((c) => `<button aria-label="${c} finish" onclick="window.col='${c}';${kv("_col", "'" + c + "'")}">●</button>`).join("")}</div>`
            : `<label>Colour <select onchange="window.col=this.value;${kv("_col", "this.value")}"><option value="">Choose</option>${colours.map((c) => `<option>${c}</option>`).join("")}</select></label>`;
          return {
            title: n,
            body: v.wrap(`<h1>${n}</h1><p>$${p}</p>${picker}<br><button onclick="if(!window.col){alert('Pick a colour');return}${kv("cart", `'${s}:'+window.col.toLowerCase()`)};setTimeout(()=>location='/flow/f01-shop/cart',150)">${v.lab("Add to cart", "Add to bag")}</button>`),
          };
        },
      ]),
    ),
    "/flow/f01-shop/cart": (ctx) => {
      const v = V(ctx);
      const c = String(ctx.state.kv.cart || "");
      const item = lamps.find(([s]) => c.startsWith(s + ":"));
      return { title: v.lab("Cart", "Bag"), body: v.wrap(`<h1>${v.lab("Your cart", "Your bag")}</h1>${item ? `<p>${item[1]} (${c.split(":")[1]}) — $${item[2]}.00</p><p><b>Total: $${item[2]}.00</b></p>` : "<p>Empty</p>"}`) };
    },
  },
  steps: [
    act("Type 'desk lamp' into the store search box"),
    act("Submit the search"),
    act("Open the Arc desk lamp"),
    act("Choose the Black colour"),
    act("Add the lamp to the cart"),
    ext("What is the total?", S.obj({ total: S.num() })),
  ],
  check: ({ state, results }) => all(kvIs(state, "cart", "arc:black"), extIs(results, { total: 49 })),
});

// f02 settings tabs, toggle, save
add({
  id: "f02-settings",
  pages: {
    "/flow/f02-settings": (ctx) => {
      const v = V(ctx);
      const tabs = ["Profile", "Notifications", "Privacy"];
      const nav = v.v2
        ? `<aside><ul>${tabs.map((t) => `<li><a href="#" onclick="show('${t}');return false">${t}</a></li>`).join("")}</ul></aside>`
        : `<div role="tablist">${tabs.map((t) => `<button role="tab" onclick="show('${t}')">${t}</button>`).join("")}</div>`;
      const toggle = (key, label, on) =>
        v.v2
          ? `<div><button role="switch" aria-checked="${on}" onclick="const n=this.getAttribute('aria-checked')!=='true';this.setAttribute('aria-checked',n);s.${key}=n;this.textContent=n?'On':'Off'">${on ? "On" : "Off"}</button> ${label}</div>`
          : `<label><input type="checkbox" ${on ? "checked" : ""} onchange="s.${key}=this.checked"> ${label}</label><br>`;
      return {
        title: "Settings",
        body:
          v.banner +
          v.wrap(`<h1>Settings</h1>${nav}
          <div id="Profile" class="pane">Name: Jo</div>
          <div id="Notifications" class="pane" style="display:none">${toggle("digest", v.lab("Weekly digest email", "Email me a weekly summary"), true)}${toggle("updates", "Product updates", false)}</div>
          <div id="Privacy" class="pane" style="display:none">Visible to: team</div>
          <button onclick="${kv("saved", "JSON.parse(JSON.stringify(s))")}">${v.lab("Save changes", "Update preferences")}</button>
          <script>var s={digest:true,updates:false};function show(t){document.querySelectorAll('.pane').forEach(p=>p.style.display=p.id===t?'block':'none')}</script>`),
      };
    },
  },
  steps: [act("Open the Notifications settings"), act("Turn off the weekly digest email"), act("Save the settings")],
  check: ({ state }) => kvIs(state, "saved", { digest: false, updates: false }),
});

// f03 booking
add({
  id: "f03-booking",
  pages: {
    "/flow/f03-booking": (ctx) => {
      const v = V(ctx);
      const dates = ["Thu 11 Dec", "Fri 12 Dec", "Sat 13 Dec"];
      const guests = v.v2 ? `<label>Number of guests <input type="number" min=1 max=6 value=1 id="g"></label>` : `<label>Guests <select id="g">${[1, 2, 3, 4].map((n) => `<option>${n}</option>`).join("")}</select></label>`;
      return {
        title: "Book a stay",
        body: v.wrap(`<h1>Book a stay</h1><label>${v.lab("Check-in", "Arrival date")} <select id="d"><option value="">Pick a date</option>${dates.map((d) => `<option>${d}</option>`).join("")}</select></label><br>${guests}<br>
          <button onclick="${kv("_q", "{d:d.value,g:g.value}")};rooms.style.display='block'">${v.lab("Find rooms", "Check availability")}</button>
          <div id="rooms" style="display:none">${v.order(["Standard Double", "Garden Suite", "Sea View Room"]).map((r) => `<div class="card">${r} <button onclick="${kv("booking", `{room:'${r}',checkin:d.value,guests:Number(g.value)}`)};sum.textContent='Booked: ${r}, '+d.value+', '+g.value+' guests'">${v.lab("Select", "Choose room")}</button></div>`).join("")}</div><p id="sum"></p>`),
      };
    },
  },
  steps: [
    act("Choose Friday 12 December as the check-in date"),
    act("Set the number of guests to 3"),
    act("Search for available rooms"),
    act("Select the Garden Suite"),
    ext("Summarise the booking: room, check-in date and number of guests", S.obj({ room: S.str(), checkin: S.str(), guests: S.num() })),
  ],
  check: ({ state, results }) => all(kvIs(state, "booking", { room: "Garden Suite", checkin: "Fri 12 Dec", guests: 3 }), extIs(results, { room: "Garden Suite", guests: 3 })),
});

// f04 sign-up form (local fixture)
add({
  id: "f04-newsletter",
  pages: {
    "/flow/f04-newsletter": (ctx) => {
      const v = V(ctx);
      const topics = ["Cooking", "Gardening", "Travel"];
      const topic = v.v2
        ? `<fieldset><legend>Pick a topic</legend>${topics.map((t) => `<label><input type="radio" name="topic" value="${t}"> ${t}</label>`).join("")}</fieldset>`
        : `<label>Topic <select name="topic"><option value="">Choose</option>${topics.map((t) => `<option>${t}</option>`).join("")}</select></label><br>`;
      const name = `<label>${v.lab("Name", "Your name")} <input name="name"></label><br>`;
      const email = `<label>${v.lab("Email", "Email address")} <input name="email" type="email"></label><br>`;
      return {
        title: "Newsletter",
        body: v.wrap(`<h1>Join the newsletter</h1><form id="f" onsubmit="event.preventDefault();const fd=new FormData(f);${kv("sub", "{name:fd.get('name'),email:fd.get('email'),topic:fd.get('topic'),consent:fd.get('consent')==='on'}")}">
          ${v.v2 ? email + name : name + email}${topic}<label><input type="checkbox" name="consent"> ${v.lab("I agree to receive emails", "Yes, send me the newsletter")}</label><br><button>${v.lab("Subscribe", "Sign me up")}</button></form>`),
      };
    },
  },
  steps: [
    act("Type 'Rita Gomes' as the name"),
    act("Type 'rita@example.test' as the email"),
    act("Choose the Gardening topic"),
    act("Tick the box agreeing to receive the newsletter"),
    act("Submit the form"),
  ],
  check: ({ state }) => kvIs(state, "sub", { name: "Rita Gomes", email: "rita@example.test", topic: "Gardening", consent: true }),
});

// f05 filter and sort, then read the first item
const bags = [["Kestrel Roll-top", "Kestrel", 95], ["Fjell Daypack", "Fjell", 70], ["Kestrel Sling", "Kestrel", 45], ["Kestrel Tote", "Kestrel", 60], ["Arro Duffel", "Arro", 80]];
add({
  id: "f05-filter-sort",
  pages: {
    "/flow/f05-filter-sort": (ctx) => {
      const v = V(ctx);
      const brands = ["Arro", "Fjell", "Kestrel"];
      const filter = v.v2
        ? `<label>Brand <select onchange="st.brand=this.value||null;draw()"><option value="">All brands</option>${brands.map((b) => `<option>${b}</option>`).join("")}</select></label>`
        : `<fieldset><legend>Brand</legend>${brands.map((b) => `<label><input type="checkbox" onchange="st.brand=this.checked?'${b}':null;draw()"> ${b}</label>`).join("")}</fieldset>`;
      const sort = v.v2
        ? `<div>Sort: <button onclick="st.sort='asc';draw()">Price ↑</button><button onclick="st.sort='desc';draw()">Price ↓</button></div>`
        : `<label>Sort by <select onchange="st.sort=this.value;draw()"><option value="">Featured</option><option value="asc">Price: low to high</option><option value="desc">Price: high to low</option></select></label>`;
      return {
        title: "Bags",
        body: v.wrap(`<h1>Bags</h1>${filter}${sort}<div id="list"></div><script>const all=${JSON.stringify(bags)};const st={brand:null,sort:''};
          function draw(){let l=all.filter(b=>!st.brand||b[1]===st.brand);if(st.sort)l=[...l].sort((a,b)=>st.sort==='asc'?a[2]-b[2]:b[2]-a[2]);list.innerHTML=l.map(b=>'<div class="card">'+b[0]+' — $'+b[2]+'</div>').join('');__probe.set('view',{brand:st.brand,sort:st.sort})}draw();</script>`),
      };
    },
  },
  steps: [act("Show only Kestrel bags"), act("Sort by price, lowest first"), ext("What is the first bag listed and its price?", S.obj({ name: S.str(), price: S.num() }))],
  check: ({ state, results }) => all(kvIs(state, "view", { brand: "Kestrel", sort: "asc" }), extIs(results, { name: "Kestrel Sling", price: 45 })),
});

// f06 to-do list
add({
  id: "f06-todo",
  pages: {
    "/flow/f06-todo": (ctx) => {
      const v = V(ctx);
      return {
        title: "Tasks",
        body: v.wrap(`<h1>Tasks</h1><input id="n" placeholder="${v.lab("New task", "What needs doing?")}" aria-label="New task"><button onclick="if(n.value){items.push({t:n.value,d:false});n.value='';draw()}">${v.lab("Add", "+ Add task")}</button><ul id="ul"></ul><p id="left"></p>
          <script>const items=[{t:'Call the plumber',d:false},{t:'Renew passport',d:false},{t:'Water the plants',d:false}];
          function draw(){ul.innerHTML=items.map((x,i)=>'<li><label><input type="checkbox" '+(x.d?'checked':'')+' onchange="items['+i+'].d=this.checked;draw()"> '+x.t+'</label></li>').join('');const l=items.filter(x=>!x.d).length;left.textContent=l+' tasks left';__probe.set('todo',items.map(x=>x.t+(x.d?':done':'')))}draw();</script>`),
      };
    },
  },
  steps: [act("Type 'Buy stamps' into the new task field"), act("Add the task"), act("Mark 'Call the plumber' as done"), ext("How many tasks are left to do?", S.obj({ left: S.num() }))],
  check: ({ state, results }) => all(kvIs(state, "todo", ["Call the plumber:done", "Renew passport", "Water the plants", "Buy stamps"]), extIs(results, { left: 3 })),
});

// f07 support ticket with a custom dropdown
add({
  id: "f07-ticket",
  pages: {
    "/flow/f07-ticket": (ctx) => {
      const v = V(ctx);
      const cats = ["Technical", "Billing", "Other"];
      return {
        title: "Support",
        css: `.dd ul{display:none;list-style:none;padding:0;border:1px solid #999;width:200px}.dd.open ul{display:block}.dd li{padding:4px;cursor:pointer}`,
        body: v.wrap(`<h1>${v.lab("Contact support", "Open a request")}</h1>
          <div class="dd" id="dd"><div role="button" tabindex=0 onclick="dd.classList.toggle('open')">${v.lab("Category", "Topic")}: <span id="cat">Select</span></div><ul>${v.order(cats).map((c) => `<li role="option" onclick="cat.textContent='${c}';t.cat='${c}';dd.classList.remove('open')">${c}</li>`).join("")}</ul></div>
          <label>${v.lab("Subject", "Summary")} <input id="sub" oninput="t.subject=this.value"></label><br><label>${v.lab("Message", "Details")}<br><textarea id="msg" rows=3 cols=40 oninput="t.message=this.value"></textarea></label><br>
          <button onclick="${kv("ticket", "t")}">${v.lab("Submit", "Send request")}</button><script>var t={}</script>`),
      };
    },
  },
  steps: [act("Choose the Billing category"), act("Type 'Double charge in October' as the subject"), act("Type 'I was charged twice for my October invoice.' as the message"), act("Submit the ticket")],
  check: ({ state }) => kvIs(state, "ticket", { cat: "Billing", subject: "Double charge in October", message: "I was charged twice for my October invoice." }),
});

// f08 calendar and slot
add({
  id: "f08-calendar",
  pages: {
    "/flow/f08-calendar": (ctx) => {
      const v = V(ctx);
      return {
        title: "Appointments",
        body: v.wrap(`<h1>Book an appointment</h1><div><button onclick="m=Math.max(0,m-1);draw()">${v.lab("‹ Previous month", "‹")}</button> <b id="mh"></b> <button aria-label="Next month" onclick="m=Math.min(1,m+1);draw()">${v.lab("Next month ›", "›")}</button></div><div id="grid"></div><div id="slots"></div><button onclick="if(sel.day&&sel.time)${kv("appt", "sel.day+' '+sel.time")}">${v.lab("Confirm", "Book this time")}</button>
          <script>let m=0;const names=['November 2026','December 2026'];const sel={};function draw(){mh.textContent=names[m];grid.innerHTML=Array.from({length:30},(_,i)=>'<button style="width:40px" onclick="pick('+(i+1)+')">'+(i+1)+'</button>').join('')}
          function pick(d){sel.day='2026-'+(m?'12':'11')+'-'+String(d).padStart(2,'0');slots.innerHTML='Times for '+sel.day+': '+['09:00','10:30','14:00'].map(t=>'<button onclick="sel.time=\\''+t+'\\'">'+t+'</button>').join('')}draw()</script>`),
      };
    },
  },
  steps: [act("Go to the next month"), act("Pick the 14th"), act("Choose the 10:30 time"), act("Confirm the appointment")],
  check: ({ state }) => kvIs(state, "appt", "2026-12-14 10:30"),
});

// f09 three-step wizard
add({
  id: "f09-wizard",
  pages: {
    "/flow/f09-wizard": (ctx) => {
      const v = V(ctx);
      const plans = ["Solo", "Team", "Business"];
      return {
        title: "Set up",
        body: v.wrap(`<h1>Set up your workspace</h1><div id="s1">${v.order(plans).map((p) => `<label class="card" style="display:block"><input type="radio" name="p" value="${p}" onchange="w.plan='${p}'"> ${p}</label>`).join("")}</div>
          <div id="s2" style="display:none"><label>${v.lab("Company name", "Organisation")} <input oninput="w.company=this.value"></label></div><div id="s3" style="display:none"><p>All set.</p></div>
          <button id="nx" onclick="step++;show()">${v.lab("Next", "Continue")}</button><button id="fin" style="display:none" onclick="w.done=true;${kv("wizard", "w")}">${v.lab("Finish", "Create workspace")}</button>
          <script>let step=1;const w={};function show(){[1,2,3].forEach(i=>document.getElementById('s'+i).style.display=i===step?'block':'none');nx.style.display=step<3?'':'none';fin.style.display=step===3?'':'none'}</script>`),
      };
    },
  },
  steps: [act("Choose the Team plan"), act("Go to the next step"), act("Type 'Northwind' as the company name"), act("Go to the next step"), act("Finish the setup")],
  check: ({ state }) => kvIs(state, "wizard", { plan: "Team", company: "Northwind", done: true }),
});

// f10 docs navigation then read a code sample
add({
  id: "f10-docs",
  pages: {
    "/flow/f10-docs": (ctx) => {
      const v = V(ctx);
      const guides = ["Authentication", "Pagination", "Webhooks", "Rate limits"];
      return {
        title: "Docs",
        body: v.wrap(`<aside><details ${v.v2 ? "open" : ""}><summary>Guides</summary><ul>${v.order(guides).map((g) => `<li><a href="/flow/f10-docs/${g.toLowerCase().replace(" ", "-")}">${g}</a></li>`).join("")}</ul></details><details><summary>Reference</summary><ul><li><a href="#">Objects</a></li></ul></details></aside><h1>Documentation</h1>`),
      };
    },
    "/flow/f10-docs/webhooks": (ctx) => {
      const v = V(ctx);
      return { title: "Webhooks", body: v.wrap(`<h1>${v.lab("Webhooks", "Webhook events")}</h1><p>Register an endpoint to receive events.</p><pre><code>curl -X POST https://api.example.test/v2/hooks \\\n  -d url=https://you.test/in</code></pre><pre><code>curl -X DELETE https://api.example.test/v2/hooks/{id}</code></pre>`) };
    },
    "/flow/f10-docs/authentication": { title: "Auth", body: "<h1>Authentication</h1>" },
    "/flow/f10-docs/pagination": { title: "Pagination", body: "<h1>Pagination</h1>" },
    "/flow/f10-docs/rate-limits": { title: "Rate limits", body: "<h1>Rate limits</h1>" },
  },
  steps: [act("Open the Guides section in the sidebar"), act("Open the Webhooks guide"), ext("In the first code sample, what HTTP method and URL path are used?", S.obj({ method: S.str(), path: S.str() }))],
  check: ({ state, results }) => {
    const d = lastData(results) || {};
    if (d.__error) return `extract failed: ${d.__error}`;
    return all(loaded(state), matches(d.method, "POST"), String(d.path || "").endsWith("/v2/hooks") ? true : `path ${JSON.stringify(d.path)}`);
  },
});
function loaded(state) {
  return state.loads().some((l) => l.path.endsWith("/webhooks")) ? true : "webhooks page not opened";
}

// f11 pagination then detail
const orders = Array.from({ length: 20 }, (_, i) => [2001 + i, ["Processing", "Shipped", "Delivered"][(i * 7) % 3]]);
add({
  id: "f11-orders",
  pages: {
    "/flow/f11-orders": (ctx) => {
      const v = V(ctx);
      const page = Number(ctx.query.get("page") || 1);
      const rows = orders.slice((page - 1) * 10, page * 10);
      return {
        title: `Orders page ${page}`,
        body: v.wrap(`<h1>Orders</h1><table><tr><th>Order</th><th></th></tr>${rows.map(([n]) => `<tr><td>#${n}</td><td><a href="/flow/f11-orders/o/${n}">${v.lab("Details", "Open")}</a></td></tr>`).join("")}</table><nav>${[1, 2].map((p) => `<a href="?page=${p}">${v.v2 ? "Page " + p : p}</a> `).join("")}</nav>`),
      };
    },
    ...Object.fromEntries(orders.map(([n, s]) => [`/flow/f11-orders/o/${n}`, (ctx) => ({ title: `Order ${n}`, body: V(ctx).wrap(`<h1>Order #${n}</h1><p>Status: <b>${s}</b></p><p>Items: 2</p>`) })])),
  },
  steps: [act("Go to page 2 of the orders"), act("Open the details of order #2017"), ext("What is the status of this order?", S.obj({ status: S.str() }))],
  check: ({ state, results }) => all(state.loads().some((l) => l.path.endsWith("/o/2017")) ? true : "order 2017 not opened", extIs(results, { status: orders[16][1] })),
});

// f12 address form
add({
  id: "f12-address",
  pages: {
    "/flow/f12-address": (ctx) => {
      const v = V(ctx);
      const f = (k, l) => `<label>${l} <input name="${k}" id="${v.id(k)}"></label><br>`;
      return {
        title: "Address",
        body: v.wrap(`<h1>Delivery address</h1><form id="a" onsubmit="event.preventDefault();const d=Object.fromEntries(new FormData(a));${kv("address", "d")}">${f("street", v.lab("Street", "Address line 1"))}${f("city", v.lab("City", "Town or city"))}${f("postcode", v.lab("Postcode", "ZIP / Postal code"))}<label>Country <select name="country"><option value="">Choose</option>${v.order(["France", "Germany", "Ireland", "Italy"]).map((c) => `<option>${c}</option>`).join("")}</select></label><br><button>${v.lab("Use this address", "Save address")}</button></form>`),
      };
    },
  },
  steps: [act("Type '7 Quay Street' as the street"), act("Type 'Galway' as the city"), act("Type 'H91 E2K3' as the postcode"), act("Choose Ireland as the country"), act("Save the address")],
  check: ({ state }) => kvIs(state, "address", { street: "7 Quay Street", city: "Galway", postcode: "H91 E2K3", country: "Ireland" }),
});

// f13 modal invite
add({
  id: "f13-invite",
  pages: {
    "/flow/f13-invite": (ctx) => {
      const v = V(ctx);
      return {
        title: "Members",
        css: `#m{display:none;position:fixed;top:15%;left:25%;background:#fff;border:1px solid #333;padding:16px}`,
        body: v.wrap(`<h1>Members</h1><p>3 members</p><button onclick="m.style.display='block'">${v.lab("Invite teammate", "Add people")}</button>
          <div id="m" role="dialog" aria-label="Invite"><label>Email <input id="e"></label><br><label>Role <select id="r">${v.order(["Viewer", "Editor", "Admin"]).map((x) => `<option>${x}</option>`).join("")}</select></label><br><button onclick="${kv("invite", "{email:e.value,role:r.value}")};m.style.display='none'">${v.lab("Send invite", "Invite")}</button><button onclick="m.style.display='none'">Cancel</button></div>`),
      };
    },
  },
  steps: [act("Open the invite dialog"), act("Type 'sam@example.test' as the email"), act("Choose the Editor role"), act("Send the invite")],
  check: ({ state }) => kvIs(state, "invite", { email: "sam@example.test", role: "Editor" }),
});

// f14 accordion then read
add({
  id: "f14-faq",
  pages: {
    "/flow/f14-faq": (ctx) => {
      const v = V(ctx);
      const qa = [["Shipping", "We ship in 2 working days."], ["Returns", "You can return items within 30 days of delivery."], ["Warranty", "Two years on all items."]];
      return { title: "FAQ", body: v.wrap(`<h1>${v.lab("FAQ", "Help")}</h1>${v.order(qa).map(([q, a]) => `<details><summary>${v.lab(q, q + " policy")}</summary><p>${a}</p></details>`).join("")}`) };
    },
  },
  steps: [act("Expand the Returns question"), ext("How many days do customers have to return an item?", S.obj({ days: S.num() }))],
  check: ({ results }) => extIs(results, { days: 30 }),
});

// f15 cart quantities
add({
  id: "f15-cart",
  pages: {
    "/flow/f15-cart": (ctx) => {
      const v = V(ctx);
      return {
        title: "Cart",
        body: v.wrap(`<h1>Cart</h1><div id="c"></div><p id="tot"></p><script>const it=[{n:'Wool socks',p:8,q:1},{n:'Trail mug',p:15,q:1},{n:'Gift wrap',p:4,q:1}];
          function draw(){c.innerHTML=it.map((x,i)=>'<div class="card">'+x.n+' — $'+x.p+' <button aria-label="Decrease '+x.n+'" onclick="it['+i+'].q=Math.max(1,it['+i+'].q-1);draw()">−</button> '+x.q+' <button aria-label="Increase '+x.n+'" onclick="it['+i+'].q++;draw()">+</button> <button onclick="it.splice('+i+',1);draw()">${v.lab("Remove", "Delete")}</button></div>').join('');const t=it.reduce((s,x)=>s+x.p*x.q,0);tot.textContent='Total: $'+t;__probe.set('cart',it.map(x=>x.n+'x'+x.q))}draw()</script>`),
      };
    },
  },
  steps: [act("Increase the quantity of wool socks by one"), act("Increase the quantity of wool socks by one"), act("Remove the gift wrap"), ext("What is the cart total in dollars?", S.obj({ total: S.num() }))],
  check: ({ state, results }) => all(kvIs(state, "cart", ["Wool socksx3", "Trail mugx1"]), extIs(results, { total: 39 })),
});

// f16 kanban move via menu
add({
  id: "f16-kanban",
  pages: {
    "/flow/f16-kanban": (ctx) => {
      const v = V(ctx);
      const cards = ["Write tests", "Update docs", "Fix login bug"];
      return {
        title: "Board",
        css: `.menu{display:none;border:1px solid #888;background:#fff;padding:4px}.menu.open{display:block}`,
        body: v.wrap(`<h1>Sprint board</h1><h2>In progress</h2>${cards.map((c, i) => `<div class="card">${c} <button aria-label="${v.lab("Card menu", "More actions")} for ${c}" onclick="document.getElementById('m${i}').classList.toggle('open')">⋯</button><div class="menu" id="m${i}">${v.lab("Move to", "Send to")}: ${v.order(["To do", "Review", "Done"]).map((col) => `<button onclick="${kv("moved", `{card:'${c}',to:'${col}'}`)}">${col}</button>`).join("")}</div></div>`).join("")}<h2>Done</h2>`),
      };
    },
  },
  steps: [act("Open the menu of the 'Write tests' card"), act("Move the card to Done")],
  check: ({ state }) => kvIs(state, "moved", { card: "Write tests", to: "Done" }),
});

// f17 survey
add({
  id: "f17-survey",
  pages: {
    "/flow/f17-survey": (ctx) => {
      const v = V(ctx);
      return {
        title: "Feedback",
        body: v.wrap(`<h1>Tell us how we did</h1><div>${[1, 2, 3, 4, 5].map((n) => `<button aria-label="${n} star${n > 1 ? "s" : ""}" onclick="sv.rating=${n}">${"★".repeat(n)}</button>`).join("")}</div>
          <fieldset><legend>${v.lab("How often do you use the app?", "Usage")}</legend>${v.order(["Daily", "Weekly", "Monthly"]).map((f) => `<label><input type="radio" name="f" onchange="sv.freq='${f}'"> ${f}</label>`).join("")}</fieldset>
          <label>${v.lab("Comments", "Anything else?")}<br><textarea oninput="sv.comment=this.value"></textarea></label><br><button onclick="${kv("survey", "sv")}">${v.lab("Submit", "Send feedback")}</button><script>var sv={}</script>`),
      };
    },
  },
  steps: [act("Give a 4 star rating"), act("Choose Weekly as how often the app is used"), act("Type 'Great app' in the comments"), act("Submit the survey")],
  check: ({ state }) => kvIs(state, "survey", { rating: 4, freq: "Weekly", comment: "Great app" }),
});

// f18 compare then read
const models = [["Model A", 12], ["Model B", 15], ["Model C", 18], ["Model D", 10]];
add({
  id: "f18-compare",
  pages: {
    "/flow/f18-compare": (ctx) => {
      const v = V(ctx);
      return {
        title: "Speakers",
        body: v.wrap(`<h1>Portable speakers</h1>${v.order(models).map(([m]) => `<div class="card">${m} <label><input type="checkbox" onchange="sel[this.checked?'add':'delete']('${m}')"> ${v.lab("Compare", "Add to comparison")}</label></div>`).join("")}
          <button onclick="${kv("compared", "[...sel].sort()")};cmp.innerHTML='<table><tr><th>Model</th><th>Battery life</th></tr>'+[...sel].sort().map(m=>'<tr><td>'+m+'</td><td>'+bat[m]+' hours</td></tr>').join('')+'</table>'">${v.lab("Compare selected", "Show comparison")}</button><div id="cmp"></div>
          <script>const sel=new Set();const bat=${JSON.stringify(Object.fromEntries(models))}</script>`),
      };
    },
  },
  steps: [act("Select Model A for comparison"), act("Select Model C for comparison"), act("Show the comparison"), ext("What is the battery life of Model C in hours?", S.obj({ hours: S.num() }))],
  check: ({ state, results }) => all(kvIs(state, "compared", ["Model A", "Model C"]), extIs(results, { hours: 18 })),
});

// f19 checkout with a cross-origin card widget (fake, local)
add({
  id: "f19-checkout",
  pages: {
    "/flow/f19-checkout": (ctx) => {
      const v = V(ctx);
      return {
        title: "Checkout",
        body: v.wrap(`<h1>Checkout</h1><h2>Payment</h2><iframe src="{{X}}/flow/f19-checkout/card" width=460 height=110></iframe><h2>${v.lab("Shipping", "Delivery")}</h2>${v.order(["Standard", "Express"]).map((s) => `<label><input type="radio" name="s" onchange="${kv("shipping", `'${s}'`)}"> ${s}</label>`).join(" ")}<br><button onclick="${kv("review", "true")}">${v.lab("Review order", "Continue to review")}</button>`),
      };
    },
    "/flow/f19-checkout/card": (ctx) => ({ title: "Card", body: `<label>${V(ctx).lab("Name on card", "Cardholder")} <input oninput="__probe.set('cardName',this.value)"></label><p style="color:#777">Test widget. No real payment.</p>` }),
  },
  steps: [act("Type 'Test User' as the name on the card"), act("Choose standard shipping"), act("Go to the order review")],
  check: ({ state }) => all(kvIs(state, "cardName", "Test User"), kvIs(state, "shipping", "Standard"), kvIs(state, "review", true)),
});

// f20 paging through an article
const parts = ["Part one: the coast road", "Part two: the lighthouse", "Part three: the harbour", "Part four: home"];
add({
  id: "f20-article",
  start: "/flow/f20-article/1",
  pages: Object.fromEntries(
    parts.map((h, i) => [
      `/flow/f20-article/${i + 1}`,
      (ctx) => {
        const v = V(ctx);
        return { title: `Travelogue (${i + 1}/4)`, body: v.wrap(`<h1>${h}</h1><p>${"The road bends along the water. ".repeat(10)}</p><nav>${i > 0 ? `<a href="/flow/f20-article/${i}">${v.lab("Previous page", "Back")}</a> ` : ""}${i < 3 ? `<a href="/flow/f20-article/${i + 2}">${v.lab("Next page", "Continue reading")}</a>` : ""}</nav>`) };
      },
    ]),
  ),
  steps: [act("Go to the next page of the article"), act("Go to the next page of the article"), ext("What is the heading of this page?", S.obj({ heading: S.str() }))],
  check: ({ results }) => extIs(results, { heading: "Part three: the harbour" }),
});

export default T;
