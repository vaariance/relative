import { COLLATERAL } from "./config";

const PROGRAM: Array<[RegExp, string]> = [
  [/InsufficientUnlockedUnits/, "You do not have enough free units for this. Check your balance, and any units already locked in a pending request."],
  [/InsufficientPayable/, `You have less ${COLLATERAL.symbol} ready to withdraw than that.`],
  [/InsufficientFees/, "The pool could not cover this just now. Please try again shortly."],
  [/FeeVersionChanged|FEE_CHANGED/, "The trading fee changed a moment ago. Please press the button again."],
  [/ConditionFailed/, "The result would be below the minimum you set, so nothing was sent."],
  [/ZeroValueClass/, "This coin's pool has no value right now, so it cannot take new buys."],
  [/CancellationClosed/, "This request is already being filled, so it can no longer be cancelled."],
  [/AlreadyProcessed/, "This request has already been handled."],
  [/NotRefundable/, "There is nothing to refund on this request."],
  [/InvalidExpiry/, "That took a little too long. Please press the button again."],
  [/CapacityExceeded/, "The pool cannot take a request this large right now. Try a smaller amount."],
  [/BatchBusy|BatchIncomplete/, "The pool is busy filling orders. Please try again in a moment."],
  [/\bPaused\b/, "Trading is paused for the moment. Nothing was sent."],
  [/\bHalted\b/, "Trading is halted for now. You can still cancel pending requests and refund deposits."],
  [/InvalidCollateral/, `This wallet's ${COLLATERAL.symbol} is not the token the pool uses.`],
  [/AccountNotInitialized|AccountNotFound|user_token|insufficient funds|insufficient lamports|0x1\b/i, `Your wallet does not have enough ${COLLATERAL.symbol}, or has no devnet SOL to pay the network fee. You can get both on the Faucet page.`],
  [/blockhash|expired/i, "That took too long and timed out. Nothing moved. Please try again."],
  [/EntryLimit/, "This Epoch is full and takes no more entries."],
  [/WrongPhase/, "This Epoch is not taking entries right now."],
  [/nonce|already in use/i, "Someone else's request landed at the same moment. Please press the button again."],
];

const CODES: Record<string, string> = {
  NOT_LIVE: "This is demo data, so nothing can be sent.",
  UNAVAILABLE: "We could not reach the service. Check your connection and try again.",
  RATE_LIMITED: "Too many requests in a short time. Please wait a moment and try again.",
  UNKNOWN_WALLET: "This wallet has no activity here yet.",
  TRADING_CLOSED: "Trading is not open right now, so nothing was sent.",
  NO_PUBLICATION: "The market has not published yet. Please try again shortly.",
  UNKNOWN_EPOCH: "That Epoch could not be found. Please reload the page.",
  NOT_CONFIGURED: "Epochs are not available right now.",
  INTERNAL_ERROR: "Something went wrong on our side. Nothing was sent. Please try again.",
  FAUCET_DISABLED: "Test token claims are closed right now.",
  CHALLENGE_INVALID: "The signed message expired or was already used. Please press the button again.",
  FAUCET_COOLDOWN: "This wallet already claimed in the last 24 hours.",
  FAUCET_LIMITED: "The faucet's daily limit has been reached. Please try again later.",
  FAUCET_BUSY: "Your last claim is still confirming. Please wait a moment.",
  FAUCET_EMPTY: "The faucet is empty right now. Please tell the team.",
  FAUCET_UNAVAILABLE: "The faucet could not send right now. Nothing moved. Please try again shortly.",
};

const FALLBACK = "That did not go through, and nothing was sent. Please try again.";

export function humanError(code: string, message: string): string {
  for (const [pattern, text] of PROGRAM) if (pattern.test(message) || pattern.test(code)) return text;
  return CODES[code] ?? FALLBACK;
}

export function walletError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|declin|cancel/i.test(message)) return "You declined it in your wallet. Nothing was sent.";
  if (/not (found|installed|detected)|no wallet/i.test(message)) return "No wallet was found. Install a Solana wallet and try again.";
  for (const [pattern, text] of PROGRAM) if (pattern.test(message)) return text;
  return "Your wallet could not complete that. Nothing was sent.";
}
