from __future__ import annotations

import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python.accessor_discovery import (
    analyze_source_file,
    discover_accessors,
    discover_imported_accessors,
    discover_scope_context,
)


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def handle_request(request: dict) -> dict:
    mode = request.get("mode", "discover")
    workspace = Path(request["workspace"])
    source_file = Path(request["file"])
    source = request.get("source")
    line = request.get("line")

    if mode == "scope":
        return discover_scope_context(
            workspace_root=workspace,
            source_file=source_file,
            source_override=source,
            cursor_line=line,
        )

    if mode == "local":
        return analyze_source_file(
            workspace_root=workspace,
            source_file=source_file,
            source_override=source,
        )

    if mode == "imports":
        return discover_imported_accessors(
            workspace_root=workspace,
            source_file=source_file,
            import_requests=request.get("imports", []),
            current_package=request.get("current_package", ""),
        )

    search_roots = [Path(root) for root in request.get("search_roots", [])]
    return discover_accessors(
        workspace_root=workspace,
        source_file=source_file,
        extra_search_roots=search_roots,
        source_override=source,
        cursor_line=line,
    )


def main() -> int:
    emit({"type": "ready"})
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request = json.loads(raw_line)
        request_id = request.get("id")
        try:
            result = handle_request(request)
        except Exception as error:
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": str(error),
                }
            )
            continue

        emit(
            {
                "id": request_id,
                "ok": True,
                "result": result,
            }
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
