import importlib.util
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

spec = importlib.util.spec_from_file_location(
    "desearch_tool", Path(__file__).parents[1] / "desearch.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["", "   ", None, 42, "a" * 2001])
async def test_malformed_query_never_connects(query, monkeypatch):
    connect = AsyncMock()
    monkeypatch.setattr(module, "streamable_http_client", connect)
    assert (await module.Tools().search(query)).startswith("Error: query")
    connect.assert_not_called()


@pytest.mark.asyncio
async def test_missing_key_and_isolation():
    tool = module.Tools()
    assert "User Valves" in await tool.search("python docs")
    assert "User Valves" in await tool.search(
        "python docs", {"valves": tool.UserValves()}
    )
    assert "invalid" in await tool.search(
        "python docs", {"valves": tool.UserValves(DESEARCH_API_KEY="bad\nkey")}
    )
    assert not hasattr(tool, "key")


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "remote", "network", "empty"])
async def test_forwarding_redaction_and_no_retry(monkeypatch, failure):
    key = 'test-key-"-sentinel'
    result = SimpleNamespace(
        is_error=failure == "remote",
        content=[]
        if failure == "empty"
        else [SimpleNamespace(type="text", text=json.dumps({"results": [key]}))],
    )
    session = SimpleNamespace(
        initialize=AsyncMock(), call_tool=AsyncMock(return_value=result)
    )
    if failure == "network":
        session.call_tool.side_effect = RuntimeError(key)

    @asynccontextmanager
    async def transport(url, http_client):
        assert url == "https://mcp.desearch.ai/mcp"
        assert http_client.headers["x-api-key"] == key
        yield None, None

    @asynccontextmanager
    async def client_session(*args, **kwargs):
        yield session

    monkeypatch.setattr(module, "streamable_http_client", transport)
    monkeypatch.setattr(module, "ClientSession", client_session)
    output = await module.Tools().search(
        " python docs ", {"valves": module.Tools.UserValves(DESEARCH_API_KEY=key)}
    )
    assert key not in output and json.dumps(key)[1:-1] not in output
    session.call_tool.assert_awaited_once_with("search", {"query": "python docs"})
    assert output.startswith("Error:") == (failure is not None)


def test_native_secret_schema_and_single_tool():
    schema = module.Tools.UserValves.model_json_schema()
    assert schema["properties"]["DESEARCH_API_KEY"]["input"]["type"] == "password"
    assert schema["properties"]["DESEARCH_API_KEY"]["default"] == ""
    assert "sentinel" not in repr(module.Tools.UserValves(DESEARCH_API_KEY="sentinel"))
    assert [
        name
        for name in dir(module.Tools())
        if not name.startswith("_") and name[0].islower()
    ] == ["search"]
