// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { CodingSystem } from "./codes.js";
import { type FHIRQuantity } from "../fhir/baseTypes/fhirQuantity.js";
import { type Observation } from "../types/observation.js";

export class QuantityUnit {
  // Static Properties

  static readonly mg = new QuantityUnit("mg", "mg");
  static readonly lbs = new QuantityUnit("[lb_av]", "lbs");
  static readonly kg = new QuantityUnit("kg", "kg");
  static readonly bpm = new QuantityUnit("/min", "beats/minute");
  static readonly mmHg = new QuantityUnit("mm[Hg]", "mmHg");
  static readonly mg_dL = new QuantityUnit("mg/dL", "mg/dL");
  static readonly mEq_L = new QuantityUnit("meq/L", "mEq/L");
  static readonly mL_min_173m2 = new QuantityUnit(
    "mL/min/{1.73_m2}",
    "mL/min/1.73m2",
  );
  static readonly tablet = new QuantityUnit("{tbl}", "tbl.");
  static readonly score = new QuantityUnit("{count}", "count");

  // HealthKit mobility metrics
  static readonly flights = new QuantityUnit("flights", "flights");
  static readonly count = new QuantityUnit("count", "count");
  static readonly steps = new QuantityUnit("steps", "steps");
  static readonly meters = new QuantityUnit("m", "meters");
  static readonly kilometers = new QuantityUnit("km", "kilometers");
  static readonly miles = new QuantityUnit("[mi_i]", "miles");
  static readonly m_s = new QuantityUnit("m/s", "meters/second");
  static readonly cm = new QuantityUnit("cm", "centimeters");
  static readonly percent = new QuantityUnit("%", "percent");

  // HealthKit time metrics
  static readonly seconds = new QuantityUnit("s", "seconds");
  static readonly minutes = new QuantityUnit("min", "minutes");
  static readonly hours = new QuantityUnit("h", "hours");

  // HealthKit vital signs
  static readonly celsius = new QuantityUnit("Cel", "celsius");
  static readonly fahrenheit = new QuantityUnit("[degF]", "fahrenheit");
  static readonly mL_kg_min = new QuantityUnit("mL/kg/min", "mL/kg/min");
  static readonly resp_min = new QuantityUnit(
    "{Breaths}/min",
    "breaths/minute",
  );
  static readonly mg_dL_glu = new QuantityUnit("mg/dL", "mg/dL");

  // HealthKit body measurements
  static readonly cm_height = new QuantityUnit("cm", "centimeters");
  static readonly in_height = new QuantityUnit("[in_i]", "inches");
  static readonly kg_m2 = new QuantityUnit("kg/m2", "kg/m²");

  static readonly allValues = [
    QuantityUnit.mg,
    QuantityUnit.lbs,
    QuantityUnit.kg,
    QuantityUnit.bpm,
    QuantityUnit.mmHg,
    QuantityUnit.mg_dL,
    QuantityUnit.mEq_L,
    QuantityUnit.mL_min_173m2,
    QuantityUnit.tablet,

    // HealthKit mobility metrics
    QuantityUnit.flights,
    QuantityUnit.count,
    QuantityUnit.steps,
    QuantityUnit.meters,
    QuantityUnit.kilometers,
    QuantityUnit.miles,
    QuantityUnit.m_s,
    QuantityUnit.cm,
    QuantityUnit.percent,

    // HealthKit time metrics
    QuantityUnit.seconds,
    QuantityUnit.minutes,
    QuantityUnit.hours,

    // HealthKit vital signs
    QuantityUnit.celsius,
    QuantityUnit.fahrenheit,
    QuantityUnit.mL_kg_min,
    QuantityUnit.resp_min,
    QuantityUnit.mg_dL_glu,

    // HealthKit body measurements
    QuantityUnit.cm_height,
    QuantityUnit.in_height,
    QuantityUnit.kg_m2,
  ];

  // Properties

  readonly unit: string;
  readonly code: string;
  readonly system: string;

  // Constructor

  constructor(code: string, unit: string, system: string = CodingSystem.ucum) {
    this.unit = unit;
    this.code = code;
    this.system = system;
  }

  // Methods

  isUsedIn(other: FHIRQuantity): boolean {
    return (
      this.code === other.code &&
      this.system === other.system &&
      this.unit === other.unit
    );
  }

