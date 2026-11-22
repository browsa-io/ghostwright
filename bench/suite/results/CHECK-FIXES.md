# Changes to tasks and checks

A task or a check is never changed to make a number move. A check that is demonstrably wrong is fixed for every SDK measured, and listed here with the evidence.

| Date | Task | What changed | Evidence |
|---|---|---|---|
| 2026-11-19 | all fixture pages | Before the first published results: every app-state change also shows a small status line (`role="status"`), as a real app's "Saved" notice does, so an action always has an effect a person could see. Every set was run again after it. | Pages that changed state with nothing on screen made a correct click indistinguishable from a click that did nothing. |
| 2026-11-21 | none | No task and no check changed between the 0.1.0 and the 0.2.0 results. The harness moved into this repository (`bench/suite/`), reads the model key from the environment, and records the commit measured (`sdk_commit`). | `tasks/*.mjs` are the files the 0.1.0 results were measured with. |
