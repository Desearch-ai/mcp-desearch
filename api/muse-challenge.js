import { handleMcpHttpRequest, requestWithPathname } from "../build/http.js";

const PATHNAME = "/.well-known/muse-challenge/a68cf22bcf914c4484bf5adb84ba1401604f2374615d870b51ef7414a681fd7e";

async function fetch(request) {
    return handleMcpHttpRequest(requestWithPathname(request, PATHNAME));
}

export default { fetch };
export const GET = fetch;
export const HEAD = fetch;
export const OPTIONS = fetch;
