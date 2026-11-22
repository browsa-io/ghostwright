// Sign in with secrets by reference. The model sees %username% and %password%,
// never the values; they are typed only on the origin you allow, and the saved
// flow holds tokens ({{secret:DEMO_PASSWORD}}), not values.
//
//   OPENAI_API_KEY=sk-... node examples/login-secrets.mjs
//
// The site is a public practice page whose demo account is printed on the page
// itself; set DEMO_USERNAME and DEMO_PASSWORD to use other values.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ghostwright, env } from "ghostwright";

export async function main(o = {}) {
  process.env.DEMO_USERNAME ??= "tomsmith";
  process.env.DEMO_PASSWORD ??= "SuperSecretPassword!";
  const url = o.url ?? "https://the-internet.herokuapp.com/login";
  const origins = [new URL(url).host];
  const gw = await Ghostwright.create({
    model: process.env.GHOSTWRIGHT_MODEL || "openai/gpt-5.6-luna",
    secrets: { username: env("DEMO_USERNAME", { origins }), password: env("DEMO_PASSWORD", { origins }) },
    ...o.options,
  });
  try {
    const flow = await gw.flow("demo-login");
    await flow.goto(url);
    await flow.act(`type %username% into the ${o.userField ?? "username"} field`);
    await flow.act("type %password% into the password field");
    const done = await flow.act(o.submit ?? "click the login button");
    console.log(done.ok ? `signed in: now at ${gw.page.url()}` : `not signed in: ${done.reason}`);
    const recipe = await flow.save({ repair: "review" });
    for (const s of recipe.steps) console.log(`  ${s.id} ${s.kind} ${s.text ?? s.target?.name ?? s.url ?? ""}`);
    const onDisk = readFileSync(`${gw.store.dir}/flows/demo-login.json`, "utf8");
    console.log(`the password is in the saved flow: ${onDisk.includes(process.env.DEMO_PASSWORD)}`); // false
    return { ok: done.ok, recipe, leaked: onDisk.includes(process.env.DEMO_PASSWORD) };
  } finally {
    await gw.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
