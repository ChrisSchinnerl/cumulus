import { parse as parseMediaTitle } from "parse-torrent-title";
import { titleCase } from "title-case";
import type { Tags } from "./lexicons";

/**
 * Title-case wrapper that handles all-caps filename inputs. The base
 * `title-case` only uppercases the first letter of each word and preserves
 * the rest as-is, so `"THE CAPTAIN'S GUEST"` would round-trip unchanged.
 * We lowercase the input first when it's entirely uppercase or entirely
 * lowercase; mixed-case strings (which may contain intentional acronyms
 * like `NCIS`) pass through to `title-case` directly.
 */
function smartTitleCase(input: string): string {
  const isAllUpper = input === input.toUpperCase();
  const isAllLower = input === input.toLowerCase();
  return titleCase(isAllUpper || isAllLower ? input.toLowerCase() : input);
}

/** Single tag constraint extracted from a search query token. */
export type TagConstraint = { key: string; value: string };

/** Parsed search query — what the matcher consumes. */
export type ParsedQuery = {
  /** Tag constraints that MUST match (`key:value` tokens). */
  required: TagConstraint[];
  /** Tag constraints that must NOT match (`-key:value` tokens). */
  excluded: TagConstraint[];
  /** Bare/quoted tokens — substring-matched against name + tag pairs. */
  freetext: string[];
};

/** Empty query — matches everything. */
export const EMPTY_QUERY: ParsedQuery = {
  required: [],
  excluded: [],
  freetext: [],
};

/**
 * Tokenize an input string into whitespace-separated tokens, preserving
 * double-quoted phrases as single tokens (with the quotes stripped).
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;
    if (input[i] === '"') {
      i++;
      let buf = "";
      while (i < input.length && input[i] !== '"') buf += input[i++];
      if (i < input.length) i++;
      if (buf) out.push(buf);
    } else {
      let buf = "";
      while (i < input.length && !/\s/.test(input[i])) buf += input[i++];
      out.push(buf);
    }
  }
  return out;
}

/**
 * Parse a `key:value` token. Returns `null` if the token isn't of that shape
 * (no colon, empty key, or empty value).
 */
function parseKv(token: string): TagConstraint | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const key = token.slice(0, colon).trim().toLowerCase();
  const value = token.slice(colon + 1).trim().toLowerCase();
  if (!key || !value) return null;
  return { key, value };
}

/**
 * Parse a search query string into structured constraints. Syntax:
 * - `key:value` → required tag match (multi-value tags split on commas)
 * - `-key:value` → excluded tag match
 * - bare word or `"quoted phrase"` → free-text substring match against the
 *   filename and the joined tag pairs
 *
 * The empty string yields {@link EMPTY_QUERY}, which matches every entry.
 */
export function parseQuery(input: string): ParsedQuery {
  const tokens = tokenize(input);
  const required: TagConstraint[] = [];
  const excluded: TagConstraint[] = [];
  const freetext: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-") && token.length > 1) {
      const tag = parseKv(token.slice(1));
      if (tag) {
        excluded.push(tag);
        continue;
      }
    }
    const tag = parseKv(token);
    if (tag) {
      required.push(tag);
    } else if (token.length > 0) {
      freetext.push(token.toLowerCase());
    }
  }
  return { required, excluded, freetext };
}

/** True when a `Tags` map carries `key=value` (case-insensitive, comma-aware). */
function tagMatches(
  tags: Tags | undefined,
  key: string,
  value: string,
): boolean {
  if (!tags) return false;
  const targetKey = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() !== targetKey) continue;
    const parts = v.split(",").map((p) => p.trim().toLowerCase());
    if (parts.includes(value.toLowerCase())) return true;
  }
  return false;
}

/**
 * Check whether a feed entry matches the parsed query. All required tags
 * must hit, no excluded tags may hit, and every free-text token must
 * substring-match the filename or any tag pair.
 */
export function matchEntry(
  entry: { name: string; tags?: Tags },
  query: ParsedQuery,
): boolean {
  for (const r of query.required) {
    if (!tagMatches(entry.tags, r.key, r.value)) return false;
  }
  for (const x of query.excluded) {
    if (tagMatches(entry.tags, x.key, x.value)) return false;
  }
  if (query.freetext.length > 0) {
    const tagText = entry.tags
      ? Object.entries(entry.tags)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")
      : "";
    const haystack = `${entry.name} ${tagText}`.toLowerCase();
    for (const f of query.freetext) {
      if (!haystack.includes(f)) return false;
    }
  }
  return true;
}

