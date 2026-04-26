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

export interface CompareFile {
    sha: string; // new blob sha (empty for removed)
    filename: string;
    status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
    previous_filename?: string;
}

export interface CompareResponse {
    status: "ahead" | "behind" | "diverged" | "identical";
    ahead_by: number;
    behind_by: number;
    files?: CompareFile[];
}

/**
 * Compare two commits. Returns the file-level diff (added/modified/removed/renamed).
 * Limited to 300 files per response — Vault Sync warns if truncated.
 */
export async function compareCommits(
    ref: RepoRef,
    base: string,
    head: string,
    pat: string
): Promise<CompareResponse> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/compare/${base}...${head}`;
    const res = await requestUrl({
        url,
        method: "GET",
        headers: authHeaders(pat),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Compare failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    return res.json as CompareResponse;
}

export interface TreeEntry {
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
}

/**
 * Get the full recursive file tree at a commit. Returns paths + blob SHAs.
 * Throws if the tree is truncated (>100k files; would require pagination).
 */
export async function getTree(
    ref: RepoRef,
    sha: string,
    pat: string
): Promise<TreeEntry[]> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/trees/${sha}?recursive=1`;
    const res = await requestUrl({
        url,
        method: "GET",
        headers: authHeaders(pat),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Tree fetch failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    const data = res.json as { tree: TreeEntry[]; truncated: boolean };
    if (data.truncated) {
        throw new Error(
            "Repo tree exceeds GitHub's single-request limit (~100k files). Vault Sync needs pagination support — file an issue."
        );
    }
    return data.tree;
}

/**
 * Download a single file's raw bytes via the Contents API.
 * Uses `Accept: application/vnd.github.raw` so requestUrl returns
 * an ArrayBuffer directly — no base64 overhead.
 * GitHub limit: 100MB per file.
 */
export async function getFileRaw(
    ref: RepoRef,
    path: string,
    commitSha: string,
    pat: string
): Promise<ArrayBuffer> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(
        path
    ).replace(/%2F/g, "/")}?ref=${commitSha}`;
    const res = await requestUrl({
        url,
        method: "GET",
        headers: {
            ...authHeaders(pat),
            Accept: "application/vnd.github.raw",
        },
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `File fetch failed (${path}): ${res.status} — ${(res.text || "").slice(0, 200)}`
        );
    }
    return res.arrayBuffer;
}
