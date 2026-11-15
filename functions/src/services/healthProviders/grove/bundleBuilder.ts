// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Turns adapter {@link RecordDraft}s into Grove FHIR 0.8.0 exchange Bundles
 * (`grove-mobile-exchange-bundle`): one conversion Provenance per source
 * record (`providers-conversion-provenance`), provider Observations claiming
 * exactly their semantic profile plus the vendor envelope, provider recording
 * DocumentReferences for raw payloads, and one application Device snapshot for
 * this backend as the assembler.
 */

import { createHash } from "crypto";
import {
  type Coding,
  GroveUrl,
  groveMeasurement,
  type GroveMeasurement,
  groveProviderCode,
  type MhcMeasurement,
  MhcUrl,
  OUTSIDE_CATALOG_TAG,
  providerScopeMode,
  vendorEnvelopeProfile,
} from "./constants.js";
import {
  type ObservationDraft,
  type ObservationRecordDraft,
  outputKey,
  type RecordDraft,
  type RecordingRecordDraft,
} from "./drafts.js";
import {
  deriveIdentityValue,
  deviceContentDigest,
  entryFullUrl,
  type GroveIdentifier,
  type GroveIdentityKey,
  identitySystem,
  providerAccountPseudonym,
  recordContentDigest,
  typedIdentifier,
} from "./identity.js";
import {
  isAdmittedMeasurement,
  isAdmittedRecording,
} from "./providerCatalog.js";
import { type GroveEffective } from "./time.js";
import { type HealthProviderId } from "../../../models/index.js";

type Json = Record<string, unknown>;

export interface BuiltBundle {
  /** Bare source type all records of this bundle share (used in file names). */
  sourceType: string;
  bundle: Json;
  /** Provenance fullUrls (one per record), used for the deterministic file name. */
  provenanceFullUrls: string[];
  recordCount: number;
}

export interface BuildBundlesParams {
  provider: HealthProviderId;
  userId: string;
  providerUserId: string;
  key: GroveIdentityKey;
  records: RecordDraft[];
  /** Conversion time (`Provenance.recorded`, `DocumentReference.date`). */
  recordedAt: Date;
  /** Packing time (`Bundle.timestamp`). */
  packedAt?: Date;
  applicationVersion: string;
  /** Bundles never exceed this many records (matches the iOS uploader). */
  maxRecordsPerBundle?: number;
  /**
   * Split bundles by source type (the default, matching the per-type Storage
   * file names). `false` packs every record into the same bundle(s); the
   * `sourceType` of such a bundle is `mixed`.
   */
  groupBySourceType?: boolean;
}

const roleCoding = (code: string) => ({
  coding: [{ system: GroveUrl.identifierRole, code }],
});

const entryKey = (identifier: GroveIdentifier): Json => ({
  url: GroveUrl.entryKeyExtension,
  valueIdentifier: identifier,
});

const timezoneExtension = (timezone: string | undefined) =>
  timezone === undefined ? undefined : (
    { extension: [{ url: GroveUrl.timezoneExtension, valueCode: timezone }] }
  );

const effectiveElements = (effective: GroveEffective): Json =>
  effective.kind === "instant" ?
    {
      effectiveDateTime: effective.value,
      _effectiveDateTime: timezoneExtension(effective.timezone),
    }
  : {
      effectivePeriod: {
        start: effective.start,
        _start: timezoneExtension(effective.timezone),
        end: effective.end,
        _end: timezoneExtension(effective.timezone),
      },
    };

const occurredElements = (effective: GroveEffective): Json =>
  effective.kind === "instant" ?
    { occurredDateTime: effective.value }
  : { occurredPeriod: { start: effective.start, end: effective.end } };

const fhirInstant = (date: Date): string => date.toISOString();

/** Drop `undefined` members recursively so stored JSON equals the digested JSON. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isGroveMeasurement = (
  measurement: string | MhcMeasurement,
): measurement is string => typeof measurement === "string";

const effectiveIsAllowed = (
  measurement: GroveMeasurement,
  effective: GroveEffective,
): boolean =>
  measurement.effective === "dateTime-or-Period" ||
  (measurement.effective === "dateTime") === (effective.kind === "instant");

/** Value-domain rules the profiles enforce; violating outputs are dropped (fail closed). */
const valueIsAllowed = (
  measurement: GroveMeasurement,
  draft: ObservationDraft,
): boolean => {
  if (draft.value === undefined || !("quantity" in draft.value)) return true;
  const value = draft.value.quantity;
  if (!Number.isFinite(value)) return false;
  if (
    measurement.integerOnly === true &&
    (!Number.isInteger(value) || value < 0)
  ) {
    return false;
  }
  if (measurement.unit?.code === "%" && (value < 0 || value > 100))
    return false;
  return true;
};

