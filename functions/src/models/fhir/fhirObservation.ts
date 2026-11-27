// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CodingSystem, LoincCode } from "../codes/codes.js";
import { QuantityUnit } from "../codes/quantityUnit.js";
import { dateConverterISO } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { optionalish } from "../helpers/optionalish.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";
import { type Observation } from "../types/observation.js";
import {
  type FHIRCodeableConcept,
  fhirCodeableConceptConverter,
} from "./baseTypes/fhirCodeableConcept.js";
import { type FHIRCoding } from "./baseTypes/fhirCoding.js";
import {
  FHIRResource,
  fhirResourceConverter,
  type FHIRResourceInput,
} from "./baseTypes/fhirElement.js";
import {
  fhirPeriodConverter,
  type FHIRPeriod,
} from "./baseTypes/fhirPeriod.js";
import {
  type FHIRQuantity,
  fhirQuantityConverter,
} from "./baseTypes/fhirQuantity.js";
import {
  type FHIRReference,
  fhirReferenceConverter,
} from "./baseTypes/fhirReference.js";

export enum UserObservationCollection {
  heartRate = "heartRateObservations",

  // HealthKit mobility metrics
  flightsClimbed = "flightsClimbedObservations",
  stepCount = "stepCountObservations",
  distanceWalkingRunning = "distanceWalkingRunningObservations",
  distanceCycling = "distanceCyclingObservations",
  distanceWheelchair = "distanceWheelchairObservations",
  distanceSwimming = "distanceSwimmingObservations",
  walkingSpeed = "walkingSpeedObservations",
  walkingStepLength = "walkingStepLengthObservations",
  walkingAsymmetryPercentage = "walkingAsymmetryPercentageObservations",
  walkingDoubleSupportPercentage = "walkingDoubleSupportPercentageObservations",
  stairAscentSpeed = "stairAscentSpeedObservations",
  stairDescentSpeed = "stairDescentSpeedObservations",
  walkingSteadiness = "walkingSteadinessObservations",
  walkingSteadinessEvent = "walkingSteadinessEventObservations",
  sixMinuteWalkTestDistance = "sixMinuteWalkTestDistanceObservations",

  // HealthKit activity metrics
  appleExerciseTime = "appleExerciseTimeObservations",
  appleMoveTime = "appleMoveTimeObservations",
  appleStandTime = "appleStandTimeObservations",
  appleStandHour = "appleStandHourObservations",

  // HealthKit vital signs
  oxygenSaturation = "oxygenSaturationObservations",
  bodyTemperature = "bodyTemperatureObservations",
  bloodPressureSystolic = "bloodPressureSystolicObservations",
  bloodPressureDiastolic = "bloodPressureDiastolicObservations",
  respiratoryRate = "respiratoryRateObservations",
  basalBodyTemperature = "basalBodyTemperatureObservations",
  bloodGlucose = "bloodGlucoseObservations",
  vo2Max = "vo2MaxObservations",

  // HealthKit heart metrics
  restingHeartRate = "restingHeartRateObservations",
  heartRateVariabilitySDNN = "heartRateVariabilitySDNNObservations",
  heartRateRecoveryOneMinute = "heartRateRecoveryOneMinuteObservations",
  atrialFibrillationBurden = "atrialFibrillationBurdenObservations",
  walkingHeartRateAverage = "walkingHeartRateAverageObservations",
  lowHeartRateEvent = "lowHeartRateEventObservations",
  highHeartRateEvent = "highHeartRateEventObservations",
  irregularHeartRhythmEvent = "irregularHeartRhythmEventObservations",

  // HealthKit body measurements
  height = "heightObservations",
  bodyMassIndex = "bodyMassIndexObservations",
  leanBodyMass = "leanBodyMassObservations",
  bodyFatPercentage = "bodyFatPercentageObservations",
  waistCircumference = "waistCircumferenceObservations",

