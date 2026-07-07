import test from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets } from "../src/util.js";

test("scrubSecrets masks sk- API keys in free text", () => {
  const out = scrubSecrets("loaded key sk-ant-api03-AbCdEf0123456789ghIJkl for provider");
  assert.equal(out.includes("sk-ant-api03-AbCdEf0123456789ghIJkl"), false);
  assert.match(out, /sk-\[redacted\]/);
});

test("scrubSecrets masks GitHub, Slack, and pk-prefixed tokens", () => {
  const out = scrubSecrets("ghp-abcdefghijklmnopqrstuvwxyz123456 xoxb-abcdefghijklmnopqrstuvwxyz123456 pk-abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(out, /ghp-\[redacted\]/);
  assert.match(out, /xoxb-\[redacted\]/);
  assert.match(out, /pk-\[redacted\]/);
});

test("scrubSecrets masks PEM private keys", () => {
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "supersecretkeymaterial",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const out = scrubSecrets(`loaded ${key}`);
  assert.equal(out.includes("supersecretkeymaterial"), false);
  assert.match(out, /BEGIN PRIVATE KEY.*\[redacted\].*END PRIVATE KEY/s);
});

test("scrubSecrets masks Bearer and Basic authorization tokens", () => {
  const bearer = scrubSecrets("authorization: Bearer eyJhbGciOiJI.payload.sig");
  assert.equal(bearer.includes("eyJhbGciOiJI.payload.sig"), false);
  assert.match(bearer, /Bearer \[redacted\]/);
  const basic = scrubSecrets("Authorization: Basic b3BlbmNvZGU6c2VjcmV0Cg==");
  assert.equal(basic.includes("b3BlbmNvZGU6c2VjcmV0Cg=="), false);
  assert.match(basic, /Basic \[redacted\]/);
});

test("scrubSecrets masks common password assignment forms", () => {
  const out = scrubSecrets("child failed with password=hunter2 token: 'abcdef123456' and api_key=\"secret-value\" auth_token: quoted-secret-value");
  assert.equal(out.includes("hunter2"), false);
  assert.equal(out.includes("abcdef123456"), false);
  assert.equal(out.includes("secret-value"), false);
  assert.match(out, /password=\[redacted\]/);
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /api_key=\[redacted\]/);
  assert.match(out, /auth_token=\[redacted\]/);
});

test("scrubSecrets masks caller-supplied literal secrets (e.g. the child auth password)", () => {
  const out = scrubSecrets("server started with password hunter2-XYZ", ["hunter2-XYZ"]);
  assert.equal(out.includes("hunter2-XYZ"), false);
  assert.match(out, /\[redacted\]/);
});

test("scrubSecrets escapes regex metacharacters in literal secrets", () => {
  const secret = "a+b/c=d.e";
  const out = scrubSecrets(`token is ${secret} ok`, [secret]);
  assert.equal(out.includes(secret), false);
  assert.match(out, /token is \[redacted\] ok/);
});

test("scrubSecrets leaves ordinary text and short tokens untouched", () => {
  assert.equal(scrubSecrets("just a normal log line about sk- prefixes"), "just a normal log line about sk- prefixes");
  assert.equal(scrubSecrets("ratio 3/4 and a=b"), "ratio 3/4 and a=b");
});

test("scrubSecrets returns non-strings unchanged", () => {
  assert.equal(scrubSecrets(undefined), undefined);
  assert.equal(scrubSecrets(42), 42);
  assert.deepEqual(scrubSecrets({ a: 1 }), { a: 1 });
});

test("scrubSecrets ignores empty/blank literal secrets", () => {
  assert.equal(scrubSecrets("keep this text", ["", "   "]), "keep this text");
});
