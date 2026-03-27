from __future__ import annotations

import ast
import importlib.util
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


KNOWN_REGISTRARS = {
    "xarray.register_dataarray_accessor": "xarray.DataArray",
    "xarray.register_dataset_accessor": "xarray.Dataset",
    "xarray.register_datatree_accessor": "xarray.DataTree",
    "pandas.api.extensions.register_dataframe_accessor": "pandas.DataFrame",
    "pandas.api.extensions.register_series_accessor": "pandas.Series",
    "pandas.api.extensions.register_index_accessor": "pandas.Index",
}

KNOWN_FACTORIES = {
    "xarray.Dataset": "xarray.Dataset",
    "xarray.DataArray": "xarray.DataArray",
    "xarray.DataTree": "xarray.DataTree",
    "xarray.open_dataset": "xarray.Dataset",
    "xarray.open_dataarray": "xarray.DataArray",
    "pandas.DataFrame": "pandas.DataFrame",
    "pandas.Series": "pandas.Series",
    "pandas.Index": "pandas.Index",
    "pandas.read_csv": "pandas.DataFrame",
    "pandas.read_parquet": "pandas.DataFrame",
    "pandas.read_json": "pandas.DataFrame",
}

KNOWN_TYPE_NAMES = set(KNOWN_FACTORIES.values())


@dataclass(frozen=True)
class ModuleLocation:
    module_name: str
    file_path: Path | None
    is_package: bool


@dataclass(frozen=True)
class ParsedModule:
    tree: ast.Module
    imports: list[str]
    aliases: dict[str, str]


@dataclass(frozen=True)
class ScopeContext:
    symbol_types: dict[str, str]
    aliases: dict[str, str]


def discover_accessors(
    workspace_root: Path,
    source_file: Path,
    extra_search_roots: Iterable[Path] = (),
    source_override: str | None = None,
    cursor_line: int | None = None,
) -> dict:
    context = DiscoveryContext(
        workspace_root=workspace_root.resolve(),
        source_file=source_file.resolve(),
        extra_search_roots=[Path(root).resolve() for root in extra_search_roots],
        source_override=source_override,
        cursor_line=cursor_line,
    )
    return context.run()


def discover_scope_context(
    workspace_root: Path,
    source_file: Path,
    source_override: str | None = None,
    cursor_line: int | None = None,
) -> dict:
    resolved_workspace = workspace_root.resolve()
    resolved_source = source_file.resolve()
    if not resolved_source.is_file():
        raise FileNotFoundError(f"Source file does not exist: {resolved_source}")

    try:
        resolved_source.relative_to(resolved_workspace)
    except ValueError as error:
        raise ValueError("Source file must be inside the workspace root") from error

    root_module_name = infer_module_name(resolved_workspace, resolved_source)
    notes: list[str] = []
    source = source_override if source_override is not None else resolved_source.read_text(encoding="utf-8")
    parsed = parse_python_source(
        source=source,
        filename=resolved_source,
        module_name=root_module_name,
        is_package=resolved_source.name == "__init__.py",
        notes=notes,
    )
    current_package = (
        root_module_name
        if resolved_source.name == "__init__.py"
        else root_module_name.rpartition(".")[0]
    )
    scope_context = infer_symbol_types(
        parsed.tree,
        parsed.aliases,
        cursor_line,
        current_package,
    )
    notes.sort()
    return {
        "workspace_root": str(resolved_workspace),
        "source_file": str(resolved_source),
        "source_module_name": root_module_name,
        "symbol_types": scope_context.symbol_types,
        "scope_aliases": scope_context.aliases,
        "notes": notes,
    }


