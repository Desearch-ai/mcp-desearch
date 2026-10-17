import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

const PATHNAME = "/.well-known/oauth-authorization-server";

async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, PATHNAME));
}

export default { fetch };
export const GET = fetch;
export const HEAD = fetch;
export const OPTIONS = fetch;
