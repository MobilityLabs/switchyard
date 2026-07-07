import { createHash, randomBytes } from "node:crypto";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const mintToken = (prefix: string, bytes = 24) =>
  `${prefix}_${randomBytes(bytes).toString("hex")}`;