def analyze_source_file(
    workspace_root: Path,
    source_file: Path,
    source_override: str | None = None,
) -> dict:
    resolved_workspace = workspace_root.resolve()
    resolved_source = source_file.resolve()
    if not resolved_source.is_file():
        raise FileNotFoundError(f"Source file does not exist: {resolved_source}")

    try:
        resolved_source.relative_to(resolved_workspace)
    except ValueError as error:
        raise ValueError("Source file must be inside the workspace root") from error

    root_module_name = infer_module_name(resolved_workspace, resolved_source)
    notes: list[str] = []
    source = source_override if source_override is not None else resolved_source.read_text(encoding="utf-8")
    is_package = resolved_source.name == "__init__.py"
    parsed = parse_python_source(
        source=source,
        filename=resolved_source,
        module_name=root_module_name,
        is_package=is_package,
        notes=notes,
    )
    accessors = collect_accessors_from_parsed_module(
        path=resolved_source,
        module_name=root_module_name,
        parsed=parsed,
        activation_chain=[str(resolved_source)],
    )
    current_package = root_module_name if is_package else root_module_name.rpartition(".")[0]
    accessors.sort(key=lambda item: (item["host_type"], item["accessor_name"], item["module_name"]))
    notes.sort()
    return {
        "workspace_root": str(resolved_workspace),
        "source_file": str(resolved_source),
        "source_module_name": root_module_name,
        "current_package": current_package,
        "imports": parsed.imports,
        "accessors": accessors,
        "notes": notes,
        "module_locations": {
            root_module_name: {
                "file_path": str(resolved_source),
                "is_package": is_package,
            }
        },
    }


def discover_imported_accessors(
    workspace_root: Path,
    source_file: Path,
    import_requests: Iterable[str],
    current_package: str,
    extra_search_roots: Iterable[Path] = (),
) -> dict:
    context = DiscoveryContext(
        workspace_root=workspace_root.resolve(),
        source_file=source_file.resolve(),
        extra_search_roots=[Path(root).resolve() for root in extra_search_roots],
        source_override=None,
        cursor_line=None,
    )
    if not context.source_file.is_file():
        raise FileNotFoundError(f"Source file does not exist: {context.source_file}")
    if not context._is_within_workspace(context.source_file):
        raise ValueError("Source file must be inside the workspace root")

    root_module_name = infer_module_name(context.workspace_root, context.source_file)
    context._visit_import_requests(list(import_requests), str(context.source_file), current_package)
    context.accessors.sort(key=lambda item: (item["host_type"], item["accessor_name"], item["module_name"]))
    context.unresolved_imports.sort(key=lambda item: (item["importer"], item["module_name"]))
    context.notes.sort()
    return {
        "workspace_root": str(context.workspace_root),
        "source_file": str(context.source_file),
        "source_module_name": root_module_name,
        "search_roots": [str(path) for path in context.search_roots],
        "module_locations": context._serialize_module_locations(root_module_name),
        "accessors": context.accessors,
        "visited_modules": context.visited_modules,
        "unresolved_imports": context.unresolved_imports,
        "notes": context.notes,
    }


