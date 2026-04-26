// GitHub REST helpers for Vault Sync.
// Uses Obsidian's requestUrl to bypass iOS WebView CORS restrictions
// (raw fetch() fails on the codeload.github.com redirect for tarballs).

import { requestUrl } from "obsidian";

export interface RepoRef {
    owner: string;
    repo: string;
}

export const USER_AGENT = "obsidian-vault-sync";
export const API_BASE = "https://api.github.com";

export function authHeaders(pat: string): Record<string, string> {
    return {
        Authorization: `token ${pat}`,
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

export function parseRepoUrl(url: string): RepoRef {
    if (!url) throw new Error("Repository URL is empty");
    const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
    let m = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (!m) m = cleaned.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) throw new Error(`Cannot parse repo URL: ${url}`);
    return { owner: m[1], repo: m[2] };
}

export async function getBranchSha(
    ref: RepoRef,
    branch: string,
    pat: string
): Promise<string> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(
        branch
    )}`;
    const res = await requestUrl({
        url,
        method: "GET",
        headers: authHeaders(pat),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `GitHub branch lookup failed: ${res.status} — ${res.text.slice(0, 300)}`
        );
    }
    const data = res.json as { commit?: { sha?: string } };
    const sha = data?.commit?.sha;
    if (!sha) throw new Error("GitHub response missing commit.sha");
    return sha;
}

export function tarballUrl(ref: RepoRef, sha: string): string {
    return `${API_BASE}/repos/${ref.owner}/${ref.repo}/tarball/${sha}`;
}

/**
 * Download the tarball as an ArrayBuffer via Obsidian's native HTTP client.
 * This buffers the full compressed payload in memory (no streaming), but
 * is the only way to bypass iOS WebView CORS on codeload.github.com.
 * Subsequent tar parsing is incremental so disk write memory stays low.
 */
export async function downloadTarball(
    ref: RepoRef,
    sha: string,
    pat: string
): Promise<ArrayBuffer> {
    const res = await requestUrl({
        url: tarballUrl(ref, sha),
        method: "GET",
        headers: authHeaders(pat),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Tarball download failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    return res.arrayBuffer;
}
