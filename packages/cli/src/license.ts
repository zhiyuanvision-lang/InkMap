import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkLicense,
  LICENSE_PUBLIC_KEY,
  REVOKED_LICENSES,
  sanitizeAds,
  type ActivateResult,
  type Ad,
  type LicenseState,
} from "@inkmap/core";

export interface LicenseStorage {
  read(): Promise<string | undefined>;
  write(code: string | undefined): Promise<void>;
}

export interface LicenseService {
  state(): Promise<LicenseState>;
  activate(code: string): Promise<ActivateResult>;
  deactivate(): Promise<void>;
  onChange(listener: (state: LicenseState) => void): () => void;
}

const FREE: LicenseState = { pro: false };

export function licenseService(storage: LicenseStorage, publicKey = LICENSE_PUBLIC_KEY): LicenseService {
  const listeners = new Set<(state: LicenseState) => void>();
  let cached: Promise<LicenseState> | undefined;
  const evaluate = async (code: string | undefined): Promise<LicenseState> => {
    if (!code) return FREE;
    const check = await checkLicense(code, publicKey, REVOKED_LICENSES);
    return check.ok ? { pro: true, id: check.id, issued: check.issued } : FREE;
  };
  const changed = (state: LicenseState) => {
    cached = Promise.resolve(state);
    listeners.forEach(fn => fn(state));
  };
  return {
    state: () => (cached ??= storage.read().then(evaluate, () => FREE)),
    async activate(code) {
      const text = code.replace(/\s+/g, "");
      const check = await checkLicense(text, publicKey, REVOKED_LICENSES);
      if (!check.ok) return { ok: false, reason: check.reason };
      await storage.write(text);
      const state = { pro: true, id: check.id, issued: check.issued };
      changed(state);
      return { ok: true, state };
    },
    async deactivate() {
      await storage.write(undefined);
      changed(FREE);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Stores the code in ~/.inkmap/license, shared by every `inkmap` run on this machine. */
export function fileLicenseStorage(path = join(process.env.INKMAP_HOME ?? join(homedir(), ".inkmap"), "license")): LicenseStorage {
  return {
    read: () => readFile(path, "utf8").then(s => s.trim() || undefined, () => undefined),
    async write(code) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, code ? code + "\n" : "", { mode: 0o600 });
    },
  };
}

const AD_TTL = 6 * 60 * 60 * 1000;

/** Fetches the sponsor ad feed at most every few hours; any failure just means no sponsor ads. */
export function adFeed(url: string | undefined): () => Promise<Ad[]> {
  let cache: { at: number; ads: Ad[] } | undefined;
  return async () => {
    if (!url) return [];
    if (cache && Date.now() - cache.at < AD_TTL) return cache.ads;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      const ads = res.ok ? sanitizeAds(await res.json()) : [];
      cache = { at: Date.now(), ads };
      return ads;
    } catch {
      cache = { at: Date.now(), ads: [] };
      return [];
    }
  };
}
