import type { AppMetadata } from "@siafoundation/sia-storage";

// biome-ignore format: long hex literal
export const APP_KEY =
  "a8523c849ce92239e6649d92381117fa5bcf3068b6e4abe911a676ddaf6d2139";
export const APP_NAME = "cumulus";
export const DEFAULT_INDEXER_URL = "https://sia.storage";
export const APP_META: AppMetadata = {
  appId: APP_KEY,
  name: APP_NAME,
  description: "Social file-sharing built on atproto",
  serviceUrl: "https://sia.storage",
  logoUrl: undefined,
  callbackUrl: undefined,
};

// Erasure coding parameters — passed to sdk.upload() and encodedSize().
export const DATA_SHARDS = 10;
export const PARITY_SHARDS = 20;