/**
 * Parse user-entered tags from a textarea — one `key: value` per line.
 * Duplicate keys are overwritten (last wins). Whitespace around key and
 * value is trimmed; the value can include commas to express multi-value.
 */
export function parseUserTags(input: string): Tags {
  const out: Tags = {};
  const lines = input
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** Format tags back to one-per-line text for display or re-editing. */
export function tagsToText(tags: Tags | undefined): string {
  if (!tags) return "";
  return Object.entries(tags)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Strip common release-pipeline noise from a title-ish string: bracketed
 * markers like `[360p]`, parenthesized year/group, and standalone quality /
 * codec / source / audio tags. Best-effort — we don't aim to clean every
 * scene release exhaustively, just the most common cases.
 */
function stripReleaseNoise(input: string): string {
  let s = input;
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(
    /\b(?:360p|480p|540p|576p|720p|1080p|1440p|2160p|4k|8k)\b/gi,
    " ",
  );
  s = s.replace(/\b(?:x26[45]|h\.?26[45]|hevc|av1|xvid|divx)\b/gi, " ");
  s = s.replace(
    /\b(?:web[-.]?dl|webrip|bluray|brrip|bdrip|hdtv|dvdrip|hdrip|amzn|nf)\b/gi,
    " ",
  );
  s = s.replace(/\b(?:aac|ac3|dts|dd5\.1|eac3|truehd|flac|mp3)\b/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Find the season/episode marker in a filename stem. Handles the two most
 * common forms: `SxxEyy` (with optional separators between season+episode)
 * and `xXy` (Season×Episode). Returns the regex match object so callers
 * can use both the captured groups and `match.index` for splitting.
 */
function findSeasonEpisodeMarker(stem: string): RegExpExecArray | null {
  return (
    /[Ss](\d{1,2})[._\s-]*[Ee](\d{1,3})/.exec(stem) ??
    /\b(\d{1,2})x(\d{1,3})\b/.exec(stem)
  );
}

/**
 * Best-effort auto-tag generation from a filename + MIME type.
 *
 * - When the filename has a season/episode marker (`SxxEyy` or `1x05`):
 *   tags as `type: tvshow` with `name` (show), `season`, `episode`, and —
 *   when present — `title` (the part after the marker). Show name is
 *   sourced from `parse-torrent-title` when available (handles release
 *   noise robustly); episode title is sliced ourselves after the marker.
 * - Otherwise: tags as `type: image | video | audio` based on MIME prefix.
 *
 * Both `name` and `title` get {@link stripReleaseNoise} + {@link titleCase}
 * applied so `THE CAPTAIN'S GUEST [360p]` becomes `The Captain's Guest`.
 */
export function autoTagsFromFile(name: string, mimeType: string): Tags {
  const tags: Tags = {};

  const lastDot = name.lastIndexOf(".");
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name;

  const marker = findSeasonEpisodeMarker(stem);
  if (marker && typeof marker.index === "number") {
    tags.type = "tvshow";
    tags.season = String(parseInt(marker[1], 10));
    tags.episode = String(parseInt(marker[2], 10));

    const beforeRaw = stem.slice(0, marker.index).replace(/[._-]+/g, " ").trim();
    const afterRaw = stem
      .slice(marker.index + marker[0].length)
      .replace(/[._-]+/g, " ")
      .trim();

    if (beforeRaw) {
      // Prefer parse-torrent-title's cleaned show name when available — it
      // handles bracketed groups and quality markers more robustly than our
      // stripReleaseNoise pass.
      let cleanName = stripReleaseNoise(beforeRaw);
      try {
        const parsed = parseMediaTitle(name);
        if (parsed.title) cleanName = parsed.title;
      } catch {
        // fall through with stripReleaseNoise output
      }
      if (cleanName) tags.name = smartTitleCase(cleanName);
    }

    const afterClean = stripReleaseNoise(afterRaw);
    if (afterClean) tags.title = smartTitleCase(afterClean);
  } else if (mimeType.startsWith("video/")) tags.type = "video";
  else if (mimeType.startsWith("image/")) tags.type = "image";
  else if (mimeType.startsWith("audio/")) tags.type = "audio";

  return tags;
}

/** True when no part of the parsed query is active. */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    q.required.length === 0 && q.excluded.length === 0 && q.freetext.length === 0
  );
}
