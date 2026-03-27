"use strict";

const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");

const {
  extractCompletionReference,
  extractImportReference,
  extractReferenceAtOffset,
  extractSignatureCall,
  parseDisplaySignature,
  parseKnownHostType,
  resolveKnownHostTypeExpression
} = require("./lib/overlay");

const COMPLETION_TRIGGERS = [
  ".",
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
];
const COMPLETION_TRIGGER_SET = new Set(COMPLETION_TRIGGERS);

function activate(context) {
  const output = vscode.window.createOutputChannel("Accessor Discovery");
  const analysisService = new AnalysisService(context, output);
  context.subscriptions.push(output);
  const schedulePrefetch = (document, position) => {
    if (document && document.languageId === "python") {
      analysisService.prefetch(document, position);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => analysisService.invalidateAll()),
    vscode.workspace.onDidCloseTextDocument((document) =>
      analysisService.invalidateDocument(document.uri.toString())
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === event.document.uri.toString()) {
        schedulePrefetch(event.document, editor.selection.active);
        maybeTriggerSuggestForChange(analysisService, event, editor);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      schedulePrefetch(event.textEditor.document, event.selections[0]?.active || null);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      schedulePrefetch(editor?.document || null, editor?.selection.active || null);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("accessor") || event.affectsConfiguration("python")) {
        analysisService.invalidateAll();
      }
    })
  );

  const selector = { language: "python" };

  context.subscriptions.push(
    vscode.commands.registerCommand("accessor.analyzeCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "python") {
        vscode.window.showErrorMessage(
          "Open a Python file before running accessor analysis."
        );
        return;
      }

      try {
        const report = await analysisService.getReport(
          editor.document,
          editor.selection.active
        );
        output.clear();
        output.show(true);
        output.append(formatReport(report));
        vscode.window.showInformationMessage(
          `Accessor analysis found ${report.accessors.length} accessor(s).`
        );
      } catch (error) {
        output.clear();
        output.show(true);
        output.appendLine("Accessor discovery failed.");
        output.appendLine("");
        output.appendLine(String(error.message || error));
        vscode.window.showErrorMessage("Accessor discovery failed. See output for details.");
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(document, position) {
          return provideCompletionItems(analysisService, document, position);
        }
      },
      ...COMPLETION_TRIGGERS
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        return provideHover(analysisService, document, position);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position) {
        return provideDefinition(analysisService, document, position);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      selector,
      {
        provideSignatureHelp(document, position) {
          return provideSignatureHelp(analysisService, document, position);
        }
      },
      "(",
      ","
    )
  );

  schedulePrefetch(
    vscode.window.activeTextEditor?.document || null,
    vscode.window.activeTextEditor?.selection.active || null
  );
}

function deactivate() {}