class DiscoveryContext:
    def __init__(
        self,
        workspace_root: Path,
        source_file: Path,
        extra_search_roots: list[Path],
        source_override: str | None,
        cursor_line: int | None,
    ) -> None:
        self.workspace_root = workspace_root
        self.source_file = source_file
        self.source_override = source_override
        self.cursor_line = cursor_line
        self.search_roots = self._build_search_roots(extra_search_roots)
        self.accessors: list[dict] = []
        self.visited_modules: list[str] = []
        self.visited_set: set[str] = set()
        self.unresolved_imports: list[dict] = []
        self.unresolved_seen: set[tuple[str, str]] = set()
        self.notes: list[str] = []
        self.module_cache: dict[str, ModuleLocation | None] = {}
        self.parent_by_module: dict[str, str] = {}
        self.parsed_cache: dict[Path, ParsedModule] = {}
        self.symbol_types: dict[str, str] = {}
        self.scope_aliases: dict[str, str] = {}

    def run(self) -> dict:
        if not self.source_file.is_file():
            raise FileNotFoundError(f"Source file does not exist: {self.source_file}")
        if not self._is_within_workspace(self.source_file):
            raise ValueError("Source file must be inside the workspace root")

        root_module_name = infer_module_name(self.workspace_root, self.source_file)
        parsed_root = self._visit_source_file(root_module_name)
        scope_context = infer_symbol_types(
            parsed_root.tree,
            parsed_root.aliases,
            self.cursor_line,
            root_module_name if self.source_file.name == "__init__.py" else root_module_name.rpartition(".")[0],
        )
        self.symbol_types = scope_context.symbol_types
        self.scope_aliases = scope_context.aliases
        self.accessors.sort(key=lambda item: (item["host_type"], item["accessor_name"], item["module_name"]))
        self.unresolved_imports.sort(key=lambda item: (item["importer"], item["module_name"]))
        self.notes.sort()
        return {
            "workspace_root": str(self.workspace_root),
            "source_file": str(self.source_file),
            "source_module_name": root_module_name,
            "search_roots": [str(path) for path in self.search_roots],
            "module_locations": self._serialize_module_locations(root_module_name),
            "symbol_types": self.symbol_types,
            "scope_aliases": self.scope_aliases,
            "accessors": self.accessors,
            "visited_modules": self.visited_modules,
            "unresolved_imports": self.unresolved_imports,
            "notes": self.notes,
        }

    def _serialize_module_locations(self, root_module_name: str) -> dict[str, dict]:
        serialized = {
            root_module_name: {
                "file_path": str(self.source_file),
                "is_package": self.source_file.name == "__init__.py",
            }
        }
        for module_name, location in self.module_cache.items():
            if location is None:
                continue
            serialized[module_name] = {
                "file_path": str(location.file_path) if location.file_path is not None else None,
                "is_package": location.is_package,
            }
        return serialized

    def _build_search_roots(self, extra_search_roots: list[Path]) -> list[Path]:
        ordered: list[Path] = []
        for candidate in [self.workspace_root, *extra_search_roots, *map(Path, sys.path)]:
            resolved = candidate.resolve()
            if not resolved.exists():
                continue
            if resolved not in ordered:
                ordered.append(resolved)
        return ordered

    def _visit_source_file(self, module_name: str) -> ParsedModule:
        root_label = str(self.source_file)
        parsed = self._parse_module(
            path=self.source_file,
            module_name=module_name,
            is_package=self.source_file.name == "__init__.py",
            use_source_override=True,
        )
        self._collect_accessors(
            path=self.source_file,
            module_name=module_name,
            parsed=parsed,
            activation_anchor=root_label,
        )
        current_package = module_name if self.source_file.name == "__init__.py" else module_name.rpartition(".")[0]
        self._visit_import_requests(parsed.imports, root_label, current_package)
        return parsed

    def _visit_required_chain(self, module_name: str, importer: str) -> None:
        parent = importer
        for prefix in expand_module_prefixes(module_name):
            location = self._visit_module(prefix, parent, required=True)
            if location is None:
                return
            parent = prefix

    def _visit_optional_module(self, module_name: str, importer: str) -> None:
        parent = importer
        prefixes = expand_module_prefixes(module_name)
        for prefix in prefixes[:-1]:
            location = self._visit_module(prefix, parent, required=False)
            if location is None:
                return
            parent = prefix
        if prefixes:
            self._visit_module(prefixes[-1], parent, required=False)

    def _visit_module(
        self,
        module_name: str,
        importer: str,
        required: bool,
    ) -> ModuleLocation | None:
        if module_name in self.visited_set:
            return self.module_cache.get(module_name)

        location = self._resolve_module(module_name)
        if location is None:
            if required:
                key = (importer, module_name)
                if key not in self.unresolved_seen:
                    self.unresolved_seen.add(key)
                    self.unresolved_imports.append(
                        {"importer": importer, "module_name": module_name}
                    )
            return None

        self.visited_set.add(module_name)
        self.visited_modules.append(module_name)
        self.module_cache[module_name] = location
        self.parent_by_module[module_name] = importer

        if location.file_path is None:
            return location

        parsed = self._parse_module(
            path=location.file_path,
            module_name=module_name,
            is_package=location.is_package,
            use_source_override=False,
        )
        self._collect_accessors(
            path=location.file_path,
            module_name=module_name,
            parsed=parsed,
            activation_anchor=module_name,
        )
        current_package = module_name if location.is_package else module_name.rpartition(".")[0]
        self._visit_import_requests(parsed.imports, module_name, current_package)

        return location

    def _visit_import_requests(
        self,
        requests: list[str],
        importer: str,
        current_package: str,
    ) -> None:
        for request in requests:
            if request.startswith("."):
                resolved = resolve_relative_import(request, current_package)
                if resolved is None:
                    note = (
                        f"Skipped relative import {request!r} in {importer}: "
                        "could not resolve package context"
                    )
                    add_note(self.notes, note)
                    continue
                request = resolved

            if request.endswith(".*"):
                self._visit_required_chain(request[:-2], importer)
                continue

            if request.startswith("?"):
                optional_target = request[1:]
                if optional_target.startswith("."):
                    resolved = resolve_relative_import(optional_target, current_package)
                    if resolved is None:
                        continue
                    optional_target = resolved
                self._visit_optional_module(optional_target, importer)
                continue

            self._visit_required_chain(request, importer)

    def _parse_module(
        self,
        path: Path,
        module_name: str,
        is_package: bool,
        use_source_override: bool,
    ) -> ParsedModule:
        if path in self.parsed_cache and not use_source_override:
            return self.parsed_cache[path]

        source = self._read_source(path, use_source_override)
        parsed = parse_python_source(
            source=source,
            filename=path,
            module_name=module_name,
            is_package=is_package,
            notes=self.notes,
        )
        if not use_source_override:
            self.parsed_cache[path] = parsed
        return parsed

    def _read_source(self, path: Path, use_source_override: bool) -> str:
        if use_source_override and self.source_override is not None:
            return self.source_override
        return path.read_text(encoding="utf-8")

    def _collect_accessors(
        self,
        path: Path,
        module_name: str,
        parsed: ParsedModule,
        activation_anchor: str,
    ) -> None:
        self.accessors.extend(
            collect_accessors_from_parsed_module(
                path=path,
                module_name=module_name,
                parsed=parsed,
                activation_chain=self._activation_chain_for(activation_anchor),
            )
        )

    def _activation_chain_for(self, anchor: str) -> list[str]:
        chain = [anchor]
        current = anchor
        while current in self.parent_by_module:
            current = self.parent_by_module[current]
            chain.append(current)
        chain.reverse()
        return chain

    def _resolve_module(self, module_name: str) -> ModuleLocation | None:
        if module_name in self.module_cache:
            return self.module_cache[module_name]

        parts = module_name.split(".")
        for root in self.search_roots:
            resolution = resolve_module_from_root(root, parts)
            if resolution is not None:
                self.module_cache[module_name] = resolution
                return resolution
        self.module_cache[module_name] = None
        return None

    def _is_within_workspace(self, path: Path) -> bool:
        try:
            path.relative_to(self.workspace_root)
            return True
        except ValueError:
            return False


