import { assertEquals } from "https://deno.land/std@0.178.0/testing/asserts.ts";
import {
  bearerToken,
  isUuid,
  likeTerm,
  parseHmsFaultPayload,
  parseHmsEvent,
  parseHmsRestorationPayload,
  parsePagination,
  parseStatus,
  routePath,
  searchParts,
} from "./lib.ts";

Deno.test("routePath strips the function prefix and trailing slashes", () => {
  assertEquals(routePath("/functions/v1/api/tickets"), "/tickets");
  assertEquals(routePath("/functions/v1/api/tickets/abc"), "/tickets/abc");
  assertEquals(routePath("/functions/v1/api/v1/hms/fault"), "/v1/hms/fault");
  assertEquals(routePath("/api/tickets/"), "/tickets");
  assertEquals(routePath("/functions/v1/api"), "/");
});

Deno.test("parsePagination clamps page and limit", () => {
  assertEquals(parsePagination("2", "10"), {
    page: 2,
    limit: 10,
    from: 10,
    to: 19,
  });
  assertEquals(parsePagination("0", "999"), {
    page: 1,
    limit: 100,
    from: 0,
    to: 99,
  });
  assertEquals(parsePagination(null, null), {
    page: 1,
    limit: 20,
    from: 0,
    to: 19,
  });
  assertEquals(parsePagination("abc", "-5"), {
    page: 1,
    limit: 1,
    from: 0,
    to: 0,
  });
  assertEquals(parsePagination("1e400", "1e400"), {
    page: 1,
    limit: 20,
    from: 0,
    to: 19,
  });
});

Deno.test("parseStatus accepts either case and rejects junk", () => {
  assertEquals(parseStatus("Open"), "open");
  assertEquals(parseStatus("RESOLVED"), "resolved");
  assertEquals(parseStatus(null), undefined);
  assertEquals(parseStatus("pending"), null);
});

Deno.test("bearerToken extracts the token or returns empty", () => {
  assertEquals(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assertEquals(bearerToken("bearer  abc"), "abc");
  assertEquals(bearerToken("Basic abc"), "");
  assertEquals(bearerToken(null), "");
});

Deno.test("isUuid", () => {
  assertEquals(isUuid("33333333-3333-3333-3333-333333333301"), true);
  assertEquals(isUuid("not-a-uuid"), false);
});

Deno.test("likeTerm strips PostgREST delimiters", () => {
  assertEquals(likeTerm(" net,work(1) "), "%network1%");
});

Deno.test("searchParts includes branch and device matches", () => {
  assertEquals(searchParts("atm", [], []), "ticket_number.ilike.%atm%");
  assertEquals(
    searchParts("atm", ["b1"], ["d1"]),
    "ticket_number.ilike.%atm%,branch_id.in.(b1),device_id.in.(d1)",
  );
});

Deno.test("parseHmsEvent accepts known events and rejects junk", () => {
  assertEquals(parseHmsEvent("triggered"), "triggered");
  assertEquals(parseHmsEvent("OFFLINE"), "offline");
  assertEquals(parseHmsEvent(null), undefined);
  assertEquals(parseHmsEvent(""), undefined);
  assertEquals(parseHmsEvent("vibration"), null);
  assertEquals(parseHmsEvent(7), null);
});

Deno.test("HMS fault payload requires event identity and mapped branch/device", () => {
  assertEquals(parseHmsFaultPayload({
    event_id: "evt-1",
    branch_key: "BR-01",
    device_key: "CCTV-01",
    issue_description: "Camera offline",
    occurred_at: "2026-10-29T08:30:00Z",
  }), {
    event_id: "evt-1",
    branch_key: "BR-01",
    device_key: "CCTV-01",
    issue_description: "Camera offline",
    occurred_at: "2026-10-29T08:30:00Z",
  });
  assertEquals(parseHmsFaultPayload({
    event_id: "evt-1", branch_key: "BR-01", device_key: "CCTV-01",
  }), null);
  assertEquals(parseHmsFaultPayload({
    event_id: "evt-1", branch_key: "BR-01", device_key: "CCTV-01",
    issue_description: "fault", extra: "unexpected",
  }), null);
  assertEquals(parseHmsFaultPayload({
    event_id: "evt-1", branch_key: "BR-01", device_key: "CCTV-01",
    issue_description: "fault", occurred_at: "not-a-date",
  }), null);
});

Deno.test("HMS restoration requires a correlation event ID", () => {
  assertEquals(parseHmsRestorationPayload({
    event_id: "restore-1",
    correlation_event_id: "fault-1",
  }), {
    event_id: "restore-1",
    correlation_event_id: "fault-1",
    occurred_at: null,
  });
  assertEquals(parseHmsRestorationPayload({ event_id: "restore-1" }), null);
});
