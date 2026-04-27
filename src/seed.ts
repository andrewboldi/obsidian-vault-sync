import { Notice } from "obsidian";
import type VaultSyncPlugin from "./main";
import {
    getBranchSha,
    getFileRaw,
    getTree,
    parseRepoUrl,
    type TreeEntry,
} from "./github";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function ensureDir(plugin: VaultSyncPlugin, dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/" || dirPath === ".") return;
    try {
        await plugin.app.vault.adapter.mkdir(dirPath);
    } catch {
        // already exists
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

/**
 * Run an async task per item with bounded concurrency.
 * Keeps memory predictable and respects GitHub rate limits gently.
 */
async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    task: (item: T, idx: number) => Promise<void>
): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push(
            (async () => {
                while (true) {
                    const i = cursor++;
                    if (i >= items.length) return;
                    await task(items[i], i);
                }
            })()
        );
    }
    await Promise.all(workers);
}

const CONCURRENCY = 8;
const PROGRESS_EVERY = 10;

export async function seedFromGitHub(plugin: VaultSyncPlugin): Promise<void> {
    const { pat, repoUrl, branch } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");

    const ref = parseRepoUrl(repoUrl);
    const notice = new Notice("Resolving branch…", 0);

    let sha: string;
    try {
        sha = await getBranchSha(ref, branch || "main", pat);
    } catch (e) {
        notice.hide();
        throw e;
    }

    notice.setMessage(`Listing ${ref.owner}/${ref.repo}@${sha.slice(0, 7)}…`);

    let tree: TreeEntry[];
    try {
        tree = await getTree(ref, sha, pat);
    } catch (e) {
        notice.hide();
        throw e;
    }

    const dirs = tree.filter((e) => e.type === "tree");
    const blobs = tree.filter((e) => e.type === "blob");

    notice.setMessage(
        `${blobs.length} files, ${dirs.length} dirs — preparing…`
    );

    // Pre-create all directories sequentially (cheap, prevents race conditions).
    for (const d of dirs) {
        await ensureDir(plugin, d.path);
    }

    let fileCount = 0;
    let byteCount = 0;
    const fileShaMap: Record<string, string> = {};

    await runWithConcurrency(blobs, CONCURRENCY, async (entry) => {
        const content = await getFileRaw(ref, entry.path, sha, pat);
        await ensureParentDirs(plugin, entry.path);
        await plugin.app.vault.adapter.writeBinary(entry.path, content);
        fileShaMap[entry.path] = entry.sha;
        fileCount++;
        byteCount += content.byteLength;
        if (fileCount % PROGRESS_EVERY === 0) {
            notice.setMessage(
                `${fileCount}/${blobs.length} files, ${formatBytes(byteCount)}`
            );
        }
    });

    plugin.settings.lastCommitSha = sha;
    plugin.settings.fileShaMap = fileShaMap;
    await plugin.saveSettings();

    notice.setMessage(
        `Seed complete — ${fileCount} files, ${formatBytes(byteCount)} @ ${sha.slice(0, 7)}`
    );
    setTimeout(() => notice.hide(), 6000);
}
