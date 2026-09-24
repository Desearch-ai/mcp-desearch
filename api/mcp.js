import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

// Public URL is /mcp (rewritten to this function). Direct /api/mcp hits it too.
async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, "/mcp"));
}

export default { fetch };
export const GET = fetch;
export const POST = fetch;
export const DELETE = fetch;
export const OPTIONS = fetch;
