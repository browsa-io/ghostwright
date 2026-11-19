// Renders a first-vs-replay result into the README chart and table.
//
//   npx tsx bench/render-chart.mts [bench/results/first-vs-replay-<date>.json] [--out-dir dir] [--transparent] [--no-title]
//
// Writes assets/speed-dark.svg and assets/speed-light.svg (or into --out-dir; --transparent leaves out
// the background, for a page that has its own; --no-title leaves out the title lines, for a page that has a
// heading), and prints the Markdown table. With no file
// it takes the newest result in bench/results. Medians: run 1 over the trials, runs 2-5 over every replay.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const transparent = process.argv.includes("--transparent");
const noTitle = process.argv.includes("--no-title");
const fileArg = process.argv.slice(2).find((a, i, all) => a.endsWith(".json") && all[i - 1] !== "--out-dir");
const file = fileArg ?? join(resultsDir, readdirSync(resultsDir).filter(f => /^first-vs-replay-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().at(-1)!);
const res = JSON.parse(readFileSync(file, "utf8"));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

interface Row { id: string; site: string; what: string; recMs: number; repMs: number; recCalls: number; repCalls: number; recUsd: number; repUsd: number; recOk: string; repOk: string; repMin: number; repMax: number }
const rows: Row[] = res.flows.map((f: any) => {
  const runs = res.runs.filter((r: any) => r.flow === f.id);
  const rec = runs.filter((r: any) => r.kind === "record");
  const rep = runs.filter((r: any) => r.kind === "replay");
  const ok = (xs: any[]) => `${xs.filter(r => r.ok).length}/${xs.length}`;
  return {
    id: f.id, site: f.site, what: f.what,
    recMs: median(rec.map((r: any) => r.ms)), repMs: median(rep.map((r: any) => r.ms)),
    recCalls: median(rec.map((r: any) => r.modelCalls)), repCalls: median(rep.map((r: any) => r.modelCalls)),
    recUsd: median(rec.map((r: any) => r.usd)), repUsd: median(rep.map((r: any) => r.usd)),
    recOk: ok(rec), repOk: ok(rep),
    repMin: Math.min(...rep.map((r: any) => r.ms)), repMax: Math.max(...rep.map((r: any) => r.ms)),
  };
});

const sec = (ms: number) => (ms / 1000).toFixed(1) + " s";
const calls = (n: number) => `${n} model call${n === 1 ? "" : "s"}`;
const usd = (x: number) => (x === 0 ? "$0" : x < 0.001 ? `$${x.toFixed(5)}` : `$${x.toFixed(4)}`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const modelName = String(res.model).replace(/^openrouter\//, "");

// Colours checked for contrast and colour-blind separation on each surface (record: blue, replay: green).
const THEMES = {
  light: { bg: "#ffffff", ink: "#1f2328", ink2: "#59636e", ink3: "#818b98", grid: "#d8dee4", record: "#5b7bd5", replay: "#1a8f4c" },
  dark: { bg: "#0d1117", ink: "#f0f6fc", ink2: "#9198a1", ink3: "#6e7681", grid: "#262c36", record: "#6a87dc", replay: "#2fae5e" },
};

function svg(t: (typeof THEMES)["light"]): string {
  const W = 880, padL = 210, padR = 190, top = noTitle ? 56 : 92, rowH = 64, barH = 16, gap = 2;
  const plotW = W - padL - padR;
  const H = top + rows.length * rowH + 58;
  const maxMs = Math.max(...rows.map(r => Math.max(r.recMs, r.repMs)));
  const step = maxMs > 12_000 ? 5000 : maxMs > 6000 ? 2000 : 1000;
  const xMax = Math.ceil(maxMs / step) * step;
  const x = (ms: number) => padL + (ms / xMax) * plotW;
  const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  // a bar with a 4px rounded data end, square at the baseline
  const bar = (y: number, w: number, fill: string) => {
    const r = Math.min(4, w / 2), x0 = padL, x1 = padL + Math.max(w, 1);
    return `<path d="M${x0} ${y}H${x1 - r}Q${x1} ${y} ${x1} ${y + r}V${y + barH - r}Q${x1} ${y + barH} ${x1 - r} ${y + barH}H${x0}Z" fill="${fill}"/>`;
  };
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" ${font}>`);
  out.push(`<title id="t">First run vs replay: median seconds per run</title>`);
  out.push(`<desc id="d">${esc(rows.map(r => `${r.id}: run 1 ${sec(r.recMs)} with ${calls(r.recCalls)}, replays ${sec(r.repMs)} with ${calls(r.repCalls)}`).join("; "))}</desc>`);
  if (!transparent) out.push(`<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`);
  if (!noTitle) {
    out.push(`<text x="24" y="38" font-size="19" font-weight="600" fill="${t.ink}">First run vs replay</text>`);
    out.push(`<text x="24" y="60" font-size="13" fill="${t.ink2}">Median seconds per run, and model calls per run. Lower is better.</text>`);
  }
  // legend: top right, or from the plot's left edge when there is no title
  const lx = noTitle ? padL : W - 24 - 372;
  const ly = noTitle ? 10 : 27;
  out.push(`<rect x="${lx}" y="${ly}" width="12" height="12" rx="3" fill="${t.record}"/><text x="${lx + 18}" y="${ly + 10.5}" font-size="13" fill="${t.ink2}">Run 1: records with the model</text>`);
  out.push(`<rect x="${lx + 236}" y="${ly}" width="12" height="12" rx="3" fill="${t.replay}"/><text x="${lx + 254}" y="${ly + 10.5}" font-size="13" fill="${t.ink2}">Runs 2-5: replay</text>`);
  // grid and axis
  const axisY = top + rows.length * rowH;
  for (let v = 0; v <= xMax; v += step) {
    out.push(`<line x1="${x(v)}" y1="${top - 8}" x2="${x(v)}" y2="${axisY}" stroke="${t.grid}" stroke-width="1"/>`);
    out.push(`<text x="${x(v)}" y="${axisY + 18}" font-size="12" text-anchor="middle" fill="${t.ink3}">${v / 1000} s</text>`);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + 8;
    out.push(`<text x="${padL - 16}" y="${y + 15}" font-size="14" font-weight="600" text-anchor="end" fill="${t.ink}">${esc(r.id)}</text>`);
    out.push(`<text x="${padL - 16}" y="${y + 33}" font-size="12" text-anchor="end" fill="${t.ink3}">${esc(r.site)}</text>`);
    out.push(bar(y, x(r.recMs) - padL, t.record));
    out.push(bar(y + barH + gap, x(r.repMs) - padL, t.replay));
    out.push(`<text x="${x(r.recMs) + 8}" y="${y + 12.5}" font-size="12.5" fill="${t.ink2}"><tspan font-weight="600" fill="${t.ink}">${sec(r.recMs)}</tspan>  ${calls(r.recCalls)}</text>`);
    out.push(`<text x="${x(r.repMs) + 8}" y="${y + barH + gap + 12.5}" font-size="12.5" fill="${t.ink2}"><tspan font-weight="600" fill="${t.ink}">${sec(r.repMs)}</tspan>  ${calls(r.repCalls)}</text>`);
  });
  out.push(`<text x="24" y="${H - 16}" font-size="11.5" fill="${t.ink3}">${esc(`${modelName} · ${res.trials} trials · ${res.date} · local Chrome, public sites · bench/first-vs-replay.mts`)}</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

const assets = flag("out-dir") ?? join(here, "..", "assets");
writeFileSync(join(assets, "speed-light.svg"), svg(THEMES.light));
writeFileSync(join(assets, "speed-dark.svg"), svg(THEMES.dark));

console.log(`| Flow | Run 1 (records) | Runs 2-5 (replay) | Model calls: run 1 / replay | Model cost: run 1 / replay | Passed: run 1, replays |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  console.log(`| \`${r.id}\` ${r.site}: ${r.what} | ${sec(r.recMs)} | ${sec(r.repMs)} (${sec(r.repMin)} to ${sec(r.repMax)}) | ${r.recCalls} / ${r.repCalls} | ${usd(r.recUsd)} / ${usd(r.repUsd)} | ${r.recOk}, ${r.repOk} |`);
}
console.log(`\n${res.totals.ok}/${res.totals.runs} runs passed; ${res.totals.modelCalls} model calls and ${usd(res.totals.usd)} for the whole benchmark (${modelName}, ${res.trials} trials, ${res.date}).`);
console.log(`wrote ${join(assets, "speed-light.svg")} and speed-dark.svg from ${file}`);
