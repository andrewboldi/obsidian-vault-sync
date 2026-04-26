import { Notice } from "obsidian";
import type VaultSyncPlugin from "./main";
import {
    createBlob,
    createCommit,
    createTree,
    getBranchSha,
    getCommitTreeSha,
    parseRepoUrl,
    updateRef,
    type TreeUpdateEntry,
} from "./github";

const SKIP_PATHS = new Set<string>([
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    ".obsidian/appearance.json",
    ".obsidian/plugins/obsidian-vault-sync/data.json",
    ".obsidian/plugins/obsidian-git/data.json",
    ".DS_Store",
    "_GIT-DEBUG-ERROR.md",
]);

const SKIP_PREFIXES = [".trash/"];

function shouldSkip(path: string): boolean {
    if (SKIP_PATHS.has(path)) return true;
    if (path.endsWith(".tmp")) return true;
    for (const p of SKIP_PREFIXES) if (path.startsWith(p)) return true;
    if (path.startsWith(".obsidian/workspace")) return true;
    return false;
}

async function gitBlobSha(content: ArrayBuffer): Promise<string> {
    const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
    const combined = new Uint8Array(header.byteLength + content.byteLength);
    combined.set(header, 0);
    combined.set(new Uint8Array(content), header.byteLength);
    const buf = await crypto.subtle.digest("SHA-1", combined);
    const arr = new Uint8Array(buf);
    let hex = "";
    for (const b of arr) hex += b.toString(16).padStart(2, "0");
    return hex;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function listAllVaultFiles(plugin: VaultSyncPlugin): Promise<string[]> {
    // Recursively walk via vault adapter to catch dotfiles too
    // (app.vault.getFiles() omits dotfile dirs like .obsidian).
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        const list = await plugin.app.vault.adapter.list(dir || "/");
        for (const f of list.files) out.push(f);
        for (const d of list.folders) {
            // Skip well-known internal dirs that should never be pushed
            if (d === ".trash" || d === ".git") continue;
            await walk(d);
        }
    }
    await walk("");
    return out;
}

export async function pushToGitHub(plugin: VaultSyncPlugin): Promise<void> {
    const { pat, repoUrl, branch, lastCommitSha, fileShaMap } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");
    if (!lastCommitSha) {
        throw new Error("No baseline commit. Seed first.");
    }

    const ref = parseRepoUrl(repoUrl);
    const notice = new Notice("Vault Sync: scanning local changes…", 0);

    // 1. Detect divergence — refuse if remote moved.
    const remoteHead = await getBranchSha(ref, branch || "main", pat);
    if (remoteHead !== lastCommitSha) {
        notice.hide();
        throw new Error(
            `Remote advanced (${remoteHead.slice(0, 7)} vs local baseline ${lastCommitSha.slice(0, 7)}). Run 'Vault Sync: Pull from GitHub' first.`
        );
    }

    // 2. Walk vault, hash every non-skipped file, compare to fileShaMap.
    const allPaths = await listAllVaultFiles(plugin);
    const localFiles = allPaths.filter((p) => !shouldSkip(p));
    const localSet = new Set(localFiles);

    notice.setMessage(`Vault Sync: hashing ${localFiles.length} files…`);

    type Change = { path: string; kind: "add" | "modify"; content: ArrayBuffer };
    const changes: Change[] = [];
    const deletions: string[] = [];

    let scanned = 0;
    for (const path of localFiles) {
        const content = await plugin.app.vault.adapter.readBinary(path);
        const sha = await gitBlobSha(content);
        const knownSha = fileShaMap[path];
        if (!knownSha) {
            changes.push({ path, kind: "add", content });
        } else if (knownSha !== sha) {
            changes.push({ path, kind: "modify", content });
        }
        scanned++;
        if (scanned % 50 === 0) {
            notice.setMessage(
                `Vault Sync: hashed ${scanned}/${localFiles.length}…`
            );
        }
    }

    for (const trackedPath of Object.keys(fileShaMap)) {
        if (!localSet.has(trackedPath)) deletions.push(trackedPath);
    }

    if (changes.length === 0 && deletions.length === 0) {
        notice.setMessage("Vault Sync: nothing to push");
        setTimeout(() => notice.hide(), 4000);
        return;
    }

    // 3. Upload blobs for changed files (sequential to keep memory bounded for large files).
    notice.setMessage(
        `Vault Sync: uploading ${changes.length} blobs (${deletions.length} deletions)…`
    );

    const treeEntries: TreeUpdateEntry[] = [];
    let uploaded = 0;
    let bytes = 0;
    for (const c of changes) {
        const blobSha = await createBlob(ref, c.content, pat);
        treeEntries.push({
            path: c.path,
            mode: "100644",
            type: "blob",
            sha: blobSha,
        });
        uploaded++;
        bytes += c.content.byteLength;
        if (uploaded % 5 === 0) {
            notice.setMessage(
                `Vault Sync: uploaded ${uploaded}/${changes.length} (${formatBytes(bytes)})`
            );
        }
    }

    for (const path of deletions) {
        treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    // 4. Build new tree on top of the last commit's tree.
    notice.setMessage("Vault Sync: creating tree…");
    const baseTreeSha = await getCommitTreeSha(ref, lastCommitSha, pat);
    const newTreeSha = await createTree(ref, baseTreeSha, treeEntries, pat);

    // 5. Create commit.
    notice.setMessage("Vault Sync: creating commit…");
    const message = `Vault Sync: ${changes.length} changed, ${deletions.length} deleted from mobile`;
    const newCommitSha = await createCommit(
        ref,
        message,
        newTreeSha,
        [lastCommitSha],
        pat
    );

    // 6. Update branch ref.
    notice.setMessage("Vault Sync: updating branch…");
    const upd = await updateRef(ref, branch || "main", newCommitSha, pat);
    if (!upd.ok) {
        notice.hide();
        throw new Error(
            `Branch update failed (${upd.status}): ${upd.message}. Pull and retry.`
        );
    }

    // 7. Persist new state.
    for (const c of changes) {
        // Update local map with NEW blob SHAs from this push
        const e = treeEntries.find((t) => t.path === c.path && t.sha !== null);
        if (e && e.sha) fileShaMap[c.path] = e.sha;
    }
    for (const path of deletions) delete fileShaMap[path];

    plugin.settings.lastCommitSha = newCommitSha;
    plugin.settings.fileShaMap = fileShaMap;
    await plugin.saveSettings();

    notice.setMessage(
        `Vault Sync: pushed ${changes.length} changes (${formatBytes(bytes)}) → ${newCommitSha.slice(0, 7)}`
    );
    setTimeout(() => notice.hide(), 6000);
}
