"""Write Open WebUI's native Tools import JSON to stdout (never includes valves)."""

import json
from pathlib import Path

source = Path(__file__).with_name("desearch.py").read_text()
print(
    json.dumps(
        [
            {
                "id": "desearch",
                "name": "Desearch",
                "content": source,
                "meta": {
                    "description": "Search the web through the hosted Desearch MCP service."
                },
                "access_grants": [],
            }
        ],
        indent=2,
    )
)