def parse_python_source(
    source: str,
    filename: Path,
    module_name: str,
    is_package: bool,
    notes: list[str],
) -> ParsedModule:
    tree = parse_python_source_with_recovery(
        source=source,
        filename=filename,
        module_name=module_name,
        notes=notes,
    )
    imports: list[str] = []
    aliases: dict[str, str] = {}
    current_package = module_name if is_package else module_name.rpartition(".")[0]

    for statement in tree.body:
        if isinstance(statement, ast.Import):
            imports.extend(alias.name for alias in statement.names)
            update_aliases_for_import(statement, aliases)
            continue

        if isinstance(statement, ast.ImportFrom):
            imports.extend(parse_import_from(statement))
            update_aliases_for_import_from(statement, aliases, current_package)
            continue

        if isinstance(statement, ast.If):
            if is_type_checking_test(statement.test):
                continue
            if block_contains_import(statement.body) or block_contains_import(statement.orelse):
                add_note(
                    notes,
                    f"Skipped conditional import block in {module_name} at line {statement.lineno}",
                )
            continue

        if isinstance(statement, (ast.Try, ast.With, ast.For, ast.AsyncFor, ast.While, ast.Match)):
            if block_contains_import(getattr(statement, "body", [])):
                add_note(
                    notes,
                    f"Skipped non-trivial import block in {module_name} at line {statement.lineno}",
                )
            continue

    return ParsedModule(tree=tree, imports=imports, aliases=aliases)


