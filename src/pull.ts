import { Notice } from "obsidian";
import type VaultSyncPlugin from "./main";
import {
    compareCommits,
    getBranchSha,
    getFileRaw,
    parseRepoUrl,
    type CompareFile,
} from "./github";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function ensureDir(plugin: VaultSyncPlugin, dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/" || dirPath === ".") return;
    try {
        await plugin.app.vault.adapter.mkdir(dirPath);
    } catch (_e) {
        /* exists */
    }
}

async function ensureParentDirs(
    plugin: VaultSyncPlugin,
    filePath: string
): Promise<void> {
    const parts = filePath.split("/");
    parts.pop();
    if (parts.length === 0) return;
    let acc = "";
    for (const p of parts) {
        if (!p) continue;
        acc = acc ? `${acc}/${p}` : p;
        await ensureDir(plugin, acc);
    }
}

async function safeRemove(plugin: VaultSyncPlugin, path: string): Promise<void> {
    try {
        await plugin.app.vault.adapter.remove(path);
    } catch (_e) {
        /* already gone */
    }
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<void>
): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push(
            (async () => {
                while (true) {
                    const i = cursor++;
                    if (i >= items.length) return;
                    await task(items[i]);
                }
            })()
        );
    }
    await Promise.all(workers);
}

const CONCURRENCY = 8;

export async function pullFromGitHub(plugin: VaultSyncPlugin): Promise<void> {
    const { pat, repoUrl, branch, lastCommitSha, fileShaMap } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");
    if (!lastCommitSha) {
        throw new Error(
            "No baseline commit recorded. Run 'Vault Sync: Seed from GitHub' first."
        );
    }

    const ref = parseRepoUrl(repoUrl);
    const notice = new Notice("Vault Sync: checking remote…", 0);

    const headSha = await getBranchSha(ref, branch || "main", pat);
    if (headSha === lastCommitSha) {
        notice.setMessage("Vault Sync: already up to date");
        setTimeout(() => notice.hide(), 4000);
        return;
    }

    notice.setMessage(`Vault Sync: comparing ${lastCommitSha.slice(0, 7)}…${headSha.slice(0, 7)}`);

    const cmp = await compareCommits(ref, lastCommitSha, headSha, pat);

    if (cmp.status === "diverged") {
        notice.setMessage(
            "Vault Sync: remote diverged from local baseline. Manual resolution needed (Phase 3 push will detect this)."
        );
        setTimeout(() => notice.hide(), 10000);
        throw new Error(
            `Remote and local have diverged (ahead ${cmp.ahead_by}, behind ${cmp.behind_by}). Vault Sync can only fast-forward in Phase 2.`
        );
    }

    const files = cmp.files ?? [];
    if (files.length === 0) {
        plugin.settings.lastCommitSha = headSha;
        await plugin.saveSettings();
        notice.setMessage("Vault Sync: pull complete (no file changes)");
        setTimeout(() => notice.hide(), 4000);
        return;
    }

    if (files.length === 300) {
        new Notice(
            "Vault Sync: compare returned exactly 300 files (GitHub's per-call cap). Some changes may be missing — re-seed if pull seems incomplete.",
            10000
        );
    }

    const toFetch: CompareFile[] = [];
    const toRemove: string[] = [];

    for (const f of files) {
        switch (f.status) {
            case "added":
            case "modified":
            case "changed":
            case "copied":
                toFetch.push(f);
                break;
            case "renamed":
                if (f.previous_filename) toRemove.push(f.previous_filename);
                toFetch.push(f);
                break;
            case "removed":
                toRemove.push(f.filename);
                break;
            case "unchanged":
                break;
        }
    }

    notice.setMessage(
        `Vault Sync: ${toFetch.length} to fetch, ${toRemove.length} to remove…`
    );

    // Apply removals first (cheap, sequential).
    for (const path of toRemove) {
        await safeRemove(plugin, path);
        delete fileShaMap[path];
    }

    let done = 0;
    let bytes = 0;

    await runWithConcurrency(toFetch, CONCURRENCY, async (entry) => {
        const content = await getFileRaw(ref, entry.filename, headSha, pat);
        await ensureParentDirs(plugin, entry.filename);
        await plugin.app.vault.adapter.writeBinary(entry.filename, content);
        fileShaMap[entry.filename] = entry.sha;
        done++;
        bytes += content.byteLength;
        if (done % 5 === 0) {
            notice.setMessage(
                `Vault Sync: ${done}/${toFetch.length} files, ${formatBytes(bytes)}`
            );
        }
    });

    plugin.settings.lastCommitSha = headSha;
    plugin.settings.fileShaMap = fileShaMap;
    await plugin.saveSettings();

    notice.setMessage(
        `Vault Sync: pull complete — ${toFetch.length} updated, ${toRemove.length} removed @ ${headSha.slice(0, 7)}`
    );
    setTimeout(() => notice.hide(), 6000);
}
