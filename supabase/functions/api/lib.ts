// Pure helpers for the ticket API. Kept dependency-free so they can be tested
// with `deno test` without a Supabase instance.

// Strips everything up to the `/api` function prefix and trailing slashes.
export function routePath(pathname: string): string {
  const stripped = pathname.replace(/^.*\/api(?=\/|$)/, "") || "/";
  const trimmed = stripped.replace(/\/+$/, "");
  return trimmed || "/";
}

export function parsePagination(
  pageParam: string | null,
  limitParam: string | null,
): { page: number; limit: number; from: number; to: number } {
  const rawPage = Number(pageParam ?? 1);
  const rawLimit = Number(limitParam ?? 20);
  const page = Number.isFinite(rawPage) && rawPage > 0
    ? Math.floor(rawPage)
    : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
    : 20;
  const offset = (page - 1) * limit;
  return { page, limit, from: offset, to: offset + limit - 1 };
}

export type StatusFilter = "open" | "resolved";

// undefined = no filter supplied, null = invalid value.
export function parseStatus(
  value: string | null,
): StatusFilter | undefined | null {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return normalized === "open" || normalized === "resolved" ? normalized : null;
}

export function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// PostgREST treats commas and parentheses as syntax inside `or` filters.
export function likeTerm(value: string): string {
  return `%${value.replace(/[%(),\\]/g, "").trim()}%`;
}

export function searchParts(
  term: string,
  branchIds: string[],
  deviceIds: string[],
): string {
  const like = likeTerm(term);
  const parts = [`ticket_number.ilike.${like}`];
  if (branchIds.length > 0) parts.push(`branch_id.in.(${branchIds.join(",")})`);
  if (deviceIds.length > 0) parts.push(`device_id.in.(${deviceIds.join(",")})`);
  return parts.join(",");
}

// HMS (Dexter) events that justify raising a ticket. undefined = not supplied,
// null = invalid value.
export const HMS_EVENTS = ["triggered", "offline", "inactive"] as const;
export type HmsEvent = (typeof HMS_EVENTS)[number];

export function parseHmsEvent(value: unknown): HmsEvent | undefined | null {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return (HMS_EVENTS as readonly string[]).includes(normalized)
    ? (normalized as HmsEvent)
    : null;
}

export interface HmsFaultPayload {
  event_id: string;
  branch_key: string;
  device_key: string;
  issue_description: string;
  occurred_at: string | null;
}

export interface HmsRestorationPayload {
  event_id: string;
  correlation_event_id: string;
  occurred_at: string | null;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    !Number.isNaN(Date.parse(value));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.trim().length <= max;
}

export function parseHmsFaultPayload(
  value: unknown,
): HmsFaultPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "event_id", "branch_key", "device_key", "issue_description", "occurred_at",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (!boundedString(body.event_id, 200) ||
    !boundedString(body.branch_key, 200) ||
    !boundedString(body.device_key, 200) ||
    !boundedString(body.issue_description, 2000)) return null;
  if (body.occurred_at != null && !isIsoTimestamp(body.occurred_at)) return null;
  return {
    event_id: body.event_id.trim(),
    branch_key: body.branch_key.trim(),
    device_key: body.device_key.trim(),
    issue_description: body.issue_description.trim(),
    occurred_at: typeof body.occurred_at === "string" ? body.occurred_at : null,
  };
}

export function parseHmsRestorationPayload(
  value: unknown,
): HmsRestorationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["event_id", "correlation_event_id", "occurred_at"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (!boundedString(body.event_id, 200) ||
    !boundedString(body.correlation_event_id, 200)) return null;
  if (body.occurred_at != null && !isIsoTimestamp(body.occurred_at)) return null;
  return {
    event_id: body.event_id.trim(),
    correlation_event_id: body.correlation_event_id.trim(),
    occurred_at: typeof body.occurred_at === "string" ? body.occurred_at : null,
  };
}
