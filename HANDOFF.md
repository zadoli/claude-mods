# Handoff: prompt-cache-control és context-band modok

Sessionök: 2026-10-05 és 2026-10-06, desktop app (Code tab). Ebből a fájlból egy új, hideg cache-ű session is folytathatja a munkát.

## Röviden

Két saját Claude Code mod (function-hook plugin) készült. A `zadoli/claude-mods` privát GitHub repóban vannak, `zadoli-mods` nevű marketplace-ként.

| Mod | Mit csinál |
| --- | --- |
| `prompt-cache-control` (0.3.0) | Cache-sáv a prompt felett: hit rate (1 tizedes), `⏱` visszaszámláló, `♨ keepwarm`, `❄ re-warm` ár, `details` gomb. Részletes panel csoportokkal (CACHE, LAST REQUEST, KEEPWARM, COST, TURNS). `/keepwarm` pingelés. Figyelmeztetés hideg cache-re küldés előtt (guard). Automatikus 3 órás keepwarm fizetett hideg írás után. Kísérleti becslés az 5 órás keret százalékára, az összes helyi session költésével. |
| `context-band` (0.1.0) | Csak desktopon: egy sor a prompt felett a munkakönyvtárral, a git ággal és az utolsó `Skill` tool hívással. A cache-sortól egy üres sor választja el (`marginTop`), de csak ha a cache-sor látszik. Terminálban nem rajzol, ott a felhasználó saját status line-ja mutatja ugyanezt. |

A `cache-tax@claude-code-mods` plugint eltávolítottuk. Minden funkcióját (keepwarm, hideg-cache ár és figyelmeztetés, auto-keepwarm, összesítő) átvittük a prompt-cache-control-ba.

## Hol van mi

- **Ezen a gépen ezek futnak:** `~/.claude/skills/prompt-cache-control/` és `~/.claude/skills/context-band/`. `@skills-dir` pluginként töltődnek be.
- **Repó:** `D:\Development\AI\claude-mods\`, alatta `plugins/<mod>/`, valamint `.claude-plugin/marketplace.json`, `README.md` és `LICENSE` (MIT, a claude-code-templates és a cache-tax megnevezésével).
- **A két hely kézzel van szinkronban.** A szerkesztés a skills mappában történik. Utána ezt kell futtatni:
  ```bash
  cp -r ~/.claude/skills/prompt-cache-control/{hooks,tests} D:/Development/AI/claude-mods/plugins/prompt-cache-control/
  cp -r ~/.claude/skills/context-band/{hooks,tests} D:/Development/AI/claude-mods/plugins/context-band/
  ```
  Majd commit és push a repóban.
- **Marketplace ezen a gépen:** a `zadoli-mods` hozzá van adva, de a modok nincsenek belőle telepítve, mert akkor duplán töltődnének be.
- **Beállítások** a `~/.claude/settings.json`-ban (másolat a módosítás előttiről a session scratchpadjében volt):
  ```json
  "pluginConfigs": { "prompt-cache-control@skills-dir": { "options": { "status": false, "breakdown": false, "ttl": "1h" } } }
  ```
  Ha egy gépen a marketplace-ből telepíted, a kulcs `prompt-cache-control@zadoli-mods`.

## Fontos tények és döntések

- **A TTL kézzel van 1 órára rögzítve (`ttl: "1h"`).** A terminál a Windows felhasználói környezeti változón át (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, valószínűleg headroom proxy) proxyn megy keresztül. Így nem jönnek meg a rate-limit ablakok, és a mod 5 percet hinne. A desktop session `https://api.anthropic.com`-ot használ.
- **A keepwarm a mod saját része.** `$.model.fork`-kal pingel, és a pinget `Sample`-ként rögzíti, így a mérő is látja. A cache-tax pingjeit más plugin nem látta: a fork nem `turn.step`, és nincs rá hook.
- **Időzítés:** a ping-periódus `ttl × 5/6`, vagyis 1 órás TTL-nél 50 perc. Az ablak lejáratát a `$.store` tárolja (`keepwarm.deadline:<sid>`), ezért túléli a reloadot.
- **Árak:** a cache-tax 2026. szeptemberi listaár-táblája alapján (`PRICES`). 5 perces TTL-nél a cache-írás díja az 1 órás díj 0,625-szöröse.
- **A guard (`guard` opció):** `refuse` / `warn` / `off`. 50 000 token felett és hideg cache esetén lép működésbe. A döntés a tiszta `guardVerdict()` függvényben van (`cache.ts`).
- **Hideg írás:** a `isColdWrite()` dönti el. Akkor számít annak, ha a guard átengedte az üzenetet, vagy ha a kör az előző, legalább 20 000 tokenes prompt legalább felét újraírta. Ilyenkor 3 órás keepwarm indul.
- **5 órás keret becslése (kísérleti):** a session listaáras költését (`spentUsd`) veti össze a `five_hour` keret `percentUsed` értékének változásával. Akkor ad számot, ha a keret legalább 0,5%-ot mozdult (`calibRate()`). Az arányt a `calib.pctPerUsd` kulcson menti el. Minden session a `spend:<sid>` kulcsra írja a saját ablakbeli költését (`{ resetsAt, usd, at }`), a becslés ezek összegével számol (`windowSpend()`), és kiírja az aktív (10 percen belül író) sessionök számát. A claude.ai, a Cowork és a más gépek fogyasztását nem látja, ezek miatt a becslés még túl magas lehet.
- **Sávok összefűzése:** az `AbovePrompt` hookok a `next(e)` eredményét is visszaadják, és a saját sorukat alá teszik. Így a két mod sora egymás alatt jelenik meg.
- **Store-fájl:** `~/.claude/plugins/store/prompt-cache-control_skills-dir-<hash>.json`. Ebben látszik élőben a `calib.pctPerUsd`, a `keepwarm.deadline:<sid>` és a `spend:<sid>` kulcsok.
- **Elválasztó a két sor között:** a `─` vonal nem vált be. A `truncate-end` a végére `…`-t tett, a vágott változat (`height={1} overflow="hidden"`) pedig desktopon két sorba tört. A végleges megoldás az üres sor. A `rest` (a `next(e)` eredménye) üres, ha a cache-sor nem rajzol, mert a motor maga nem rajzol semmit az `AbovePrompt`-ba.
- **A panel** a sávon lévő `details` gombbal vagy a `/cache` paranccsal nyílik, és a `/cache stop` zárja be. Amíg nyitva van, a sáv rejtve marad. A `/cache status` parancs megszűnt, az összesítő a panelen van.