def parse_python_source_with_recovery(
    source: str,
    filename: Path,
    module_name: str,
    notes: list[str],
) -> ast.Module:
    candidate_source = source
    sanitized_lines: set[int] = set()

    for _ in range(8):
        try:
            return ast.parse(candidate_source, filename=str(filename))
        except SyntaxError as error:
            line_number = error.lineno
            if line_number is None or line_number < 1 or line_number in sanitized_lines:
                raise

            updated_source = sanitize_source_line(candidate_source, line_number)
            if updated_source == candidate_source:
                raise

            sanitized_lines.add(line_number)
            candidate_source = updated_source
            add_note(
                notes,
                f"Sanitized line {line_number} in {module_name} for parsing after syntax error: {error.msg}",
            )

    return ast.parse(candidate_source, filename=str(filename))


def sanitize_source_line(source: str, line_number: int) -> str:
    lines = source.splitlines(keepends=True)
    index = line_number - 1
    if index < 0 or index >= len(lines):
        return source

    line = lines[index]
    line_without_newline = line.rstrip("\r\n")
    newline = line[len(line_without_newline) :]
    indentation = re.match(r"[ \t]*", line_without_newline).group(0)
    replacement = f"{indentation}pass"
    if newline:
        replacement += newline
    lines[index] = replacement
    return "".join(lines)


def update_aliases_for_import(statement: ast.Import, aliases: dict[str, str]) -> None:
    for alias in statement.names:
        binding = alias.asname or alias.name.split(".")[0]
        target = alias.name if alias.asname else alias.name.split(".")[0]
        aliases[binding] = target


def update_aliases_for_import_from(
    statement: ast.ImportFrom,
    aliases: dict[str, str],
    current_package: str,
) -> None:
    base = statement.module or ""
    if statement.level:
        base = resolve_relative_import("." * statement.level + base, current_package) or ""
    if not base:
        return
    for alias in statement.names:
        if alias.name == "*":
            continue
        binding = alias.asname or alias.name
        aliases[binding] = f"{base}.{alias.name}"


def parse_import_from(statement: ast.ImportFrom) -> list[str]:
    base = statement.module or ""
    if statement.level:
        base_reference = "." * statement.level + base
    else:
        base_reference = base

    imports = [base_reference] if base_reference else []
    if not base_reference:
        return imports

    for alias in statement.names:
        if alias.name == "*":
            imports.append(f"{base_reference}.*")
            continue
        imports.append(f"?{join_import_reference(base_reference, alias.name)}")
    return imports


def resolve_relative_import(reference: str, current_package: str) -> str | None:
    try:
        return importlib.util.resolve_name(reference, current_package)
    except (ImportError, ValueError):
        return None


def expand_module_prefixes(module_name: str) -> list[str]:
    if not module_name:
        return []
    parts = module_name.split(".")
    return [".".join(parts[: index + 1]) for index in range(len(parts))]


