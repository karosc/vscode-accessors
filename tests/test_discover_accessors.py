from __future__ import annotations

import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python.accessor_discovery import discover_accessors


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


if __name__ == "__main__":
    unittest.main()
