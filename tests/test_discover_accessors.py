from __future__ import annotations

import sys
import unittest
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


FIXTURES = PROJECT_ROOT / "tests" / "fixtures"
WORKSPACE = FIXTURES / "workspace"
SITEPKGS = FIXTURES / "sitepkgs"


class AccessorDiscoveryTests(unittest.TestCase):
    def test_direct_import_discovers_xarray_accessors(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            extra_search_roots=[SITEPKGS],
        )

        names = {(item["host_type"], item["accessor_name"]) for item in report["accessors"]}
        self.assertIn(("xarray.DataArray", "cf"), names)
        self.assertIn(("xarray.Dataset", "cf"), names)
        self.assertEqual(report["symbol_types"]["ds"], "xarray.Dataset")
        self.assertEqual(report["symbol_types"]["da"], "xarray.DataArray")

        chain = next(
            item["activation_chain"]
            for item in report["accessors"]
            if item["host_type"] == "xarray.DataArray"
        )
        self.assertEqual(chain[0], str(WORKSPACE / "use_cf.py"))
        self.assertIn("cf_xarray", chain)

        dataarray_accessor = next(
            item for item in report["accessors"] if item["host_type"] == "xarray.DataArray"
        )
        member_names = {member["name"] for member in dataarray_accessor["members"]}
        self.assertIn("axes", member_names)
        self.assertIn("summary", member_names)

    def test_recursive_workspace_import_discovers_accessors(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "consumer.py",
            extra_search_roots=[SITEPKGS],
        )

        names = {(item["host_type"], item["accessor_name"]) for item in report["accessors"]}
        self.assertIn(("xarray.DataArray", "cf"), names)
        self.assertIn("bootstrap", report["visited_modules"])

    def test_pandas_accessor_is_discovered(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_pandas.py",
            extra_search_roots=[SITEPKGS],
        )

        names = {(item["host_type"], item["accessor_name"]) for item in report["accessors"]}
        self.assertIn(("pandas.DataFrame", "demo"), names)
        self.assertEqual(report["symbol_types"]["df"], "pandas.DataFrame")

    def test_type_checking_import_does_not_activate_accessor(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "type_checking_only.py",
            extra_search_roots=[SITEPKGS],
        )

        self.assertEqual(report["accessors"], [])

    def test_conditional_import_is_skipped_with_note(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "conditional_import.py",
            extra_search_roots=[SITEPKGS],
        )

        self.assertEqual(report["accessors"], [])
        self.assertTrue(any("Skipped conditional import block" in note for note in report["notes"]))

    def test_function_scope_symbols_are_inferred_at_cursor_line(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "function_scope.py",
            extra_search_roots=[SITEPKGS],
            cursor_line=6,
        )

        self.assertEqual(report["symbol_types"]["da"], "xarray.Dataset")
        self.assertEqual(report["symbol_types"]["local"], "xarray.Dataset")

    def test_root_from_import_does_not_report_optional_marker(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "from_import_root.py",
            extra_search_roots=[SITEPKGS],
        )

        self.assertFalse(
            any(item["module_name"].startswith("?") for item in report["unresolved_imports"])
        )

    def test_scope_aliases_include_imported_host_types(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "imported_dataset_name.py",
            extra_search_roots=[SITEPKGS],
            cursor_line=5,
        )

        self.assertEqual(report["scope_aliases"]["Dataset"], "xarray.Dataset")

    def test_module_locations_include_import_targets(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "from_import_root.py",
            extra_search_roots=[SITEPKGS],
        )

        self.assertEqual(
            Path(report["module_locations"]["cf_xarray"]["file_path"]),
            SITEPKGS / "cf_xarray" / "__init__.py",
        )
        self.assertEqual(
            Path(report["module_locations"]["cf_xarray.accessors"]["file_path"]),
            SITEPKGS / "cf_xarray" / "accessors.py",
        )

    def test_accessor_members_include_definition_file_paths(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            extra_search_roots=[SITEPKGS],
        )

        dataarray_accessor = next(
            item for item in report["accessors"] if item["host_type"] == "xarray.DataArray"
        )
        summary_member = next(
            member for member in dataarray_accessor["members"] if member["name"] == "summary"
        )
        self.assertEqual(
            Path(summary_member["file_path"]),
            SITEPKGS / "cf_xarray" / "accessors.py",
        )

    def test_incomplete_accessor_line_is_sanitized_for_parsing(self) -> None:
        report = discover_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            extra_search_roots=[SITEPKGS],
            source_override=(
                "import xarray as xr\n"
                "import cf_xarray\n\n"
                "da = xr.Dataset()\n"
                "da.cf.\n"
            ),
            cursor_line=5,
        )

        names = {(item["host_type"], item["accessor_name"]) for item in report["accessors"]}
        self.assertIn(("xarray.Dataset", "cf"), names)
        self.assertEqual(report["symbol_types"]["da"], "xarray.Dataset")
        self.assertTrue(any("Sanitized line 5" in note for note in report["notes"]))

    def test_scope_only_report_infers_symbols_without_import_walk(self) -> None:
        report = discover_scope_context(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "function_scope.py",
            source_override=(
                "import xarray as xr\n"
                "import cf_xarray\n\n"
                "def render(da: xr.Dataset):\n"
                "    local = xr.Dataset()\n"
                "    return da, local\n"
            ),
            cursor_line=5,
        )

        self.assertEqual(report["symbol_types"]["da"], "xarray.Dataset")
        self.assertEqual(report["symbol_types"]["local"], "xarray.Dataset")
        self.assertNotIn("accessors", report)

    def test_analyze_source_file_reports_local_imports_and_accessors(self) -> None:
        report = analyze_source_file(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            source_override=(
                "import xarray as xr\n"
                "import cf_xarray\n\n"
                "@xr.register_dataset_accessor('demo')\n"
                "class DemoAccessor:\n"
                "    pass\n"
            ),
        )

        self.assertIn("cf_xarray", report["imports"])
        self.assertIn(("xarray.Dataset", "demo"), {(item["host_type"], item["accessor_name"]) for item in report["accessors"]})

    def test_function_accessor_is_discovered(self) -> None:
        report = analyze_source_file(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            source_override=(
                "import xarray\n\n"
                "@xarray.register_dataset_accessor('ems')\n"
                "def ems_accessor(dataset: xarray.Dataset) -> Convention:\n"
                "    \"\"\"Resolve the convention accessor.\"\"\"\n"
                "    return Convention(dataset)\n\n"
                "class Convention:\n"
                "    def summary(self) -> str:\n"
                "        return ''\n"
            ),
        )

        accessor = next(
            item for item in report["accessors"] if item["accessor_name"] == "ems"
        )
        self.assertEqual(accessor["host_type"], "xarray.Dataset")
        self.assertEqual(accessor["accessor_class"], "Convention")
        self.assertEqual(accessor["docstring"], "Resolve the convention accessor.")
        self.assertIn("summary", {member["name"] for member in accessor["members"]})

    def test_function_accessor_uses_imported_return_class_members(self) -> None:
        report = analyze_source_file(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            source_override=(
                "import xarray as xr\n"
                "from conventions import Convention\n\n"
                "@xr.register_dataset_accessor('ems')\n"
                "def ems_accessor(dataset: xr.Dataset) -> Convention:\n"
                "    return Convention(dataset)\n"
            ),
        )

        accessor = next(
            item for item in report["accessors"] if item["accessor_name"] == "ems"
        )
        self.assertEqual(accessor["accessor_class"], "Convention")
        self.assertIn("summary", {member["name"] for member in accessor["members"]})
        self.assertIn("title", {member["name"] for member in accessor["members"]})

    def test_callable_registration_accessor_is_discovered(self) -> None:
        report = analyze_source_file(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            source_override=(
                "import dataclasses\n"
                "import xarray\n\n"
                "@dataclasses.dataclass\n"
                "class State:\n"
                "    accessor_name: str = '_emsarray_state'\n\n"
                "    def is_bound(self) -> bool:\n"
                "        return False\n\n"
                "xarray.register_dataset_accessor(State.accessor_name)(State)\n"
            ),
        )

        accessor = next(
            item
            for item in report["accessors"]
            if item["accessor_name"] == "_emsarray_state"
        )
        self.assertEqual(accessor["host_type"], "xarray.Dataset")
        self.assertEqual(accessor["accessor_class"], "State")
        self.assertIn("is_bound", {member["name"] for member in accessor["members"]})

    def test_discover_imported_accessors_skips_root_accessors(self) -> None:
        report = discover_imported_accessors(
            workspace_root=WORKSPACE,
            source_file=WORKSPACE / "use_cf.py",
            import_requests=["xarray", "cf_xarray"],
            current_package="",
            extra_search_roots=[SITEPKGS],
        )

        names = {(item["host_type"], item["accessor_name"]) for item in report["accessors"]}
        self.assertIn(("xarray.Dataset", "cf"), names)
        self.assertNotIn(("xarray.Dataset", "demo"), names)


if __name__ == "__main__":
    unittest.main()