def resolve_module_from_root(root: Path, parts: list[str]) -> ModuleLocation | None:
    current = root
    last_file: Path | None = None
    is_package = False
    for index, part in enumerate(parts):
        package_dir = current / part
        init_path = package_dir / "__init__.py"
        module_path = current / f"{part}.py"

        if init_path.is_file():
            current = package_dir
            last_file = init_path
            is_package = True
            continue

        if module_path.is_file():
            if index != len(parts) - 1:
                return None
            return ModuleLocation(".".join(parts), module_path, False)

        if package_dir.is_dir():
            current = package_dir
            last_file = None
            is_package = True
            continue

        return None

    return ModuleLocation(".".join(parts), last_file, is_package)


def infer_module_name(workspace_root: Path, file_path: Path) -> str:
    relative = file_path.relative_to(workspace_root)
    parts = list(relative.parts)
    if parts[-1] == "__init__.py":
        parts = parts[:-1]
    else:
        parts[-1] = Path(parts[-1]).stem
    return ".".join(parts)


def join_import_reference(base: str, child: str) -> str:
    if base.startswith(".") and base.strip(".") == "":
        return f"{base}{child}"
    return f"{base}.{child}"


def block_contains_import(statements: list[ast.stmt]) -> bool:
    for statement in statements:
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            return True
        if isinstance(statement, ast.If):
            if block_contains_import(statement.body) or block_contains_import(statement.orelse):
                return True
    return False


def is_type_checking_test(node: ast.AST) -> bool:
    if isinstance(node, ast.Name):
        return node.id == "TYPE_CHECKING"
    if isinstance(node, ast.Attribute):
        return render_dotted_name(node, {}) == "typing.TYPE_CHECKING"
    return False


def infer_symbol_types(
    tree: ast.Module,
    aliases: dict[str, str],
    cursor_line: int | None,
    current_package: str,
) -> ScopeContext:
    target_line = cursor_line or 10**9
    return infer_scope_symbols(
        tree.body,
        aliases,
        target_line,
        inherited_symbols={},
        current_package=current_package,
    )


def infer_scope_symbols(
    statements: list[ast.stmt],
    aliases: dict[str, str],
    target_line: int,
    inherited_symbols: dict[str, str],
    current_package: str,
) -> ScopeContext:
    local_aliases = dict(aliases)
    symbol_types = dict(inherited_symbols)

    for statement in statements:
        if statement.lineno > target_line:
            break

        if isinstance(statement, ast.Import):
            update_aliases_for_import(statement, local_aliases)
            continue

        if isinstance(statement, ast.ImportFrom):
            update_aliases_for_import_from(statement, local_aliases, current_package)
            continue

        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if line_contains_node(target_line, statement):
                function_symbols = dict(symbol_types)
                function_symbols.update(infer_parameter_types(statement, local_aliases))
                return infer_scope_symbols(
                    statement.body,
                    local_aliases,
                    target_line,
                    function_symbols,
                    current_package=current_package,
                )
            continue

        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            resolved = resolve_known_type_annotation(statement.annotation, local_aliases)
            if resolved is not None:
                symbol_types[statement.target.id] = resolved
                continue
            if statement.value is not None:
                inferred = resolve_known_value_type(statement.value, local_aliases, symbol_types)
                if inferred is not None:
                    symbol_types[statement.target.id] = inferred
            continue

        if isinstance(statement, ast.Assign):
            inferred = resolve_known_value_type(statement.value, local_aliases, symbol_types)
            if inferred is None:
                continue
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    symbol_types[target.id] = inferred
            continue

    return ScopeContext(
        symbol_types=symbol_types,
        aliases=filter_known_aliases(local_aliases),
    )


def infer_parameter_types(
    statement: ast.FunctionDef | ast.AsyncFunctionDef,
    aliases: dict[str, str],
) -> dict[str, str]:
    symbol_types: dict[str, str] = {}
    all_arguments = [
        *statement.args.posonlyargs,
        *statement.args.args,
        *statement.args.kwonlyargs,
    ]
    if statement.args.vararg is not None:
        all_arguments.append(statement.args.vararg)
    if statement.args.kwarg is not None:
        all_arguments.append(statement.args.kwarg)

    for argument in all_arguments:
        resolved = resolve_known_type_annotation(argument.annotation, aliases)
        if resolved is not None:
            symbol_types[argument.arg] = resolved
    return symbol_types


