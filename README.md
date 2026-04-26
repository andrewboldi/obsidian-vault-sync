# Vault Sync (REST)

**The Obsidian sync plugin that actually works on iOS — for vaults of any size, including images.**

## Why this exists

The popular [obsidian-git](https://github.com/Vinzent03/obsidian-git) plugin uses [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git), which loads entire packfiles into memory during clone and pull. On iOS, the WKWebView heap kills Obsidian once the packfile pressure adds up — silently. No error, just an "Obsidian is loading…" splash and a wiped `.obsidian/` folder.

This is a documented, multi-year, unfixed issue ([#642](https://github.com/Vinzent03/obsidian-git/issues/642), [#1012](https://github.com/Vinzent03/obsidian-git/issues/1012), [#475](https://github.com/Vinzent03/obsidian-git/issues/475)). The maintainer's own README warns: *"The git implementation on mobile is very unstable!"*

The fix isn't in JavaScript. It's in the protocol: stop using git's wire protocol on iOS. Use GitHub's REST API instead — fetch one file at a time, and memory pressure stays bounded by the largest single file rather than the whole vault.

This plugin syncs your Obsidian vault to a GitHub repository **without ever invoking git's wire protocol**, while still producing **real git commits** on the GitHub side.

## What it does

| Operation | How |
|---|---|
| **Seed** (initial download) | `GET /git/trees/{sha}?recursive=1` for the file list, then `GET /contents/{path}` per file (raw bytes, no base64 overhead) |
| **Pull** | `GET /compare/{old}...{new}` for the file-level diff, then per-file fetch of only the changed ones |
| **Push** | `POST /git/blobs` per changed file → `POST /git/trees` (delta on `base_tree`) → `POST /git/commits` → `PATCH /git/refs/heads/{branch}`. One atomic commit. |
| **Auto-sync** | `setInterval` runs pull then push every N minutes, silent unless something errors |

Memory use during any operation: **bounded by your largest single file**, not your vault size. A 1GB vault syncs as cleanly as a 1MB one.

## Install

### Stable (Community plugins)

> **Status:** submitted for review. Once accepted, install via Settings → Community plugins → Browse → **Vault Sync (REST)**.

### Beta (BRAT) — recommended while review is pending

[BRAT](https://github.com/TfTHacker/obsidian42-brat) lets you install plugins straight from GitHub.

1. Install **BRAT** from Community plugins.
2. BRAT settings → **Add Beta plugin** → paste:
   ```
   https://github.com/andrewboldi/obsidian-vault-sync
   ```
3. Enable **Vault Sync (REST)** under Community plugins.
4. BRAT auto-updates the plugin when new releases are published.

## Setup

1. **Create a GitHub Personal Access Token** ([fine-grained](https://github.com/settings/personal-access-tokens/new) recommended):
   - Resource owner: your account
   - Repository access: **Only select repositories** → pick the vault repo
   - Repository permissions: **Contents: Read and write** ✅
2. Settings → Vault Sync (REST):
   - **GitHub Personal Access Token:** paste the token
   - **Repository URL:** `https://github.com/{you}/{repo}` (or `{you}/{repo}`)
   - **Branch:** `main` (or whatever your default branch is)
   - **Auto-sync interval (minutes):** `1` for near-realtime, `0` to disable
3. Run **Vault Sync: Seed from GitHub** (command palette).

That's it. Edit on phone → 1 minute later it's a real commit on GitHub. Edit on desktop → 1 minute later it's on phone.

## Commands

| Command | What it does |
|---|---|
| **Vault Sync: Seed from GitHub** | Initial download of the entire repo. Run once after install. |
| **Vault Sync: Pull from GitHub** | Fetch incremental changes since last sync. |
| **Vault Sync: Push to GitHub** | Detect local changes, upload as one atomic commit. |
| **Vault Sync: Sync now** | Pull then push. Same as the ribbon icon. |

## How conflict handling works (and doesn't)

- **Push refuses if remote diverged** since your last pull. Run *Pull* then retry *Push*. This is intentional — the plugin won't silently overwrite remote work.
- **Pull refuses on diverged history** for now. Reseed if you really need to discard local state.
- **Same file edited on both sides:** last-pull-then-push wins. There is no merge engine. For prose vaults this is rare and tolerable; for collaborative editing, use desktop git for resolution.

## What gets skipped (never pushed)

- `.obsidian/plugins/**` — plugin code/configs are per-device. Each install pulls them fresh from BRAT/community store. Avoids leaking credentials in plugin `data.json` files.
- `.obsidian/workspace*`, `.obsidian/cache`, `.obsidian/appearance.json` — UI/UX state, per-device.
- `.trash/`, `.DS_Store`, `*.tmp`
- The plugin's own settings file (your PAT lives in `.obsidian/plugins/vault-sync/data.json` — protected by the rule above)

What still syncs from `.obsidian/`:
- `.obsidian/community-plugins.json` — list of which plugins to enable (so each device knows what to install)
- `.obsidian/hotkeys.json`, themes, etc.

## Limits & caveats

- **GitHub-only.** No GitLab/Bitbucket/Gitea support. The Git Data API shape varies enough between hosts that supporting all of them would be a separate project.
- **Files >100 MB:** GitHub's API hard-caps individual files at 100 MB. For larger files, use Git LFS (out of scope) or store them outside the vault.
- **>100k files:** Git tree API caps at ~100k entries per recursive call. Vaults beyond that need pagination, not implemented.
- **Compare API caps at 300 files per call.** If a single push between syncs touches more than 300 files, the plugin warns; reseed to recover.
- **Phone has no local git history**, just the last-known SHA pointer. Real git history lives on GitHub and on your desktop. This is a feature, not a bug — phone storage stays small.
- **No conflict merging.** See above.

## Architecture

```
iOS Obsidian                       GitHub                       Desktop Obsidian
─────────────                      ──────                       ─────────────────
Vault Sync (REST)  ──HTTPS──>  api.github.com  <──git──  obsidian-git / git CLI
                                      │
                                  real git commits
                                  in repo history
```

The GitHub repository is the single source of truth. Mobile and desktop both read/write through it independently. Mobile uses REST/Git-Data APIs; desktop uses normal git. They never need to know about each other.

## Built in one evening

This plugin was designed and built in a single session after spending hours debugging why obsidian-git wouldn't clone an Obsidian vault on iOS. The diagnostic path was:

1. Confirmed the bug → found upstream isomorphic-git issues → patched `batchAllSettled` to surface silent failures
2. Discovered the real root cause was iOS WebView heap exhaustion, not silent JS errors
3. Pivoted to the only viable architecture for iOS: per-file REST API instead of git wire protocol
4. Phase 1 (seed) → Phase 2 (pull) → Phase 3 (push) → Phase 4 (auto-sync), shipped iteratively

## License

MIT. See [LICENSE](LICENSE).
