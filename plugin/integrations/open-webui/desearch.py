"""
title: Desearch
author: Desearch
description: Search the web through the hosted Desearch MCP service.
version: 0.1.0
required_open_webui_version: 0.13.3
license: MIT
"""

import asyncio
import json

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, Field


class Tools:
    class UserValves(BaseModel):
        DESEARCH_API_KEY: str = Field(
            default="",
            description="Your Desearch API key from https://console.desearch.ai/api-keys",
            json_schema_extra={"input": {"type": "password"}},
            repr=False,
        )

    async def search(self, query: str, __user__: dict | None = None) -> str:
        """Search the web with Desearch. Returns source titles and URLs.

        :param query: A nonempty public web search query, at most 2000 characters.
        """
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            return "Error: query must contain 1 to 2000 characters."
        valves = (__user__ or {}).get("valves")
        key = getattr(valves, "DESEARCH_API_KEY", "")
        if not isinstance(key, str) or not key.strip():
            return "Error: set your Desearch API key in this tool's User Valves."
        key = key.strip()
        if "\r" in key or "\n" in key:
            return "Error: invalid Desearch API key."

        # The endpoint is fixed: a user cannot redirect another user's credential.
        # One protected call per invocation; no automatic tool-call retries.
        try:
            async with asyncio.timeout(45):
                async with httpx2.AsyncClient(  # noqa: SIM117 - ordered transport lifetimes
                    headers={"x-api-key": key},
                    timeout=30,
                    follow_redirects=False,
                ) as client:
                    async with streamable_http_client(
                        "https://mcp.desearch.ai/mcp", http_client=client
                    ) as (read, write):
                        async with ClientSession(
                            read, write, read_timeout_seconds=30
                        ) as session:
                            await session.initialize()
                            result = await session.call_tool(
                                "search", {"query": query.strip()}
                            )
            if result.is_error:
                # Never echo remote error text, headers, or exception details.
                return "Error: Desearch rejected the search. Check your key and service status."
            text = "\n".join(
                item.text
                for item in result.content
                if getattr(item, "type", None) == "text"
            )
            if not text:
                return "Error: Desearch returned no text result."
            # Also guard against a service accidentally reflecting the credential.
            return text.replace(key, "[redacted]").replace(
                json.dumps(key)[1:-1], "[redacted]"
            )
        except Exception:  # noqa: BLE001 - keep transport exception details out of model output
            return "Error: Desearch is unavailable or the request failed. No automatic retry was made."
