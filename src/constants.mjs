// Shared chain-agnostic constants. Kept separate from order.mjs so that status/reporting code can
// compare zero values without importing the order encoder.
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const LOCAL_CHAIN_ID = 31337;
