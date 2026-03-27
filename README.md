# Accessor Discovery Prototype

This repository contains a minimal VS Code extension prototype plus a stdlib-only Python resolver that statically discovers xarray and pandas accessors through recursive import analysis.

## What It Does

- Starts from the active Python file in VS Code.
- Walks its import graph without executing third-party package code.
- Parses reachable Python modules for supported accessor decorators.
- Reports which accessors are reachable through import side effects.
- Adds an overlay completion/hover/definition layer for discovered accessors and their class members.

Supported decorators:

- `xarray.register_dataarray_accessor`
- `xarray.register_dataset_accessor`
- `xarray.register_datatree_accessor`
- `pandas.api.extensions.register_dataframe_accessor`
- `pandas.api.extensions.register_series_accessor`
- `pandas.api.extensions.register_index_accessor`

## What It Does Not Do

- It does not modify Pylance, Pyright, ty, or any other Python language server.
- It does not generate type stubs yet.
- It does not execute arbitrary imports to discover dynamic registration.
- It does not model conditional imports exactly; conditional and other non-trivial top-level blocks are skipped and reported in the output.
- It does not suppress missing-attribute diagnostics from the underlying Python language server.
- It only infers host variables from simple module-level annotations and constructor/factory calls unless the active language server hover text can fill the gap.

## Running The Prototype

1. Open this folder in VS Code.
2. Run the `Accessor: Analyze Current Python File` command.
3. Inspect the `Accessor Discovery` output channel.

The extension runs `scripts/discover_accessors.py` using:

- `accessor.pythonPath`, if configured
- `python.defaultInterpreterPath`, if configured
- `python.pythonPath`, if configured
- `python3`, otherwise

## Running The Resolver Directly

```bash
python3 scripts/discover_accessors.py \
  --workspace /path/to/workspace \
  --file /path/to/workspace/example.py \
  --json-indent 2
```

Optional `--search-root` flags let you add fixture or environment roots during testing.

## Tests

```bash
npm run test:resolver
```
