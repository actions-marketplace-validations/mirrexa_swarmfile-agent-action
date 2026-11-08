import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Parse and validate the flat `.swarmfile/agents.yml` policy. The schema is
 * deliberately flat (scalars plus string arrays) so the MCP server and the
 * GitHub Action can read it without a YAML dependency; comments and
 * inline/block arrays are supported.
 *
 * Fail closed: an unknown key, a wrong type or an out-of-range value is an
 * error, never a silent fallback. The previous parser accepted malformed
 * policy and let a caller's `|| true` turn `upstream_push: never` into a push.
 */
export const KNOWN_KEYS = new Set([
  "max_concurrent",
  "branch_prefix",
  "ttl_days",
  "checkpoint_idle_secs",
  "conflict_mode",
  "image",
  "paths_deny",
  "local_checks",
  "upstream_push",
  "upstream_ci",
  "merge_diff3",
]);

export function parseAgentsPolicy(text) {
  const policy = {};
  let currentArray = null;
  const body = String(text).replace(/^\uFEFF/, "");
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    // YAML document markers are valid (and common in generated files).
    if (trimmed === "---" || trimmed === "...") continue;
    const withoutComment = stripComment(rawLine);
    if (!withoutComment.trim()) continue;
    const arrayItem = withoutComment.match(/^\s*-\s+(.*)$/);
    if (arrayItem) {
      if (!currentArray) throw new Error(`array item without a key: ${rawLine.trim()}`);
      currentArray.push(parseScalar(arrayItem[1]));
      continue;
    }
    const pair = withoutComment.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!pair) throw new Error(`invalid agents policy line: ${rawLine.trim()}`);
    const [, key, rawValue] = pair;
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`unknown agents policy key: ${key}`);
    }
    if (rawValue.trim() === "") {
      const values = [];
      policy[key] = values;
      currentArray = values;
    } else if (/^\[.*\]$/.test(rawValue.trim())) {
      const inner = rawValue.trim().slice(1, -1).trim();
      policy[key] = inner ? splitInline(inner).map(parseScalar) : [];
      currentArray = null;
    } else {
      policy[key] = parseScalar(rawValue);
      currentArray = null;
    }
  }
  return policy;
}

export function validateAgentsPolicy(policy) {
  const errors = [];
  const present = (key) => policy[key] !== undefined && policy[key] !== null;

  const integer = (key, min, max) => {
    if (!present(key)) return;
    const value = policy[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
    }
  };
  integer("ttl_days", 1, 30);
  integer("checkpoint_idle_secs", 1, 86400);
  integer("max_concurrent", 1, Number.MAX_SAFE_INTEGER);

  if (present("conflict_mode") && !["hard", "soft"].includes(policy.conflict_mode)) {
    errors.push("conflict_mode must be hard or soft");
  }
  if (present("branch_prefix")) {
    const prefix = policy.branch_prefix;
    if (typeof prefix !== "string" || !/^[a-z0-9-]{1,64}$/.test(prefix)) {
      errors.push("branch_prefix must use 1-64 lowercase letters, digits and hyphens");
    }
  }
  if (present("image")) {
    const image = policy.image;
    if (
      typeof image !== "string" ||
      image.length === 0 ||
      image.startsWith("-") ||
      !/^[A-Za-z0-9._:/@-]+$/.test(image)
    ) {
      errors.push("image must be a valid container image reference");
    }
  }
  if (present("paths_deny")) {
    if (!Array.isArray(policy.paths_deny)) {
      errors.push("paths_deny must be a list");
    } else if (policy.paths_deny.length > 128) {
      errors.push("paths_deny supports at most 128 entries");
    } else {
      policy.paths_deny.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.trim() === "") {
          errors.push(`paths_deny[${index}] must be a non-empty string`);
        } else if (entry.length > 256) {
          errors.push(`paths_deny[${index}] may be at most 256 characters`);
        } else if (entry.trimStart().startsWith("!") || entry.trimStart().startsWith("#")) {
          errors.push(`paths_deny[${index}] must be a positive deny glob (no ! or #)`);
        }
      });
    }
  }
  for (const key of ["local_checks", "merge_diff3"]) {
    if (present(key) && typeof policy[key] !== "boolean") {
      errors.push(`${key} must be true or false`);
    }
  }
  if (
    present("upstream_push") &&
    !["session_end", "task_complete", "manual", "never"].includes(policy.upstream_push)
  ) {
    errors.push("upstream_push must be session_end, task_complete, manual or never");
  }
  if (
    present("upstream_ci") &&
    !["pr_only", "on_push", "none"].includes(policy.upstream_ci)
  ) {
    errors.push("upstream_ci must be pr_only, on_push or none");
  }
  return errors;
}

export function readAgentsPolicy(policyRoot) {
  const file = join(policyRoot, ".swarmfile", "agents.yml");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const policy = parseAgentsPolicy(text);
  const errors = validateAgentsPolicy(policy);
  if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
  return policy;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitInline(value) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseScalar(raw) {
  const value = String(raw).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

// CLI: node read-policy.mjs <path>; missing file prints {}. A malformed policy
// exits 2 so a caller cannot silently fall back to defaults.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: read-policy.mjs <path>");
    process.exit(2);
  }
  try {
    const text = readFileSync(file, "utf8");
    const policy = parseAgentsPolicy(text);
    const errors = validateAgentsPolicy(policy);
    if (errors.length) throw new Error(errors.join("; "));
    process.stdout.write(JSON.stringify(policy));
  } catch (error) {
    if (error?.code === "ENOENT") {
      process.stdout.write("{}");
    } else {
      console.error(String(error?.message || error));
      process.exit(2);
    }
  }
}
