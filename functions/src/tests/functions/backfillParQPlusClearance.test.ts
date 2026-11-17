// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { backfillParQPlusClearance } from "../../functions/backfillParQPlusClearance.js";
import { fhirQuestionnaireResponseConverter } from "../../models/index.js";
import { FirestoreService } from "../../services/database/firestoreService.js";
import { parQPlusGeneralQuestionLinkIds } from "../../services/questionnaireResponse/parQPlusClearanceService.js";
import {
  groveQuestionnaireResponse,
  preGroveQuestionnaireResponse,
} from "../helpers/questionnaireResponses.js";
import { MockFirestore } from "../mocks/firestore.js";

const generalItems = (first: boolean) =>
  parQPlusGeneralQuestionLinkIds.map((linkId, index) => ({
    linkId,
    answer: [{ valueBoolean: index === 0 && first }],
  }));

describe("backfillParQPlusClearance", () => {
  it("computes the flag from the newest Par-Q+ response and skips flagged users", async () => {
    const firestore = new MockFirestore();
    const databaseService = new FirestoreService(
      firestore as unknown as Firestore,
    );
    const encode = fhirQuestionnaireResponseConverter.value.encode;
    await databaseService.runTransaction((collections, transaction) => {
      const users = collections.firestore.collection("users");
      transaction.set(users.doc("answered"), {});
      transaction.set(users.doc("never-answered"), {});
      transaction.set(users.doc("already-flagged"), {
        parQPlusCleared: false,
        parQPlusAuthored: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
      });
      const responses = users
        .doc("answered")
        .collection("questionnaireResponses");
      // Older pre-Grove response says "no" everywhere, newer Grove one has a general "yes" and follow-up "yes".
      transaction.set(
        responses.doc("old"),
        encode(
          preGroveQuestionnaireResponse("parQplus", "old", generalItems(false)),
        ),
      );
      transaction.set(
        responses.doc("new"),
        encode(
          groveQuestionnaireResponse("parQplus", "new", [
            ...generalItems(true),
            {
              linkId: "6ab1cdf1-f8fa-429b-ba08-7097a87ffb82",
              answer: [{ valueBoolean: true }],
            },
            {
              linkId: "c59933b4-153b-4067-88e8-327075dbd22c",
              answer: [{ valueBoolean: true }],
            },
          ]),
        ),
      );
      transaction.set(
        responses.doc("who5"),
        encode(groveQuestionnaireResponse("who5", "who5", [])),
      );
      transaction.set(
        users
          .doc("already-flagged")
          .collection("questionnaireResponses")
          .doc("r"),
        encode(
          preGroveQuestionnaireResponse("parQplus", "r", generalItems(false)),
        ),
      );
    });

    await backfillParQPlusClearance(databaseService);

    const user = async (id: string) =>
      (
        await databaseService.getDocument((collections) =>
          collections.firestore.collection("users").doc(id),
        )
      )?.content as Record<string, unknown>;

    expect((await user("answered")).parQPlusCleared).to.equal(false);
    expect(await user("never-answered")).to.deep.equal({});
    expect((await user("already-flagged")).parQPlusCleared).to.equal(false);
  });
});
