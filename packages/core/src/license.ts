// Offline license codes: a short payload signed with Ed25519. The extension only holds the public
// key, so codes can be checked without a server; issuing needs the private key kept by the seller.
// Uses WebCrypto so the same code runs in Node, browsers and Cloudflare Workers.

export const LICENSE_PREFIX = "INK1-";
const VERSION = 1;
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const PAYLOAD_BYTES = 10;
const SIGNATURE_BYTES = 64;

export type Edition = "pro";
const EDITIONS: Edition[] = ["pro"];

export interface License {
  /** Hex id, unique per code; used to revoke leaked codes. */
  id: string;
  edition: Edition;
  /** ISO date the code was issued. */
  issued: string;
}

export type LicenseCheck = ({ ok: true } & License) | { ok: false; reason: "format" | "signature" | "revoked" };

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

function encodePayload(edition: Edition, issued: Date, id: Uint8Array): Uint8Array<ArrayBuffer> {
  const days = Math.max(0, Math.floor((issued.getTime() - EPOCH) / DAY));
  const out = new Uint8Array(PAYLOAD_BYTES);
  out[0] = VERSION;
  out[1] = EDITIONS.indexOf(edition) + 1;
  out[2] = days >> 8;
  out[3] = days & 0xff;
  out.set(id.subarray(0, 6), 4);
  return out;
}

function decodePayload(bytes: Uint8Array): License | null {
  if (bytes[0] !== VERSION) return null;
  const edition = EDITIONS[bytes[1] - 1];
  if (!edition) return null;
  const issued = new Date(EPOCH + ((bytes[2] << 8) | bytes[3]) * DAY);
  return { id: hex(bytes.subarray(4, 10)), edition, issued: issued.toISOString().slice(0, 10) };
}

export async function generateLicenseKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
}

export interface IssueOptions {
  edition?: Edition;
  issued?: Date;
  /** Six or more bytes; random when omitted. Pass a hash of an order id to make codes reproducible. */
  id?: Uint8Array;
}

/** A stable license id for a store order, so the same order always maps to the same id. */
export async function orderLicenseId(store: string, orderId: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${store}:${orderId}`));
  return new Uint8Array(digest, 0, 6);
}

export async function issueLicense(privateKey: string, { edition = "pro", issued = new Date(), id }: IssueOptions = {}): Promise<string> {
  const raw = fromBase64Url(privateKey);
  if (!raw) throw new Error("invalid private key");
  const key = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  const payload = encodePayload(edition, issued, id ?? crypto.getRandomValues(new Uint8Array(6)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, payload));
  const all = new Uint8Array(PAYLOAD_BYTES + SIGNATURE_BYTES);
  all.set(payload);
  all.set(signature, PAYLOAD_BYTES);
  return LICENSE_PREFIX + toBase64Url(all);
}

export async function checkLicense(code: string, publicKey: string, revoked: readonly string[] = []): Promise<LicenseCheck> {
  const text = code.replace(/\s+/g, "");
  if (!text.startsWith(LICENSE_PREFIX)) return { ok: false, reason: "format" };
  const bytes = fromBase64Url(text.slice(LICENSE_PREFIX.length));
  const pub = fromBase64Url(publicKey);
  if (!bytes || !pub || bytes.length !== PAYLOAD_BYTES + SIGNATURE_BYTES) return { ok: false, reason: "format" };
  const payload = bytes.subarray(0, PAYLOAD_BYTES);
  const license = decodePayload(payload);
  if (!license) return { ok: false, reason: "format" };
  const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, bytes.subarray(PAYLOAD_BYTES), payload))) return { ok: false, reason: "signature" };
  if (revoked.includes(license.id)) return { ok: false, reason: "revoked" };
  return { ok: true, ...license };
}