class AnalysisService {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.cache = new Map();
    this.prefetchTimers = new Map();
  }

  async getReport(document, position = null) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      throw new Error("The current file must be inside a workspace folder.");
    }

    const pythonCandidates = getPythonCandidates(workspaceFolder);
    const lineKey = position ? position.line + 1 : 0;
    const cacheKey = `${document.uri.toString()}::${lineKey}`;
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      cached.version === document.version &&
      cached.pythonKey === pythonCandidates.join("::")
    ) {
      return cached.report;
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "discover_accessors.py"
    );
    const args = [
      scriptPath,
      "--workspace",
      workspaceFolder.uri.fsPath,
      "--file",
      document.uri.fsPath,
      "--line",
      String(lineKey || document.lineCount),
      "--source-stdin",
      "--json-indent",
      "2"
    ];

    const report = await runHelper(pythonCandidates, args, document.getText());
    this.cache.set(cacheKey, {
      version: document.version,
      pythonKey: pythonCandidates.join("::"),
      report
    });
    return report;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  invalidateDocument(uriKey) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${uriKey}::`)) {
        this.cache.delete(key);
      }
    }
    const timer = this.prefetchTimers.get(uriKey);
    if (timer) {
      clearTimeout(timer);
      this.prefetchTimers.delete(uriKey);
    }
  }

  invalidateAll() {
    this.cache.clear();
    for (const timer of this.prefetchTimers.values()) {
      clearTimeout(timer);
    }
    this.prefetchTimers.clear();
  }

  prefetch(document, position = null) {
    const uriKey = document.uri.toString();
    const existing = this.prefetchTimers.get(uriKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.prefetchTimers.delete(uriKey);
      this.getReport(document, position).catch(() => {});
    }, 75);
    this.prefetchTimers.set(uriKey, timer);
  }

  async warm(document, position = null) {
    return this.getReport(document, position);
  }
}

async function provideCompletionItems(analysisService, document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const reference = extractCompletionReference(linePrefix);
  if (!reference) {
    return undefined;
  }

  const report = await analysisService.getReport(document, position);
  const replaceStart = position.translate(0, -reference.partial.length);
  const replaceRange = new vscode.Range(replaceStart, position);

  const memberItems = await buildMemberCompletionItems(
    document,
    position,
    report,
    reference,
    replaceRange
  );
  if (memberItems.length > 0) {
    return new vscode.CompletionList(memberItems, false);
  }

  const accessorItems = await buildAccessorCompletionItems(
    document,
    position,
    report,
    reference,
    replaceRange
  );
  return accessorItems.length > 0
    ? new vscode.CompletionList(accessorItems, false)
    : undefined;
}

async function buildAccessorCompletionItems(
  document,
  position,
  report,
  reference,
  replaceRange
) {
  const hostExpression = reference.parts.join(".");
  const hostType = await resolveExpressionType(
    document,
    hostExpression,
    position,
    report,
    true
  );
  if (!hostType) {
    return [];
  }

  const partialLower = reference.partial.toLowerCase();
  return report.accessors
    .filter((accessor) => accessor.host_type === hostType)
    .filter((accessor) => accessor.accessor_name.toLowerCase().startsWith(partialLower))
    .map((accessor) => createAccessorCompletionItem(accessor, replaceRange));
}

async function buildMemberCompletionItems(
  document,
  position,
  report,
  reference,
  replaceRange
) {
  if (reference.parts.length < 2) {
    return [];
  }

  const accessorName = reference.parts.at(-1);
  const hostExpression = reference.parts.slice(0, -1).join(".");
  const hostType = await resolveExpressionType(
    document,
    hostExpression,
    position,
    report,
    true
  );
  if (!hostType) {
    return [];
  }

  const accessor = findAccessor(report, hostType, accessorName);
  if (!accessor) {
    return [];
  }

  const partialLower = reference.partial.toLowerCase();
  return accessor.members
    .filter((member) => member.name.toLowerCase().startsWith(partialLower))
    .map((member) => createMemberCompletionItem(accessor, member, replaceRange));
}

async function provideHover(analysisService, document, position) {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!wordRange) {
    return undefined;
  }

  const lineText = document.lineAt(position.line).text;
  const reference = extractReferenceAtOffset(
    lineText,
    wordRange.start.character,
    wordRange.end.character
  );
  if (!reference) {
    return undefined;
  }

  const report = await analysisService.getReport(document, position);
  const resolved = await resolveReferencedItem(
    document,
    position,
    report,
    reference,
    false
  );
  if (!resolved) {
    return undefined;
  }

  return new vscode.Hover(buildHoverMarkdown(resolved), wordRange);
}

async function provideDefinition(analysisService, document, position) {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!wordRange) {
    return undefined;
  }

  const lineText = document.lineAt(position.line).text;
  const reference = extractReferenceAtOffset(
    lineText,
    wordRange.start.character,
    wordRange.end.character
  );
  const report = await analysisService.getReport(document, position);
  if (reference) {
    const resolved = await resolveReferencedItem(
      document,
      position,
      report,
      reference,
      true
    );
    if (resolved) {
      const target = resolved.member || resolved.accessor;
      const filePath = target.file_path || resolved.accessor.file_path;
      return new vscode.Location(
        vscode.Uri.file(filePath),
        new vscode.Position(Math.max(target.line - 1, 0), 0)
      );
    }
  }

  const importReference = extractImportReference(
    lineText,
    wordRange.start.character,
    wordRange.end.character
  );
  if (!importReference) {
    return undefined;
  }

  return locationForResolvedModule(report, importReference);
}

async function provideSignatureHelp(analysisService, document, position) {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const call = extractSignatureCall(linePrefix);
  if (!call || call.parts.length < 3) {
    return undefined;
  }

  const report = await analysisService.getReport(document, position);
  const member = await resolveCallableMember(
    document,
    position,
    report,
    call.parts
  );
  if (!member) {
    return undefined;
  }

  return buildSignatureHelp(member.accessor, member.member, call.activeParameter);
}

async function resolveReferencedItem(
  document,
  position,
  report,
  reference,
  allowHoverFallback
) {
  if (reference.tokenIndex >= 2) {
    const accessorName = reference.parts[reference.tokenIndex - 1];
    const hostExpression = reference.parts.slice(0, reference.tokenIndex - 1).join(".");
    const hostType = await resolveExpressionType(
      document,
      hostExpression,
      position,
      report,
      allowHoverFallback
    );
    const accessor = findAccessor(report, hostType, accessorName);
    if (accessor) {
      const member = accessor.members.find(
        (candidate) => candidate.name === reference.parts[reference.tokenIndex]
      );
      if (member) {
        return { accessor, member };
      }
    }
  }

  if (reference.tokenIndex >= 1) {
    const hostExpression = reference.parts.slice(0, reference.tokenIndex).join(".");
    const hostType = await resolveExpressionType(
      document,
      hostExpression,
      position,
      report,
      allowHoverFallback
    );
    const accessor = findAccessor(report, hostType, reference.parts[reference.tokenIndex]);
    if (accessor) {
      return { accessor, member: null };
    }
  }

  return null;
}

async function resolveExpressionType(
  document,
  expression,
  position,
  report,
  allowHoverFallback
) {
  if (!expression) {
    return null;
  }

  if (report.symbol_types && report.symbol_types[expression]) {
    return report.symbol_types[expression];
  }

  const aliasResolvedType = resolveKnownHostTypeExpression(
    expression,
    report.scope_aliases || {}
  );
  if (aliasResolvedType) {
    return aliasResolvedType;
  }

  if (!allowHoverFallback) {
    return null;
  }

  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const endIndex = linePrefix.lastIndexOf(expression);
  if (endIndex === -1 || expression.length === 0) {
    return null;
  }

  const hoverPosition = new vscode.Position(
    position.line,
    endIndex + expression.length - 1
  );
  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    document.uri,
    hoverPosition
  );
  return parseKnownHostType(flattenHoverContents(hovers));
}

function flattenHoverContents(hovers) {
  if (!hovers) {
    return "";
  }

  const chunks = [];
  for (const hover of hovers) {
    for (const content of hover.contents) {
      if (typeof content === "string") {
        chunks.push(content);
        continue;
      }
      if (content && typeof content.value === "string") {
        chunks.push(content.value);
      }
    }
  }
  return chunks.join("\n");
}

function findAccessor(report, hostType, accessorName) {
  if (!hostType) {
    return null;
  }
  return (
    report.accessors.find(
      (accessor) =>
        accessor.host_type === hostType && accessor.accessor_name === accessorName
    ) || null
  );
}

function locationForResolvedModule(report, importReference) {
  const candidates = [
    importReference.moduleName,
    importReference.fallbackModuleName
  ].filter(Boolean);
  for (const moduleName of candidates) {
    const moduleRecord = report.module_locations?.[moduleName];
    if (!moduleRecord?.file_path) {
      continue;
    }
    return new vscode.Location(
      vscode.Uri.file(moduleRecord.file_path),
      new vscode.Position(0, 0)
    );
  }
  return undefined;
}

function createAccessorCompletionItem(accessor, replaceRange) {
  const item = new vscode.CompletionItem(
    accessor.accessor_name,
    vscode.CompletionItemKind.Property
  );
  item.range = replaceRange;
  item.detail = `${accessor.host_type} accessor`;
  item.documentation = buildAccessorMarkdown(accessor);
  item.sortText = `0_${accessor.accessor_name}`;
  return item;
}

function createMemberCompletionItem(accessor, member, replaceRange) {
  const item = new vscode.CompletionItem(
    member.name,
    completionKindForMember(member.kind)
  );
  item.range = replaceRange;
  item.detail = buildMemberDetail(accessor, member);
  item.documentation = buildMemberMarkdown(accessor, member);
  item.sortText = `0_${member.name}`;

  if (member.kind === "method" || member.kind === "callable") {
    item.insertText = new vscode.SnippetString(`${member.name}($0)`);
    item.command = {
      command: "editor.action.triggerParameterHints",
      title: "Trigger parameter hints"
    };
  }

  return item;
}

function completionKindForMember(kind) {
  switch (kind) {
    case "property":
      return vscode.CompletionItemKind.Property;
    case "attribute":
      return vscode.CompletionItemKind.Field;
    case "callable":
      return vscode.CompletionItemKind.Function;
    default:
      return vscode.CompletionItemKind.Method;
  }
}

function buildHoverMarkdown(resolved) {
  return resolved.member
    ? buildMemberMarkdown(resolved.accessor, resolved.member)
    : buildAccessorMarkdown(resolved.accessor);
}

async function resolveCallableMember(document, position, report, parts) {
  const memberName = parts.at(-1);
  const accessorName = parts.at(-2);
  const hostExpression = parts.slice(0, -2).join(".");
  const hostType = await resolveExpressionType(
    document,
    hostExpression,
    position,
    report,
    true
  );
  if (!hostType) {
    return null;
  }

  const accessor = findAccessor(report, hostType, accessorName);
  if (!accessor) {
    return null;
  }

  const member = accessor.members.find(
    (candidate) =>
      candidate.name === memberName &&
      (candidate.kind === "method" || candidate.kind === "callable")
  );
  if (!member) {
    return null;
  }

  return { accessor, member };
}

function buildSignatureHelp(accessor, member, activeParameter) {
  const parsedSignature = parseDisplaySignature(member.signature);
  const signature = new vscode.SignatureInformation(
    parsedSignature.label,
    buildSignatureMarkdown(accessor, member)
  );
  signature.parameters = parsedSignature.parameters.map(
    (parameter) => new vscode.ParameterInformation(parameter)
  );

  const help = new vscode.SignatureHelp();
  help.signatures = [signature];
  help.activeSignature = 0;
  help.activeParameter =
    signature.parameters.length > 0
      ? Math.min(activeParameter, signature.parameters.length - 1)
      : 0;
  return help;
}

function buildAccessorMarkdown(accessor) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(
    `${accessor.host_type}.${accessor.accessor_name} -> ${accessor.accessor_class}`,
    "python"
  );
  if (accessor.docstring) {
    markdown.appendMarkdown(`\n\n${escapeMarkdown(accessor.docstring)}`);
  }
  markdown.appendMarkdown(`\n\nModule: \`${accessor.module_name}\``);
  return markdown;
}

