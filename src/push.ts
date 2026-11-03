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

export function buildSkipFn(configDir: string): (path: string) => boolean {
    const skipPaths = new Set<string>([
        `${configDir}/workspace.json`,
        `${configDir}/workspace-mobile.json`,
        `${configDir}/cache`,
        `${configDir}/appearance.json`,
        ".DS_Store",
        "_GIT-DEBUG-ERROR.md",
    ]);
    // Plugin installs are per-device. Each Obsidian install pulls plugin code
    // from its own source (community store, BRAT, etc). Syncing plugin folders
    // bloats the repo and risks leaking credentials stored in plugin data.json.
    // The list of *which* plugins to enable still syncs via community-plugins.json.
    const skipPrefixes = [".trash/", `${configDir}/plugins/`];
    const workspacePrefix = `${configDir}/workspace`;
    return (path: string) => {
        if (skipPaths.has(path)) return true;
        if (path.endsWith(".tmp")) return true;
        for (const p of skipPrefixes) if (path.startsWith(p)) return true;
        if (path.startsWith(workspacePrefix)) return true;
        return false;
    };
}

export async function gitBlobSha(content: ArrayBuffer): Promise<string> {
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

export async function pushToGitHub(
    plugin: VaultSyncPlugin,
    opts: { silent?: boolean } = {}
): Promise<void> {
    const { pat, repoUrl, branch, lastCommitSha, fileShaMap } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");
    if (!lastCommitSha) {
        throw new Error("No baseline commit. Seed first.");
    }

    const ref = parseRepoUrl(repoUrl);
    const notice = opts.silent
        ? null
        : new Notice("Scanning local changes…", 0);

    // 1. Detect divergence — refuse if remote moved.
    const remoteHead = await getBranchSha(ref, branch || "main", pat);
    if (remoteHead !== lastCommitSha) {
        notice?.hide();
        throw new Error(
            `Remote advanced (${remoteHead.slice(0, 7)} vs local baseline ${lastCommitSha.slice(0, 7)}). Run 'Pull from GitHub' first.`
        );
    }

    // 2. Walk vault, hash every non-skipped file, compare to fileShaMap.
    const shouldSkip = buildSkipFn(plugin.app.vault.configDir);
    const allPaths = await listAllVaultFiles(plugin);
    const localFiles = allPaths.filter((p) => !shouldSkip(p));
    const localSet = new Set(localFiles);

    notice?.setMessage(`Hashing ${localFiles.length} files…`);

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
            notice?.setMessage(
                `Hashed ${scanned}/${localFiles.length}…`
            );
        }
    }

    for (const trackedPath of Object.keys(fileShaMap)) {
        if (!localSet.has(trackedPath)) {
            if (shouldSkip(trackedPath)) {
                delete fileShaMap[trackedPath];
            } else {
                deletions.push(trackedPath);
            }
        }
    }

    if (changes.length === 0 && deletions.length === 0) {
        notice?.setMessage("Nothing to push");
        setTimeout(() => notice?.hide(), 4000);
        return;
    }

    // 3. Upload blobs for changed files (sequential to keep memory bounded for large files).
    notice?.setMessage(
        `Uploading ${changes.length} blobs (${deletions.length} deletions)…`
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
            notice?.setMessage(
                `Uploaded ${uploaded}/${changes.length} (${formatBytes(bytes)})`
            );
        }
    }

    for (const path of deletions) {
        treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    // 4. Build new tree on top of the last commit's tree.
    notice?.setMessage("Creating tree…");
    const baseTreeSha = await getCommitTreeSha(ref, lastCommitSha, pat);
    const newTreeSha = await createTree(ref, baseTreeSha, treeEntries, pat);

    // 5. Create commit.
    notice?.setMessage("Creating commit…");
    const message = `Vault Sync: ${changes.length} changed, ${deletions.length} deleted from mobile`;
    const newCommitSha = await createCommit(
        ref,
        message,
        newTreeSha,
        [lastCommitSha],
        pat
    );

    // 6. Update branch ref.
    notice?.setMessage("Updating branch…");
    const upd = await updateRef(ref, branch || "main", newCommitSha, pat);
    if (!upd.ok) {
        notice?.hide();
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

    notice?.setMessage(
        `Pushed ${changes.length} changes (${formatBytes(bytes)}) → ${newCommitSha.slice(0, 7)}`
    );
    setTimeout(() => notice?.hide(), 6000);
}