const observationValue = (
  draft: ObservationDraft,
  fallbackUnit: { code: string; unit: string } | undefined,
): Json => {
  const value = draft.value;
  if (value === undefined) return {};
  if ("quantity" in value) {
    const quantityUnit = value.unit ?? fallbackUnit;
    return {
      valueQuantity: {
        value: value.quantity,
        unit: quantityUnit?.unit,
        system: quantityUnit ? GroveUrl.ucum : undefined,
        code: quantityUnit?.code,
      },
    };
  }
  if ("concept" in value) {
    return {
      valueCodeableConcept: { coding: value.concept, text: value.text },
    };
  }
  return { valueString: value.text };
};

class RecordContext {
  readonly sourceRecord: GroveIdentifier;
  private readonly scope: { system: string; value: string };
  private readonly providerCode: string;

  constructor(
    private readonly params: BuildBundlesParams,
    readonly record: RecordDraft,
  ) {
    this.providerCode = groveProviderCode[params.provider];
    this.scope =
      providerScopeMode[params.provider] === "global" ?
        {
          system: MhcUrl.providerKeySpace,
          value: `${this.providerCode}-document-id-global`,
        }
      : {
          system: MhcUrl.providerAccount(this.providerCode),
          value: providerAccountPseudonym(
            params.key,
            this.providerCode,
            params.providerUserId,
          ),
        };
    this.sourceRecord = typedIdentifier(params.key, "provider-record", [
      this.providerCode,
      record.sourceType,
      this.scope.system,
      this.scope.value,
      record.nativeRecordId,
    ]);
  }

  sourceOutput(role: string, discriminator: string): GroveIdentifier {
    return typedIdentifier(this.params.key, "provider-output", [
      this.providerCode,
      this.record.sourceType,
      this.scope.system,
      this.scope.value,
      this.record.nativeRecordId,
      role,
      discriminator,
    ]);
  }

  sourceArtifact(): GroveIdentifier {
    return typedIdentifier(this.params.key, "provider-artifact", [
      this.providerCode,
      this.record.sourceType,
      this.scope.system,
      this.scope.value,
      this.record.nativeRecordId,
      "provider-recording",
      "0",
    ]);
  }

  providerExtensions(): Json[] {
    return [
      { url: GroveUrl.providerExtension, valueCode: this.providerCode },
      {
        url: GroveUrl.providerSourceTypeExtension,
        valueCode: `${this.providerCode}/${this.record.sourceType}`,
      },
    ];
  }
}

const subjectReference = (userId: string): Json => ({
  type: "Patient",
  identifier: { system: MhcUrl.participant, value: userId },
});

interface BuiltEntry {
  fullUrl: string;
  key: GroveIdentifier;
  resource: Json;
}

