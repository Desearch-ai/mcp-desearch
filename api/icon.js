import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

// vercel.json rewrites each public icon path here with ?name=<file>.
const NAMES = new Set(["icon-512.png", "icon-64.png", "favicon.png", "favicon.ico"]);

async function fetch(request) {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const pathname = NAMES.has(name) ? `/${name}` : "/api/icon";
    return handleMcpHttpRequest(requestWithPathname(request, pathname));
}

export default { fetch };
export const GET = fetch;
export const HEAD = fetch;
export const POST = fetch;
export const OPTIONS = fetch;
