// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { createTransport } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {
  feedbackEmailSecretParams,
  getFeedbackCoordinatorEmail,
  getFeedbackSenderEmail,
  getSmtpHost,
  getSmtpPassword,
  getSmtpPort,
  getSmtpUsername,
} from "../env.js";
import { defaultServiceAccount } from "./helpers.js";

const formatFeedbackEmail = (
  feedbackId: string,
  data: Record<string, unknown>,
): { subject: string; text: string } => {
  const subject = `[MyHeartCounts] New Feedback Received (ID: ${feedbackId})`;

  const { accountId, ...rest } = data;
  const lines: string[] = [
    `New feedback has been submitted.`,
    ``,
    `Feedback ID: ${feedbackId}`,
    `From user: ${typeof accountId === "string" ? accountId : "unknown"}`,
    ``,
    `--- Feedback Content ---`,
  ];

  for (const [key, value] of Object.entries(rest)) {
    const formatted =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    lines.push(`${key}: ${formatted}`);
  }

  return { subject, text: lines.join("\n") };
};

export const onFeedbackCreated = onDocumentCreated(
  {
    document: "feedback/{feedbackId}",
    serviceAccount: defaultServiceAccount,
    secrets: feedbackEmailSecretParams,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.warn("onFeedbackCreated: No data in event");
      return;
    }

    const feedbackId = event.params.feedbackId;
    const data = snapshot.data();
    const { subject, text } = formatFeedbackEmail(feedbackId, data);

    try {
      // requireTLS/forceAuth make the transport fail loudly if the server does
      // not offer STARTTLS or AUTH, instead of silently sending
      // unauthenticated. forceAuth is supported by nodemailer at runtime but
      // missing from @types/nodemailer, so the options object needs a cast.
      const port = Number(getSmtpPort());
      const transporter = createTransport({
        host: getSmtpHost(),
        port,
        secure: port === 465,
        requireTLS: true,
        forceAuth: true,
        logger: true,
        auth: {
          user: getSmtpUsername(),
          pass: getSmtpPassword(),
        },
      } as SMTPTransport.Options);

      await transporter.sendMail({
        from: `"MyHeart Counts" <${getFeedbackSenderEmail()}>`,
        to: getFeedbackCoordinatorEmail(),
        subject,
        text,
      });

      logger.info(
        `Feedback notification sent for ${feedbackId} to ${getFeedbackCoordinatorEmail()}`,
      );
    } catch (error) {
      logger.error(
        `Failed to send feedback notification for ${feedbackId}: ${String(error)}`,
      );
    }
  },
);