const buildObservations = (
  params: BuildBundlesParams,
  context: RecordContext,
  record: ObservationRecordDraft,
): BuiltEntry[] => {
  const envelope = vendorEnvelopeProfile[params.provider];
  const prepared = record.outputs.flatMap((draft) => {
    const grove = isGroveMeasurement(draft.measurement);
    const measurement =
      grove ? groveMeasurement(draft.measurement as string) : undefined;
    if (measurement !== undefined) {
      if (!effectiveIsAllowed(measurement, draft.effective)) return [];
      if (!valueIsAllowed(measurement, draft)) return [];
    }
    const role =
      grove ?
        (draft.measurement as string)
      : (draft.measurement as MhcMeasurement).code;
    const discriminator = draft.discriminator ?? "single";
    const sourceOutput = context.sourceOutput(role, discriminator);
    return [
      {
        draft,
        measurement,
        role,
        discriminator,
        sourceOutput,
        fullUrl: entryFullUrl(sourceOutput.system, sourceOutput.value),
      },
    ];
  });

  const fullUrlByKey = new Map(
    prepared.map((item) => [
      outputKey(item.role, item.discriminator),
      item.fullUrl,
    ]),
  );

  return prepared.map(({ draft, measurement, role, sourceOutput, fullUrl }) => {
    const mhc =
      measurement === undefined ?
        (draft.measurement as MhcMeasurement)
      : undefined;
    const admitted =
      measurement !== undefined &&
      draft.outsideCatalog !== true &&
      isAdmittedMeasurement(params.provider, record.sourceType, role);
    const code: Coding = measurement?.code ?? {
      system: MhcUrl.providerMeasurement,
      code: mhc?.code ?? role,
      display: mhc?.display,
    };
    const categoryCode = measurement?.category ?? mhc?.category;
    const method = draft.method ?? measurement?.method;
    const extensions = [...context.providerExtensions()];
    if (draft.recordingMethod !== undefined) {
      extensions.push({
        url: GroveUrl.recordingMethodExtension,
        valueCoding: {
          system: GroveUrl.recordingMethodSystem,
          code: draft.recordingMethod,
        },
      });
    }
    const hasMember = (draft.hasMember ?? [])
      .map((key) => fullUrlByKey.get(key))
      .filter((reference): reference is string => reference !== undefined)
      .map((reference) => ({ reference }));

    const resource: Json = clean({
      resourceType: "Observation",
      meta: {
        profile: measurement ? [measurement.profile, envelope] : [envelope],
        tag: admitted ? undefined : [OUTSIDE_CATALOG_TAG],
      },
      extension: extensions,
      identifier: [context.sourceRecord, sourceOutput],
      status: "final",
      category:
        categoryCode ?
          [
            {
              coding: [
                {
                  system: GroveUrl.observationCategory,
                  code: categoryCode,
                  display:
                    categoryCode === "vital-signs" ? "Vital Signs" : "Activity",
                },
              ],
            },
          ]
        : undefined,
      code: { coding: [code], text: code.display },
      subject: subjectReference(params.userId),
      ...effectiveElements(draft.effective),
      ...observationValue(draft, measurement?.unit ?? mhc?.unit),
      method:
        method ?
          { coding: [{ system: GroveUrl.aggregationMethod, code: method }] }
        : undefined,
      component: draft.components?.map((component) => ({
        code: { coding: [component.code] },
        ...("quantity" in component.value ?
          {
            valueQuantity: {
              value: component.value.quantity,
              unit: component.value.unit.unit,
              system: GroveUrl.ucum,
              code: component.value.unit.code,
            },
          }
        : {
            valueCodeableConcept: {
              coding: component.value.concept,
              text: component.value.text,
            },
          }),
      })),
      hasMember: hasMember.length > 0 ? hasMember : undefined,
    });
    return { fullUrl, key: sourceOutput, resource };
  });
};

const buildRecordingDocument = (
  params: BuildBundlesParams,
  context: RecordContext,
  record: RecordingRecordDraft,
  applicationFullUrl: string,
): BuiltEntry => {
  const sourceOutput = context.sourceOutput("native-recording", "single");
  const admitted = isAdmittedRecording(params.provider, record.sourceType);
  const resource = clean({
    resourceType: "DocumentReference",
    meta: {
      profile: [
        GroveUrl.sensorRecordingDocumentProfile,
        GroveUrl.providerRecordingDocumentProfile,
      ],
      tag: admitted ? undefined : [OUTSIDE_CATALOG_TAG],
    },
    extension: context.providerExtensions(),
    identifier: [context.sourceRecord, sourceOutput, context.sourceArtifact()],
    status: "current",
    type: { text: record.typeText },
    subject: subjectReference(params.userId),
    date: fhirInstant(params.recordedAt),
    author: [{ reference: applicationFullUrl }],
    content: [
      {
        attachment: {
          // The object at `url` is the zstd-compressed form of these JSON bytes;
          // size and hash describe the uncompressed payload.
          contentType: "application/json",
          url: record.url,
          size: record.payload.length,
          hash: createHash("sha1").update(record.payload).digest("base64"),
          title: "Provider recording (stored zstd-compressed)",
        },
        format: {
          system: GroveUrl.recordingFormat,
          code: "provider-recording",
          display: "Provider Recording",
        },
      },
    ],
  });
  return {
    fullUrl: entryFullUrl(sourceOutput.system, sourceOutput.value),
    key: sourceOutput,
    resource,
  };
};

const buildProvenance = (
  params: BuildBundlesParams,
  context: RecordContext,
  outputs: BuiltEntry[],
  applicationFullUrl: string,
): BuiltEntry => {
  const body: Json = clean({
    resourceType: "Provenance",
    meta: { profile: [GroveUrl.providerConversionProvenanceProfile] },
    target: outputs.map((output) => ({ reference: output.fullUrl })),
    ...occurredElements(context.record.occurred),
    recorded: fhirInstant(params.recordedAt),
    activity: {
      coding: [{ system: GroveUrl.isoLifecycle, code: "transform" }],
    },
    agent: [
      {
        type: {
          coding: [
            { system: GroveUrl.provenanceParticipantType, code: "assembler" },
          ],
        },
        who: { reference: applicationFullUrl },
      },
    ],
    entity: [
      {
        role: "source",
        what: {
          identifier: context.sourceRecord,
        },
      },
    ],
  });
  const digest = recordContentDigest(
    body,
    outputs.map((output) => output.resource),
  );
  const recordVersion: GroveIdentifier = {
    type: roleCoding("record-version"),
    system: identitySystem(params.key, "record-version"),
    value: deriveIdentityValue(params.key, "record-version", [
      context.sourceRecord.system,
      context.sourceRecord.value,
      digest,
    ]),
  };
  const resource = {
    ...body,
    extension: [
      { url: GroveUrl.recordVersionExtension, valueIdentifier: recordVersion },
    ],
  };
  return {
    fullUrl: entryFullUrl(recordVersion.system, recordVersion.value),
    key: recordVersion,
    resource,
  };
};

