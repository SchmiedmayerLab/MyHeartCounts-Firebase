// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import nodemailer from "nodemailer";
import { defaultServiceAccount } from "./helpers.js";

const senderAddress = "myheartcounts@stanford.edu";
const recipientAddress = "goldschmidt@stanford.edu";

export const sendTestEmail = async (): Promise<void> => {
  // GCP blocks outbound port 25, so we default to 587 with STARTTLS
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.stanford.edu",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
  });

  const info = await transporter.sendMail({
    from: `"MyHeart Counts" <${senderAddress}>`,
    to: recipientAddress,
    subject: "MyHeart Counts SMTP relay test",
    text: `This is an automated hourly test email from the MyHeart Counts Firebase functions, sent at ${new Date().toISOString()}.`,
  });
  logger.info(`Test email sent to ${recipientAddress}: ${info.response}`);
};

export const hourlyTestEmail = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
    serviceAccount: defaultServiceAccount,
  },
  async (_event) => {
    try {
      await sendTestEmail();
    } catch (error) {
      logger.error("Failed to send test email:", error);
    }
  },
);
