<!--
This source file is part of the MyHeart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# HealthKit type registry

`healthkit-types.json` is generated from the grove-fhir catalogs by `scripts/gen_registry.py` and records the Grove version and commit it came from. One entry per HealthKit source type:

| Field | Meaning |
|---|---|
| `status` | Grove adapter status; only `supported` types are exported |
| `measurement_id` | Grove measurement, used as the output role in the `sample_id` derivation |
| `value_kind` | `quantity` or `codeableConcept` are exportable; others are skipped and counted |
| `unit` | canonical UCUM code every value is converted to |
| `integer_only` | values are expected to be integral; violations are counted as warnings |
| `effective` | `dateTime`, `Period` or `dateTime-or-Period`; mismatches are counted as warnings |
| `allowed_values` | Grove codes a category value must map to |
| `code` | clinical code of the measurement |

Do not edit the file by hand. Change the generator or the Grove catalogs and regenerate. Measurements that Grove admits through an authoritative FHIR profile instead of a measurement row, currently BMI, are added by the generator's `STANDARD_CLAIMS` overlay.
