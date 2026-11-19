// Checks a recipe against Browsa's recipe v1 schema (schema/recipe-v1.json).
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("../schema/recipe-v1.json", import.meta.url), "utf8"));
const ajv = new (Ajv2020 as any)({ allErrors: true, strict: false });
(addFormats as any)(ajv);
const check = ajv.compile(schema);

/** "" when valid, else the errors. */
export function recipeErrors(r: unknown): string {
  return check(r) ? "" : ajv.errorsText(check.errors);
}
