// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import nodemailer from "nodemailer";
import {
  getSmtpPassword,
  getSmtpUsername,
  smtpPasswordParam,
  smtpUsernameParam,
} from "../env.js";
import { defaultServiceAccount } from "./helpers.js";

const senderAddress = "myheartcounts@stanford.edu";
const recipientAddress = "goldschmidt@stanford.edu";

const getEgressIp = async (): Promise<string> => {
  try {
    const response = await fetch("https://api.ipify.org");
    return await response.text();
  } catch (error) {
    logger.warn("Failed to determine egress IP:", error);
    return "unknown";
  }
};

export const sendTestEmail = async (): Promise<void> => {
  const egressIp = await getEgressIp();
  logger.info(`Sending test email from egress IP ${egressIp}`);

  // GCP blocks outbound port 25, so we default to 587 with STARTTLS
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.stanford.edu",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
      user: getSmtpUsername(),
      pass: getSmtpPassword(),
    },
  });

  const info = await transporter.sendMail({
    from: `"MyHeart Counts" <${senderAddress}>`,
    to: recipientAddress,
    subject: "MyHeart Counts SMTP relay test",
    text: `This is an automated hourly test email from the MyHeart Counts Firebase functions, sent at ${new Date().toISOString()} from egress IP ${egressIp}.`,
  });
  logger.info(
    `Test email sent to ${recipientAddress} from egress IP ${egressIp}: ${info.response}`,
  );
};

export const hourlyTestEmail = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
    secrets: [smtpUsernameParam, smtpPasswordParam],
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