  // HealthKit other measurements
  mindfulSession = "mindfulSessionObservations",
  bloodAlcoholContent = "bloodAlcoholContentObservations",
  dietaryCholesterol = "dietaryCholesterolObservations",
  dietaryVitaminD = "dietaryVitaminDObservations",
  inhalerUsage = "inhalerUsageObservations",

  // HealthKit electrocardiograms
  electrocardiogram = "electrocardiogramObservations",

  // HealthKit workouts
  workout = "workoutObservations",
}

export enum FHIRObservationStatus {
  registered = "registered",
  preliminary = "preliminary",
  final = "final",
  amended = "amended",
  corrected = "corrected",
  cancelled = "cancelled",
  entered_in_error = "entered-in-error",
  unknown = "unknown",
}

export const fhirObservationComponentConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        code: z.lazy(() => fhirCodeableConceptConverter.value.schema),
        valueQuantity: optionalish(
          z.lazy(() => fhirQuantityConverter.value.schema),
        ),
      }),
      encode: (object) => {
        const result: Record<string, unknown> = {
          code: fhirCodeableConceptConverter.value.encode(object.code),
        };

        if (object.valueQuantity) {
          result.valueQuantity = fhirQuantityConverter.value.encode(
            object.valueQuantity,
          );
        }

        return result;
      },
    }),
);

export type FHIRObservationComponent = z.output<
  typeof fhirObservationComponentConverter.value.schema
>;

export const fhirObservationConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: fhirResourceConverter.value.schema
        .extend({
          status: z.nativeEnum(FHIRObservationStatus),
          code: z.lazy(() => fhirCodeableConceptConverter.value.schema),
          subject: z.lazy(() => fhirReferenceConverter.value.schema),
          component: optionalish(
            z
              .lazy(() => fhirObservationComponentConverter.value.schema)
              .array(),
          ),
          valueQuantity: optionalish(
            z.lazy(() => fhirQuantityConverter.value.schema),
          ),
          effectivePeriod: optionalish(
            z.lazy(() => fhirPeriodConverter.value.schema),
          ),
          effectiveDateTime: optionalish(dateConverterISO.schema),
          effectiveInstant: optionalish(dateConverterISO.schema),
          issued: optionalish(dateConverterISO.schema),
          derivedFrom: optionalish(
            z.lazy(() => fhirReferenceConverter.value.schema).array(),
          ),
        })
        .transform((values) => new FHIRObservation(values)),
      encode: (object) => {
        const resourceBase = fhirResourceConverter.value.encode(object);

        const result: Record<string, unknown> = { ...resourceBase };

        result.resourceType = "Observation";
        result.status = object.status;
        result.code = fhirCodeableConceptConverter.value.encode(object.code);
        // Ensure clean subject encoding to prevent field leakage
        result.subject = {
          reference: object.subject.reference,
          ...(object.subject.type !== undefined && {
            type: object.subject.type,
          }),
          ...(object.subject.display !== undefined && {
            display: object.subject.display,
          }),
          ...(object.subject.identifier !== undefined && {
            identifier: object.subject.identifier,
          }),
        };

        // Only include optional fields that have values...
        if (object.component && object.component.length > 0) {
          result.component = object.component.map(
            fhirObservationComponentConverter.value.encode,
          );
        }

        if (object.valueQuantity) {
          result.valueQuantity = fhirQuantityConverter.value.encode(
            object.valueQuantity,
          );
        }

        if (object.issued) {
          result.issued = dateConverterISO.encode(object.issued);
        }

        if (object.derivedFrom && object.derivedFrom.length > 0) {
          result.derivedFrom = object.derivedFrom.map((ref) => {
            // Create an explicitly clean reference object to prevent any field leakage
            const cleanRef: Record<string, unknown> = {
              reference: ref.reference,
            };
            if (ref.type !== undefined) cleanRef.type = ref.type;
            if (ref.display !== undefined) cleanRef.display = ref.display;
            if (ref.identifier !== undefined)
              cleanRef.identifier = ref.identifier;
            return cleanRef;
          });
        }

        // and only include one of the mutually exclusive effective fields
        if (object.effectivePeriod) {
          result.effectivePeriod = fhirPeriodConverter.value.encode(
            object.effectivePeriod,
          );
        } else if (object.effectiveDateTime) {
          result.effectiveDateTime = dateConverterISO.encode(
            object.effectiveDateTime,
          );
        } else if (object.effectiveInstant) {
          result.effectiveInstant = dateConverterISO.encode(
            object.effectiveInstant,
          );
        }

        return result;
      },
    }),
);

