"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");
const { buildCombinedNotebookSource, countLines } = require("./lib/notebook");

const {
  extractCompletionReference,
  extractImportReference,
  extractReferenceAtOffset,
  extractSignatureCall,
  parseDisplaySignature,
  parseKnownHostType,
  parseKnownHostTypes,
  resolveKnownHostTypeExpression
} = require("./lib/overlay");

const COMPLETION_TRIGGERS = [
  ".",
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
];
const COMPLETION_TRIGGER_SET = new Set(COMPLETION_TRIGGERS);
const PYTHON_LANGUAGE_ID = "python";

function activate(context) {
  const output = vscode.window.createOutputChannel("Accessor Discovery");
  const analysisService = new AnalysisService(context, output);
  context.subscriptions.push(output, { dispose: () => analysisService.dispose() });
  const schedulePrefetch = (document, position) => {
    if (isPythonAnalysisDocument(document)) {
      analysisService.prefetch(document, position);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => analysisService.invalidateAll()),
    vscode.workspace.onDidCloseTextDocument((document) =>
      analysisService.invalidateForDocument(document)
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      analysisService.invalidateForDocument(event.document);
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
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      analysisService.invalidateDocument(event.notebook.uri.toString());
      const editor = vscode.window.activeTextEditor;
      if (editor && isDocumentInNotebook(editor.document, event.notebook)) {
        schedulePrefetch(editor.document, editor.selection.active);
      }
    }),
    vscode.workspace.onDidSaveNotebookDocument((notebook) =>
      analysisService.invalidateDocument(notebook.uri.toString())
    ),
    vscode.workspace.onDidCloseNotebookDocument((notebook) =>
      analysisService.invalidateDocument(notebook.uri.toString())
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("accessor") || event.affectsConfiguration("python")) {
        analysisService.invalidateAll();
        analysisService.resetWorker();
      }
    })
  );

  const selector = { language: "python" };

  context.subscriptions.push(
    vscode.commands.registerCommand("accessor.analyzeCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isPythonAnalysisDocument(editor.document)) {
        vscode.window.showErrorMessage(
          "Open a Python file or Python notebook cell before running accessor analysis."
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

  activatePythonExtensionWatcher(analysisService, context);
}

function deactivate() {}

class AnalysisService {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.localCache = new Map();
    this.discoveryCache = new Map();
    this.scopeCache = new Map();
    this.localPending = new Map();
    this.discoveryPending = new Map();
    this.scopePending = new Map();
    this.prefetchTimers = new Map();
    this.interpreterRefreshTimers = new Map();
    this.workerClient = new HelperWorkerClient(context, output);
    this.pythonApiPromise = null;
    this.lastPythonCandidatesKey = "";
    this.activeEnvironmentOverrides = new Map();
  }

  async getReport(document, position = null) {
    const target = resolveAnalysisTarget(document, position);
    if (!target?.workspaceFolder) {
      throw new Error("The current file must be inside a workspace folder.");
    }

    return this.getReportForTarget(target);
  }

  async getReportForTarget(target) {
    const pythonCandidates = await this.getPythonCandidates(
      target.workspaceFolder,
      target.resourceUri
    );
    const lineKey = target.position ? target.position.line + 1 : 0;
    const localReport = await this.getLocalReport(
      target,
      pythonCandidates
    );
    const discoveryReport = await this.getDiscoveryReport(
      target,
      pythonCandidates,
      localReport
    );
    const scopeReport = await this.getScopeReport(
      target,
      pythonCandidates,
      lineKey || countTextDocumentLines(target.source)
    );
    return mergeReports(localReport, discoveryReport, scopeReport);
  }

  async getPythonCandidates(workspaceFolder, resourceUri) {
    const result = await getPythonCandidates(
      workspaceFolder,
      resourceUri,
      () => this.getPythonApi(),
      this.getActiveEnvironmentOverride(workspaceFolder, resourceUri)
    );
    const candidates = result.candidates;
    const logKey = JSON.stringify({
      workspace: workspaceFolder.uri.toString(),
      resource: resourceUri.toString(),
      candidates,
      details: result.details
    });
    if (this.lastPythonCandidatesKey !== logKey) {
      this.lastPythonCandidatesKey = logKey;
      this.output.appendLine(
        `Python helper candidates for ${resourceUri.fsPath}: ${
          candidates.length > 0 ? candidates.join(", ") : "(none)"
        }`
      );
      for (const detail of result.details) {
        this.output.appendLine(`  - ${detail}`);
      }
    }
    return candidates;
  }

  async getPythonApi() {
    if (!this.pythonApiPromise) {
      this.pythonApiPromise = activatePythonExtensionApi(this);
    }
    return this.pythonApiPromise;
  }

  getActiveEnvironmentOverride(workspaceFolder, resourceUri) {
    const resourceKey = getResourceScopeKey(resourceUri);
    if (resourceKey && this.activeEnvironmentOverrides.has(resourceKey)) {
      return {
        path: this.activeEnvironmentOverrides.get(resourceKey),
        source: `event override for resource ${resourceUri.fsPath}`
      };
    }

    const workspaceKey = getResourceScopeKey(workspaceFolder);
    if (workspaceKey && this.activeEnvironmentOverrides.has(workspaceKey)) {
      return {
        path: this.activeEnvironmentOverrides.get(workspaceKey),
        source: `event override for workspace ${workspaceFolder.uri.fsPath}`
      };
    }

    if (this.activeEnvironmentOverrides.has("__default__")) {
      return {
        path: this.activeEnvironmentOverrides.get("__default__"),
        source: "event override for workspace default"
      };
    }

    return null;
  }

  recordActiveEnvironmentChange(resource, pathValue) {
    const key = getResourceScopeKey(resource) || "__default__";
    this.activeEnvironmentOverrides.set(key, pathValue);
    this.lastPythonCandidatesKey = "";
  }

  clearActiveEnvironmentOverride(resource) {
    const key = getResourceScopeKey(resource) || "__default__";
    this.activeEnvironmentOverrides.delete(key);
    this.lastPythonCandidatesKey = "";
  }

  refreshOpenPythonEditors(resource) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!isPythonAnalysisDocument(editor.document)) {
        continue;
      }
      if (!resourceMatchesDocument(resource, editor.document)) {
        continue;
      }
      this.prefetch(editor.document, editor.selection.active);
    }
  }

  scheduleInterpreterRefresh(resource, reason) {
    const key = getResourceScopeKey(resource) || "__default__";
    const existing = this.interpreterRefreshTimers.get(key);
    if (existing) {
      for (const timer of existing) {
        clearTimeout(timer);
      }
    }

    const delays = [0, 150, 500, 1200];
    const timers = delays.map((delay, index) =>
      setTimeout(() => {
        this.clearActiveEnvironmentOverride(resource);
        this.invalidateAll();
        this.resetWorker();
        this.refreshOpenPythonEditors(resource);
        if (index === delays.length - 1) {
          this.interpreterRefreshTimers.delete(key);
        }
      }, delay)
    );
    this.interpreterRefreshTimers.set(key, timers);
  }

  async getLocalReport(target, pythonCandidates) {
    const cacheKey = target.cacheKey;
    const pythonKey = pythonCandidates.join("::");
    const cached = this.localCache.get(cacheKey);
    if (
      cached &&
      cached.version === target.version &&
      cached.pythonKey === pythonKey
    ) {
      return cached.report;
    }
    if (this.localPending.has(cacheKey)) {
      return this.localPending.get(cacheKey);
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "discover_accessors_worker.py"
    );
    const args = [
      scriptPath
    ];
    const pending = this.workerClient
      .request(pythonCandidates, args, {
        mode: "local",
        workspace: target.workspaceFolder.uri.fsPath,
        file: target.filePath,
        source: target.source
      })
      .then((report) => {
        this.localCache.set(cacheKey, {
          version: target.version,
          pythonKey,
          report
        });
        return report;
      })
      .finally(() => {
        this.localPending.delete(cacheKey);
      });
    this.localPending.set(cacheKey, pending);
    return pending;
  }

  async getDiscoveryReport(target, pythonCandidates, localReport) {
    const pythonKey = pythonCandidates.join("::");
    const cacheKey = buildImportsCacheKey(target.cacheKey, pythonKey, localReport);
    const cached = this.discoveryCache.get(cacheKey);
    if (cached) {
      return cached.report;
    }
    if (this.discoveryPending.has(cacheKey)) {
      return this.discoveryPending.get(cacheKey);
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "discover_accessors_worker.py"
    );
    const args = [scriptPath];
    const pending = this.workerClient
      .request(pythonCandidates, args, {
        mode: "imports",
        workspace: target.workspaceFolder.uri.fsPath,
        file: target.filePath,
        imports: localReport.imports || [],
        current_package: localReport.current_package || ""
      })
      .then((report) => {
        this.discoveryCache.set(cacheKey, { report });
        return report;
      })
      .finally(() => {
        this.discoveryPending.delete(cacheKey);
      });
    this.discoveryPending.set(cacheKey, pending);
    return pending;
  }

  async getScopeReport(target, pythonCandidates, lineKey) {
    const cacheKey = `${target.cacheKey}::${lineKey}`;
    const pythonKey = pythonCandidates.join("::");
    const cached = this.scopeCache.get(cacheKey);
    if (
      cached &&
      cached.version === target.version &&
      cached.pythonKey === pythonKey
    ) {
      return cached.report;
    }
    if (this.scopePending.has(cacheKey)) {
      return this.scopePending.get(cacheKey);
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "discover_accessors_worker.py"
    );
    const args = [
      scriptPath
    ];
    const pending = this.workerClient
      .request(pythonCandidates, args, {
        mode: "scope",
        workspace: target.workspaceFolder.uri.fsPath,
        file: target.filePath,
        line: lineKey,
        source: target.source
      })
      .then((report) => {
        this.scopeCache.set(cacheKey, {
          version: target.version,
          pythonKey,
          report
        });
        return report;
      })
      .finally(() => {
        this.scopePending.delete(cacheKey);
      });
    this.scopePending.set(cacheKey, pending);
    return pending;
  }

  invalidate(key) {
    this.localCache.delete(key);
    this.localPending.delete(key);
    this.discoveryCache.delete(key);
    this.scopeCache.delete(key);
    this.discoveryPending.delete(key);
    this.scopePending.delete(key);
  }

  invalidateForDocument(document) {
    const key = resolveInvalidationKey(document);
    this.invalidateDocument(key);
  }

  invalidateDocument(uriKey) {
    deleteKeysWithPrefix(this.localCache, uriKey);
    deleteKeysWithPrefix(this.localPending, uriKey);
    deleteKeysWithPrefix(this.discoveryCache, uriKey);
    deleteKeysWithPrefix(this.discoveryPending, uriKey);
    deleteKeysWithPrefix(this.scopeCache, uriKey);
    deleteKeysWithPrefix(this.scopePending, uriKey);
    const timer = this.prefetchTimers.get(uriKey);
    if (timer) {
      clearTimeout(timer);
      this.prefetchTimers.delete(uriKey);
    }
  }

  invalidateAll() {
    this.localCache.clear();
    this.localPending.clear();
    this.discoveryCache.clear();
    this.scopeCache.clear();
    this.discoveryPending.clear();
    this.scopePending.clear();
    for (const timer of this.prefetchTimers.values()) {
      clearTimeout(timer);
    }
    this.prefetchTimers.clear();
    for (const timers of this.interpreterRefreshTimers.values()) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    }
    this.interpreterRefreshTimers.clear();
    this.lastPythonCandidatesKey = "";
  }

  dispose() {
    this.invalidateAll();
    this.workerClient.dispose();
  }

  resetWorker() {
    this.workerClient.dispose();
  }

  prefetch(document, position = null) {
    const target = resolveAnalysisTarget(document, position);
    if (!target) {
      return;
    }

    const uriKey = target.invalidationKey;
    const existing = this.prefetchTimers.get(uriKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.prefetchTimers.delete(uriKey);
      this.getReportForTarget(target).catch(() => {});
    }, 75);
    this.prefetchTimers.set(uriKey, timer);
  }

  async warm(document, position = null) {
    const target = resolveAnalysisTarget(document, position);
    if (!target) {
      throw new Error("The current file must be inside a workspace folder.");
    }
    return this.getReportForTarget(target);
  }
}

