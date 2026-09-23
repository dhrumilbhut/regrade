import { anthropicAdapter } from "./adapters/anthropicAdapter.js";
import { httpAdapter } from "./adapters/httpAdapter.js";
import { openaiAdapter } from "./adapters/openaiAdapter.js";
import { Registry } from "./core/registry.js";
import { exactMatch } from "./scorers/exactMatch.js";
import { latencyCost } from "./scorers/latencyCost.js";
import { llmJudge } from "./scorers/llmJudge.js";
import { maxSteps, toolCalled } from "./scorers/traceScorers.js";

/** Built-ins register through the same public API that user code uses. */
export function registerBuiltins(registry: Registry): Registry {
  registry
    .registerAdapter(httpAdapter)
    .registerAdapter(openaiAdapter)
    .registerAdapter(anthropicAdapter)
    .registerScorer(exactMatch)
    .registerScorer(llmJudge)
    .registerScorer(latencyCost)
    .registerScorer(toolCalled)
    .registerScorer(maxSteps);
  return registry;
}

/** A fresh registry with the built-in adapters and scorers. */
export function createRegistry(): Registry {
  return registerBuiltins(new Registry());
}
