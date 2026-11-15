// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash } from "crypto";
import { expect } from "chai";
import { buildExchangeBundles } from "./bundleBuilder.js";
import {
  providerBundleStoragePath,
  sourceTypeFileToken,
} from "./bundleStorage.js";
import {
  GroveUrl,
  MhcMeasurements,
  MhcUrl,
  OUTSIDE_CATALOG_TAG,
} from "./constants.js";
import { type RecordDraft } from "./drafts.js";
import {
  deriveIdentityValue,
  deviceContentDigest,
  entryFullUrl,
  type GroveIdentityKey,
  recordContentDigest,
} from "./identity.js";
import { civilDay, instant, period } from "./time.js";
import { HealthProviderId } from "../../../models/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-non-null-assertion -- loosely typed FHIR JSON assertions */
type Json = Record<string, any>;

const key: GroveIdentityKey = {
  key: Buffer.alloc(32, 7),
  keyId: "unittest",
  epoch: "1",
  root: "https://myheartcounts.stanford.edu/fhir",
};

const build = (provider: HealthProviderId, records: RecordDraft[]) =>
  buildExchangeBundles({
    provider,
    userId: "user-1",
    providerUserId: "provider-user-1",
    key,
    records,
    recordedAt: new Date("2026-08-21T10:00:00Z"),
    packedAt: new Date("2026-08-21T10:00:01Z"),
    applicationVersion: "4.0.5",
  });

const resources = (bundle: Json, type: string): Json[] =>
  (bundle.entry as Json[])
    .filter((entry) => entry.resource.resourceType === type)
    .map((entry) => entry.resource);

const bloodPressureRecord: RecordDraft = {
  kind: "observations",
  sourceType: "getmeas:9+10",
  nativeRecordId: "17348211",
  occurred: instant(Date.parse("2026-08-20T14:45:00Z"), {
    iana: "America/Los_Angeles",
  }),
  outputs: [
    {
      measurement: "blood-pressure",
      effective: instant(Date.parse("2026-08-20T14:45:00Z"), {
        iana: "America/Los_Angeles",
      }),
      components: [
        {
          code: { system: GroveUrl.loinc, code: "8480-6" },
          value: { quantity: 118, unit: { code: "mm[Hg]", unit: "mmHg" } },
        },
        {
          code: { system: GroveUrl.loinc, code: "8462-4" },
          value: { quantity: 76, unit: { code: "mm[Hg]", unit: "mmHg" } },
        },
      ],
    },
  ],
};

