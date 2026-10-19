<!--
This source file is part of the MyHeart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# Scripts

`gen_registry.py` reads `catalog/healthkit-adapter.json` and `catalog/measurement-catalog.json` from a grove-fhir checkout at a given ref and writes `schemas/healthkit-types.json`.

```sh
uv run python scripts/gen_registry.py ../grove-fhir --ref origin/main
```
