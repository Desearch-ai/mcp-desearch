import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createDesearchMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, x-api-key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
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
 * Desearch API key from the remote client.
 * Accepted forms, and only these:
 * - `Authorization: Bearer <key>`
 * - `Authorization: <key>` (the key alone: no scheme and no spaces)
 * - `x-api-key: <key>`
 * Query strings are ignored so keys do not land in access logs.
 *
 * The key is not checked with the Desearch API here. The public spec has no
 * unmetered account, balance, or usage route, and a search call would be billed.
 * An invalid key still fails when a tool calls the API (HTTP 403).
 */
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

export function extractDesearchApiKey(request: Request): string | undefined {
    const authorization = request.headers.get("authorization")?.trim();
    if (authorization) {
        const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
        if (bearer?.[1]) {
            return bearer[1];
        }
        if (!/^Bearer\b/i.test(authorization) && !/\s/.test(authorization)) {
            return authorization;
        }
    }

    const headerKey = request.headers.get("x-api-key")?.trim();
    if (headerKey) {
        return headerKey;
    }

    return undefined;
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
    return pathname === "/" || pathname === "/health";
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
            auth: "Authorization: Bearer <key>, Authorization: <key>, or x-api-key: <key>",
        }),
        {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }
    );
}

function unauthorized(): Response {
    // No OAuth challenge. Desearch auth is a per-user API key, and a
    // WWW-Authenticate discovery hint makes some MCP clients start an OAuth flow.
    return jsonRpcError(
        401,
        -32001,
        "Unauthorized. Send your Desearch API key as Authorization: Bearer <key>, Authorization: <key>, or x-api-key: <key>."
    );
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

    const apiKey = extractDesearchApiKey(request);
    if (!apiKey) {
        return withCors(unauthorized());
    }

    if (request.method === "GET" || request.method === "DELETE") {
        return withCors(jsonRpcError(405, -32000, "Method not allowed. This server is stateless; use POST.", { Allow: "POST" }));
    }

    if (request.method !== "POST") {
        return withCors(jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" }));
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

function readRawBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
    const host = req.headers.host ?? "localhost";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) {
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

    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readRawBody(req) : undefined;
    return new Request(url, {
        method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
    });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
    const body = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.set("content-length", String(body.byteLength));
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
            await writeWebResponse(res, response);
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
