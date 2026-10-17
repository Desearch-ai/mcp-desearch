import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

const PATHNAME = "/register";

async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, PATHNAME));
}

export default { fetch };
export const POST = fetch;
export const OPTIONS = fetch;
