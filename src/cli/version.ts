declare const __REGRADE_VERSION__: string | undefined;

/** Injected at build time by tsup; falls back when running from source (tests, tsx). */
export const VERSION: string = typeof __REGRADE_VERSION__ === "string" ? __REGRADE_VERSION__ : "0.0.0-dev";
