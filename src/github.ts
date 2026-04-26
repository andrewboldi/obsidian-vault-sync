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
 * Get the tree SHA for a commit. Used as base_tree when building a new commit.
 */
export async function getCommitTreeSha(
    ref: RepoRef,
    commitSha: string,
    pat: string
): Promise<string> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/commits/${commitSha}`;
    const res = await requestUrl({
        url,
        method: "GET",
        headers: authHeaders(pat),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`Commit lookup failed: ${res.status}`);
    }
    return (res.json as { tree: { sha: string } }).tree.sha;
}

/**
 * Create a blob from raw binary data. Returns the new blob SHA.
 * Content is base64-encoded for transit. Max 100MB per file (GitHub limit).
 */
export async function createBlob(
    ref: RepoRef,
    content: ArrayBuffer,
    pat: string
): Promise<string> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/blobs`;
    // base64 encode
    const bytes = new Uint8Array(content);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    const res = await requestUrl({
        url,
        method: "POST",
        headers: { ...authHeaders(pat), "Content-Type": "application/json" },
        body: JSON.stringify({ content: b64, encoding: "base64" }),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Blob create failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    return (res.json as { sha: string }).sha;
}

export interface TreeUpdateEntry {
    path: string;
    mode: "100644" | "100755" | "040000" | "160000" | "120000";
    type: "blob" | "tree" | "commit";
    sha: string | null; // null = delete
}

/**
 * Create a new tree as a delta on top of base_tree. Returns new tree SHA.
 * Entries with sha=null are deletions.
 */
export async function createTree(
    ref: RepoRef,
    baseTreeSha: string,
    entries: TreeUpdateEntry[],
    pat: string
): Promise<string> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/trees`;
    const res = await requestUrl({
        url,
        method: "POST",
        headers: { ...authHeaders(pat), "Content-Type": "application/json" },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Tree create failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    return (res.json as { sha: string }).sha;
}

/**
 * Create a commit object. Returns the new commit SHA.
 */
export async function createCommit(
    ref: RepoRef,
    message: string,
    treeSha: string,
    parentShas: string[],
    pat: string
): Promise<string> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/commits`;
    const res = await requestUrl({
        url,
        method: "POST",
        headers: { ...authHeaders(pat), "Content-Type": "application/json" },
        body: JSON.stringify({ message, tree: treeSha, parents: parentShas }),
        throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(
            `Commit create failed: ${res.status} — ${(res.text || "").slice(0, 300)}`
        );
    }
    return (res.json as { sha: string }).sha;
}

/**
 * Update a branch ref to point at a new commit. Returns true on success,
 * false if the branch advanced under us (caller should pull and retry).
 */
export async function updateRef(
    ref: RepoRef,
    branch: string,
    newCommitSha: string,
    pat: string
): Promise<{ ok: boolean; status: number; message: string }> {
    const url = `${API_BASE}/repos/${ref.owner}/${ref.repo}/git/refs/heads/${encodeURIComponent(
        branch
    )}`;
    const res = await requestUrl({
        url,
        method: "PATCH",
        headers: { ...authHeaders(pat), "Content-Type": "application/json" },
        body: JSON.stringify({ sha: newCommitSha, force: false }),
        throw: false,
    });
    return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        message: (res.text || "").slice(0, 300),
    };
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
