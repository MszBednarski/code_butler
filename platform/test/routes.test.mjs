import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReturn } from "../auth.mjs";
import { configuration } from "../config.mjs";

test("sign-in can return to setup or saved projects while external redirects stay blocked", () => {
  for (const target of [
    "/",
    "/start",
    "/projects",
    "/connect/boat",
    "/p/11111111-1111-4111-8111-111111111111",
  ])
    assert.equal(safeReturn(target), target);
  for (const target of [
    "https://other.example/start",
    "//other.example",
    "/start?next=https://other.example",
    "/projects/../setup",
    "/%2fother.example",
    "\\other.example",
    undefined,
  ])
    assert.equal(safeReturn(target), "/");
});
test("domain aliases are explicit HTTPS origins", () => {
  assert.deepEqual(
    configuration({
      PUBLIC_URL: "https://butl.dev",
      PUBLIC_URL_ALIASES: "https://old.example",
    }).publicAliases,
    ["https://old.example"],
  );
  for (const alias of [
    "http://old.example",
    "https://old.example/path",
    "https://old.example?x=1",
  ])
    assert.throws(() =>
      configuration({
        PUBLIC_URL: "https://butl.dev",
        PUBLIC_URL_ALIASES: alias,
      }),
    );
});