export class FHIRObservation extends FHIRResource {
  // Static Functions

  private static readonly loincDisplay = new Map<LoincCode, string>([
    // Existing LOINC codes
    [
      LoincCode.bloodPressure,
      "Blood pressure panel with all children optional",
    ],
    [LoincCode.systolicBloodPressure, "Systolic blood pressure"],
    [LoincCode.diastolicBloodPressure, "Diastolic blood pressure"],
    [LoincCode.bodyWeight, "Body weight"],
    [LoincCode.creatinine, "Creatinine [Mass/volume] in Serum or Plasma"],
    [
      LoincCode.estimatedGlomerularFiltrationRate,
      "Glomerular filtration rate/1.73 sq M.predicted [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI 2021)",
    ],
    [LoincCode.heartRate, "Heart rate"],
    [LoincCode.potassium, "Potassium [Moles/volume] in Blood"],

    // HealthKit mobility metrics
    [LoincCode.flightsClimbed, "Stairs climbed"],
    [LoincCode.stepCount, "Step count"],
    [LoincCode.distanceWalkingRunning, "Distance walked/run"],
    [LoincCode.distanceCycling, "Distance cycled"],
    [LoincCode.distanceWheelchair, "Wheelchair distance"],
    [LoincCode.distanceSwimming, "Swimming distance"],
    [LoincCode.walkingSpeed, "Walking speed"],
    [LoincCode.walkingStepLength, "Step length"],
    [LoincCode.walkingAsymmetryPercentage, "Walking asymmetry percentage"],
    [LoincCode.walkingDoubleSupportPercentage, "Double support percentage"],
    [LoincCode.stairAscentSpeed, "Stair ascent speed"],
    [LoincCode.stairDescentSpeed, "Stair descent speed"],
    [LoincCode.walkingSteadiness, "Walking steadiness"],
    [LoincCode.walkingSteadinessEvent, "Walking steadiness event"],
    [LoincCode.sixMinuteWalkTestDistance, "Six-minute walk test distance"],

    // HealthKit activity metrics
    [LoincCode.appleExerciseTime, "Exercise time"],
    [LoincCode.appleMoveTime, "Move time"],
    [LoincCode.appleStandTime, "Stand time"],
    [LoincCode.appleStandHour, "Stand hour"],

    // HealthKit vital signs
    [LoincCode.oxygenSaturation, "Oxygen saturation"],
    [LoincCode.bodyTemperature, "Body temperature"],
    [LoincCode.respiratoryRate, "Respiratory rate"],
    [LoincCode.basalBodyTemperature, "Basal body temperature"],
    [LoincCode.bloodGlucose, "Blood glucose"],
    [LoincCode.vo2Max, "VO2 max"],

    // HealthKit heart metrics
    [LoincCode.restingHeartRate, "Resting heart rate"],
    [LoincCode.heartRateVariabilitySDNN, "Heart rate variability SDNN"],
    [LoincCode.heartRateRecoveryOneMinute, "Heart rate recovery (1 min)"],
    [LoincCode.atrialFibrillationBurden, "Atrial fibrillation burden"],
    [LoincCode.walkingHeartRateAverage, "Walking heart rate average"],
    [LoincCode.lowHeartRateEvent, "Low heart rate event"],
    [LoincCode.highHeartRateEvent, "High heart rate event"],
    [LoincCode.irregularHeartRhythmEvent, "Irregular heart rhythm event"],

    // HealthKit body measurements
    [LoincCode.height, "Body height"],
    [LoincCode.bodyMassIndex, "Body mass index"],
    [LoincCode.leanBodyMass, "Lean body mass"],
    [LoincCode.bodyFatPercentage, "Body fat percentage"],
    [LoincCode.waistCircumference, "Waist circumference"],

    // HealthKit other measurements
    [LoincCode.mindfulSession, "Mindful session"],
    [LoincCode.bloodAlcoholContent, "Blood alcohol content"],
    [LoincCode.dietaryCholesterol, "Dietary cholesterol"],
    [LoincCode.dietaryVitaminD, "Dietary vitamin D"],
    [LoincCode.inhalerUsage, "Inhaler usage"],

    // HealthKit electrocardiograms and workouts
    [LoincCode.electrocardiogram, "Electrocardiogram"],
    [LoincCode.workout, "Workout"],
  ]);

