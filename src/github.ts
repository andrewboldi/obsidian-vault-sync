// GitHub REST helpers for Vault Sync.
// Phase 1 only needs: parse repo URL, fetch latest branch SHA, build tarball URL.

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
    let cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
    // Allow either full URL or "owner/repo".
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
    const res = await fetch(url, { headers: authHeaders(pat) });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `GitHub branch lookup failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
        );
    }
    const data = (await res.json()) as { commit?: { sha?: string } };
    const sha = data?.commit?.sha;
    if (!sha) throw new Error("GitHub response missing commit.sha");
    return sha;
}

export function tarballUrl(ref: RepoRef, sha: string): string {
    return `${API_BASE}/repos/${ref.owner}/${ref.repo}/tarball/${sha}`;
}
