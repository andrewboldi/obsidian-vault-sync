import { Notice, TFile } from "obsidian";
import type VaultSyncPlugin from "./main";
import {
    compareCommits,
    getBranchSha,
    getFileRaw,
    parseRepoUrl,
    type CompareFile,
    type RepoRef,
} from "./github";
import { buildSkipFn, gitBlobSha } from "./push";
import {
    assertNoConflicts,
    conflictCopyPath,
    decodeText,
    describeConflicts,
    mergeText,
    type ConflictEntry,
} from "./conflicts";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function ensureDir(plugin: VaultSyncPlugin, dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/" || dirPath === ".") return;
    try {
        await plugin.app.vault.adapter.mkdir(dirPath);
    } catch {
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
    } catch {
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

async function readLocal(plugin: VaultSyncPlugin, path: string): Promise<ArrayBuffer | null> {
    if (!(await plugin.app.vault.adapter.exists(path))) return null;
    try {
        return await plugin.app.vault.adapter.readBinary(path);
    } catch {
        return null;
    }
}

/** File content at the last synced commit; empty if it can't be fetched (merges against nothing). */
async function getBaseContent(ref: RepoRef, path: string, baseSha: string, pat: string): Promise<ArrayBuffer> {
    try {
        return await getFileRaw(ref, path, baseSha, pat);
    } catch {
        return new ArrayBuffer(0);
    }
}

const CONCURRENCY = 8;

export async function pullFromGitHub(
    plugin: VaultSyncPlugin,
    opts: { silent?: boolean } = {}
): Promise<void> {
    const { pat, repoUrl, branch, lastCommitSha, fileShaMap } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");
    if (!lastCommitSha) {
        throw new Error(
            "No baseline commit recorded. Run 'Seed from GitHub' first."
        );
    }
    await assertNoConflicts(plugin);

    const ref = parseRepoUrl(repoUrl);
    const notice = opts.silent
        ? null
        : new Notice("Checking remote…", 0);

    const headSha = await getBranchSha(ref, branch || "main", pat);
    if (headSha === lastCommitSha) {
        if (notice) {
            notice?.setMessage("Already up to date");
            setTimeout(() => notice?.hide(), 4000);
        }
        return;
    }

    notice?.setMessage(`Comparing ${lastCommitSha.slice(0, 7)}…${headSha.slice(0, 7)}`);

    const cmp = await compareCommits(ref, lastCommitSha, headSha, pat);

    if (cmp.status === "diverged") {
        notice?.setMessage(
            "Remote diverged from local baseline. Manual resolution needed (push will detect this)."
        );
        setTimeout(() => notice?.hide(), 10000);
        throw new Error(
            `Remote and local have diverged (ahead ${cmp.ahead_by}, behind ${cmp.behind_by}). Pull only supports fast-forward updates.`
        );
    }

    const files = cmp.files ?? [];
    if (files.length === 0) {
        plugin.settings.lastCommitSha = headSha;
        await plugin.saveSettings();
        notice?.setMessage("Pull complete (no file changes)");
        setTimeout(() => notice?.hide(), 4000);
        return;
    }

    if (files.length === 300) {
        new Notice(
            "Compare returned exactly 300 files (GitHub's per-call cap). Some changes may be missing — re-seed if pull seems incomplete.",
            10000
        );
    }

    const toFetch: CompareFile[] = [];
    const toRemove: string[] = [];

    const shouldSkip = buildSkipFn(plugin.app.vault.configDir);

    for (const f of files) {
        // A rename across the skip boundary still has a non-skipped side
        // that must be applied: remove the old path if it's tracked, fetch
        // the new path if it's tracked.
        if (f.status === "renamed") {
            if (f.previous_filename && !shouldSkip(f.previous_filename)) {
                toRemove.push(f.previous_filename);
            }
            if (!shouldSkip(f.filename)) toFetch.push(f);
            continue;
        }
        if (shouldSkip(f.filename)) continue;

        switch (f.status) {
            case "added":
            case "modified":
            case "changed":
            case "copied":
                toFetch.push(f);
                break;
            case "removed":
                toRemove.push(f.filename);
                break;
            case "unchanged":
                break;
        }
    }

    notice?.setMessage(
        `${toFetch.length} to fetch, ${toRemove.length} to remove…`
    );

    // Files deleted on GitHub but edited here, and vice versa: keep the edits.
    const keptDeleted: string[] = [];
    const restored: string[] = [];
    const merged: string[] = [];
    const conflicted: string[] = [];

    const recordConflict = async (path: string, sha: string, entry: ConflictEntry) => {
        // Persist right away so a crash mid-pull can't leave markers on disk untracked.
        fileShaMap[path] = sha;
        plugin.settings.conflicts = { ...plugin.settings.conflicts, [path]: entry };
        conflicted.push(path);
        await plugin.saveSettings();
    };

    // Apply removals first (cheap, sequential). Only remove files unchanged since last sync.
    for (const path of toRemove) {
        const known = fileShaMap[path];
        delete fileShaMap[path];
        const local = await readLocal(plugin, path);
        if (local === null) continue;
        if (known !== undefined && (await gitBlobSha(local)) === known) {
            await safeRemove(plugin, path);
        } else {
            keptDeleted.push(path);
        }
    }

    let done = 0;
    let bytes = 0;

    await runWithConcurrency(toFetch, CONCURRENCY, async (entry) => {
        const path = entry.filename;
        const content = await getFileRaw(ref, path, headSha, pat);
        // Read local only after the fetch so an edit made meanwhile isn't missed.
        const known = fileShaMap[path];
        const local = await readLocal(plugin, path);
        const localSha = local === null ? null : await gitBlobSha(local);

        if (local === null || localSha === known || localSha === entry.sha) {
            // Unchanged here (or already identical): take GitHub's version.
            if (local === null && known !== undefined) restored.push(path);
            if (localSha !== entry.sha) {
                await ensureParentDirs(plugin, path);
                await plugin.app.vault.adapter.writeBinary(path, content);
            }
            fileShaMap[path] = entry.sha;
        } else {
            // Changed on both sides: 3-way merge text, conflict-copy anything else.
            const base = known !== undefined
                ? await getBaseContent(ref, path, lastCommitSha, pat)
                : new ArrayBuffer(0);
            const baseText = decodeText(base);
            const localText = decodeText(local);
            const remoteText = decodeText(content);
            if (baseText !== null && localText !== null && remoteText !== null) {
                let conflict = false;
                const doMerge = (current: string): string => {
                    const m = mergeText(baseText, current, remoteText, `remote ${headSha.slice(0, 7)}`);
                    conflict = m.conflict;
                    return m.text;
                };
                const file = plugin.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    // Merge against the latest content, including an open editor's.
                    await plugin.app.vault.process(file, doMerge);
                } else {
                    await plugin.app.vault.adapter.write(path, doMerge(localText));
                }
                if (conflict) {
                    await recordConflict(path, entry.sha, {});
                } else {
                    fileShaMap[path] = entry.sha;
                    merged.push(path);
                }
            } else {
                const copyPath = conflictCopyPath(path);
                await plugin.app.vault.adapter.writeBinary(copyPath, content);
                await recordConflict(path, entry.sha, { copyPath });
            }
        }
        done++;
        bytes += content.byteLength;
        if (done % 5 === 0) {
            notice?.setMessage(
                `${done}/${toFetch.length} files, ${formatBytes(bytes)}`
            );
        }
    });

    // Advance the baseline even with conflicts: resolved files then push as
    // ordinary changes on top of the new head.
    plugin.settings.lastCommitSha = headSha;
    plugin.settings.fileShaMap = fileShaMap;
    await plugin.saveSettings();

    // Shown even for silent auto-sync: the user needs to know about these.
    if (keptDeleted.length > 0) {
        new Notice(
            `Kept ${keptDeleted.length} file(s) you edited here that were deleted on GitHub: ${keptDeleted.join(", ")}. They'll be re-added on push — delete them if unwanted.`,
            15000
        );
    }
    if (restored.length > 0) {
        new Notice(
            `Restored ${restored.length} file(s) you deleted here that were edited on GitHub: ${restored.join(", ")}.`,
            15000
        );
    }
    if (conflicted.length > 0) {
        notice?.hide();
        throw new Error(describeConflicts(plugin.settings.conflicts));
    }

    notice?.setMessage(
        `Pull complete — ${toFetch.length} updated${merged.length ? ` (${merged.length} merged)` : ""}, ${toRemove.length} removed @ ${headSha.slice(0, 7)}`
    );
    setTimeout(() => notice?.hide(), 6000);
}
