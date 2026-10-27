// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { CodingSystem } from "./codes.js";
import { type FHIRCoding } from "../fhir/baseTypes/fhirCoding.js";

export enum MhcSampleTypeCode {
  bloodLipidMeasurement = "MHCCustomSampleTypeBloodLipidMeasurement",
  dietMEPAScore = "MHCCustomSampleTypeDietMEPAScore",
  nicotineExposure = "MHCCustomSampleTypeNicotineExposure",
  who5Score = "MHCCustomSampleTypeWHO5Score",
}

const mhcSampleTypeSystems = [
  CodingSystem.mhcSampleType,
  CodingSystem.mhcSampleTypeSuperseded,
];

export const mhcSampleTypeCollection = (code: MhcSampleTypeCode): string =>
  `HealthObservations_${code}`;

export const mhcSampleTypeCodings = (
  code: MhcSampleTypeCode,
  display: string,
): FHIRCoding[] =>
  mhcSampleTypeSystems.map((system) => ({ code, display, system }));
