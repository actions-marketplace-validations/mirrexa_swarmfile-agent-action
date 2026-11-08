#!/usr/bin/env node
/**
 * R223 B3 — verify the hub's signed agent-session manifest before the publish
 * job posts a success check. The shell owns HTTP; this owns the cryptographic
 * and identity checks (Node is already a publish-mode requirement).
 *
 *   node verify-manifest.mjs <manifest.json> <branch> <hub-head> <repository> <github-head>
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [file, expectedBranch, expectedHead, expectedRepository, expectedGithub] = process.argv.slice(2);
const fail = (message) => {
  console.error(`manifest rejected: ${message}`);
  process.exit(1);
};
if (!file || !expectedBranch || !expectedHead || !expectedRepository) {
  fail("usage: verify-manifest.mjs <manifest.json> <branch> <head> <repository> <github-head>");
}

let body;
try {
  body = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`unreadable JSON (${String(error)})`);
}

const hash = /^[0-9a-f]{64}$/;
const pub = /^[0-9a-f]{64}$/;
const sig = /^[0-9a-f]{128}$/;
if (!hash.test(body.sha256 ?? "")) fail("sha256 is not 64 lowercase hex");
if (!body.canonical || typeof body.canonical !== "string") fail("canonical is missing");
if (!body.signature || typeof body.signature !== "object") fail("signature is missing");
if (!pub.test(body.signature.publicKey ?? "")) fail("public key is not 64 lowercase hex");
if (!sig.test(body.signature.signature ?? "")) fail("signature is not 128 lowercase hex");
if (typeof body.signature.keyId !== "string" || !body.signature.keyId) fail("keyId is missing");

const canonical = Buffer.from(body.canonical, "base64");
const digest = createHash("sha256").update(canonical).digest("hex");
if (digest !== body.sha256) fail("canonical does not hash to sha256");

const domain = "swarmfile-agent-manifest-v1\n";
const payload = Buffer.from(`${domain}${body.sha256}\n${body.signature.keyId}\n`);
// Ed25519 SPKI DER prefix + the raw 32-byte public key.
const der = Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  Buffer.from(body.signature.publicKey, "hex"),
]);
const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
if (!verify(null, payload, publicKey, Buffer.from(body.signature.signature, "hex"))) {
  fail("Ed25519 signature does not verify");
}

const manifest = body.manifest;
if (!manifest || typeof manifest !== "object") fail("manifest is missing");
if (manifest.branch !== expectedBranch) fail("branch does not match the request");
if (manifest.headCommit !== expectedHead) fail("headCommit does not match the request");
if (manifest.repository !== expectedRepository) fail("repository does not match the request");
if (manifest.githubCommit && expectedGithub && manifest.githubCommit !== expectedGithub) {
  fail("githubCommit does not match the GitHub commit");
}
if (manifest.kind !== "swarmfile-agent-session") fail("unexpected manifest kind");
console.log("manifest verified");
