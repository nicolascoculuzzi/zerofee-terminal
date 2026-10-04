/**
 * Token media: metadata field extraction (images, socials), URL normalization and IPFS sources, and the
 * same-origin image proxy behind GET /api/img (contract: packages/protocol media.ts).
 */
export { loadMediaConfig, type MediaConfig } from "./config";
export { extractImage, extractSocials, type ParsedMetadata, parseMetadataJson } from "./extract";
export { ImageProxy, type ImageProxyOptions, type ImageProxyStats, type ImageRef } from "./proxy";
export { normalizeSocials } from "./socials";
export { contentKey, DEFAULT_IPFS_GATEWAYS, extractArweave, extractCid, fetchCandidates, normalizeImageUrl } from "./urls";
