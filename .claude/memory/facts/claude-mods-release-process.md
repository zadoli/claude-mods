---
id: claude-mods-release-process
type: decision
scope: project:claude-mods
confidence: high
created: 2026-10-08
updated: 2026-10-08
evidence: 1
sources: [75a2ff9a-8425-4de3-9e8e-51a2d9954f7c#2026-10-08]
supersedes: []
status: active
review_after:
last_used:
tags: [release, versioning, plugin, marketplace]
---

**Tény:** A claude-mods (zadoli-mods marketplace) pluginjainál minden kiadás: verzióemelés a plugin `plugin.json`-jában (semver, pluginonként külön), bejegyzés a `CHANGELOG.md`-be, annotált tag `<plugin>-v<verzió>` (`git tag -a`), `git push --follow-tags`, majd `claude plugin marketplace update zadoli-mods` és `/reload-plugins`.

**Miért:** 2026-10-08-án a telepített klón 4 committal le volt maradva (a marketplace update nem futott), a 0.3.0 az első commit óta nem változott, és a lightweight tageket a `--follow-tags` nem tolta fel.

**Nem érvényes, ha:** egy plugint fejlesztés közben `--plugin-dir`-ből töltesz be.
