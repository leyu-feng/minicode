import { materializePiDistribution } from "./materialize-pi-distribution.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import { materializePinnedCursorDistribution } from "./materialize-cursor-distribution.mjs";
const CANDIDATES = new Set(["cursor", "copilot", "pi"]);

/** Only materialized providers enter the serialized manifest and its digest. */
export function providerPackManifestFields(providers, candidates) {
  return {
    ...(["pi", "cursor"].some(provider => providers[provider]) ? { providers: Object.fromEntries(["pi", "cursor"].filter(provider => providers[provider]).map(provider => [provider, providers[provider]])) } : {}),
    ...(["pi", ...candidates].some(provider => providers[provider]) ? { candidateProviders: Object.fromEntries([...new Set(["pi", ...candidates])].filter(provider => providers[provider]).map(provider => [provider, providers[provider]])) } : {}),
  };
}

export function providerPackProviders(platform, architecture, candidates, excluded = []) {
  const nativeSupported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(`${platform}-${architecture}`);
  return [...new Set([...(nativeSupported ? ["pi", "cursor"] : []), ...candidates])]
    .filter(provider => !excluded.includes(provider));
}

export function parseProviderPackArguments(args) {
  let output;
  const candidates = [];
  const excluded = [];
  for (const value of args.filter(value => value !== "--")) {
    if (value.startsWith("--candidate-providers=")) {
      for (const provider of value.slice("--candidate-providers=".length).split(",").filter(Boolean)) {
        if (!CANDIDATES.has(provider) || candidates.includes(provider)) throw new Error("Unknown or duplicate candidate provider");
        candidates.push(provider);
      }
    } else if (value.startsWith("--exclude-providers=")) {
      for (const provider of value.slice("--exclude-providers=".length).split(",").filter(Boolean)) {
        if (!CANDIDATES.has(provider) || excluded.includes(provider)) throw new Error("Unknown or duplicate excluded provider");
        excluded.push(provider);
      }
    } else if (value.startsWith("--") || output !== undefined) throw new Error("Invalid provider-pack arguments");
    else output = value;
  }
  if (candidates.some(provider => excluded.includes(provider))) throw new Error("Provider cannot be both selected and excluded");
  return { output, candidates, excluded };
}

/** Closed source-owned builder registry; provider branches add their exact pins. */
export async function materializeCandidateProviderPack({ provider, outputRoot }) {
  if (!CANDIDATES.has(provider)) throw new Error("Unknown candidate provider");
  if (provider === "pi") return materializePiDistribution({ outputRoot });
  if (provider === "copilot") {
    const { buildPinnedCopilotDistribution } = await import("./build-copilot-distribution.mjs");
    return buildPinnedCopilotDistribution({ outputRoot });
  }
  if (provider === "cursor") {
    const result = await materializePinnedCursorDistribution({ destination: outputRoot });
    return { version: result.version,
      profileDigest: profiles.profiles.cursor.commandDigest,
      closureDigest: `sha256:${result.closureSha256}` };
  }
  throw new Error(`The ${provider} candidate distribution builder is not included in this source revision`);
}
