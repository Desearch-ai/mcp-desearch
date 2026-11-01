import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PUBLIC_ICONS } from "./icons.js";
import { AGENT_TOOLS_ORG_TOKEN } from "./agent-tools-org.js";
import { AGENT_TOOLS_VERIFY_TOKEN } from "./agent-tools-verify.js";
import { openaiAppsChallengeToken } from "./openai-apps-challenge.js";
import { DIRECT_CLIENT_IP_HEADER } from "./oauth/client-ip.js";
import { OAuthConfigError } from "./oauth/errors.js";
import { handleOAuthHttp, resolveRequestCredential } from "./oauth/http.js";
import { wwwAuthenticate, type WwwChallenge } from "./oauth/metadata.js";
import { extractDesearchApiKey } from "./request-key.js";
import { createDesearchMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export { extractDesearchApiKey };

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, x-api-key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
};

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
]);

export interface HttpListenOptions {
    port?: number;
    host?: string;
}

export interface RunningHttpServer {
    port: number;
    host: string;
    close: () => Promise<void>;
}

/**
 * Copy a request onto another path. Used by the Vercel functions, which see
 * the rewritten URL (`/api/mcp`) rather than the public path (`/mcp`).
 */
export function requestWithPathname(request: Request, pathname: string): Request {
    const url = new URL(request.url);
    url.pathname = pathname;
    const method = request.method;
    const init: RequestInit & { duplex?: "half" } = {
        method,
        headers: request.headers,
    };
    if (method !== "GET" && method !== "HEAD") {
        init.body = request.body;
        init.duplex = "half";
    }
    return new Request(url, init);
}

function normalizePath(pathname: string): string {
    if (pathname.length > 1 && pathname.endsWith("/")) {
        return pathname.slice(0, -1);
    }
    return pathname;
}

function isMcpPath(pathname: string): boolean {
    return pathname === "/mcp" || pathname === "/api/mcp";
}

function isHealthPath(pathname: string): boolean {
    // `/api/health` is the Vercel function path. The public rewrite of `/health`
    // delivers that pathname when the function wrapper does not remap it, and
    // `isMcpPath` already accepts both `/mcp` and `/api/mcp` for the same reason.
    return pathname === "/" || pathname === "/health" || pathname === "/api/health";
}

function withCors(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        headers.set(key, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function jsonRpcError(status: number, code: number, message: string, extra?: Record<string, string>): Response {
    const headers = new Headers({ "Content-Type": "application/json", ...extra });
    return new Response(
        JSON.stringify({
            jsonrpc: "2.0",
            error: { code, message },
            id: null,
        }),
        { status, headers }
    );
}

function healthResponse(): Response {
    return new Response(
        JSON.stringify({
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: "streamable-http",
            endpoint: "/mcp",
            auth: "initialize and tools/list are public. tools/call requires Authorization: Bearer <DESEARCH_API_KEY>, x-api-key, or an OAuth access token.",
        }),
        {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }
    );
}

const INVALID_TOKEN_CHALLENGE: WwwChallenge = {
    error: "invalid_token",
    error_description: "The access token is invalid or expired.",
};

const LOGIN_CHALLENGE: WwwChallenge = {
    error: "insufficient_scope",
    error_description: "You need to login to continue",
};

const UNAUTHORIZED_MESSAGE =
    "Unauthorized. Send your Desearch API key in the Authorization: Bearer <key> header or the x-api-key header.";

function challengeHeader(request: Request, challenge?: WwwChallenge): string | Response {
    try {
        return wwwAuthenticate(request, challenge);
    } catch (error) {
        if (error instanceof OAuthConfigError) {
            return jsonRpcError(500, -32603, "Authorization storage is unavailable.");
        }
        throw error;
    }
}

function unauthorized(request: Request, invalidToken = false): Response {
    const header = challengeHeader(request, invalidToken ? INVALID_TOKEN_CHALLENGE : undefined);
    if (header instanceof Response) {
        return header;
    }
    return jsonRpcError(401, -32001, UNAUTHORIZED_MESSAGE, { "WWW-Authenticate": header });
}

interface ToolsCallMessage {
    id?: unknown;
}

function readToolsCalls(raw: string): { batched: boolean; calls: ToolsCallMessage[] } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const batched = Array.isArray(parsed);
    const messages: unknown[] = batched ? (parsed as unknown[]) : [parsed];
    if (messages.length === 0) {
        return null;
    }
    const calls: ToolsCallMessage[] = [];
    for (const message of messages) {
        if (typeof message !== "object" || message === null) {
            return null;
        }
        if ((message as { method?: unknown }).method !== "tools/call") {
            return null;
        }
        calls.push(message as ToolsCallMessage);
    }
    return { batched, calls };
}

function authFailure(request: Request, raw: string, invalidToken: boolean): Response {
    const header = challengeHeader(request, invalidToken ? INVALID_TOKEN_CHALLENGE : undefined);
    if (header instanceof Response) {
        return header;
    }
    const metaHeader = invalidToken ? header : challengeHeader(request, LOGIN_CHALLENGE);
    if (metaHeader instanceof Response) {
        return metaHeader;
    }
    const tools = readToolsCalls(raw);
    if (!tools) {
        return jsonRpcError(401, -32001, UNAUTHORIZED_MESSAGE, { "WWW-Authenticate": header });
    }
    const results = tools.calls.map((call) => ({
        jsonrpc: "2.0",
        id: call.id ?? null,
        result: {
            content: [{ type: "text", text: UNAUTHORIZED_MESSAGE }],
            isError: true,
            _meta: {
                "mcp/www_authenticate": [`'${metaHeader}'`],
            },
        },
    }));
    return new Response(JSON.stringify(tools.batched ? results : results[0]), {
        status: 401,
        headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": header,
        },
    });
}

