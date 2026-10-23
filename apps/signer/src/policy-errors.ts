import type { RejectionCode } from "@eox/signing";

export class PolicyRejection extends Error {
  constructor(readonly code: RejectionCode, message: string) {
    super(message);
  }
}
