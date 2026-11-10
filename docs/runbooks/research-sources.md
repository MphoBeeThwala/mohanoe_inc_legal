# Research sources (approved corpus)

AI research answers only from **approved sources** (roadmap §7.4). An operator registers each source with the licence or written permission relied on. Until then it can't be searched, and suspending it removes it from research straight away.

```
npm run ops -w apps/api -- sources add --code laws-africa --name "Laws.Africa" --kind legislation \
  --publisher "Laws.Africa" --url https://laws.africa \
  --licence "Laws.Africa API terms, <plan>, accepted <date>" --approved-by <operator email>
npm run ops -w apps/api -- sources list
npm run ops -w apps/api -- sources suspend --code <code>
npm run ops -w apps/api -- sources import --code <code> --file act.pdf --title "..." --citation "Act 19 of 1998" \
  [--level 1-6] [--court ZACC] [--validity in_force|amended|repealed|not_commenced|overruled] \
  [--effective YYYY-MM-DD] [--repealed YYYY-MM-DD] [--version YYYY-MM-DD] [--url ...]
npm run ops -w apps/api -- sources sync-laws-africa [--place za] [--limit N]   # weekly job
```

Kinds: `legislation`, `regulation`, `case_law`, `rules`, `practice_directive`, `tribunal`, `guidance`, `journal`, `treatise`, `other`.

## Hierarchy of authority and validity

| Level | What | Examples |
|---|---|---|
| 1 | Constitutional Court | `[2012] ZACC 9` |
| 2 | Supreme Court of Appeal | `[2019] ZASCA 1` |
| 3 | High Court and specialist courts | `ZAGPJHC`, `ZAWCHC`, `ZALC`, `ZALAC`, `ZACAC` |
| 4 | Statutes and regulations | `Act 19 of 1998` |
| 5 | Rules and practice directives | Uniform Rules, divisional directives |
| 6 | Tribunals, guidance, commentary | CCMA awards, ombuds, FIC guidance, journals |

- **Hierarchy.** Neutral citations set the level automatically, and `--level` overrides it. Search ranks higher authority first when passages are equally relevant, and the model is told each passage's level.
- **Validity.** Every document carries its effective date, validity and repeal date. Repealed, overruled or not-yet-commenced documents, and repealed provisions inside an act, are never offered to the model.
- **Citations.** A citation shown with an answer is the document's own (`[Year] ZACC [Number]`, `Act N of YYYY`). Any authority the model names that wasn't retrieved is removed by the citation checks.

## Sources by licence status

From the data-source specification (`docs/research-data-sources.md`). None can be searched until it is registered with its licence or permission.

| Source | Kind | What is needed before registering |
|---|---|---|
| Laws.Africa Content API (consolidated Acts, by-laws; Akoma Ntoso) | legislation | Account and API token; accept its terms for commercial use. Adapter built: `sources sync-laws-africa` |
| Government & Provincial Gazettes | legislation, regulation | Official texts have no copyright (Copyright Act s12(8)(a)); import with `sources import` |
| Uniform Rules, Magistrates' Courts Rules, CC and SCA rules | rules | Official texts; import with `sources import --kind rules` |
| Divisional practice directives | practice_directive | Official texts from each division; import |
| LPC Code of Conduct and rules | guidance | Official; import |
| FIC directives and guidance notes; Information Regulator guidance; CIPC practice notes | guidance | Official; import (FICA intake checks are separate from research) |
| SARS rulings (BGRs and published BPRs), Tax Court judgments | guidance, case_law | Published by SARS and the courts; confirm reuse terms |
| SAFLII judgments | case_law | **Written permission from SAFLII** (its terms restrict bulk reuse); record the reference with `--permission` |
| CCMA awards, bargaining council agreements, Competition Tribunal, NCT and ombuds decisions | tribunal | Confirm each body's reuse terms |
| LexisNexis SA (SALR, All SA), Juta, Sabinet NetLaw and African Journals | case_law, legislation, journal | **Commercial licence** that allows AI retrieval; an adapter per licence |
| De Rebus, Advocate | journal | Permission from the publishers |
| Treatises (Erasmus, Henochsberg, Silke, Bill of Rights Compendium) | treatise | **Commercial licence** |

Firm precedents are each firm's own (Account → Research sources):

1. They are de-identified when uploaded.
2. Someone checks the result.
3. An attorney approves them before research can use them.

They are presented to the model as precedent, not authority.
