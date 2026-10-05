// Custom image nodes (custom-image-*) — OpenAI-compatible /images/generations,
// baseUrl carried on the connection credential (no registry entry exists for them).
import createOpenAIAdapter from "./openai.js";

const baseAdapter = createOpenAIAdapter("openai");

export function normalizeImageBaseUrl(rawBaseUrl) {
  return String(rawBaseUrl || "https://api.openai.com/v1")
    .trim()
    .replace(/\/$/, "")
    .replace(/\/images(\/(generations|edits|variations))?$/, "");
}

export default {
  ...baseAdapter,
  buildUrl: (_model, creds) => {
    const baseUrl = normalizeImageBaseUrl(creds?.providerSpecificData?.baseUrl);
    return `${baseUrl}/images/generations`;
  },
};
