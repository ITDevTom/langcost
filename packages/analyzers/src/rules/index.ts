import { agentLoopsRule } from "./agent-loops";
import { cacheExpiryRule } from "./cache-expiry";
import { highOutputRule } from "./high-output";
import { lowCacheRule } from "./low-cache";
import { modelOveruseRule } from "./model-overuse";
import { retryPatternsRule } from "./retry-patterns";
import { toolFailuresRule } from "./tool-failures";

export { agentLoopsRule } from "./agent-loops";
export { cacheExpiryRule } from "./cache-expiry";
export { highOutputRule } from "./high-output";
export { lowCacheRule } from "./low-cache";
export { modelOveruseRule } from "./model-overuse";
export { retryPatternsRule } from "./retry-patterns";
export { toolFailuresRule } from "./tool-failures";
export type { WasteRule } from "./types";

export const tier1Rules = [
  lowCacheRule,
  modelOveruseRule,
  agentLoopsRule,
  retryPatternsRule,
  toolFailuresRule,
  highOutputRule,
  cacheExpiryRule,
];
