import { PROVIDERS } from "./providers.js";
import type { ProviderId } from "./types.js";

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(", ")}.`);
    this.name = "UnknownProviderError";
  }
}

/** Provider selection: --provider flag > LLM_PROVIDER env > default deepseek. */
export function resolveProvider(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderId {
  const provider = flag ?? env.LLM_PROVIDER ?? "deepseek";
  if (!(provider in PROVIDERS)) throw new UnknownProviderError(provider);
  return provider as ProviderId;
}

/**
 * Model resolution per provider:
 * --model flag > that provider's model env var (e.g. ANTHROPIC_MODEL) > the provider's default.
 * Model IDs pass through unvalidated: model catalogs go stale, so refusing
 * unknown IDs would reject valid models (revisit if it bites).
 */
export function resolveModel(
  provider: ProviderId,
  modelFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const info = PROVIDERS[provider];
  const envModel = (env[info.modelEnvVar] ?? "").trim();
  return modelFlag ?? (envModel || info.defaultModel);
}
