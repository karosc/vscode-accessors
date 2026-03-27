"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractCompletionReference,
  extractImportReference,
  extractReferenceAtOffset,
  extractSignatureCall,
  parseDisplaySignature,
  parseKnownHostType,
  resolveExpressionAlias,
  resolveKnownHostTypeExpression
} = require("../lib/overlay");

test("extractCompletionReference handles accessor property completions", () => {
  assert.deepEqual(extractCompletionReference("ds."), {
    parts: ["ds"],
    partial: ""
  });
  assert.deepEqual(extractCompletionReference("ds.c"), {
    parts: ["ds"],
    partial: "c"
  });
});

test("extractCompletionReference handles accessor member completions", () => {
  assert.deepEqual(extractCompletionReference("ds.cf."), {
    parts: ["ds", "cf"],
    partial: ""
  });
  assert.deepEqual(extractCompletionReference("ds.cf.sum"), {
    parts: ["ds", "cf"],
    partial: "sum"
  });
});

test("extractReferenceAtOffset finds the token inside a dotted chain", () => {
  const line = "result = ds.cf.summary";
  const start = line.indexOf("cf");
  const end = start + 2;
  assert.deepEqual(extractReferenceAtOffset(line, start, end), {
    expression: "ds.cf.summary",
    parts: ["ds", "cf", "summary"],
    tokenIndex: 1
  });
});

test("extractImportReference resolves import module paths and aliases", () => {
  const importLine = "import cf_xarray.accessors as cfa";
  const moduleStart = importLine.indexOf("accessors");
  assert.deepEqual(
    extractImportReference(importLine, moduleStart, moduleStart + "accessors".length),
    {
      kind: "import-module",
      moduleName: "cf_xarray.accessors",
      fallbackModuleName: null
    }
  );

  const aliasStart = importLine.indexOf("cfa");
  assert.deepEqual(extractImportReference(importLine, aliasStart, aliasStart + 3), {
    kind: "import-alias",
    moduleName: "cf_xarray.accessors",
    fallbackModuleName: null
  });
});

test("extractImportReference resolves from-import namespaces", () => {
  const line = "from cf_xarray import accessors as cfa";
  const baseStart = line.indexOf("cf_xarray");
  assert.deepEqual(
    extractImportReference(line, baseStart, baseStart + "cf_xarray".length),
    {
      kind: "from-module",
      moduleName: "cf_xarray",
      fallbackModuleName: null
    }
  );

  const memberStart = line.indexOf("accessors");
  assert.deepEqual(
    extractImportReference(line, memberStart, memberStart + "accessors".length),
    {
      kind: "from-import",
      moduleName: "cf_xarray.accessors",
      fallbackModuleName: "cf_xarray"
    }
  );
});

test("extractSignatureCall finds accessor member calls and active argument index", () => {
  assert.deepEqual(extractSignatureCall("da.geo.plot("), {
    parts: ["da", "geo", "plot"],
    activeParameter: 0
  });
  assert.deepEqual(extractSignatureCall("da.geo.plot(x, "), {
    parts: ["da", "geo", "plot"],
    activeParameter: 1
  });
  assert.deepEqual(extractSignatureCall("da.geo.plot(func(a, b), "), {
    parts: ["da", "geo", "plot"],
    activeParameter: 1
  });
});

test("parseDisplaySignature hides self and preserves useful parameters", () => {
  assert.deepEqual(
    parseDisplaySignature("plot(self, x: int, *, color: str = 'red') -> None"),
    {
      label: "plot(x: int, *, color: str = 'red') -> None",
      parameters: ["x: int", "color: str = 'red'"]
    }
  );
});

test("parseKnownHostType recognizes short and fully qualified names", () => {
  assert.equal(parseKnownHostType("(variable) ds: Dataset"), "xarray.Dataset");
  assert.equal(
    parseKnownHostType("```python\n(variable) df: pandas.DataFrame\n```"),
    "pandas.DataFrame"
  );
});

test("resolveExpressionAlias expands imported module and class aliases", () => {
  assert.equal(
    resolveExpressionAlias("Dataset", { Dataset: "xarray.Dataset" }),
    "xarray.Dataset"
  );
  assert.equal(
    resolveExpressionAlias("xr.Dataset", { xr: "xarray" }),
    "xarray.Dataset"
  );
});

test("resolveKnownHostTypeExpression recognizes alias-expanded host types", () => {
  assert.equal(
    resolveKnownHostTypeExpression("Dataset", { Dataset: "xarray.Dataset" }),
    "xarray.Dataset"
  );
  assert.equal(
    resolveKnownHostTypeExpression("xr.Dataset", { xr: "xarray" }),
    "xarray.Dataset"
  );
});
