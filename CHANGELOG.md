# Changelog

Each plugin is versioned on its own (`plugins/<name>/.claude-plugin/plugin.json`), and each release is tagged `<plugin>-v<version>`.

## prompt-cache-control

### 0.4.0 — 2026-10-08
- Saved requests survive a process restart under an idle session: the band no longer drops back to "waiting for the first request", and keepwarm keeps its last turn.
- TURNS: cold-write turns marked with ❄, a cost column and a 5h% column.
- Keepwarm button in the pane; a placeholder band before the first request.
- The cache row sits above other mods' rows.
- `/cache` answers in text where nothing draws the pane (Remote Control), and recounts the active sessions from the store.
- Experimental estimate of the 5-hour plan window, summed across sessions.

### 0.3.0
- First release in this marketplace.

## context-band

### 0.2.0 — 2026-10-08
- A blank row instead of a rule under the cache band.

### 0.1.0
- First release in this marketplace.
