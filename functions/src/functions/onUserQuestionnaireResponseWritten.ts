// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import {
  type FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
} from "../models/index.js";
import { DatabaseConverter } from "../services/database/databaseConverter.js";
import { type Document } from "../services/database/databaseService.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import { privilegedServiceAccount } from "./helpers.js";

const converter = new DatabaseConverter(
  fhirQuestionnaireResponseConverter.value,
);

export const onUserQuestionnaireResponseWritten = onDocumentWritten(
  {
    document: "users/{userId}/questionnaireResponses/{questionnaireResponseId}",
    serviceAccount: privilegedServiceAccount,
  },
  async (event) => {
    const triggerService = getServiceFactory().trigger();

    const beforeData = event.data?.before;
    const afterData = event.data?.after;

    const beforeDocument: Document<FHIRQuestionnaireResponse> | undefined =
      beforeData?.exists ?
        {
          id: beforeData.id,
          path: beforeData.ref.path,
          lastUpdate:
            beforeData.updateTime?.toDate() ?? beforeData.readTime.toDate(),
          content: converter.fromFirestore(beforeData),
        }
      : undefined;

    const afterDocument: Document<FHIRQuestionnaireResponse> | undefined =
      afterData?.exists ?
        {
          id: afterData.id,
          path: afterData.ref.path,
          lastUpdate:
            afterData.updateTime?.toDate() ?? afterData.readTime.toDate(),
          content: converter.fromFirestore(afterData),
        }
      : undefined;

    await triggerService.questionnaireResponseWritten(
      event.params.userId,
      event.params.questionnaireResponseId,
      beforeDocument,
      afterDocument,
    );
  },
);
