export type ModelCapabilityCatalogProvider = "deepseek" | "openai";

export interface ModelCapabilityCatalogEntry {
  readonly contextWindowTokens: number;
  readonly evidenceUrl: string;
  readonly examples: readonly string[];
  readonly id: string;
  readonly matches: RegExp;
  readonly maxOutputTokens: number;
  readonly profileRevision: string;
  readonly provider: ModelCapabilityCatalogProvider;
  readonly verifiedAt: string;
}

export const MODEL_CAPABILITY_CATALOG_REVISION = "2026-08-23";

const OPENAI_MODEL_EVIDENCE =
  "https://developers.openai.com/api/docs/models/compare";
const DEEPSEEK_MODEL_EVIDENCE =
  "https://api-docs.deepseek.com/quick_start/pricing";

export const MODEL_CAPABILITY_CATALOG: readonly ModelCapabilityCatalogEntry[] =
  Object.freeze([
    {
      contextWindowTokens: 1_050_000,
      evidenceUrl: OPENAI_MODEL_EVIDENCE,
      examples: [
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.6-sol-2026-08-23",
      ],
      id: "openai-gpt-5.6",
      matches: /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 128_000,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 1_050_000,
      evidenceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4",
      examples: ["gpt-5.4", "gpt-5.4-2026-08-23"],
      id: "openai-gpt-5.4",
      matches: /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 128_000,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 400_000,
      evidenceUrl: "https://developers.openai.com/api/docs/models/gpt-5.2",
      examples: ["gpt-5.1", "gpt-5.2", "gpt-5.2-2025-12-11"],
      id: "openai-gpt-5.1-5.2",
      matches: /^gpt-5\.(?:1|2)(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 128_000,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 400_000,
      evidenceUrl: "https://developers.openai.com/api/docs/models/gpt-5",
      examples: [
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-5-2025-08-07",
      ],
      id: "openai-gpt-5",
      matches: /^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 128_000,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 1_047_576,
      evidenceUrl: "https://developers.openai.com/api/docs/models/gpt-4.1",
      examples: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"],
      id: "openai-gpt-4.1",
      matches: /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 32_768,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 200_000,
      evidenceUrl: "https://developers.openai.com/api/docs/models/o4-mini",
      examples: ["o3", "o4-mini", "o4-mini-2025-04-16"],
      id: "openai-o3-o4-mini",
      matches: /^(?:o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 100_000,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 128_000,
      evidenceUrl: "https://developers.openai.com/api/docs/models/gpt-4o",
      examples: ["gpt-4o", "gpt-4o-mini", "gpt-4o-2024-11-20"],
      id: "openai-gpt-4o",
      matches: /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u,
      maxOutputTokens: 16_384,
      profileRevision: "2026-08-22",
      provider: "openai",
      verifiedAt: "2026-08-23",
    },
    {
      contextWindowTokens: 1_000_000,
      evidenceUrl: DEEPSEEK_MODEL_EVIDENCE,
      examples: ["deepseek-v4-flash", "deepseek-v4-pro"],
      id: "deepseek-v4",
      matches: /^deepseek-v4-(?:flash|pro)$/u,
      maxOutputTokens: 384_000,
      profileRevision: "2026-08-22",
      provider: "deepseek",
      verifiedAt: "2026-08-23",
    },
  ]);

const allowedEvidenceHosts = new Set([
  "api-docs.deepseek.com",
  "developers.openai.com",
]);

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
}

export function validateModelCapabilityCatalog(
  entries: readonly ModelCapabilityCatalogEntry[] = MODEL_CAPABILITY_CATALOG,
  revision = MODEL_CAPABILITY_CATALOG_REVISION,
): void {
  if (entries.length === 0) {
    throw new TypeError("Model capability catalogue must not be empty");
  }
  const ids = new Set<string>();
  const examples = new Map<string, string>();
  let newestVerification = "";

  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new TypeError(`Duplicate model capability catalogue ID ${entry.id}`);
    }
    ids.add(entry.id);
    if (
      !Number.isSafeInteger(entry.contextWindowTokens) ||
      entry.contextWindowTokens <= 0 ||
      !Number.isSafeInteger(entry.maxOutputTokens) ||
      entry.maxOutputTokens <= 0 ||
      entry.maxOutputTokens > entry.contextWindowTokens
    ) {
      throw new TypeError(`Invalid hard limits for catalogue entry ${entry.id}`);
    }
    if (entry.matches.global || entry.matches.sticky) {
      throw new TypeError(`Catalogue entry ${entry.id} must use a stateless matcher`);
    }
    if (!isIsoDate(entry.verifiedAt)) {
      throw new TypeError(`Catalogue entry ${entry.id} has an invalid verification date`);
    }
    if (
      !isIsoDate(entry.profileRevision) ||
      entry.profileRevision > entry.verifiedAt
    ) {
      throw new TypeError(`Catalogue entry ${entry.id} has an invalid profile revision`);
    }
    newestVerification = newestVerification < entry.verifiedAt
      ? entry.verifiedAt
      : newestVerification;
    let evidence: URL;
    try {
      evidence = new URL(entry.evidenceUrl);
    } catch {
      throw new TypeError(`Catalogue entry ${entry.id} has an invalid evidence URL`);
    }
    if (
      evidence.protocol !== "https:" ||
      !allowedEvidenceHosts.has(evidence.hostname.toLowerCase())
    ) {
      throw new TypeError(`Catalogue entry ${entry.id} has unsupported evidence origin`);
    }
    if (entry.examples.length === 0 || entry.examples.length > 8) {
      throw new TypeError(`Catalogue entry ${entry.id} must have 1-8 examples`);
    }
    for (const example of entry.examples) {
      if (!entry.matches.test(example)) {
        throw new TypeError(`Catalogue entry ${entry.id} does not match ${example}`);
      }
      const key = `${entry.provider}:${example}`;
      const previous = examples.get(key);
      if (previous !== undefined) {
        throw new TypeError(
          `Catalogue example ${example} overlaps ${previous} and ${entry.id}`,
        );
      }
      examples.set(key, entry.id);
      const overlaps = entries.filter(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.id !== entry.id &&
          candidate.matches.test(example),
      );
      if (overlaps.length > 0) {
        throw new TypeError(
          `Catalogue example ${example} overlaps ${entry.id} and ${overlaps[0]?.id}`,
        );
      }
    }
  }

  if (!isIsoDate(revision) || revision !== newestVerification) {
    throw new TypeError(
      `Catalogue revision ${revision} does not match newest verification ${newestVerification}`,
    );
  }
}