class HelperWorkerClient {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.child = null;
    this.command = null;
    this.stderr = "";
    this.stdoutBuffer = "";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.readyPromise = null;
  }

  async request(commands, args, payload) {
    await this.ensureWorker(commands, args);
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId;
      this.nextRequestId += 1;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  async ensureWorker(commands, args) {
    if (this.child && this.command && commands.includes(this.command)) {
      return this.readyPromise;
    }

    this.disposeWorker();
    const failures = [];
    for (const command of commands) {
      try {
        await this.startWorker(command, args);
        this.command = command;
        return this.readyPromise;
      } catch (error) {
        failures.push(`${command}: ${String(error.message || error)}`);
        this.disposeWorker();
      }
    }

    throw new Error(`No usable Python interpreter found.\n${failures.join("\n")}`);
  }

  startWorker(command, args) {
    this.output.appendLine(`Starting accessor helper worker with interpreter: ${command}`);
    const child = spawn(command, ["-u", ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.command = command;
    this.stderr = "";
    this.stdoutBuffer = "";

    this.readyPromise = new Promise((resolve, reject) => {
      this.onReady = (message) => {
        if (message?.type === "ready") {
          this.onReady = null;
          this.onReadyReject = null;
          resolve();
        }
      };
      this.onReadyReject = reject;
    });

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString();
      this.drainStdout();
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (this.onReadyReject) {
        this.onReadyReject(error);
        this.onReadyReject = null;
      }
    });
    child.on("close", (code) => {
      const error = new Error(
        this.stderr.trim() || `Accessor helper exited with code ${code}`
      );
      if (this.onReadyReject) {
        this.onReadyReject(error);
        this.onReadyReject = null;
      }
      this.rejectPending(error);
      this.child = null;
      this.command = null;
      this.readyPromise = null;
      this.onReady = null;
    });

    return this.readyPromise;
  }

  drainStdout() {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.rejectPending(
          new Error(`Invalid JSON output from helper worker: ${String(error.message || error)}`)
        );
        this.disposeWorker();
        return;
      }

      if (message.type === "ready") {
        if (this.onReady) {
          this.onReady(message);
        }
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
        continue;
      }
      const error = new Error(message.error || "Accessor helper failed.");
      error.kind = "helper";
      pending.reject(error);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (this.onReadyReject) {
      this.onReadyReject(error);
      this.onReadyReject = null;
    }
  }

  disposeWorker() {
    if (this.child) {
      this.output.appendLine(`Stopping accessor helper worker for interpreter: ${this.command}`);
      this.child.kill();
    }
    this.child = null;
    this.command = null;
    this.readyPromise = null;
  }

  dispose() {
    this.rejectPending(new Error("Accessor helper worker stopped."));
    this.disposeWorker();
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
  const hostTypes = await resolveExpressionTypes(
    document,
    hostExpression,
    position,
    report,
    true
  );
  if (hostTypes.length === 0) {
    return [];
  }

  const hostTypeSet = new Set(hostTypes);
  const partialLower = reference.partial.toLowerCase();
  const seenAccessorNames = new Set();
  return report.accessors
    .filter((accessor) => hostTypeSet.has(accessor.host_type))
    .filter((accessor) => accessor.accessor_name.toLowerCase().startsWith(partialLower))
    .filter((accessor) => {
      if (seenAccessorNames.has(accessor.accessor_name)) {
        return false;
      }
      seenAccessorNames.add(accessor.accessor_name);
      return true;
    })
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
  const hostTypes = await resolveExpressionTypes(
    document,
    hostExpression,
    position,
    report,
    true
  );
  if (hostTypes.length === 0) {
    return [];
  }

  const partialLower = reference.partial.toLowerCase();
  const seenMemberNames = new Set();
  const matchingAccessors = hostTypes
    .map((hostType) => findAccessor(report, hostType, accessorName))
    .filter(Boolean);

  return matchingAccessors.flatMap((accessor) =>
    accessor.members
      .filter((member) => member.name.toLowerCase().startsWith(partialLower))
      .filter((member) => {
        if (seenMemberNames.has(member.name)) {
          return false;
        }
        seenMemberNames.add(member.name);
        return true;
      })
      .map((member) => createMemberCompletionItem(accessor, member, replaceRange))
  );
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
    const resolvedItems = await resolveReferencedItems(
      document,
      position,
      report,
      reference,
      true
    );
    if (resolvedItems.length > 0) {
      return resolvedItems
        .map((resolved) => locationForResolvedAccessorTarget(resolved))
        .filter(Boolean);
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
  const resolvedItems = await resolveReferencedItems(
    document,
    position,
    report,
    reference,
    allowHoverFallback
  );
  return resolvedItems[0] || null;
}

async function resolveReferencedItems(
  document,
  position,
  report,
  reference,
  allowHoverFallback
) {
  const matches = [];

  if (reference.tokenIndex >= 2) {
    const accessorName = reference.parts[reference.tokenIndex - 1];
    const hostExpression = reference.parts.slice(0, reference.tokenIndex - 1).join(".");
    const hostTypes = await resolveExpressionTypes(
      document,
      hostExpression,
      position,
      report,
      allowHoverFallback
    );
    for (const hostType of hostTypes) {
      const accessor = findAccessor(report, hostType, accessorName);
      if (!accessor) {
        continue;
      }
      const member = accessor.members.find(
        (candidate) => candidate.name === reference.parts[reference.tokenIndex]
      );
      if (member) {
        matches.push({ accessor, member });
      }
    }
    if (matches.length > 0) {
      return dedupeResolvedItems(matches);
    }
  }

  if (reference.tokenIndex >= 1) {
    const hostExpression = reference.parts.slice(0, reference.tokenIndex).join(".");
    const hostTypes = await resolveExpressionTypes(
      document,
      hostExpression,
      position,
      report,
      allowHoverFallback
    );
    for (const hostType of hostTypes) {
      const accessor = findAccessor(report, hostType, reference.parts[reference.tokenIndex]);
      if (accessor) {
        matches.push({ accessor, member: null });
      }
    }
  }

  return dedupeResolvedItems(matches);
}

async function resolveExpressionType(
  document,
  expression,
  position,
  report,
  allowHoverFallback
) {
  const hostTypes = await resolveExpressionTypes(
    document,
    expression,
    position,
    report,
    allowHoverFallback
  );
  return hostTypes[0] || null;
}

async function resolveExpressionTypes(
  document,
  expression,
  position,
  report,
  allowHoverFallback
) {
  if (!expression) {
    return [];
  }

  const directType = report.symbol_types && report.symbol_types[expression];
  if (directType) {
    return parseKnownHostTypes(directType);
  }

  const aliasResolvedType = resolveKnownHostTypeExpression(
    expression,
    report.scope_aliases || {}
  );
  if (aliasResolvedType) {
    return [aliasResolvedType];
  }

  if (!allowHoverFallback) {
    return [];
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
  return parseKnownHostTypes(flattenHoverContents(hovers));
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

function dedupeResolvedItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const target = item.member || item.accessor;
    const key = [
      target.file_path || item.accessor.file_path || "",
      target.line || item.accessor.line || 0,
      item.accessor.host_type,
      item.accessor.accessor_name,
      item.member?.name || ""
    ].join("::");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function locationForResolvedAccessorTarget(resolved) {
  const target = resolved.member || resolved.accessor;
  const filePath = target.file_path || resolved.accessor.file_path;
  if (!filePath) {
    return null;
  }
  return new vscode.Location(
    vscode.Uri.file(filePath),
    new vscode.Position(Math.max(target.line - 1, 0), 0)
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
    appendDocstringMarkdown(markdown, accessor.docstring, true);
  }
  markdown.appendMarkdown(`\n\nModule: \`${accessor.module_name}\``);
  return markdown;
}

function buildMemberMarkdown(accessor, member) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(buildMemberCodeLabel(accessor, member), "python");
  markdown.appendMarkdown(`\n\nKind: \`${member.kind}\``);
  if (member.docstring) {
    appendDocstringMarkdown(markdown, member.docstring, true);
  }
  return markdown;
}

function buildSignatureMarkdown(accessor, member) {
  const markdown = new vscode.MarkdownString();
  if (member.docstring) {
    appendDocstringMarkdown(markdown, member.docstring, false);
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

function appendDocstringMarkdown(markdown, docstring, withLeadingSpacing) {
  const rendered = String(docstring || "").trim();
  if (!rendered) {
    return;
  }
  markdown.appendMarkdown(withLeadingSpacing ? `\n\n${rendered}` : rendered);
}

async function getPythonCandidates(
  workspaceFolder,
  resourceUri,
  getPythonApi,
  activeEnvironmentOverride
) {
  const candidates = [];
  const details = [];
  const accessorConfig = vscode.workspace.getConfiguration("accessor", workspaceFolder.uri);
  addPythonCandidate(
    candidates,
    accessorConfig.get("pythonPath", ""),
    workspaceFolder,
    "accessor.pythonPath",
    details
  );
  if (candidates.length > 0) {
    details.push("Using accessor.pythonPath as an explicit override.");
    return { candidates, details };
  }

  const pythonApi = await getPythonApi();
  const selectedInterpreter = await getSelectedPythonInterpreterPath(
    workspaceFolder,
    resourceUri,
    pythonApi,
    activeEnvironmentOverride
  );
  details.push(...selectedInterpreter.details);
  if (selectedInterpreter.path) {
    addPythonCandidate(
      candidates,
      selectedInterpreter.path,
      workspaceFolder,
      "selected interpreter",
      details
    );
    return { candidates, details };
  }

  if (pythonApi) {
    details.push("No active Python environment path is currently available.");
    return { candidates, details };
  }

  details.push("Python API is unavailable and accessor.pythonPath is not set.");
  return { candidates, details };
}

async function getSelectedPythonInterpreterPath(
  workspaceFolder,
  resourceUri,
  pythonApi,
  activeEnvironmentOverride
) {
  const details = [];
  if (activeEnvironmentOverride?.path) {
    details.push(
      `${activeEnvironmentOverride.source} -> final=${formatInterpreterValue(
        activeEnvironmentOverride.path
      )}`
    );
    return { path: activeEnvironmentOverride.path, details };
  }
  let selectedEnvironmentPath = "";
  try {
    const environments = pythonApi?.environments;
    if (
      !environments ||
      typeof environments.getActiveEnvironmentPath !== "function" ||
      typeof environments.resolveEnvironment !== "function"
    ) {
      details.push("Python environments API is unavailable.");
    } else {
      const environmentPathEntries = [
        {
          label: "environments.getActiveEnvironmentPath(workspaceFolder)",
          value: environments.getActiveEnvironmentPath(workspaceFolder)
        },
        {
          label: "environments.getActiveEnvironmentPath(resourceUri)",
          value: environments.getActiveEnvironmentPath(resourceUri)
        },
        {
          label: "environments.getActiveEnvironmentPath()",
          value: environments.getActiveEnvironmentPath()
        }
      ].filter((entry) => Boolean(entry.value));

      for (const entry of environmentPathEntries) {
        const resolved = await environments.resolveEnvironment(entry.value);
        const interpreterPath = extractInterpreterPath(entry.value, resolved);
        details.push(
          `${entry.label} -> raw=${formatInterpreterValue(entry.value)} resolved=${formatInterpreterValue(resolved?.path)} executable=${formatInterpreterValue(
            resolved?.executable?.uri?.fsPath || resolved?.executable?.filename
          )} final=${formatInterpreterValue(interpreterPath)}`
        );
        if (!selectedEnvironmentPath && interpreterPath) {
          selectedEnvironmentPath = interpreterPath;
        }
      }
      if (environmentPathEntries.length === 0) {
        details.push("Python environments API returned no active environment paths.");
      }
    }
  } catch (error) {
    details.push(
      `Python environments API lookup failed: ${String(error.message || error)}`
    );
  }
  if (selectedEnvironmentPath) {
    details.push("Interpreter selection -> using environments API result.");
    return { path: selectedEnvironmentPath, details };
  }
  return { path: "", details };
}

function extractInterpreterPath(environmentPath, resolved) {
  const resolvedPath = String(
    resolved?.path || environmentPath?.path || environmentPath || ""
  ).trim();
  return (
    resolved?.executable?.uri?.fsPath ||
    resolved?.executable?.filename ||
    resolveEnvironmentExecutablePath(resolvedPath) ||
    resolvedPath ||
    ""
  );
}

function extractInterpreterPathFromEnvironmentRecord(environment) {
  return extractInterpreterPath(environment, environment);
}

function resolveEnvironmentExecutablePath(rawPath) {
  const resolved = String(rawPath || "").trim();
  if (!resolved) {
    return "";
  }
  if (!fs.existsSync(resolved)) {
    return "";
  }

  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return "";
  }

  if (!stats.isDirectory()) {
    return resolved;
  }

  const executable = process.platform === "win32"
    ? path.join(resolved, "Scripts", "python.exe")
    : path.join(resolved, "bin", "python");
  return fs.existsSync(executable) ? executable : "";
}

function addPythonCandidate(candidates, rawValue, workspaceFolder, source, details = null) {
  const resolved = resolveWorkspaceVariables(String(rawValue || "").trim(), workspaceFolder);
  if (!resolved) {
    if (details) {
      details.push(`${source} -> skipped because it resolved to an empty value.`);
    }
    return;
  }

  if (resolved.includes("${command:")) {
    if (details) {
      details.push(`${source} -> skipped unresolved command variable: ${resolved}`);
    }
    return;
  }

  if (resolved === "python") {
    if (details) {
      details.push(`${source} -> skipped generic placeholder: python`);
    }
    return;
  }

  const beforeLength = candidates.length;
  addUnique(candidates, resolved);
  if (!details) {
    return;
  }
  if (candidates.length > beforeLength) {
    details.push(`${source} -> candidate ${resolved}`);
  } else {
    details.push(`${source} -> duplicate candidate ${resolved}`);
  }
}

function formatInterpreterValue(value) {
  if (value === null || value === undefined || value === "") {
    return "(empty)";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value?.path === "string" && value.path) {
    return value.path;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPythonAnalysisDocument(document) {
  return Boolean(document && document.languageId === PYTHON_LANGUAGE_ID);
}

function resolveAnalysisTarget(document, position = null) {
  if (!isPythonAnalysisDocument(document)) {
    return null;
  }

  const notebookCell = findNotebookCellContext(document);
  if (notebookCell) {
    return resolveNotebookAnalysisTarget(document, position, notebookCell);
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return null;
  }

  return {
    workspaceFolder,
    resourceUri: document.uri,
    filePath: document.uri.fsPath,
    source: document.getText(),
    position,
    cacheKey: document.uri.toString(),
    invalidationKey: document.uri.toString(),
    version: document.version
  };
}

function resolveNotebookAnalysisTarget(document, position, notebookCell) {
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(notebookCell.notebook.uri) ||
    vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return null;
  }

  const combinedSource = buildCombinedNotebookSource(
    notebookCell.notebook.getCells().map((cell) => ({
      kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      languageId: cell.document.languageId,
      text: cell.document.getText()
    })),
    notebookCell.cellIndex,
    PYTHON_LANGUAGE_ID
  );
  if (!combinedSource) {
    return null;
  }

  return {
    workspaceFolder,
    resourceUri: notebookCell.notebook.uri,
    filePath: resolveNotebookAnalysisFilePath(workspaceFolder, notebookCell.notebook.uri),
    source: combinedSource.source,
    position: position
      ? new vscode.Position(combinedSource.lineOffset + position.line, position.character)
      : null,
    cacheKey: `${notebookCell.notebook.uri.toString()}::cell:${notebookCell.cellIndex}`,
    invalidationKey: notebookCell.notebook.uri.toString(),
    version: notebookCell.notebook.version
  };
}

function findNotebookCellContext(document) {
  const documentKey = document?.uri?.toString();
  if (!documentKey) {
    return null;
  }

  for (const notebook of vscode.workspace.notebookDocuments) {
    const cells = notebook.getCells();
    const cellIndex = cells.findIndex(
      (candidate) => candidate.document.uri.toString() === documentKey
    );
    if (cellIndex !== -1) {
      return {
        notebook,
        cellIndex
      };
    }
  }

  return null;
}

function isDocumentInNotebook(document, notebook) {
  const notebookCell = findNotebookCellContext(document);
  return Boolean(
    notebookCell &&
      notebookCell.notebook.uri.toString() === notebook.uri.toString()
  );
}

function resolveInvalidationKey(document) {
  const notebookCell = findNotebookCellContext(document);
  return notebookCell
    ? notebookCell.notebook.uri.toString()
    : document.uri.toString();
}

function resolveNotebookAnalysisFilePath(workspaceFolder, notebookUri) {
  if (notebookUri.scheme === "file" && notebookUri.fsPath) {
    return notebookUri.fsPath;
  }

  const baseName = sanitizeVirtualModuleName(path.posix.basename(notebookUri.path || ""));
  return path.join(
    workspaceFolder.uri.fsPath,
    "__accessor_virtual__",
    `${baseName || "notebook"}.py`
  );
}

function sanitizeVirtualModuleName(value) {
  const stem = path.posix.parse(String(value || "")).name || "notebook";
  return stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "notebook";
}

function countTextDocumentLines(text) {
  return countLines(text);
}

function getResourceScopeKey(resource) {
  if (!resource) {
    return "";
  }
  if (typeof resource.fsPath === "string") {
    return resource.toString();
  }
  if (resource.uri && typeof resource.uri.toString === "function") {
    return resource.uri.toString();
  }
  if (typeof resource.path === "string" && resource.path) {
    return resource.path;
  }
  return "";
}

function resourceMatchesDocument(resource, document) {
  if (!resource) {
    return true;
  }
  const resourceUris = [document.uri];
  const notebookCell = findNotebookCellContext(document);
  if (notebookCell) {
    resourceUris.push(notebookCell.notebook.uri);
  }
  if (resource.uri && typeof resource.uri.toString === "function") {
    const resourceUri = resource.uri;
    const resourcePath = resourceUri.fsPath || resourceUri.path;
    if (!resourcePath) {
      return true;
    }
    return resourceUris.some(
      (uri) =>
        uri.fsPath === resourcePath ||
        uri.fsPath.startsWith(`${resourcePath}${path.sep}`)
    );
  }
  if (typeof resource.fsPath === "string") {
    return resourceUris.some((uri) => uri.fsPath === resource.fsPath);
  }
  return true;
}

function addUnique(items, value) {
  if (!value || items.includes(value)) {
    return;
  }
  items.push(value);
}

function deleteKeysWithPrefix(map, prefix) {
  map.delete(prefix);
  for (const key of [...map.keys()]) {
    if (key.startsWith(`${prefix}::`)) {
      map.delete(key);
    }
  }
}

async function activatePythonExtensionApi(analysisService) {
  try {
    const pythonExtensionModule = await importPythonExtensionModule();
    if (pythonExtensionModule?.PythonExtension?.api) {
      return await pythonExtensionModule.PythonExtension.api();
    }

    const extension = vscode.extensions.getExtension("ms-python.python");
    if (!extension) {
      return null;
    }
    return extension.isActive ? extension.exports : await extension.activate();
  } catch (error) {
    analysisService.output.appendLine(
      `Unable to activate the Python extension API: ${String(error.message || error)}`
    );
    return null;
  }
}

async function importPythonExtensionModule() {
  try {
    return await import("@vscode/python-extension");
  } catch {
    return null;
  }
}

function activatePythonExtensionWatcher(analysisService, context) {
  const registerWatcher = async () => {
    const api = await analysisService.getPythonApi();
    const handleActiveEnvironmentChange = (source, event) => {
      const changedPath = event?.path || event;
      const changedResource = event?.resource;
      analysisService.recordActiveEnvironmentChange(changedResource, changedPath);
      analysisService.invalidateAll();
      analysisService.resetWorker();
      analysisService.refreshOpenPythonEditors(changedResource);
    };

    if (api) {
      await api.ready;
      const environments = api?.environments;
      if (typeof environments?.onDidChangeActiveEnvironmentPath === "function") {
        context.subscriptions.push(
          environments.onDidChangeActiveEnvironmentPath((event) => {
            handleActiveEnvironmentChange("onDidChangeActiveEnvironmentPath", event);
          })
        );
      }
      if (typeof environments?.onDidChangeActiveEnvironment === "function") {
        context.subscriptions.push(
          environments.onDidChangeActiveEnvironment((event) => {
            handleActiveEnvironmentChange("onDidChangeActiveEnvironment", event);
          })
        );
      }
      if (typeof environments?.onDidChangeEnvironments === "function") {
        context.subscriptions.push(
          environments.onDidChangeEnvironments((event) => {
            const eventResource =
              event?.env?.environment?.workspaceFolder ||
              vscode.window.activeTextEditor?.document.uri;
            const updatedInterpreterPath = extractInterpreterPathFromEnvironmentRecord(
              event?.env
            );
            if (updatedInterpreterPath) {
              analysisService.output.appendLine(
                `Python interpreter updated from environment discovery: ${updatedInterpreterPath}`
              );
              analysisService.recordActiveEnvironmentChange(
                eventResource,
                updatedInterpreterPath
              );
              analysisService.invalidateAll();
              analysisService.resetWorker();
              analysisService.refreshOpenPythonEditors(eventResource);
              return;
            }
            analysisService.scheduleInterpreterRefresh(
              eventResource,
              `onDidChangeEnvironments:${formatInterpreterValue(event?.type)}`
            );
          })
        );
      }
    }
  };

  registerWatcher().catch(() => {});
}

function resolveWorkspaceVariables(value, workspaceFolder) {
  return value.replaceAll("${workspaceFolder}", workspaceFolder.uri.fsPath);
}

function mergeReports(localReport, discoveryReport, scopeReport) {
  return {
    ...discoveryReport,
    source_module_name: localReport.source_module_name,
    module_locations: {
      ...(discoveryReport.module_locations || {}),
      ...(localReport.module_locations || {})
    },
    accessors: [...(discoveryReport.accessors || []), ...(localReport.accessors || [])].sort(
      compareAccessors
    ),
    symbol_types: scopeReport.symbol_types || {},
    scope_aliases: scopeReport.scope_aliases || {},
    notes: uniqueStrings([
      ...(localReport.notes || []),
      ...(discoveryReport.notes || []),
      ...(scopeReport.notes || [])
    ])
  };
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function compareAccessors(left, right) {
  return (
    left.host_type.localeCompare(right.host_type) ||
    left.accessor_name.localeCompare(right.accessor_name) ||
    left.module_name.localeCompare(right.module_name)
  );
}

function buildImportsCacheKey(uriKey, pythonKey, localReport) {
  return `${uriKey}::${pythonKey}::${JSON.stringify({
    current_package: localReport.current_package || "",
    imports: localReport.imports || []
  })}`;
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
  if (!isPythonAnalysisDocument(editor.document)) {
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
