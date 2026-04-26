import { Notice } from "obsidian";
import type VaultSyncPlugin from "./main";
import { downloadTarball, getBranchSha, parseRepoUrl } from "./github";
import { parseTar } from "./tar";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Strip GitHub's wrapper directory ("{owner}-{repo}-{shortsha}/") from a tar entry path.
 * Returns null if the result would be empty (i.e. the wrapper dir itself).
 */
function stripWrapperDir(path: string): string | null {
    const normalized = path.replace(/\\/g, "/");
    const idx = normalized.indexOf("/");
    if (idx < 0) return null; // wrapper dir entry alone
    const rest = normalized.slice(idx + 1);
    if (!rest || rest === "/") return null;
    // Defense in depth: refuse path traversal.
    if (rest.startsWith("/") || rest.includes("../")) return null;
    return rest;
}

async function ensureDir(plugin: VaultSyncPlugin, dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/" || dirPath === ".") return;
    try {
        await plugin.app.vault.adapter.mkdir(dirPath);
    } catch (_e) {
        // Already exists, or parent created concurrently — ignore.
    }
}

async function ensureParentDirs(
    plugin: VaultSyncPlugin,
    filePath: string
): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // remove file name
    if (parts.length === 0) return;
    let acc = "";
    for (const p of parts) {
        if (!p) continue;
        acc = acc ? `${acc}/${p}` : p;
        await ensureDir(plugin, acc);
    }
}

export async function seedFromGitHub(plugin: VaultSyncPlugin): Promise<void> {
    const { pat, repoUrl, branch } = plugin.settings;
    if (!pat) throw new Error("Set a GitHub PAT in Vault Sync settings.");
    if (!repoUrl) throw new Error("Set a repo URL in Vault Sync settings.");

    const ref = parseRepoUrl(repoUrl);
    const notice = new Notice("Vault Sync: resolving branch…", 0);

    let sha: string;
    try {
        sha = await getBranchSha(ref, branch || "main", pat);
    } catch (e) {
        notice.hide();
        throw e;
    }

    notice.setMessage(`Vault Sync: downloading ${ref.owner}/${ref.repo}@${sha.slice(0, 7)}…`);

    let compressed: ArrayBuffer;
    try {
        compressed = await downloadTarball(ref, sha, pat);
    } catch (e) {
        notice.hide();
        throw e;
    }

    notice.setMessage(
        `Vault Sync: decompressing ${formatBytes(compressed.byteLength)}…`
    );

    // Wrap the in-memory compressed buffer as a ReadableStream so we can pipe
    // through gzip decompression and tar parsing without holding two copies.
    const sourceStream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(compressed));
            controller.close();
        },
    });

    let tarStream: ReadableStream<Uint8Array>;
    try {
        tarStream = sourceStream.pipeThrough(new DecompressionStream("gzip"));
    } catch (e) {
        notice.hide();
        throw new Error(
            `DecompressionStream('gzip') unavailable: ${String(e)}`
        );
    }

    let fileCount = 0;
    let byteCount = 0;
    let lastUiUpdate = 0;

    for await (const entry of parseTar(tarStream)) {
        const stripped = stripWrapperDir(entry.name);
        if (!stripped) continue;

        if (entry.type === "dir") {
            await ensureDir(plugin, stripped.replace(/\/$/, ""));
            continue;
        }

        // File.
        await ensureParentDirs(plugin, stripped);
        // Convert Uint8Array view -> standalone ArrayBuffer for writeBinary.
        const ab = entry.content.buffer.slice(
            entry.content.byteOffset,
            entry.content.byteOffset + entry.content.byteLength
        ) as ArrayBuffer;
        await plugin.app.vault.adapter.writeBinary(stripped, ab);

        fileCount++;
        byteCount += entry.content.byteLength;

        if (fileCount - lastUiUpdate >= 25) {
            notice.setMessage(
                `Vault Sync: extracted ${fileCount} files, ${formatBytes(byteCount)}`
            );
            lastUiUpdate = fileCount;
        }
    }

    plugin.settings.lastCommitSha = sha;
    await plugin.saveSettings();

    notice.setMessage(
        `Vault Sync: seed complete — ${fileCount} files, ${formatBytes(byteCount)} @ ${sha.slice(0, 7)}`
    );
    setTimeout(() => notice.hide(), 6000);
}