  static createSimple(input: {
    id: string;
    date: Date;
    value: number;
    unit: QuantityUnit;
    code: LoincCode;
    subject: FHIRReference;
  }): FHIRObservation {
    return new FHIRObservation({
      id: input.id,
      status: FHIRObservationStatus.final,
      subject: input.subject,
      code: {
        text: this.loincDisplay.get(input.code) ?? undefined,
        coding: [
          {
            system: CodingSystem.loinc,
            code: input.code,
            display: this.loincDisplay.get(input.code) ?? undefined,
          },
        ],
      },
      valueQuantity: {
        value: input.value,
        unit: input.unit.unit,
        system: input.unit.system,
        code: input.unit.code,
      },
      effectiveDateTime: input.date,
    });
  }

  // Stored Properties

  readonly resourceType: string = "Observation";
  readonly status: FHIRObservationStatus;
  readonly code: FHIRCodeableConcept;
  readonly subject: FHIRReference;
  readonly component?: FHIRObservationComponent[];
  readonly valueQuantity?: FHIRQuantity;
  readonly effectivePeriod?: FHIRPeriod;
  readonly effectiveDateTime?: Date;
  readonly effectiveInstant?: Date;
  readonly issued?: Date;
  readonly derivedFrom?: FHIRReference[];

  // Computed Properties

  get systolicBloodPressure(): Observation | undefined {
    return this.observations({
      code: LoincCode.bloodPressure,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mmHg,
      component: {
        code: LoincCode.systolicBloodPressure,
        system: CodingSystem.loinc,
      },
    }).at(0);
  }

  get diastolicBloodPressure(): Observation | undefined {
    return this.observations({
      code: LoincCode.bloodPressure,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mmHg,
      component: {
        code: LoincCode.diastolicBloodPressure,
        system: CodingSystem.loinc,
      },
    }).at(0);
  }

  bodyWeight(unit: QuantityUnit): Observation | undefined {
    return this.observations({
      code: LoincCode.bodyWeight,
      system: CodingSystem.loinc,
      unit: unit,
    }).at(0);
  }

  get creatinine(): Observation | undefined {
    return this.observations({
      code: LoincCode.creatinine,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mg_dL,
    }).at(0);
  }

  get estimatedGlomerularFiltrationRate(): Observation | undefined {
    return this.observations({
      code: LoincCode.estimatedGlomerularFiltrationRate,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mL_min_173m2,
    }).at(0);
  }

  get heartRate(): Observation | undefined {
    return this.observations({
      code: LoincCode.heartRate,
      system: CodingSystem.loinc,
      unit: QuantityUnit.bpm,
    }).at(0);
  }

  get potassium(): Observation | undefined {
    return this.observations({
      code: LoincCode.potassium,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mEq_L,
    }).at(0);
  }

  // HealthKit mobility metrics

  get flightsClimbed(): Observation | undefined {
    return this.observations({
      code: LoincCode.flightsClimbed,
      system: CodingSystem.loinc,
      unit: QuantityUnit.flights,
    }).at(0);
  }

  get stepCount(): Observation | undefined {
    return this.observations({
      code: LoincCode.stepCount,
      system: CodingSystem.loinc,
      unit: QuantityUnit.steps,
    }).at(0);
  }

