import test from "node:test";
import assert from "node:assert/strict";
import { issueTicket, verifyTicket } from "../src/tickets.ts";
import { SECRET } from "./helpers.ts";

const claims = (exp: number) => ({ room: "r", sub: "u", sessionId: "s", role: "editor" as const, exp });

test("ticket round trip", () => {
  const now = 1_000_000;
  const ticket = issueTicket(SECRET, claims(now + 30_000));
  assert.deepEqual(verifyTicket(SECRET, ticket, now), claims(now + 30_000));
  assert.match(ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("ticket rejects bad signature, wrong secret, expiry and long lifetime", () => {
  const now = 1_000_000;
  const ticket = issueTicket(SECRET, claims(now + 30_000));
  assert.throws(() => verifyTicket("another-secret-another", ticket, now), /Invalid/);
  const [body, sig] = ticket.split(".");
  assert.throws(() => verifyTicket(SECRET, `${body}.${sig.slice(0, -2)}AA`, now), /Invalid/);
  assert.throws(() => verifyTicket(SECRET, "garbage", now), /Invalid/);
  assert.throws(() => verifyTicket(SECRET, ticket, now + 30_000), /Expired/);
  assert.throws(
    () => verifyTicket(SECRET, issueTicket(SECRET, claims(now + 90_001)), now),
    /Expired/,
  );
  assert.doesNotThrow(() => verifyTicket(SECRET, issueTicket(SECRET, claims(now + 90_000)), now));
});
