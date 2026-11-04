import { merge } from "node-diff3";
import type VaultSyncPlugin from "./main";

/**
 * An unresolved pull conflict. Text conflicts have git-style markers in the
 * file itself; binary ones keep the local file and save the remote version
 * beside it at `copyPath`.
 */
export interface ConflictEntry {
    copyPath?: string;
}

const MARKER_LINE = /^(<{7}|>{7})(\s|$)/m;

export function decodeText(buf: ArrayBuffer): string | null {
    if (new Uint8Array(buf).includes(0)) return null;
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
        return null;
    }
}

/** Git-style 3-way line merge. Identical changes on both sides are not conflicts. */
export function mergeText(
    base: string,
    local: string,
    remote: string,
    remoteLabel: string
): { text: string; conflict: boolean } {
    const r = merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
        label: { a: "local", b: remoteLabel },
    });
    return { text: r.result.join("\n"), conflict: r.conflict };
}

export function hasConflictMarkers(text: string): boolean {
    return MARKER_LINE.test(text);
}

/** "notes/photo.png" → "notes/photo (remote conflict).png" */
export function conflictCopyPath(path: string): string {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const hasExt = dot > slash + 1;
    const stem = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";
    return `${stem} (remote conflict)${ext}`;
}

async function isResolved(
    plugin: VaultSyncPlugin,
    path: string,
    entry: ConflictEntry
): Promise<boolean> {
    const adapter = plugin.app.vault.adapter;
    if (entry.copyPath) return !(await adapter.exists(entry.copyPath));
    if (!(await adapter.exists(path))) return true;
    const text = decodeText(await adapter.readBinary(path));
    return text === null || !hasConflictMarkers(text);
}

export function describeConflicts(conflicts: Record<string, ConflictEntry>): string {
    const parts = Object.entries(conflicts).map(([path, e]) =>
        e.copyPath
            ? `${path} (keep one: delete it or "${e.copyPath}")`
            : `${path} (keep the text you want and delete all three marker lines: <<<<<<<, =======, >>>>>>>)`
    );
    return `Merge conflict — resolve before syncing: ${parts.join("; ")}`;
}

/**
 * Drop conflicts the user has resolved, then refuse (like git with unmerged
 * paths) if any remain. Called at the start of every pull and push.
 */
export async function assertNoConflicts(plugin: VaultSyncPlugin): Promise<void> {
    const conflicts = plugin.settings.conflicts ?? {};
    const remaining: Record<string, ConflictEntry> = {};
    for (const [path, entry] of Object.entries(conflicts)) {
        if (!(await isResolved(plugin, path, entry))) remaining[path] = entry;
    }
    if (Object.keys(remaining).length !== Object.keys(conflicts).length) {
        plugin.settings.conflicts = remaining;
        await plugin.saveSettings();
    }
    if (Object.keys(remaining).length > 0) {
        throw new Error(describeConflicts(remaining));
    }
}
