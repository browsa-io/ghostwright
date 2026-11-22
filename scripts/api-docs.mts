// Writes docs/api.md from the types that src/index.ts exports.
//   npx tsx scripts/api-docs.mts            write docs/api.md
//   npx tsx scripts/api-docs.mts --check    exit 1 when docs/api.md is out of date
// Signatures and comments come from the source, so the reference cannot drift from the code.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = root + "src/index.ts";
const outFile = root + "docs/api.md";

export function render(): string {
  const cfg = ts.readConfigFile(root + "tsconfig.json", ts.sys.readFile);
  const opts = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).options;
  const program = ts.createProgram([entry], { ...opts, noEmit: true });
  const checker = program.getTypeChecker();
  const src = program.getSourceFile(entry)!;
  const mod = checker.getSymbolAtLocation(src)!;
  const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType | ts.TypeFormatFlags.WriteArrowStyleSignature;

  const doc = (s: ts.Symbol) => ts.displayPartsToString(s.getDocumentationComment(checker)).replace(/\s*\n\s*/g, " ").trim();
  const hidden = (s: ts.Symbol) => {
    if (s.getJsDocTags().some(t => t.name === "internal")) return true;
    if (/^@internal\b/.test(doc(s))) return true;
    const d = s.declarations?.[0];
    if (!d) return false;
    const m = ts.getCombinedModifierFlags(d as ts.Declaration);
    return !!(m & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) || s.name.startsWith("#") || s.name.startsWith("_");
  };
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";
  const typeOf = (s: ts.Symbol, at: ts.Node) => checker.typeToString(checker.getTypeOfSymbolAtLocation(s, at), at, FLAGS);
  const sigText = (name: string, sig: ts.Signature, at: ts.Node) => name + checker.signatureToString(sig, at, FLAGS | ts.TypeFormatFlags.WriteArrowStyleSignature).replace(/ => /, ": ").replace(/^\((.*)\): /s, "($1): ");

  const sections: Record<string, string[]> = { Classes: [], Functions: [], Errors: [], "Options and results": [], Values: [] };

  const members = (type: ts.Type, at: ts.Node, staticSide?: ts.Type): string[] => {
    const lines: string[] = [];
    const rows: string[] = [];
    const emit = (p: ts.Symbol, prefix: string) => {
      if (hidden(p) || p.name === "prototype") return;
      const d = p.valueDeclaration ?? p.declarations?.[0];
      if (!d) return;
      // what every Error or object has (name, message, stack) is not listed
      if (program.isSourceFileDefaultLibrary(d.getSourceFile()) || d.getSourceFile().fileName.includes("/node_modules/")) return;
      const t = checker.getTypeOfSymbolAtLocation(p, at);
      const calls = t.getCallSignatures();
      const isMethod = !!(p.flags & ts.SymbolFlags.Method) || (calls.length > 0 && ts.isMethodDeclaration(d));
      if (isMethod) {
        for (const sig of calls) {
          const sd = ts.displayPartsToString(sig.getDocumentationComment(checker)).replace(/\s*\n\s*/g, " ").trim() || doc(p);
          rows.push(`| ${code(cell(prefix + sigText(p.name, sig, at)))} | ${cell(sd)} |`);
        }
      } else {
        const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
        rows.push(`| ${code(cell(`${prefix}${p.name}${opt}: ${typeOf(p, at)}`))} | ${cell(doc(p))} |`);
      }
    };
    if (staticSide) for (const p of staticSide.getProperties()) emit(p, "static ");
    for (const p of type.getProperties()) emit(p, "");
    if (rows.length) lines.push("| Member | What it is |", "|---|---|", ...rows);
    return lines;
  };

  const exports = checker.getExportsOfModule(mod).sort((a, b) => a.name.localeCompare(b.name));
  for (const ex of exports) {
    const s = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
    const d = s.declarations?.[0];
    if (!d || hidden(s)) continue;
    const head = (kind: string) => [`### ${ex.name}`, "", ...(doc(s) ? [doc(s), ""] : []), `*${kind}*`, ""];
    if (s.flags & ts.SymbolFlags.Class) {
      const inst = checker.getDeclaredTypeOfSymbol(s);
      const stat = checker.getTypeOfSymbolAtLocation(s, d);
      const isError = inst.getBaseTypes()?.some(function up(b): boolean { return b.symbol?.name === "Error" || !!b.getBaseTypes()?.some(up); }) ?? false;
      (isError ? sections.Errors : sections.Classes).push(...head(isError ? "error class" : "class"), ...members(inst, d, isError ? undefined : stat), "");
    } else if (s.flags & ts.SymbolFlags.Function) {
      const t = checker.getTypeOfSymbolAtLocation(s, d);
      const sigs = t.getCallSignatures();
      sections.Functions.push(...head("function"), "```ts", ...sigs.map(sig => sigText(ex.name, sig, d)), "```", "");
    } else if (s.flags & ts.SymbolFlags.Interface) {
      sections["Options and results"].push(...head("interface"), ...members(checker.getDeclaredTypeOfSymbol(s), d), "");
    } else if (s.flags & ts.SymbolFlags.TypeAlias) {
      const t = checker.getDeclaredTypeOfSymbol(s);
      const text = (d as ts.TypeAliasDeclaration).type.getText().replace(/\s*\n\s*/g, " ");
      const props = t.isUnion() || !(t.flags & ts.TypeFlags.Object) ? [] : members(t, d);
      sections["Options and results"].push(...head("type"), ...(props.length ? props : ["```ts", `type ${ex.name} = ${text}`, "```"]), "");
    } else if (s.flags & ts.SymbolFlags.Variable) {
      sections.Values.push(...head("value"), "```ts", `${ex.name}: ${typeOf(s, d).slice(0, 400)}`, "```", "");
    }
  }

  const out = [
    "# API reference",
    "",
    "Everything `ghostwright` exports, written from the types in `src/` by `scripts/api-docs.mts` (`npm run docs`). Do not edit by hand: change the source comments and run it again. The [README](../README.md) and the [guides](README.md) explain how the parts fit together.",
    "",
  ];
  for (const [title, body] of Object.entries(sections)) if (body.length) out.push(`## ${title}`, "", ...body);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render();
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(outFile, "utf8"); } catch { /* missing */ }
    if (have !== text) { console.error("docs/api.md is out of date: run `npm run docs`"); process.exit(1); }
    console.log("docs/api.md is up to date");
  } else {
    writeFileSync(outFile, text);
    console.log(`wrote docs/api.md (${text.split("\n").length} lines)`);
  }
}
