import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/connectors.ts", import.meta.url), "utf8");

test("the personal keychain owns Tlon connection setup and keeps login codes write-only", () => {
  assert.match(source, /Connect a Tlon ship/);
  assert.match(source, /Bot ship/);
  assert.match(source, /Your owner ship/);
  assert.match(source, /autocomplete="new-password"/);
  assert.match(source, /api<\{ connections\?: TlonConnection\[\] \}>\("\/api\/tlon\/connections"\)/);
  assert.match(source, /method: draft\.id \? "PUT" : "POST"/);
  assert.match(source, /method: "DELETE"/);
  assert.doesNotMatch(source, /tlon.*allowedShips/is);
});
