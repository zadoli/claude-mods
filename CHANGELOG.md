# Changelog

Each plugin is versioned on its own (`plugins/<name>/.claude-plugin/plugin.json`), and each release is tagged `<plugin>-v<version>`.

## prompt-cache-control

### 0.5.0 — 2026-10-08
- The 5-hour plan window under the prompt: `5h 42% · reset 2h13m`, after the cache entry when `status` is on. New `limit` option, on by default; shown only on a Claude subscription.

### 0.4.2 — 2026-10-08
- The open details pane counts seconds again: since 0.4.1 it redrew only once a minute above 10 minutes.
- The band's keepwarm segment counts the pings in the window (`· 3 pings`) instead of the last ping's tokens and price, counted from the saved requests so it survives a restart; the details pane still shows the tokens and price.

### 0.4.1 — 2026-10-08
- The band's countdown shows whole minutes (`35m`) from 10 minutes up and seconds only below, so it no longer ticks every second. The status line follows; the details pane stays to the second.

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