function buildMemberMarkdown(accessor, member) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(buildMemberCodeLabel(accessor, member), "python");
  markdown.appendMarkdown(`\n\nKind: \`${member.kind}\``);
  if (member.docstring) {
    markdown.appendMarkdown(`\n\n${escapeMarkdown(member.docstring)}`);
  }
  return markdown;
}

function buildSignatureMarkdown(accessor, member) {
  const markdown = new vscode.MarkdownString();
  if (member.docstring) {
    markdown.appendMarkdown(escapeMarkdown(member.docstring));
  }
  markdown.appendMarkdown(`\n\nAccessor: \`${accessor.accessor_name}\``);
  return markdown;
}

function buildMemberCodeLabel(accessor, member) {
  if (member.kind === "method" || member.kind === "callable") {
    return `${accessor.accessor_class}.${parseDisplaySignature(member.signature).label}`;
  }
  if (member.kind === "property") {
    return `${accessor.accessor_class}.${member.name}`;
  }
  return `${accessor.accessor_class}.${member.signature}`;
}

function buildMemberDetail(accessor, member) {
  if (member.kind === "method" || member.kind === "callable") {
    return `${accessor.accessor_name}.${parseDisplaySignature(member.signature).label}`;
  }
  if (member.kind === "property") {
    return `${accessor.accessor_name}.${member.name}`;
  }
  return `${accessor.accessor_name}.${member.signature}`;
}

