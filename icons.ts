import { FAVICON_ICO_BASE64, ICON_512_PNG_BASE64, ICON_64_PNG_BASE64 } from "./icons-data.js";

export interface PublicIcon {
    contentType: "image/png" | "image/x-icon";
    bytes: Uint8Array<ArrayBuffer>;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(base64, "base64"));
}

const ICON_512: PublicIcon = { contentType: "image/png", bytes: decode(ICON_512_PNG_BASE64) };
const ICON_64: PublicIcon = { contentType: "image/png", bytes: decode(ICON_64_PNG_BASE64) };
const FAVICON: PublicIcon = { contentType: "image/x-icon", bytes: decode(FAVICON_ICO_BASE64) };

/**
 * Public icon paths. `/api/icon` serves them on Vercel and maps each rewrite
 * back to one of these names with `?name=`.
 */
export const PUBLIC_ICONS: ReadonlyMap<string, PublicIcon> = new Map([
    ["/icon-512.png", ICON_512],
    ["/icon-64.png", ICON_64],
    ["/favicon.png", ICON_64],
    ["/favicon.ico", FAVICON],
]);
