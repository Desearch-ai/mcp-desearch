"""Run inside a disposable Open WebUI 0.13.3 container after REST import.

Uses the host's real DB, module loader, discovery, UserValves injection and
guarded callable used by chat. No language model or search response is mocked.
JSON stdin: {"query": "..."}. Never prints stored UserValves.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

os.environ["WEBUI_SECRET_KEY"] = Path(".webui_secret_key").read_text().strip()

from fastapi import Request
from open_webui.main import app
from open_webui.models.users import Users
from open_webui.utils.tools import get_tools


async def main():
    payload = json.load(sys.stdin)
    user = await Users.get_user_by_email("admin@localhost")
    request = Request({"type": "http", "app": app, "headers": []})
    tools = await get_tools(
        request, ["desearch"], user, {"__user__": user.model_dump()}
    )
    if not tools:
        print(json.dumps({"discovered": []}))
        return
    assert list(tools) == ["search"], list(tools)
    spec = tools["search"]["spec"]
    assert set(spec["parameters"]["properties"]) == {"query"}, spec
    if payload.get("network_failure"):
        with patch(
            "httpx2.AsyncClient", side_effect=ConnectionError("test disconnect")
        ) as connect:
            output = await tools["search"]["callable"](query=payload["query"])
            assert connect.call_count == 1
            assert output.startswith("Error: Desearch is unavailable")
    else:
        output = await tools["search"]["callable"](query=payload["query"])
    print(
        "T595_RESULT="
        + json.dumps({"discovered": list(tools), "spec": spec, "output": output})
    )


asyncio.run(main())
