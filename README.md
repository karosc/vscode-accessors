# Accessor Discovery

Accessor Discovery brings completion, hover, and go-to-definition support to xarray and pandas accessors in Python files.

It is designed for teams who rely on custom or third-party accessors and want something better than "unknown attribute" dead ends while still keeping analysis static and predictable.

## Why It Exists

Python language servers usually do a great job with regular attributes, but accessors are often registered through import side effects and dynamic attribute lookup. That leaves common workflows like these underpowered:

```python
import xarray as xr
import cf_xarray

ds = xr.Dataset()
ds.cf.summary()
```

Accessor Discovery fills in that gap by scanning reachable imports, discovering supported accessor registrations, and overlaying editor features for the accessors and their members.

## What You Get

- Completion for discovered accessor namespaces such as `ds.cf`
- Completion for accessor members such as `ds.cf.summary`
- Hover text for accessor namespaces and members
- Go to Definition for accessor namespaces and members
- Static recursive import analysis starting from the active file
- Namespace/import definition fallbacks for resolved modules
- An output report you can inspect from the command palette

## Supported Decorators

- `xarray.register_dataarray_accessor`
- `xarray.register_dataset_accessor`
- `xarray.register_datatree_accessor`
- `pandas.api.extensions.register_dataframe_accessor`
- `pandas.api.extensions.register_series_accessor`
- `pandas.api.extensions.register_index_accessor`

## How It Works

1. Start from the active Python file in your workspace.
2. Walk its import graph without executing third-party package code.
3. Parse reachable Python modules for supported accessor decorators.
4. Infer host object types from simple annotations, assignments, and known factory calls.
5. Overlay completion, hover, signature help, and definition support in the editor.

This keeps the extension fast, deterministic, and safe for projects where import-time execution would be undesirable.

## Command

- `Accessor: Analyze Current Python File`

This command opens the `Accessor Discovery` output channel and prints the current static analysis report, including:

- discovered accessors
- inferred symbol types
- scope aliases
- visited modules
- unresolved imports
- parser notes

## Configuration

### `accessor.pythonPath`

Optional Python interpreter path used to run the resolver. If empty, the extension tries the following in order:

1. `accessor.pythonPath`
2. `python.defaultInterpreterPath`
3. `python.pythonPath`
4. `python3`

## Example

With a registered accessor like this:

```python
import xarray as xr


@xr.register_dataset_accessor("cf")
class CFDatasetAccessor:
    def summary(self, include_bounds: bool = False) -> str:
        return ""
```

And usage like this:

```python
import xarray as xr
import cf_xarray

ds = xr.Dataset()
ds.cf.summary()
```

Accessor Discovery can provide:

- completion for `cf`
- completion for `summary`
- hover for `cf` and `summary`
- go to definition to the accessor class or member implementation

## Notes About Definitions

Accessor definitions are supplied by this extension, but VS Code may also show definitions from your active Python language server.

For dynamic accessor lookups, that can mean two locations appear:

- the real accessor definition from this extension
- a fallback dynamic attribute definition such as `__getattr__` from the underlying library

When that happens, VS Code often opens Peek Definitions instead of jumping directly. If you prefer direct navigation when multiple definitions exist, set:

```json
"editor.gotoLocation.multipleDefinitions": "goto"
```

## What It Does Not Do

- It does not modify Pylance, Pyright, ty, or any other Python language server.
- It does not generate type stubs.
- It does not execute arbitrary imports to discover dynamic registration.
- It does not fully model conditional imports or other non-trivial top-level control flow.
- It does not suppress missing-attribute diagnostics from the underlying language server.
- It only infers host variables from simple annotations, assignments, constructor calls, and selected known factory functions unless the active language server hover text can fill the gap.

## Troubleshooting

### No accessors are discovered

- Make sure the file is inside an open VS Code workspace folder.
- Make sure the module that registers the accessor is imported, directly or indirectly, from the active file.
- Run `Accessor: Analyze Current Python File` and inspect the output channel for unresolved imports or skipped blocks.

### Definitions open in a peek window

- This usually means VS Code received more than one definition result.
- See the setting in the "Notes About Definitions" section above.

### The wrong Python interpreter is used

- Set `accessor.pythonPath` explicitly.
- If that is empty, the extension falls back to Python extension settings and then `python3`.

## Development

Run the test suite with:

```bash
npm test
```

Run only the Python resolver tests with:

```bash
npm run test:resolver
```

Run only the overlay tests with:

```bash
npm run test:overlay
```

## Publishing Readiness

This repository now includes marketplace-friendly README content, a changelog, and a publishing checklist. Before publishing, you should still replace placeholder metadata such as:

- the `publisher` value in `package.json`
- repository, homepage, and issue tracker URLs
- the extension icon
- the project license

See [PUBLISHING.md](./PUBLISHING.md) for a concrete checklist.