def filter_known_aliases(aliases: dict[str, str]) -> dict[str, str]:
    filtered: dict[str, str] = {}
    for name, target in aliases.items():
        if target == "xarray" or target == "pandas":
            filtered[name] = target
            continue
        if target in KNOWN_TYPE_NAMES:
            filtered[name] = target
    return filtered


def line_contains_node(target_line: int, node: ast.AST) -> bool:
    start = getattr(node, "lineno", -1)
    end = getattr(node, "end_lineno", start)
    return start <= target_line <= end


def resolve_known_type_annotation(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Subscript):
        return resolve_known_type_annotation(node.value, aliases)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left = resolve_known_type_annotation(node.left, aliases)
        return left or resolve_known_type_annotation(node.right, aliases)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return resolve_known_type_string(node.value, aliases)
    rendered = render_dotted_name(node, aliases)
    if rendered in KNOWN_TYPE_NAMES:
        return rendered
    return None


def resolve_known_type_string(value: str, aliases: dict[str, str]) -> str | None:
    cleaned = value.strip().strip("\"'")
    if cleaned in KNOWN_TYPE_NAMES:
        return cleaned
    if cleaned in aliases and aliases[cleaned] in KNOWN_TYPE_NAMES:
        return aliases[cleaned]
    return None


def resolve_known_value_type(
    node: ast.AST,
    aliases: dict[str, str],
    symbol_types: dict[str, str],
) -> str | None:
    if isinstance(node, ast.Call):
        rendered = render_dotted_name(node.func, aliases)
        if rendered in KNOWN_FACTORIES:
            return KNOWN_FACTORIES[rendered]
    if isinstance(node, ast.Name):
        return symbol_types.get(node.id)
    return None


def collect_accessors_from_parsed_module(
    path: Path,
    module_name: str,
    parsed: ParsedModule,
    activation_chain: list[str],
) -> list[dict]:
    accessors: list[dict] = []
    for statement in parsed.tree.body:
        if not isinstance(statement, ast.ClassDef):
            continue
        for decorator in statement.decorator_list:
            record = parse_accessor_decorator(
                decorator=decorator,
                aliases=parsed.aliases,
                module_name=module_name,
                class_name=statement.name,
                file_path=path,
                class_node=statement,
                activation_chain=activation_chain,
            )
            if record is not None:
                accessors.append(record)
    return accessors


def parse_accessor_decorator(
    decorator: ast.expr,
    aliases: dict[str, str],
    module_name: str,
    class_name: str,
    file_path: Path,
    class_node: ast.ClassDef,
    activation_chain: list[str],
) -> dict | None:
    if not isinstance(decorator, ast.Call):
        return None
    resolved_name = render_dotted_name(decorator.func, aliases)
    host_type = KNOWN_REGISTRARS.get(resolved_name)
    if host_type is None:
        return None
    if not decorator.args:
        return None
    accessor_name = extract_string_literal(decorator.args[0])
    if accessor_name is None:
        return None
    return {
        "host_type": host_type,
        "accessor_name": accessor_name,
        "accessor_class": class_name,
        "module_name": module_name,
        "file_path": str(file_path),
        "decorator": resolved_name,
        "activation_chain": activation_chain,
        "line": class_node.lineno,
        "end_line": getattr(class_node, "end_lineno", class_node.lineno),
        "docstring": ast.get_docstring(class_node) or "",
        "members": extract_class_members(class_node, file_path),
    }


