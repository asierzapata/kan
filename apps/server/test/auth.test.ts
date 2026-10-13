import test from "node:test";
import assert from "node:assert/strict";
import { clearSessionCookie, decodeState, encodeState, readCookie, sessionCookie, signInUrl } from "../src/auth.ts";
import { testConfig } from "./helpers.ts";

test("cookie attributes follow the public URL scheme", () => {
  const http = testConfig({ KAN_PUBLIC_URL: "http://localhost:1430" });
  const https = testConfig({ KAN_PUBLIC_URL: "https://getkan.dev" });
  const plain = sessionCookie(http, "sealed value");
  assert.match(plain, /^wos-session=sealed%20value; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
  assert.match(sessionCookie(https, "x"), /; Secure$/);
  assert.match(clearSessionCookie(http), /^wos-session=; .*Max-Age=0$/);
  assert.equal(readCookie(`a=1; wos-session=${encodeURIComponent("sealed value")}; b=2`), "sealed value");
  assert.equal(readCookie("a=1"), null);
});

test("state round trips and only allows local return paths", () => {
  assert.equal(decodeState(encodeState("/?invite=abc")), "/?invite=abc");
  assert.equal(decodeState(encodeState("//evil.test")), "/");
  assert.equal(decodeState(encodeState("https://evil.test")), "/");
  assert.equal(decodeState("not-base64-json"), "/");
  assert.equal(decodeState(null), "/");
});

test("sign-in URL carries redirect URI and state", () => {
  const config = testConfig();
  const url = new URL(signInUrl(config, "/?invite=x"));
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1430/api/auth/callback");
  assert.equal(url.searchParams.get("provider"), "authkit");
  assert.equal(decodeState(url.searchParams.get("state")), "/?invite=x");
});