describe("grove bundleBuilder", () => {
  it("builds a Grove provider exchange bundle for a Withings blood-pressure panel", () => {
    const [built] = build(HealthProviderId.withings, [bloodPressureRecord]);
    const bundle = built.bundle as Json;
    expect(bundle.resourceType).to.equal("Bundle");
    expect(bundle.type).to.equal("collection");
    expect(bundle.meta.profile).to.deep.equal([GroveUrl.exchangeBundleProfile]);
    expect(bundle.timestamp).to.equal("2026-08-21T10:00:01.000Z");

    const [observation] = resources(bundle, "Observation");
    expect(observation.meta.profile).to.deep.equal([
      "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-blood-pressure",
      "https://grovealliance.org/fhir/withings/StructureDefinition/withings-observation",
    ]);
    expect(observation.meta.tag).to.equal(undefined);
    expect(observation.issued).to.equal(undefined);
    expect(observation.performer).to.equal(undefined);
    expect(observation.device).to.equal(undefined);
    expect(observation.id).to.equal(undefined);
    expect(observation.status).to.equal("final");
    expect(observation.category[0].coding[0].code).to.equal("vital-signs");
    expect(observation.code.coding[0]).to.include({
      system: GroveUrl.loinc,
      code: "85354-9",
    });
    expect(observation.valueQuantity).to.equal(undefined);
    expect(
      observation.component.map((c: Json) => c.code.coding[0].code),
    ).to.deep.equal(["8480-6", "8462-4"]);
    expect(observation.component[0].valueQuantity).to.deep.equal({
      value: 118,
      unit: "mmHg",
      system: GroveUrl.ucum,
      code: "mm[Hg]",
    });
    expect(observation.subject).to.deep.equal({
      type: "Patient",
      identifier: { system: MhcUrl.participant, value: "user-1" },
    });
    expect(observation.effectiveDateTime).to.equal("2026-08-20T07:45:00-07:00");
    expect(observation._effectiveDateTime).to.deep.equal({
      extension: [
        { url: GroveUrl.timezoneExtension, valueCode: "America/Los_Angeles" },
      ],
    });
    expect(observation.extension).to.deep.equal([
      { url: GroveUrl.providerExtension, valueCode: "withings" },
      {
        url: GroveUrl.providerSourceTypeExtension,
        valueCode: "withings/getmeas:9+10",
      },
    ]);

    // Identifiers: provider-record and provider-output HMACs over the catalog preimage.
    const [sourceRecord, sourceOutput] = observation.identifier as Json[];
    expect(sourceRecord.type.coding[0].code).to.equal("source-record");
    expect(sourceRecord.system).to.equal(
      "https://myheartcounts.stanford.edu/fhir/NamingSystem/grove-provider-record-v0/unittest/1",
    );
    expect(sourceRecord.value).to.match(/^v0:unittest:1:[A-Za-z0-9_-]{43}$/);
    expect(sourceOutput.type.coding[0].code).to.equal("source-output");

    // Entry fullUrl and entry key follow the source-output identifier.
    const observationEntry = (bundle.entry as Json[]).find(
      (entry) => entry.resource === observation,
    )!;
    expect(observationEntry.fullUrl).to.equal(
      entryFullUrl(sourceOutput.system, sourceOutput.value),
    );
    expect(observationEntry.extension[0].url).to.equal(
      GroveUrl.entryKeyExtension,
    );
    expect(observationEntry.extension[0].valueIdentifier).to.deep.equal(
      sourceOutput,
    );

    // Provenance: one per record, record version reproducible from content.
    const [provenance] = resources(bundle, "Provenance");
    expect(provenance.meta.profile).to.deep.equal([
      GroveUrl.providerConversionProvenanceProfile,
    ]);
    expect(provenance.target).to.deep.equal([
      { reference: observationEntry.fullUrl },
    ]);
    expect(provenance.entity[0].what.identifier).to.deep.equal(sourceRecord);
    expect(provenance.recorded).to.equal("2026-08-21T10:00:00.000Z");
    expect(provenance.occurredDateTime).to.equal("2026-08-20T07:45:00-07:00");
    const recordVersion = provenance.extension[0].valueIdentifier as Json;
    const digest = recordContentDigest(provenance, [observation]);
    expect(recordVersion.value).to.equal(
      deriveIdentityValue(key, "record-version", [
        sourceRecord.system,
        sourceRecord.value,
        digest,
      ]),
    );

    // Application Device snapshot is the assembler.
    const [device] = resources(bundle, "Device");
    expect(provenance.agent[0].who.reference).to.equal(
      entryFullUrl(device.identifier[0].system, device.identifier[0].value),
    );
    expect(device.identifier[0].value).to.equal(
      deriveIdentityValue(key, "device-snapshot", [
        MhcUrl.participant,
        "user-1",
        "application",
        deviceContentDigest(device),
      ]),
    );
  });

  it("is deterministic for identical input", () => {
    const first = build(HealthProviderId.withings, [bloodPressureRecord]);
    const second = build(HealthProviderId.withings, [bloodPressureRecord]);
    expect(JSON.stringify(first)).to.equal(JSON.stringify(second));
  });

  it("uses the documented global key space for Oura and an account pseudonym otherwise", () => {
    const record: RecordDraft = {
      kind: "observations",
      sourceType: "daily_activity",
      nativeRecordId: "a1",
      occurred: civilDay("2026-08-20", { offsetMinutes: -420 }) as never,
      outputs: [
        {
          measurement: "step-count",
          effective: civilDay("2026-08-20", { offsetMinutes: -420 }) as never,
          value: { quantity: 8241 },
        },
      ],
    };
    const [oura] = build(HealthProviderId.oura, [record]);
    const [observation] = resources(oura.bundle, "Observation");
    expect(observation.effectivePeriod).to.deep.equal({
      start: "2026-08-20T00:00:00-07:00",
      end: "2026-08-21T00:00:00-07:00",
    });
    expect(observation.valueQuantity).to.deep.equal({
      value: 8241,
      unit: "steps",
      system: GroveUrl.ucum,
      code: "{steps}",
    });
    expect(observation.category[0].coding[0].code).to.equal("activity");
    expect(observation.identifier[0].value).to.equal(
      deriveIdentityValue(key, "provider-record", [
        "oura",
        "daily_activity",
        MhcUrl.providerKeySpace,
        "oura-document-id-global",
        "a1",
      ]),
    );
  });

  it("tags out-of-catalog outputs and keeps only the envelope profile for MHC codes", () => {
    const effective = period(
      Date.parse("2026-08-20T06:00:00Z"),
      Date.parse("2026-08-20T14:00:00Z"),
    );
    const [built] = build(HealthProviderId.oura, [
      {
        kind: "observations",
        sourceType: "sleep",
        nativeRecordId: "s1",
        occurred: effective,
        outputs: [
          {
            measurement: "sleep-heart-rate",
            effective,
            value: { quantity: 48 },
            method: "session-minimum",
          },
          {
            measurement: MhcMeasurements.sleepHrvRmssd,
            effective,
            value: { quantity: 41 },
            method: "session-mean",
          },
        ],
      },
    ]);
    const [heartRate, hrv] = resources(built.bundle, "Observation");
    expect(heartRate.meta.tag).to.equal(undefined);
    expect(heartRate.method.coding[0]).to.deep.equal({
      system: GroveUrl.aggregationMethod,
      code: "session-minimum",
    });
    expect(hrv.meta.profile).to.deep.equal([
      "https://grovealliance.org/fhir/oura/StructureDefinition/oura-observation",
    ]);
    expect(hrv.meta.tag).to.deep.equal([OUTSIDE_CATALOG_TAG]);
    expect(hrv.code.coding[0].system).to.equal(MhcUrl.providerMeasurement);
    expect(hrv.valueQuantity.code).to.equal("ms");
  });

  it("drops outputs violating a profile's value domain or effective type", () => {
    const day = civilDay("2026-08-20") as never;
    const bundles = build(HealthProviderId.withings, [
      {
        kind: "observations",
        sourceType: "getactivity:steps",
        nativeRecordId: "2026-08-20",
        occurred: day,
        outputs: [
          {
            measurement: "step-count",
            effective: day,
            value: { quantity: 12.5 },
          },
        ],
      },
      {
        kind: "observations",
        sourceType: "getmeas:1",
        nativeRecordId: "1",
        occurred: day,
        // body weight is dateTime-only
        outputs: [
          {
            measurement: "body-weight",
            effective: day,
            value: { quantity: 70 },
          },
        ],
      },
    ]);
    expect(bundles).to.have.lengthOf(0);
  });

  it("resolves hasMember references within a record", () => {
    const effective = period(
      Date.parse("2026-08-20T06:00:00Z"),
      Date.parse("2026-08-20T14:00:00Z"),
    );
    const stage = period(
      Date.parse("2026-08-20T06:00:00Z"),
      Date.parse("2026-08-20T07:00:00Z"),
    );
    const [built] = build(HealthProviderId.googleHealth, [
      {
        kind: "observations",
        sourceType: "sleep",
        nativeRecordId: "sleep-1",
        occurred: effective,
        outputs: [
          {
            measurement: "sleep-stage",
            discriminator: "x",
            outsideCatalog: true,
            effective: stage,
            value: {
              concept: [{ system: GroveUrl.sleepStage, code: "light" }],
            },
          },
          {
            measurement: "sleep-duration",
            effective,
            value: { quantity: 7.5 },
            hasMember: ["sleep-stage|x"],
          },
        ],
      },
    ]);
    const entries = built.bundle.entry as Json[];
    const stageEntry = entries.find(
      (entry) => entry.resource.code?.coding?.[0]?.code === "sleep-stage",
    )!;
    const duration = entries.find(
      (entry) => entry.resource.code?.coding?.[0]?.code === "93832-4",
    )!;
    expect(duration.resource.hasMember).to.deep.equal([
      { reference: stageEntry.fullUrl },
    ]);
    expect(stageEntry.resource.meta.tag).to.deep.equal([OUTSIDE_CATALOG_TAG]);
  });

  it("describes raw recordings as provider recording documents", () => {
    const payload = Buffer.from('{"a":1}', "utf8");
    const [built] = build(HealthProviderId.oura, [
      {
        kind: "recording",
        sourceType: "heartrate",
        nativeRecordId: "file-1",
        occurred: period(0, 1000),
        typeText: "Oura heart-rate samples",
        payload,
        url: "gs://bucket/users/user-1/ouraHealthSamples/x.json.zstd",
      },
    ]);
    const [document] = resources(built.bundle, "DocumentReference");
    expect(document.meta.profile).to.deep.equal([
      GroveUrl.sensorRecordingDocumentProfile,
      GroveUrl.providerRecordingDocumentProfile,
    ]);
    expect(
      document.identifier.map((i: Json) => i.type.coding[0].code),
    ).to.deep.equal(["source-record", "source-output", "source-artifact"]);
    expect(document.content[0].attachment).to.include({
      contentType: "application/json",
      size: 7,
      hash: createHash("sha1").update(payload).digest("base64"),
      url: "gs://bucket/users/user-1/ouraHealthSamples/x.json.zstd",
    });
    expect(document.content[0].format.code).to.equal("provider-recording");
    expect(document.meta.tag).to.equal(undefined);
  });

  it("groups by source type, chunks, and names files deterministically", () => {
    const day = (n: number) =>
      civilDay(`2026-08-${String(n).padStart(2, "0")}`) as never;
    const records: RecordDraft[] = [1, 2, 3].map((n) => ({
      kind: "observations",
      sourceType: "getactivity:steps",
      nativeRecordId: `2026-08-0${n}`,
      occurred: day(n),
      outputs: [
        {
          measurement: "step-count",
          effective: day(n),
          value: { quantity: n * 1000 },
        },
      ],
    }));
    const bundles = buildExchangeBundles({
      provider: HealthProviderId.withings,
      userId: "user-1",
      providerUserId: "p",
      key,
      records,
      recordedAt: new Date(0),
      applicationVersion: "1",
      maxRecordsPerBundle: 2,
    });
    expect(bundles.map((b) => b.recordCount)).to.deep.equal([2, 1]);
    expect(sourceTypeFileToken("getmeas:9+10")).to.equal("getmeas-9-10");
    const path = providerBundleStoragePath(
      "user-1",
      HealthProviderId.withings,
      bundles[0],
    );
    expect(path).to.match(
      /^users\/user-1\/providerHealthSamples\/withings\/withings_getactivity-steps_[0-9a-f]{24}\.json\.zstd$/,
    );
  });
});