## A plugin-motor buktatói, amikbe belefutottunk

1. **`$` nem adható át importon keresztül**, csak az azonos fájlban deklarált függvénynek. Ezért van a keepwarm is a `prompt-cache-control.tsx`-ben. A tiszta logika a `cache.ts`-be kerül, `$` nélkül.
2. **Egy eseményre modulonként csak egy matcher nélküli hook** regisztrálható. A `session.start` és a `session.end` ezért a fő hookokból hívja a `keepwarmStart` és `keepwarmEnd` függvényeket.
3. **Desktopon a szóközök nem törhető szóközre (NBSP) cserélődnek** (`sp()`). A teszt-regexekben a szóköz helyére `.` kell.
4. **Tesztek** (`claude plugin test`):
   - nincs `$.fs`, ezért a `branchOf` paraméterként kapja meg a fájlolvasó függvényeket;
   - a `Date.now` nem írható felül, ezért az időfüggő döntések tiszta függvényekbe kerültek;
   - a `next(e)` miatt kell egy alap `AbovePrompt` render, amely üres `<Box />`-ot ad.
5. **`/reload-plugins` után** a mod belső változói nullázódnak (minták, költés), a `$.store` viszont megmarad. A sáv csak az első kérés után jelenik meg újra.
6. **Validálás:** a `claude plugin validate` csak a szerkezetet és a hívásokat ellenőrzi, típusokat nem. A típusellenőrzéshez a skill `types/claude-code.d.ts` fájljával és saját `tsconfig`-gal fut `tsc` (`jsx: react`, `jsxFactory: h`, `moduleResolution: Bundler`, `allowImportingTsExtensions`).

## Ellenőrzés

```bash
claude plugin validate ~/.claude/skills/prompt-cache-control
claude plugin test ~/.claude/skills/prompt-cache-control
claude plugin test ~/.claude/skills/context-band
```
Utolsó állapot: validálás rendben, 36 teszt (prompt-cache-control) és 3 teszt (context-band), mind átment, a `tsc` hibátlan.

## Felületek (Chat, Cowork, Remote Control)

- **claude.ai Chat és Cowork:** a function-hook modok itt nem futnak. A motor ezeket a felületeket ismeri: `terminal`, `desktop`, `vscode`, `mobile`.
- **Remote Control (mobilapp, `mobile` felület):** az `AbovePrompt` csak terminálon és desktopon jelenik meg, így mobilon sem a cache-sáv, sem a context-band nem látszik. A `Pane`, a `CommandOutput` és az `AssistantMessage` minden felületen megjelenik. A mobilon nincs `Input`, `Select` és `Client`. A toastról és a status line-ról nincs adat.
- **A böngészős claude.ai/code** nem szerepel a felületek listájában.

## Nyitott pontok

- [ ] **Remote Control, 1. lépés:** telefonról kipróbálni, hogy a `/cache` panel megjelenik-e. Elvileg igen, mert a `Pane` minden felületen megjelenik, a panel pedig csak `Box`/`Text`/`Button` elemekből áll.
- [ ] **Remote Control, 2. lépés (javasolt, még nincs kész):** egy `ui.render` hook az `AssistantMessage`-re, csak `e.surface === 'mobile'` esetén. A legutóbbi válasz alá tesz egy halvány lábléc-sort, például: `● cache 98% · ⏱ 47:12 · ♨ keepwarm · 📁 AI ⎇ master`. A javaslat szerint csak a legutóbbi válasz alá kerül, de ezt a felhasználó még nem hagyta jóvá. Ez kb. 20 sor kód. Nyitott kérdés: a két mod adatát egy sorba vonja-e össze, vagy mindkét mod saját sort ad.
- [ ] **Élőben még nem kipróbált:** a guard, a 3 órás auto-keepwarm és a `❄ re-warm` sor csak hideg cache-nél látszik. Teszteléshez ideiglenesen `"ttl": "5m"` és `/keepwarm off` kell, majd 5 perc várakozás.
- [ ] **A keretbecslés:** meg kell figyelni, hogy a `🧪 calibrating… · N active sessions` sor után megjelenik-e reális szám a panel COST csoportjában, és hogy az aktív sessionök száma stimmel-e. A becslés több session esetén csak akkor pontos, ha mindegyik sessionben fut a mod új verziója (`/reload-plugins`).
- [ ] **Terminálos status line** (a felhasználó saját scriptje): a `Cache Hit` és `Cache: ●` részeket ki akarja venni, mert a mod most már mutatja ezeket. A script helyét a `settings.json` `statusLine` beállítása adja meg. Ehhez még nem nyúltunk.
- [ ] **Ötlet:** a `context-band` most csak a `Skill` toolon át indított skillt látja. A status line `Skill:` mezője lehet, hogy máshonnan veszi az adatot, és ugyanez a forrás itt is használható lenne.