  equals(other: QuantityUnit): boolean {
    return (
      this.code === other.code &&
      this.system === other.system &&
      this.unit === other.unit
    );
  }

  convert(observation: Observation): Observation | undefined {
    const converter = QuantityUnitConverter.allValues.find(
      (converter) =>
        converter.sourceUnit.equals(observation.unit) &&
        converter.targetUnit.equals(this),
    );
    if (!converter) return undefined;
    const value = converter.convert(observation.value);
    return value ? { ...observation, value, unit: this } : undefined;
  }

  fhirQuantity(value: number): FHIRQuantity {
    return {
      system: this.system,
      code: this.code,
      value: value,
      unit: this.unit,
    };
  }

  valueOf(quantity: FHIRQuantity | undefined): number | undefined {
    if (!quantity?.value) return undefined;
    if (this.isUsedIn(quantity)) return quantity.value;

    const converter = QuantityUnitConverter.allValues.find(
      (converter) =>
        converter.sourceUnit.isUsedIn(quantity) &&
        converter.targetUnit.equals(this),
    );
    if (!converter) return undefined;
    return converter.convert(quantity.value);
  }
}

class QuantityUnitConverter {
  readonly sourceUnit: QuantityUnit;
  readonly targetUnit: QuantityUnit;
  readonly convert: (value: number) => number;

  constructor(
    sourceUnit: QuantityUnit,
    targetUnit: QuantityUnit,
    convert: (value: number) => number,
  ) {
    this.sourceUnit = sourceUnit;
    this.targetUnit = targetUnit;
    this.convert = convert;
  }

  static readonly allValues = [
    // Weight conversions
    new QuantityUnitConverter(
      QuantityUnit.lbs,
      QuantityUnit.kg,
      (value) => value * 0.45359237,
    ),
    new QuantityUnitConverter(
      QuantityUnit.kg,
      QuantityUnit.lbs,
      (value) => value / 0.45359237,
    ),

    // Distance conversions
    new QuantityUnitConverter(
      QuantityUnit.meters,
      QuantityUnit.kilometers,
      (value) => value / 1000,
    ),
    new QuantityUnitConverter(
      QuantityUnit.kilometers,
      QuantityUnit.meters,
      (value) => value * 1000,
    ),
    new QuantityUnitConverter(
      QuantityUnit.meters,
      QuantityUnit.miles,
      (value) => value / 1609.344,
    ),
    new QuantityUnitConverter(
      QuantityUnit.miles,
      QuantityUnit.meters,
      (value) => value * 1609.344,
    ),
    new QuantityUnitConverter(
      QuantityUnit.kilometers,
      QuantityUnit.miles,
      (value) => value / 1.609344,
    ),
    new QuantityUnitConverter(
      QuantityUnit.miles,
      QuantityUnit.kilometers,
      (value) => value * 1.609344,
    ),

    // Time conversions
    new QuantityUnitConverter(
      QuantityUnit.seconds,
      QuantityUnit.minutes,
      (value) => value / 60,
    ),
    new QuantityUnitConverter(
      QuantityUnit.minutes,
      QuantityUnit.seconds,
      (value) => value * 60,
    ),
    new QuantityUnitConverter(
      QuantityUnit.minutes,
      QuantityUnit.hours,
      (value) => value / 60,
    ),
    new QuantityUnitConverter(
      QuantityUnit.hours,
      QuantityUnit.minutes,
      (value) => value * 60,
    ),
    new QuantityUnitConverter(
      QuantityUnit.seconds,
      QuantityUnit.hours,
      (value) => value / 3600,
    ),
    new QuantityUnitConverter(
      QuantityUnit.hours,
      QuantityUnit.seconds,
      (value) => value * 3600,
    ),

    // Temperature conversions
    new QuantityUnitConverter(
      QuantityUnit.celsius,
      QuantityUnit.fahrenheit,
      (value) => (value * 9) / 5 + 32,
    ),
    new QuantityUnitConverter(
      QuantityUnit.fahrenheit,
      QuantityUnit.celsius,
      (value) => ((value - 32) * 5) / 9,
    ),

    // Height conversions
    new QuantityUnitConverter(
      QuantityUnit.cm_height,
      QuantityUnit.in_height,
      (value) => value / 2.54,
    ),
    new QuantityUnitConverter(
      QuantityUnit.in_height,
      QuantityUnit.cm_height,
      (value) => value * 2.54,
    ),
  ];
}