/**
 * Methods a marketplace scanner can call with no Desearch API key.
 * Anything else, including tools/call, stays on the 401 gate so a missing
 * key never reaches the Desearch API.
 */
const KEYLESS_METHODS = new Set([
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "prompts/list",
    "resources/list",
    "resources/templates/list",
]);

function authRequiredOnInitialize(): boolean {
    return /^(1|true|yes)$/i.test((process.env.OAUTH_REQUIRE_AUTH_ON_INITIALIZE ?? "").trim());
}

function isKeylessMethod(method: string): boolean {
    if (method === "initialize" && authRequiredOnInitialize()) {
        return false;
    }
    return KEYLESS_METHODS.has(method);
}

function isKeylessDiscovery(raw: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return (
        messages.length > 0 &&
        messages.every((message) => {
            if (typeof message !== "object" || message === null) {
                return false;
            }
            const method = (message as { method?: unknown }).method;
            return typeof method === "string" && isKeylessMethod(method);
        })
    );
}

function copyRequestHeaders(headers: Headers): Headers {
    const copied = new Headers();
    headers.forEach((value, key) => {
        if (key.toLowerCase() === "content-length" || key.toLowerCase() === "host") {
            return;
        }
        try {
            copied.append(key, value);
        } catch {
            // The Fetch constructor rejects forbidden request headers such as host.
        }
    });
    return copied;
}

function requestWithJsonBody(request: Request, body: string): Request {
    const init = { method: "POST", headers: request.headers, body };
    try {
        return new Request(request.url, init);
    } catch {
        return new Request(request.url, { ...init, headers: copyRequestHeaders(request.headers) });
    }
}

/**
 * Stateless Streamable HTTP handler.
 * Each POST builds a fresh MCP server tied to that request's API key.
 * JSON responses (not a long-lived SSE session) so the same handler runs
 * in a local Node process and in a Vercel function.
 * GET and DELETE return 405: this server does not push messages or store sessions.
 */
