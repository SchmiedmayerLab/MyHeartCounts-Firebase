<!--
This source file is part of the My Heart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# Data Type Routing Design Doc

## Routing Rule

**Firestore (uncompressed FHIR documents):** everything the in-app dashboard displays, plus everything a Cloud Function reads or triggers on. The dashboard reads all its metrics directly from Firestore.
**Storage bucket (zstd-compressed):** everything else, plus the 10-year historical backfill of all types.

## 1. Firestore

| Data | Collections | Reason |
|---|---|---|
| Custom scores: DietMEPAScore, WHO5Score, BloodLipidMeasurement, NicotineExposure | `HealthObservations_MHCCustomSampleType*` | Written by scoring functions, displayed on dashboard |
| Dashboard HealthKit metrics (live samples): stepCount, appleExerciseTime, bodyMass, bodyMassIndex, height, bloodGlucose, bloodPressure, sleepAnalysis | `HealthObservations_{HK identifier}` | Displayed on dashboard |
| Timed walking test (6-min walk, 12-min run) | `HealthObservations_MHCHealthObservationTimedWalkingTestResultIdentifier` | "Past Tests" view |
| Questionnaire responses (all 14: ActivityFitness, Chronotype, Diet, DiseaseQOL, ExerciseAdequacy, ExerciseProcessMindset, Fatigue, GAD7, HeartRisk, Info, NicotineExposure, ParQ, SUS, WHO5) | `users/{uid}/questionnaireResponses/{id}` | Scoring function triggers on document write |
| SensorKit pointer docs | `HealthObservations_{sensorId}/{name}` + `{name}_Ref` | Small index pointing at bucket payloads |

Any metric added to the dashboard later moves its type from the bucket to Firestore.

## 2. Storage bucket

**HealthKit quantity types (36):** activeEnergyBurned, basalEnergyBurned, flightsClimbed, appleMoveTime, appleStandTime, distanceWalkingRunning, distanceCycling, distanceWheelchair, distanceSwimming, appleWalkingSteadiness, sixMinuteWalkTestDistance, vo2Max, walkingSpeed, walkingStepLength, walkingAsymmetryPercentage, walkingDoubleSupportPercentage, stairAscentSpeed, stairDescentSpeed, numberOfTimesFallen, heartRate, restingHeartRate, heartRateVariabilitySDNN, heartRateRecoveryOneMinute, atrialFibrillationBurden, walkingHeartRateAverage, bloodOxygen, bodyTemperature, respiratoryRate, basalBodyTemperature, bloodAlcoholContent, dietaryCholesterol, dietaryVitaminD, inhalerUsage, leanBodyMass, bodyFatPercentage, waistCircumference

**HealthKit category types (19):** appleStandHour, appleWalkingSteadinessEvent, lowHeartRateEvent, highHeartRateEvent, irregularHeartRhythmEvent, mindfulSession, menstrualFlow, intermenstrualBleeding, infrequentMenstrualCycles, irregularMenstrualCycles, persistentIntermenstrualBleeding, prolongedMenstrualPeriods, cervicalMucusQuality, ovulationTestResult, progesteroneTestResult, contraceptive, pregnancy, pregnancyTestResult, lactation

**HealthKit other:** workout, electrocardiogram, stateOfMind, gad7 (the HK scored assessment; the GAD7 questionnaire response goes to Firestore), clinical records (all 9 optional EHR types, see note 2)

**Historical backfill:** `historicalHealthSamples/` stays bucket-only for all types, including the dashboard metrics. Firestore holds live samples only.

**SensorKit raw streams (11):** accelerometer, ambientLightSensor, ambientPressure, heartRate, pedometerData, wristTemperature (CSV, zstd); deviceUsageReport, electrocardiogram, onWristState, visits (JSON, zstd); photoplethysmogram (binary .mhcPPG, currently uncompressed)

## 3. Required changes and notes

1. **App:** the dashboard tiles for the 8 HealthKit metrics currently query HealthKit locally (`CVHScore.swift:56-88`); they switch to `MHCFirestoreQuery`, and the client upload strategy for those types changes from queueLocally (bucket) to directFirestore.
2. **Clinical records:** bulk import currently writes them to Firestore (`HealthKitSamplesFHIRUploader.swift:29-31`). Nothing reads them and they are out of export scope; route to bucket or pause collection.
3. **Cost watch:** stepCount, sleepAnalysis, and appleExerciseTime are the highest-frequency types; storing them as individual Firestore docs partially reverses the cost decision that disabled the ingest trigger. Fallback if write costs spike: store daily aggregates in Firestore for display, raw samples in the bucket.
4. **Export:** the dashboard types now exist in both Firestore and the bucket (backfill); the export pipeline's dedup (HK UUID, firestore > bucket precedence) already handles this.
