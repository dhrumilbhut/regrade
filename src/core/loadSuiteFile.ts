import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRegistry } from "../builtins.js";
import { functionAdapter, isPipelineFunction, toScorer, type CodeSuite } from "./codeSuite.js";
import { ConfigError, errorMessage } from "./errors.js";
import type { Registry } from "./registry.js";
import { checkSuite, loadSuite, parseSuite } from "./testSuite.js";
import type { TestSuite } from "./types.js";

const TS_EXT = new Set([".ts", ".mts"]);
const JS_EXT = new Set([".js", ".mjs"]);

export interface LoadedSuite {
  suite: TestSuite;
  /** Built-ins plus any inline scorers/adapters the suite file defined. */
  registry: Registry;
  kind: "json" | "code";
}

/** Node can import `.ts` directly (type stripping) from 22.18; earlier versions report `false`. */
function canImportTypeScript(): boolean {
  const f = (process.features as { typescript?: unknown }).typescript;
  return f === "strip" || f === "transform" || f === true;
}

/**
 * Load a suite from a `.json` file (data only) or a `.ts` / `.mts` / `.js` / `.mjs` module whose default export
 * is a suite (or a function returning one). Code suites are ordinary modules: **loading one runs its code**,
 * exactly like a test file.
 */
export async function loadSuiteFile(path: string, base: Registry = createRegistry()): Promise<LoadedSuite> {
  const ext = extname(path).toLowerCase();
  if (ext === ".json" || ext === "") {
    return { suite: loadSuite(path, base), registry: base, kind: "json" };
  }
  if (!TS_EXT.has(ext) && !JS_EXT.has(ext)) {
    throw new ConfigError(`Unsupported suite file type "${ext}" (${path}). Use .json, .ts, .mts, .js or .mjs.`);
  }
  if (TS_EXT.has(ext) && !canImportTypeScript()) {
    throw new ConfigError(
      `Cannot load ${path}: this Node.js (${process.version}) cannot import TypeScript files. ` +
        "TypeScript suites need Node 22.18 or newer (native type stripping). Upgrade Node, or write the suite as .mjs or .json.",
    );
  }

  const abs = resolve(path);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const moduleTypeProblem = /Unexpected token 'export'|Cannot use import statement|Unexpected identifier 'default'/.test(errorMessage(err));
    const hint = moduleTypeProblem
      ? ' Node is treating this file as CommonJS because your package.json does not say "type": "module". Rename it to .mts / .mjs, or set "type": "module" in package.json. Local helper files need the same treatment.'
      : code === "ERR_MODULE_NOT_FOUND"
        ? " If it imports another TypeScript file, write the extension in the import (\"./helpers.ts\"). If it imports \"regrade\", install it in your project (npm i -D regrade) or use `import type`."
        : "";
    throw new ConfigError(`Failed to load suite module ${path}: ${errorMessage(err)}.${hint}`, { cause: err });
  }

  let def: unknown = mod.default;
  if (typeof def === "function") {
    try {
      def = await (def as () => unknown)();
    } catch (err) {
      throw new ConfigError(`The suite function exported by ${path} threw: ${errorMessage(err)}`, { cause: err });
    }
  }
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new ConfigError(`${path} must \`export default\` a suite object (or a function returning one).`);
  }

  const { scorers: inline, pipeline, ...rest } = def as CodeSuite;
  const registry = base;

  if (inline !== undefined) {
    if (!inline || typeof inline !== "object" || Array.isArray(inline)) {
      throw new ConfigError(`${path}: "scorers" must be an object mapping scorer names to functions.`);
    }
    for (const [name, scorerDef] of Object.entries(inline)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
        throw new ConfigError(`${path}: inline scorer name "${name}" may only contain letters, digits, '.', '_' and '-' and must start with a letter.`);
      }
      if (registry.hasScorer(name)) {
        throw new ConfigError(`${path}: inline scorer "${name}" would replace a scorer with the same name. Pick a different name.`);
      }
      registry.registerScorer(toScorer(name, scorerDef));
    }
  }

  let pipelineData: TestSuite["pipeline"];
  if (isPipelineFunction(pipeline)) {
    const adapter = functionAdapter(pipeline);
    if (registry.hasAdapter(adapter.name)) {
      throw new ConfigError(`${path}: pipeline name "${adapter.name}" collides with a registered adapter. Rename it.`);
    }
    registry.registerAdapter(adapter);
    pipelineData = { adapter: adapter.name, config: pipeline.config ?? {} };
  } else {
    pipelineData = pipeline as TestSuite["pipeline"];
  }

  const suite = parseSuite({ ...rest, pipeline: pipelineData }, path);
  checkSuite(suite, registry, path);
  return { suite, registry, kind: "code" };
}