/** The backend's application Device snapshot (`grove-application-device`). */
export const buildApplicationDevice = (
  key: GroveIdentityKey,
  userId: string,
  applicationVersion: string,
): BuiltEntry => {
  const content: Json = {
    resourceType: "Device",
    meta: { profile: [GroveUrl.applicationDeviceProfile] },
    status: "active",
    deviceName: [
      { name: "MyHeart Counts Firebase", type: "user-friendly-name" },
    ],
    version: [
      {
        type: { coding: [{ system: GroveUrl.mdc, code: "531975" }] },
        value: applicationVersion,
      },
    ],
  };
  const identifier: GroveIdentifier = {
    type: roleCoding("device-snapshot"),
    system: identitySystem(key, "device-snapshot"),
    value: deriveIdentityValue(key, "device-snapshot", [
      MhcUrl.participant,
      userId,
      "application",
      deviceContentDigest(content),
    ]),
  };
  return {
    fullUrl: entryFullUrl(identifier.system, identifier.value),
    key: identifier,
    resource: { ...content, identifier: [identifier] },
  };
};

const toEntry = (entry: BuiltEntry): Json => ({
  fullUrl: entry.fullUrl,
  extension: [entryKey(entry.key)],
  resource: entry.resource,
});

/** Build the resources of one record; empty when every output was dropped. */
const buildRecord = (
  params: BuildBundlesParams,
  record: RecordDraft,
  applicationFullUrl: string,
): { outputs: BuiltEntry[]; provenance: BuiltEntry } | undefined => {
  const context = new RecordContext(params, record);
  const outputs =
    record.kind === "observations" ?
      buildObservations(params, context, record)
    : [buildRecordingDocument(params, context, record, applicationFullUrl)];
  if (outputs.length === 0) return undefined;
  // One record per source record: a repeated record (e.g. the same Withings
  // grpid seen twice in one window) would collide on fullUrl, so keep the last.
  return {
    outputs,
    provenance: buildProvenance(params, context, outputs, applicationFullUrl),
  };
};

/**
 * Build Grove exchange Bundles for one provider sync, grouped by source type
 * and chunked to at most `maxRecordsPerBundle` records each.
 */
export const buildExchangeBundles = (
  params: BuildBundlesParams,
): BuiltBundle[] => {
  const maxRecords = params.maxRecordsPerBundle ?? 2000;
  const application = buildApplicationDevice(
    params.key,
    params.userId,
    params.applicationVersion,
  );

  // Deduplicate records by (sourceType, nativeRecordId); the last one wins.
  const unique = new Map<string, RecordDraft>();
  for (const record of params.records) {
    unique.set(`${record.sourceType}\u0000${record.nativeRecordId}`, record);
  }

  const bySourceType = new Map<string, RecordDraft[]>();
  for (const record of Array.from(unique.values())) {
    const group =
      params.groupBySourceType === false ? "mixed" : record.sourceType;
    const list = bySourceType.get(group) ?? [];
    list.push(record);
    bySourceType.set(group, list);
  }

  const bundles: BuiltBundle[] = [];
  for (const [sourceType, records] of Array.from(bySourceType.entries())) {
    for (let offset = 0; offset < records.length; offset += maxRecords) {
      const built = records
        .slice(offset, offset + maxRecords)
        .map((record) => buildRecord(params, record, application.fullUrl))
        .filter((value) => value !== undefined);
      if (built.length === 0) continue;
      const entries = [
        toEntry(application),
        ...built.flatMap(({ outputs, provenance }) => [
          ...outputs.map(toEntry),
          toEntry(provenance),
        ]),
      ];
      bundles.push({
        sourceType,
        recordCount: built.length,
        provenanceFullUrls: built.map(({ provenance }) => provenance.fullUrl),
        bundle: {
          resourceType: "Bundle",
          meta: { profile: [GroveUrl.exchangeBundleProfile] },
          type: "collection",
          timestamp: fhirInstant(params.packedAt ?? new Date()),
          entry: entries,
        },
      });
    }
  }
  return bundles;
};