  get distanceWalkingRunning(): Observation | undefined {
    return this.observations({
      code: LoincCode.distanceWalkingRunning,
      system: CodingSystem.loinc,
      unit: QuantityUnit.meters,
    }).at(0);
  }

  get distanceCycling(): Observation | undefined {
    return this.observations({
      code: LoincCode.distanceCycling,
      system: CodingSystem.loinc,
      unit: QuantityUnit.meters,
    }).at(0);
  }

  get distanceWheelchair(): Observation | undefined {
    return this.observations({
      code: LoincCode.distanceWheelchair,
      system: CodingSystem.loinc,
      unit: QuantityUnit.meters,
    }).at(0);
  }

  get distanceSwimming(): Observation | undefined {
    return this.observations({
      code: LoincCode.distanceSwimming,
      system: CodingSystem.loinc,
      unit: QuantityUnit.meters,
    }).at(0);
  }

  get walkingSpeed(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingSpeed,
      system: CodingSystem.loinc,
      unit: QuantityUnit.m_s,
    }).at(0);
  }

  get walkingStepLength(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingStepLength,
      system: CodingSystem.loinc,
      unit: QuantityUnit.cm,
    }).at(0);
  }

  get walkingAsymmetryPercentage(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingAsymmetryPercentage,
      system: CodingSystem.loinc,
      unit: QuantityUnit.percent,
    }).at(0);
  }

  get walkingDoubleSupportPercentage(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingDoubleSupportPercentage,
      system: CodingSystem.loinc,
      unit: QuantityUnit.percent,
    }).at(0);
  }

  get stairAscentSpeed(): Observation | undefined {
    return this.observations({
      code: LoincCode.stairAscentSpeed,
      system: CodingSystem.loinc,
      unit: QuantityUnit.m_s,
    }).at(0);
  }

  get stairDescentSpeed(): Observation | undefined {
    return this.observations({
      code: LoincCode.stairDescentSpeed,
      system: CodingSystem.loinc,
      unit: QuantityUnit.m_s,
    }).at(0);
  }

  get walkingSteadiness(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingSteadiness,
      system: CodingSystem.loinc,
      unit: QuantityUnit.percent,
    }).at(0);
  }

  get sixMinuteWalkTestDistance(): Observation | undefined {
    return this.observations({
      code: LoincCode.sixMinuteWalkTestDistance,
      system: CodingSystem.loinc,
      unit: QuantityUnit.meters,
    }).at(0);
  }

  // HealthKit activity metrics

  get appleExerciseTime(): Observation | undefined {
    return this.observations({
      code: LoincCode.appleExerciseTime,
      system: CodingSystem.loinc,
      unit: QuantityUnit.minutes,
    }).at(0);
  }

  get appleMoveTime(): Observation | undefined {
    return this.observations({
      code: LoincCode.appleMoveTime,
      system: CodingSystem.loinc,
      unit: QuantityUnit.minutes,
    }).at(0);
  }

  get appleStandTime(): Observation | undefined {
    return this.observations({
      code: LoincCode.appleStandTime,
      system: CodingSystem.loinc,
      unit: QuantityUnit.hours,
    }).at(0);
  }

  // HealthKit vital signs

  get oxygenSaturation(): Observation | undefined {
    return this.observations({
      code: LoincCode.oxygenSaturation,
      system: CodingSystem.loinc,
      unit: QuantityUnit.percent,
    }).at(0);
  }

  get bodyTemperature(): Observation | undefined {
    return this.observations({
      code: LoincCode.bodyTemperature,
      system: CodingSystem.loinc,
      unit: QuantityUnit.celsius,
    }).at(0);
  }

  get respiratoryRate(): Observation | undefined {
    return this.observations({
      code: LoincCode.respiratoryRate,
      system: CodingSystem.loinc,
      unit: QuantityUnit.resp_min,
    }).at(0);
  }

  get bloodGlucose(): Observation | undefined {
    return this.observations({
      code: LoincCode.bloodGlucose,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mg_dL_glu,
    }).at(0);
  }

  get vo2Max(): Observation | undefined {
    return this.observations({
      code: LoincCode.vo2Max,
      system: CodingSystem.loinc,
      unit: QuantityUnit.mL_kg_min,
    }).at(0);
  }

  // HealthKit heart metrics

  get restingHeartRate(): Observation | undefined {
    return this.observations({
      code: LoincCode.restingHeartRate,
      system: CodingSystem.loinc,
      unit: QuantityUnit.bpm,
    }).at(0);
  }

  get heartRateVariabilitySDNN(): Observation | undefined {
    return this.observations({
      code: LoincCode.heartRateVariabilitySDNN,
      system: CodingSystem.loinc,
      unit: QuantityUnit.bpm,
    }).at(0);
  }

  get walkingHeartRateAverage(): Observation | undefined {
    return this.observations({
      code: LoincCode.walkingHeartRateAverage,
      system: CodingSystem.loinc,
      unit: QuantityUnit.bpm,
    }).at(0);
  }

  // HealthKit body measurements

  get height(): Observation | undefined {
    return this.observations({
      code: LoincCode.height,
      system: CodingSystem.loinc,
      unit: QuantityUnit.cm_height,
    }).at(0);
  }

  get bodyMassIndex(): Observation | undefined {
    return this.observations({
      code: LoincCode.bodyMassIndex,
      system: CodingSystem.loinc,
      unit: QuantityUnit.kg_m2,
    }).at(0);
  }

  get leanBodyMass(): Observation | undefined {
    return this.observations({
      code: LoincCode.leanBodyMass,
      system: CodingSystem.loinc,
      unit: QuantityUnit.kg,
    }).at(0);
  }

  get bodyFatPercentage(): Observation | undefined {
    return this.observations({
      code: LoincCode.bodyFatPercentage,
      system: CodingSystem.loinc,
      unit: QuantityUnit.percent,
    }).at(0);
  }

  get waistCircumference(): Observation | undefined {
    return this.observations({
      code: LoincCode.waistCircumference,
      system: CodingSystem.loinc,
      unit: QuantityUnit.cm,
    }).at(0);
  }

  // Constructor

  constructor(
    input: FHIRResourceInput & {
      status: FHIRObservationStatus;
      code: FHIRCodeableConcept;
      subject: FHIRReference;
      component?: FHIRObservationComponent[];
      valueQuantity?: FHIRQuantity;
      effectivePeriod?: FHIRPeriod;
      effectiveDateTime?: Date;
      effectiveInstant?: Date;
      issued?: Date;
      derivedFrom?: FHIRReference[];
    },
  ) {
    super(input);
    this.status = input.status;
    this.code = input.code;
    this.subject = input.subject;
    this.component = input.component;
    this.valueQuantity = input.valueQuantity;
    this.effectivePeriod = input.effectivePeriod;
    this.effectiveDateTime = input.effectiveDateTime;
    this.effectiveInstant = input.effectiveInstant;
    this.issued = input.issued;
    this.derivedFrom = input.derivedFrom;
  }

  // Methods

  private observations(
    options: {
      unit: QuantityUnit;
      component?: FHIRCoding;
    } & FHIRCoding,
  ): Observation[] {
    const result: Observation[] = [];
    if (!this.containsCoding(this.code, [options])) return result;
    const date =
      this.effectiveDateTime ??
      this.effectiveInstant ??
      this.effectivePeriod?.start ??
      this.effectivePeriod?.end;
    if (!date) return result;

    if (options.component) {
      for (const component of this.component ?? []) {
        if (!this.containsCoding(component.code, [options.component])) continue;
        const value = options.unit.valueOf(component.valueQuantity);
        if (!value) continue;
        result.push({
          date: date,
          value: value,
          unit: options.unit,
        });
      }
    } else {
      const value = options.unit.valueOf(this.valueQuantity);
      if (!value) return result;
      result.push({ date: date, value: value, unit: options.unit });
    }
    return result;
  }
}
