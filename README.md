# zadoli-mods

Zádori Olivér's Claude Code mods (function-hook plugins), as the `zadoli-mods` plugin marketplace (repo: `zadoli/claude-mods`).

| Mod | What it does |
| --- | --- |
| `prompt-cache-control` | Cache meter above the prompt (hit rate, countdown, keepwarm, cold price) with a `details` button that opens a pane; `/keepwarm` pings the cache after idle stretches; a message to a cold cache of 50k+ tokens is stopped once with its price. |
| `context-band` | Desktop app only: a row above the prompt with the working directory, git branch and the skill loaded since your last message. |

Needs Claude Code 2.1.287 or newer.

## Install on a machine

```bash
claude plugin marketplace add zadoli/claude-mods
claude plugin install prompt-cache-control@zadoli-mods
claude plugin install context-band@zadoli-mods
```

Then `/reload-plugins` in a running session (or start a new one). The repo is private: the machine needs `gh auth login` (or git credentials) for GitHub first.

Update later with `claude plugin marketplace update zadoli-mods`.

## Options

In `~/.claude/settings.json` (the key is `<plugin>@zadoli-mods` when installed from this marketplace):

```json
"pluginConfigs": {
  "prompt-cache-control@zadoli-mods": {
    "options": { "ttl": "1h", "breakdown": false, "status": false, "guard": "refuse" }
  }
}
```

- `ttl`: `auto` | `5m` | `1h`. Pin `1h` behind a proxy (e.g. `ANTHROPIC_BASE_URL` to a local proxy) that drops the rate-limit headers the subscription is detected from.
- `breakdown`: read / wrote / new in the band.
- `status`: a short entry under the prompt.
- `guard`: `refuse` (stop a cold send once), `warn` (send and log the price), `off`.
- also `warnSeconds`, `compactAtTokens`, `band`, `toast` (see the plugin's `plugin.json`).

## Develop

```bash
claude plugin validate plugins/prompt-cache-control
claude plugin test plugins/prompt-cache-control
```
