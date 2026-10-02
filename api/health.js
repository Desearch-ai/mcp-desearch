import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

// Public URLs `/` and `/health` are rewritten to this function.
// handleMcpHttpRequest also accepts `/api/health` directly, which is the path
// Vercel delivers when this remap does not run.
async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, "/health"));
}

export default { fetch };
export const GET = fetch;
export const OPTIONS = fetch;