def extract_class_members(class_node: ast.ClassDef, file_path: Path) -> list[dict]:
    members: list[dict] = []
    for statement in class_node.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if statement.name.startswith("_") and statement.name != "__call__":
                continue
            members.append(
                {
                    "name": statement.name,
                    "kind": classify_function_member(statement),
                    "signature": format_function_signature(statement),
                    "line": statement.lineno,
                    "end_line": getattr(statement, "end_lineno", statement.lineno),
                    "file_path": str(file_path),
                    "docstring": ast.get_docstring(statement) or "",
                }
            )
            continue

        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            if statement.target.id.startswith("_"):
                continue
            members.append(
                {
                    "name": statement.target.id,
                    "kind": "attribute",
                    "signature": format_attribute_signature(statement),
                    "line": statement.lineno,
                    "end_line": getattr(statement, "end_lineno", statement.lineno),
                    "file_path": str(file_path),
                    "docstring": "",
                }
            )

    members.sort(key=lambda item: (item["line"], item["name"]))
    return members


def classify_function_member(statement: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    for decorator in statement.decorator_list:
        rendered = render_dotted_name(decorator, {})
        if rendered == "property":
            return "property"
    if statement.name == "__call__":
        return "callable"
    return "method"


def format_function_signature(statement: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    return f"{statement.name}({format_arguments(statement.args)}){format_return_annotation(statement.returns)}"


def format_attribute_signature(statement: ast.AnnAssign) -> str:
    if statement.annotation is None:
        return statement.target.id
    return f"{statement.target.id}: {safe_unparse(statement.annotation)}"


def format_arguments(arguments: ast.arguments) -> str:
    parts: list[str] = []
    positional = [*arguments.posonlyargs, *arguments.args]
    default_offset = len(positional) - len(arguments.defaults)

    for index, argument in enumerate(arguments.posonlyargs):
        default = None
        if index >= default_offset:
            default = arguments.defaults[index - default_offset]
        parts.append(format_argument(argument, default))
    if arguments.posonlyargs:
        parts.append("/")

    for index, argument in enumerate(arguments.args, start=len(arguments.posonlyargs)):
        default = None
        if index >= default_offset:
            default = arguments.defaults[index - default_offset]
        parts.append(format_argument(argument, default))

    if arguments.vararg is not None:
        parts.append(format_argument(arguments.vararg, prefix="*"))
    elif arguments.kwonlyargs:
        parts.append("*")

    for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults):
        parts.append(format_argument(argument, default))

    if arguments.kwarg is not None:
        parts.append(format_argument(arguments.kwarg, prefix="**"))

    return ", ".join(parts)


def format_argument(
    argument: ast.arg,
    default: ast.expr | None = None,
    prefix: str = "",
) -> str:
    text = f"{prefix}{argument.arg}"
    if argument.annotation is not None:
        text += f": {safe_unparse(argument.annotation)}"
    if default is not None:
        text += f" = {safe_unparse(default)}"
    return text


def format_return_annotation(annotation: ast.AST | None) -> str:
    if annotation is None:
        return ""
    return f" -> {safe_unparse(annotation)}"


def safe_unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "..."


def render_dotted_name(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = render_dotted_name(node.value, aliases)
        if base is None:
            return None
        return f"{base}.{node.attr}"
    return None


def extract_string_literal(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def add_note(notes: list[str], note: str) -> None:
    if note not in notes:
        notes.append(note)


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Discover xarray/pandas accessors from a Python file")
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--search-root", action="append", default=[], type=Path)
    parser.add_argument("--source-stdin", action="store_true")
    parser.add_argument("--line", type=int, default=None)
    parser.add_argument("--scope-only", action="store_true")
    parser.add_argument("--json-indent", type=int, default=None)
    args = parser.parse_args()

    source_override = sys.stdin.read() if args.source_stdin else None
    if args.scope_only:
        report = discover_scope_context(
            workspace_root=args.workspace,
            source_file=args.file,
            source_override=source_override,
            cursor_line=args.line,
        )
    else:
        report = discover_accessors(
            workspace_root=args.workspace,
            source_file=args.file,
            extra_search_roots=args.search_root,
            source_override=source_override,
            cursor_line=args.line,
        )
    print(json.dumps(report, indent=args.json_indent))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
