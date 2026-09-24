import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

// Public URLs `/` and `/health` are rewritten to this function.
async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, "/health"));
}

export default { fetch };
export const GET = fetch;
export const OPTIONS = fetch;
