import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Cost of one MCP tool call, from the Desearch API's `X-Desearch-Cost-Usd` and
 * `X-Desearch-Usage-Count` response headers.
 *
 * Every tool call runs inside `withCostMeter`. Each API response the call reads
 * (direct calls in desearch-api.ts and desearch-js calls) adds its headers to the
 * call's meter, and the tool result carries the total in `_meta`:
 * `{ cost_usd, usage_count }`. `_meta` works for every result shape (JSON object,
 * bare list, plain text) and never changes the result content or `structuredContent`.
 *
 * AsyncLocalStorage keeps concurrent calls on one server (stdio) apart.
 */

export interface CostMeta {
    cost_usd?: number;
    usage_count?: number;
}

interface Meter {
    costUsd?: number;
    usageCount?: number;
}

const meters = new AsyncLocalStorage<Meter>();

/** Header values carry float noise (0.0014999999999999998); ten decimals is far below a billing unit. */
function round(value: number): number {
    return Math.round(value * 1e10) / 1e10;
}

function headerNumber(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Add one billed response to the current tool call. Outside a tool call it does nothing. */
export function recordCost(costUsd: number | undefined, usageCount: number | undefined): void {
    const meter = meters.getStore();
    if (!meter) {
        return;
    }
    if (costUsd !== undefined && Number.isFinite(costUsd)) {
        meter.costUsd = round((meter.costUsd ?? 0) + costUsd);
    }
    if (usageCount !== undefined && Number.isFinite(usageCount)) {
        meter.usageCount = (meter.usageCount ?? 0) + usageCount;
    }
}

/** Add one API response's `X-Desearch-Cost-Usd` / `X-Desearch-Usage-Count` headers to the current tool call. */
export function recordCostHeaders(headers: { get(name: string): string | null }): void {
    recordCost(headerNumber(headers.get("x-desearch-cost-usd")), headerNumber(headers.get("x-desearch-usage-count")));
}

/** Run one tool call with its own meter; returns the result and what the call's API responses reported. */
export async function withCostMeter<T>(run: () => Promise<T>): Promise<{ result: T; cost: CostMeta }> {
    const meter: Meter = {};
    const result = await meters.run(meter, run);
    const cost: CostMeta = {};
    if (meter.costUsd !== undefined) {
        cost.cost_usd = meter.costUsd;
    }
    if (meter.usageCount !== undefined) {
        cost.usage_count = meter.usageCount;
    }
    return { result, cost };
}