export async function handleMcpHttpRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
    }

    const pathname = normalizePath(new URL(request.url).pathname);

    if (pathname === "/.well-known/openai-apps-challenge" || pathname === "/api/openai-apps-challenge") {
        const token = openaiAppsChallengeToken();
        if (token) {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET, HEAD" }));
            }
            return withCors(new Response(request.method === "HEAD" ? null : token, {
                status: 200,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            }));
        }
    }

    if (pathname === "/.well-known/agent-tools-verify.txt" || pathname === "/api/agent-tools-verify") {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET, HEAD" }));
        }
        return withCors(new Response(request.method === "HEAD" ? null : AGENT_TOOLS_VERIFY_TOKEN + "\n", {
            status: 200,
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
            },
        }));
    }

    if (pathname === "/.well-known/agent-tools.txt" || pathname === "/api/agent-tools") {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET, HEAD" }));
        }
        return withCors(new Response(request.method === "HEAD" ? null : AGENT_TOOLS_ORG_TOKEN, {
            status: 200,
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
            },
        }));
    }

    const icon = PUBLIC_ICONS.get(pathname);
    if (icon) {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET, HEAD" }));
        }
        return withCors(new Response(request.method === "HEAD" ? null : icon.bytes, {
            status: 200,
            headers: {
                "Content-Type": icon.contentType,
                "Content-Length": String(icon.bytes.byteLength),
                "Cache-Control": "public, max-age=86400",
                "Cross-Origin-Resource-Policy": "cross-origin",
            },
        }));
    }

    const oauthResponse = await handleOAuthHttp(request);
    if (oauthResponse) {
        return withCors(oauthResponse);
    }

    if (isHealthPath(pathname)) {
        if (request.method === "GET") {
            return withCors(healthResponse());
        }
        return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET" }));
    }

    if (!isMcpPath(pathname)) {
        return withCors(
            new Response(JSON.stringify({ error: "Not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            })
        );
    }

    const credential = await resolveRequestCredential(request);
    if (credential.kind === "unavailable") {
        return withCors(jsonRpcError(500, -32603, "Authorization storage is unavailable."));
    }

    if (request.method === "GET" || request.method === "DELETE") {
        if (credential.kind !== "key") {
            return withCors(unauthorized(request, credential.kind === "unauthorized"));
        }
        return withCors(jsonRpcError(405, -32000, "Method not allowed. This server is stateless; use POST.", { Allow: "POST" }));
    }

    if (request.method !== "POST") {
        return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" }));
    }

    let apiKey: string;
    if (credential.kind === "key") {
        apiKey = credential.apiKey;
    } else if (credential.kind === "unauthorized") {
        const raw = await request.text();
        return withCors(authFailure(request, raw, true));
    } else {
        const raw = await request.text();
        if (!isKeylessDiscovery(raw)) {
            return withCors(authFailure(request, raw, false));
        }
        request = requestWithJsonBody(request, raw);
        apiKey = "";
    }

    const server = createDesearchMcpServer(apiKey);
    const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
    });
    transport.onerror = (error) => {
        console.error(`MCP HTTP error: ${error.message}`);
    };

    try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        return withCors(response);
    } catch (error) {
        console.error(
            `MCP HTTP handler error: ${error instanceof Error ? error.message : String(error)}`
        );
        return withCors(jsonRpcError(500, -32603, "Internal server error"));
    } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}

function readRawBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        // TS 5.7+ DOM BodyInit accepts Uint8Array<ArrayBuffer> and rejects
        // Uint8Array<ArrayBufferLike> (Node Buffer, whose buffer may be a
        // SharedArrayBuffer). Copy into a plain ArrayBuffer.
        req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        req.on("error", reject);
    });
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
    const host = req.headers.host ?? "localhost";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === DIRECT_CLIENT_IP_HEADER) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const entry of value) {
                headers.append(key, entry);
            }
        } else {
            headers.set(key, value);
        }
    }
    const remote = req.socket?.remoteAddress;
    if (remote) {
        headers.set(DIRECT_CLIENT_IP_HEADER, remote);
    }

    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readRawBody(req) : undefined;
    return new Request(url, {
        method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
    });
}

async function writeWebResponse(res: ServerResponse, response: Response, method?: string): Promise<void> {
    const body = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    // A HEAD response keeps the Content-Length of the GET body it describes.
    if (method !== "HEAD" || !headers.has("content-length")) {
        headers.set("content-length", String(body.byteLength));
    }
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
        outgoing[key] = value;
    });
    res.writeHead(response.status, outgoing);
    res.end(body);
}

export function startHttpServer(options: HttpListenOptions = {}): Promise<RunningHttpServer> {
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? 3000;

    const nodeServer = createServer(async (req, res) => {
        try {
            const request = await toWebRequest(req);
            const response = await handleMcpHttpRequest(request);
            await writeWebResponse(res, response, request.method);
        } catch (error) {
            console.error(
                `HTTP server error: ${error instanceof Error ? error.message : String(error)}`
            );
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        error: { code: -32603, message: "Internal server error" },
                        id: null,
                    })
                );
            } else {
                res.end();
            }
        }
    });

    return new Promise((resolve, reject) => {
        nodeServer.once("error", reject);
        nodeServer.listen(port, host, () => {
            const address = nodeServer.address();
            const boundPort = typeof address === "object" && address ? address.port : port;
            console.error(
                `Desearch MCP listening on ${host}:${boundPort} (endpoint /mcp)`
            );
            resolve({
                host,
                port: boundPort,
                close: () =>
                    new Promise((closeResolve, closeReject) => {
                        // Client transports abort the optional GET stream and can leave
                        // a socket that close() would otherwise hold until timeout.
                        nodeServer.closeAllConnections();
                        nodeServer.close((error) => (error ? closeReject(error) : closeResolve()));
                    }),
            });
        });
    });
}
