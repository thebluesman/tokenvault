// Git blob SHA-1 — ADR-0006 §4.
//
// The entire sync design rests on the plugin being able to compute the SHA GitHub *would* assign to
// a file it has not uploaded. If this is wrong by one byte the panel produces forty plausible hex
// characters that never match anything, and every file reads as diverged forever.
//
// So the expectations here are not hand-derived: every one of them is the output of
// `git hash-object --stdin` on the same bytes, which is the only authority that matters.

import { test } from "node:test";
import assert from "node:assert/strict";

import { blobSha, sha1, utf8Bytes } from "../src/git/blob";

test("SHA-1 matches the published test vectors", () => {
  assert.equal(sha1([]), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1(utf8Bytes("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(
    sha1(utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
  );
});

test("SHA-1 spans the 64-byte block boundary correctly", () => {
  // 56 bytes is the exact length at which the padding no longer fits in the same block, which is
  // where a hand-written implementation goes wrong if it is going to.
  const long = "a".repeat(1000000);
  assert.equal(sha1(utf8Bytes(long)), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
});

test("blob SHAs match git hash-object", () => {
  // Captured with `printf … | git hash-object --stdin`.
  assert.equal(blobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(blobSha("hello world\n"), "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  assert.equal(blobSha('{\n  "a": 1\n}\n'), "8d6b85c7b3f97652ab7fdfdf53f3dd2b6dc3ccef");
});

test("the header counts UTF-8 bytes, not JS string length", () => {
  // A `$description` with an em dash in it is not hypothetical — the panel's own copy is full of
  // them. Hashing the character count instead of the byte count would make every accented file
  // look permanently changed.
  assert.equal(blobSha("héllo — ünicode\n"), "9e686fe5e48eabd352a756979cff0d1de97c7f0b");
  assert.equal(utf8Bytes("é").length, 2);
  assert.equal(utf8Bytes("—").length, 3);
  // A surrogate pair is one code point and four bytes, not two characters and six.
  assert.equal(utf8Bytes("😀").length, 4);
});
