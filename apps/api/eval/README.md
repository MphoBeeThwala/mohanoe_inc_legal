# Research evaluation set

Run before any change to the research model, prompts or retrieval (roadmap §7):

```
AI_PROVIDER=foundry AI_ENDPOINT=https://<resource>.services.ai.azure.com/anthropic \
AI_MODEL=<deployment> npm run eval -w apps/api
```

It loads every `corpus/*.json` into a fresh embedded database, runs every `cases/*.json` brief through the research pipeline (query planning → retrieval → generation → citation checks) with the configured model, scores it, and writes `report.json`. The run fails below `EVAL_MIN_PASS_RATE` (default 0.9), or if verification has to remove more than `EVAL_MAX_REMOVED_RATE` (default 0.2) of the model's claims.

**The files here are synthetic placeholders** that exercise the harness. They are not law. The real set has these parts:

- **`corpus/`** — a snapshot of the approved sources the cases rely on. You can export these from the platform's sources with their licences.
- **`cases/`** — 50–100 de-identified matters across the pilot firms' practice areas, each written and checked by an attorney:
  - **`brief`** — exactly as a confirmed research brief, with role tokens and no personal information
  - **`expect.mustCite`** — the authorities a correct answer relies on (each inner list: any one of them)
  - **`expect.mustSay` / `mustNotSay`** — phrases, as regular expressions
  - **`expect.noAuthority`** — when the corpus doesn't answer the question

Record the model and the pass rate of each run in the change's PR.
