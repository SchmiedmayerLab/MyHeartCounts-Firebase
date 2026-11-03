// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

export const loincSystem = "http://loinc.org";
export const ucumSystem = "http://unitsofmeasure.org";

export type MeasurementId =
  | "blood-pressure"
  | "body-weight"
  | "body-height"
  | "body-mass-index"
  | "blood-glucose-unspecified-specimen"
  | "ldl-cholesterol";

export interface MeasurementCode {
  code: string;
  display: string;
}

export interface UcumQuantity {
  code: string;
  unit: string;
}

export interface QuantityMeasurement {
  id: MeasurementId;
  code: MeasurementCode;
  valueKind: "quantity";
  quantity: UcumQuantity;
}

export interface ComponentsMeasurement {
  id: MeasurementId;
  code: MeasurementCode;
  valueKind: "components";
  components: Record<string, { code: MeasurementCode; quantity: UcumQuantity }>;
}

export type Measurement = QuantityMeasurement | ComponentsMeasurement;

const mmHg: UcumQuantity = { code: "mm[Hg]", unit: "mmHg" };
const mgPerDl: UcumQuantity = { code: "mg/dL", unit: "mg/dL" };

// Subset of grove-fhir catalog/measurement-catalog.json; ldl-cholesterol has no Grove entry yet.
export const measurementCatalog = {
  "blood-pressure": {
    id: "blood-pressure",
    code: {
      code: "85354-9",
      display: "Blood pressure panel with all children optional",
    },
    valueKind: "components",
    components: {
      systolic: {
        code: { code: "8480-6", display: "Systolic blood pressure" },
        quantity: mmHg,
      },
      diastolic: {
        code: { code: "8462-4", display: "Diastolic blood pressure" },
        quantity: mmHg,
      },
    },
  },
  "body-weight": {
    id: "body-weight",
    code: { code: "29463-7", display: "Body weight" },
    valueKind: "quantity",
    quantity: { code: "kg", unit: "kg" },
  },
  "body-height": {
    id: "body-height",
    code: { code: "8302-2", display: "Body height" },
    valueKind: "quantity",
    quantity: { code: "cm", unit: "cm" },
  },
  "body-mass-index": {
    id: "body-mass-index",
    code: { code: "39156-5", display: "Body mass index (BMI) [Ratio]" },
    valueKind: "quantity",
    quantity: { code: "kg/m2", unit: "kg/m2" },
  },
  "blood-glucose-unspecified-specimen": {
    id: "blood-glucose-unspecified-specimen",
    code: { code: "2339-0", display: "Glucose [Mass/volume] in Blood" },
    valueKind: "quantity",
    quantity: mgPerDl,
  },
  "ldl-cholesterol": {
    id: "ldl-cholesterol",
    code: {
      code: "18262-6",
      display:
        "Cholesterol in LDL [Mass/volume] in Serum or Plasma by Direct assay",
    },
    valueKind: "quantity",
    quantity: mgPerDl,
  },
} as const satisfies Record<MeasurementId, Measurement>;

export type QuantityMeasurementId = {
  [Id in MeasurementId]: (typeof measurementCatalog)[Id]["valueKind"] extends (
    "quantity"
  ) ?
    Id
  : never;
}[MeasurementId];

export type ComponentsMeasurementId = Exclude<
  MeasurementId,
  QuantityMeasurementId
>;