function escapeMarkdown(text) {
  return text.replace(/([\\`*_{}[\]()#+\-.!])/g, "\\$1");
}

function getPythonCandidates(workspaceFolder) {
  const accessorConfig = vscode.workspace.getConfiguration("accessor", workspaceFolder.uri);
  const candidates = [];
  addPythonCandidate(
    candidates,
    accessorConfig.get("pythonPath", ""),
    workspaceFolder,
    false
  );

  const pythonConfig = vscode.workspace.getConfiguration("python", workspaceFolder.uri);
  addPythonCandidate(
    candidates,
    pythonConfig.get("defaultInterpreterPath", ""),
    workspaceFolder,
    true
  );
  addPythonCandidate(candidates, pythonConfig.get("pythonPath", ""), workspaceFolder, true);

  if (process.platform === "win32") {
    addUnique(candidates, "py");
    addUnique(candidates, "python");
  } else {
    addUnique(candidates, "python3");
    addUnique(candidates, "/usr/bin/python3");
    addUnique(candidates, "python");
  }

  return candidates;
}

function addPythonCandidate(candidates, rawValue, workspaceFolder, allowPlaceholder) {
  const resolved = resolveWorkspaceVariables(String(rawValue || "").trim(), workspaceFolder);
  if (!resolved) {
    return;
  }

  if (resolved.includes("${command:")) {
    return;
  }

  if (!allowPlaceholder && resolved === "python") {
    return;
  }

  if (allowPlaceholder && resolved === "python") {
    return;
  }

  addUnique(candidates, resolved);
}

function addUnique(items, value) {
  if (!value || items.includes(value)) {
    return;
  }
  items.push(value);
}

function resolveWorkspaceVariables(value, workspaceFolder) {
  return value.replaceAll("${workspaceFolder}", workspaceFolder.uri.fsPath);
}

async function runHelper(commands, args, stdinContent) {
  const spawnFailures = [];
  const helperFailures = [];
  for (const command of commands) {
    try {
      return await runHelperOnce(command, args, stdinContent);
    } catch (error) {
      const formatted = `${command}: ${String(error.message || error)}`;
      if (error && error.kind === "helper") {
        helperFailures.push(formatted);
        continue;
      }
      spawnFailures.push(formatted);
    }
  }

  if (helperFailures.length > 0) {
    const lines = ["Accessor helper failed.", ...helperFailures];
    if (spawnFailures.length > 0) {
      lines.push("", "Other interpreter candidates were unavailable:", ...spawnFailures);
    }
    throw new Error(lines.join("\n"));
  }

  throw new Error(`No usable Python interpreter found.\n${spawnFailures.join("\n")}`);
}

function runHelperOnce(command, args, stdinContent) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnFailed = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      spawnFailed = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (spawnFailed) {
        return;
      }

      if (code !== 0) {
        const error = new Error(stderr.trim() || stdout.trim() || `Helper exited with code ${code}`);
        error.kind = "helper";
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        const error = new Error(
          `Invalid JSON output from helper:\n${stdout.trim() || stderr.trim() || parseError.message}`
        );
        error.kind = "helper";
        reject(error);
      }
    });

    if (stdinContent) {
      child.stdin.write(stdinContent);
    }
    child.stdin.end();
  });
}

function formatReport(report) {
  const lines = [];
  lines.push("Summary");
  lines.push(`  Accessors: ${report.accessors.length}`);
  lines.push(`  Symbols: ${Object.keys(report.symbol_types || {}).length}`);
  lines.push(`  Scope aliases: ${Object.keys(report.scope_aliases || {}).length}`);
  lines.push(`  Visited modules: ${report.visited_modules.length}`);
  lines.push(`  Unresolved imports: ${report.unresolved_imports.length}`);
  lines.push("");

  if (Object.keys(report.scope_aliases || {}).length > 0) {
    lines.push("Scope Aliases");
    for (const [name, target] of Object.entries(report.scope_aliases)) {
      lines.push(`  ${name} -> ${target}`);
    }
    lines.push("");
  }

  if (Object.keys(report.symbol_types || {}).length > 0) {
    lines.push("Inferred Symbols");
    for (const [name, hostType] of Object.entries(report.symbol_types)) {
      lines.push(`  ${name}: ${hostType}`);
    }
    lines.push("");
  }

  if (report.accessors.length > 0) {
    lines.push("Discovered Accessors");
    for (const accessor of report.accessors) {
      lines.push(
        `  ${accessor.host_type}.${accessor.accessor_name} -> ${accessor.accessor_class}`
      );
      lines.push(`    Module: ${accessor.module_name}`);
      lines.push(`    Decorator: ${accessor.decorator}`);
      lines.push(`    Activation chain: ${accessor.activation_chain.join(" -> ")}`);
      if (accessor.members.length > 0) {
        lines.push(
          `    Members: ${accessor.members.map((member) => member.name).join(", ")}`
        );
      }
    }
    lines.push("");
  }

  if (report.unresolved_imports.length > 0) {
    lines.push("Unresolved Imports");
    for (const unresolved of report.unresolved_imports) {
      lines.push(`  ${unresolved.importer} -> ${unresolved.module_name}`);
    }
    lines.push("");
  }

  if (report.notes.length > 0) {
    lines.push("Notes");
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
    lines.push("");
  }

  lines.push("Raw JSON");
  lines.push(JSON.stringify(report, null, 2));
  lines.push("");
  return lines.join("\n");
}

function maybeTriggerSuggestForChange(analysisService, event, editor) {
  if (editor.document.languageId !== "python") {
    return;
  }

  const lastChange = event.contentChanges.at(-1);
  if (!lastChange || !lastChange.text) {
    return;
  }

  const insertedChars = [...lastChange.text];
  const finalChar = insertedChars.at(-1);
  if (!finalChar || !COMPLETION_TRIGGER_SET.has(finalChar)) {
    return;
  }

  const position = event.document.positionAt(lastChange.rangeOffset + lastChange.text.length);
  const linePrefix = event.document.lineAt(position.line).text.slice(0, position.character);
  if (!extractCompletionReference(linePrefix)) {
    return;
  }

  setTimeout(() => {
    analysisService
      .warm(event.document, position)
      .then(() => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          return;
        }
        if (activeEditor.document.uri.toString() !== event.document.uri.toString()) {
          return;
        }
        return vscode.commands
          .executeCommand(
            "vscode.executeCompletionItemProvider",
            event.document.uri,
            position,
            finalChar
          )
          .then((result) => {
            if (!result || !Array.isArray(result.items) || result.items.length === 0) {
              return;
            }
            return new Promise((resolve) => {
              setTimeout(() => {
                vscode.commands.executeCommand("editor.action.triggerSuggest").then(resolve);
              }, 25);
            });
          });
      })
      .catch(() => {});
  }, 0);
}

module.exports = {
  activate,
  deactivate
};
