// Example 2: sign in with secrets. The model sees only %email% and
// %password%; the values are typed at the keystroke, only on localhost, and
// never reach a prompt, a trace or the saved flow.
//   OPENAI_API_KEY=... APP_EMAIL=ada@example.com APP_PASSWORD=pw npx tsx examples/login-secrets.ts
import { Ghostwright, env } from "../src/index.js";
import { startFixtures } from "../test/server.js";

const site = await startFixtures(); // a small local site with a login form
const gw = await Ghostwright.create({
  model: process.env.GHOSTWRIGHT_MODEL ?? "openai/gpt-5.6-luna",
  secrets: {
    email: env("APP_EMAIL", { origins: ["localhost"] }),
    password: env("APP_PASSWORD", { origins: ["localhost"] }),
  },
});
try {
  const flow = await gw.flow("fixture-login");
  await flow.goto(`${site.url}/login.html`);
  await flow.act("type %email% into the email field");
  await flow.act("type %password% into the password field");
  const r = await flow.act("click sign in");
  console.log(r.result.split("\n")[1]); // navigated → .../account.html
  const recipe = await flow.save();
  console.log(recipe.steps.map(s => `${s.id} ${s.kind} ${s.text ?? s.target?.name ?? s.url ?? ""}`).join("\n"));
  // s2 type {{secret:APP_EMAIL}}  s3 type {{secret:APP_PASSWORD}}: no values on disk,
  // and the same tokens Browsa Secrets types when the flow runs on Browsa
} finally {
  await gw.close();
  await site.close();
}
