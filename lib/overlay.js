"use strict";

const KNOWN_HOST_TYPES = {
  "xarray.DataArray": ["xarray.DataArray", "DataArray"],
  "xarray.Dataset": ["xarray.Dataset", "Dataset"],
  "xarray.DataTree": ["xarray.DataTree", "DataTree"],
  "pandas.DataFrame": ["pandas.DataFrame", "DataFrame"],
  "pandas.Series": ["pandas.Series", "Series"],
  "pandas.Index": ["pandas.Index", "Index"]
};

function extractCompletionReference(linePrefix) {
  if (linePrefix.endsWith(".")) {
    const match = linePrefix.match(/([A-Za-z_][A-Za-z0-9_\.]*)\.$/);
    if (!match) {
      return null;
    }
    return { parts: match[1].split("."), partial: "" };
  }

  const match = linePrefix.match(/([A-Za-z_][A-Za-z0-9_\.]*)$/);
  if (!match || !match[1].includes(".")) {
    return null;
  }

  const full = match[1];
  const lastDot = full.lastIndexOf(".");
  return {
    parts: full.slice(0, lastDot).split("."),
    partial: full.slice(lastDot + 1)
  };
}

function extractReferenceAtOffset(lineText, wordStart, wordEnd) {
  let left = wordStart;
  let right = wordEnd;

  while (left > 0 && isReferenceChar(lineText[left - 1])) {
    left -= 1;
  }
  while (right < lineText.length && isReferenceChar(lineText[right])) {
    right += 1;
  }

  const expression = lineText.slice(left, right);
  if (!expression.includes(".")) {
    return null;
  }

  const beforeWord = lineText.slice(left, wordStart);
  return {
    expression,
    parts: expression.split("."),
    tokenIndex: beforeWord.split(".").length - 1
  };
}

function extractImportReference(lineText, wordStart, wordEnd) {
  const fromMatch = lineText.match(/^\s*from\s+([A-Za-z_][A-Za-z0-9_\.]*)\s+import\s+(.+)$/);
  if (fromMatch) {
    const [, baseModule, importedSection] = fromMatch;
    const baseStart = lineText.indexOf(baseModule);
    const baseEnd = baseStart + baseModule.length;
    if (wordStart >= baseStart && wordEnd <= baseEnd) {
      const reference = extractReferenceAtOffset(lineText, wordStart, wordEnd);
      if (!reference) {
        return {
          kind: "from-module",
          moduleName: baseModule,
          fallbackModuleName: null
        };
      }
      return {
        kind: "from-module",
        moduleName: reference.parts.slice(0, reference.tokenIndex + 1).join("."),
        fallbackModuleName: null
      };
    }

    const importKeyword = " import ";
    const sectionStart =
      lineText.indexOf(importKeyword, baseEnd) + importKeyword.length;
    const entries = splitImportEntries(importedSection, sectionStart);
    for (const entry of entries) {
      if (wordStart < entry.start || wordEnd > entry.end) {
        continue;
      }
      if (!entry.importedName || entry.importedName === "*") {
        return null;
      }
      return {
        kind: "from-import",
        moduleName: `${baseModule}.${entry.importedName}`,
        fallbackModuleName: baseModule
      };
    }
  }

  const importMatch = lineText.match(/^\s*import\s+(.+)$/);
  if (!importMatch) {
    return null;
  }

  const sectionText = importMatch[1];
  const sectionStart = lineText.indexOf(sectionText);
  const entries = splitImportEntries(sectionText, sectionStart);
  for (const entry of entries) {
    if (wordStart >= entry.start && wordEnd <= entry.end) {
      if (entry.alias && wordStart >= entry.alias.start && wordEnd <= entry.alias.end) {
        return {
          kind: "import-alias",
          moduleName: entry.moduleName,
          fallbackModuleName: null
        };
      }
      const reference = extractReferenceAtOffset(lineText, wordStart, wordEnd);
      if (!reference) {
        return {
          kind: "import-module",
          moduleName: entry.moduleName,
          fallbackModuleName: null
        };
      }
      return {
        kind: "import-module",
        moduleName: reference.parts.slice(0, reference.tokenIndex + 1).join("."),
        fallbackModuleName: null
      };
    }
  }

  return null;
}

function parseKnownHostType(text) {
  return parseKnownHostTypes(text)[0] || null;
}

function parseKnownHostTypes(text) {
  const matches = [];
  const seen = new Set();
  const source = String(text || "");

  for (const [hostType, labels] of Object.entries(KNOWN_HOST_TYPES)) {
    let bestIndex = -1;
    for (const label of labels) {
      const index = source.indexOf(label);
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
      }
    }
    if (bestIndex === -1 || seen.has(hostType)) {
      continue;
    }
    seen.add(hostType);
    matches.push({ hostType, index: bestIndex });
  }

  matches.sort((left, right) => left.index - right.index);
  return matches.map((match) => match.hostType);
}

function resolveExpressionAlias(expression, scopeAliases) {
  if (!expression || !scopeAliases) {
    return expression;
  }

  const parts = expression.split(".");
  const target = scopeAliases[parts[0]];
  if (!target) {
    return expression;
  }
  return [target, ...parts.slice(1)].join(".");
}

function resolveKnownHostTypeExpression(expression, scopeAliases) {
  const resolved = resolveExpressionAlias(expression, scopeAliases);
  return Object.prototype.hasOwnProperty.call(KNOWN_HOST_TYPES, resolved)
    ? resolved
    : null;
}

function extractSignatureCall(linePrefix) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = linePrefix.length - 1; index >= 0; index -= 1) {
    const char = linePrefix[index];

    if (char === ")") {
      parenDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth += 1;
      continue;
    }

    if (char === "(") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        const beforeCall = linePrefix.slice(0, index);
        const match = beforeCall.match(/([A-Za-z_][A-Za-z0-9_\.]*)$/);
        if (!match || !match[1].includes(".")) {
          return null;
        }
        return {
          parts: match[1].split("."),
          activeParameter: countTopLevelCommas(linePrefix.slice(index + 1))
        };
      }
      parenDepth -= 1;
      continue;
    }

    if (char === "[") {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      continue;
    }

    if (char === "{") {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
    }
  }

  return null;
}

function parseDisplaySignature(signature) {
  const openIndex = signature.indexOf("(");
  if (openIndex === -1) {
    return { label: signature, parameters: [] };
  }

  const closeIndex = findMatchingParen(signature, openIndex);
  if (closeIndex === -1) {
    return { label: signature, parameters: [] };
  }

  const name = signature.slice(0, openIndex).trim();
  const returnSuffix = signature.slice(closeIndex + 1).trim();
  const rawTokens = splitTopLevel(signature.slice(openIndex + 1, closeIndex))
    .map((token) => token.trim())
    .filter(Boolean);
  const displayTokens = removeImplicitReceiver(rawTokens);
  const label = `${name}(${displayTokens.join(", ")})${
    returnSuffix ? ` ${returnSuffix}` : ""
  }`;

  return {
    label,
    parameters: displayTokens.filter((token) => token !== "*" && token !== "/")
  };
}

function removeImplicitReceiver(tokens) {
  const displayTokens = [...tokens];
  const firstToken = displayTokens[0] || "";
  const receiverName = firstToken.split(":")[0].trim();

  if (receiverName === "self" || receiverName === "cls") {
    displayTokens.shift();
  }
  if (displayTokens[0] === "/") {
    displayTokens.shift();
  }

  return displayTokens;
}

function findMatchingParen(text, openIndex) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quoteChar = null;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];

    if (quoteChar) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quoteChar = char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index;
      }
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
    }
  }

  return -1;
}

function splitTopLevel(text) {
  const tokens = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quoteChar = null;
  let escaped = false;

  for (const char of text) {
    if (quoteChar) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quoteChar = char;
      current += char;
      continue;
    }

    if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      tokens.push(current);
      current = "";
      continue;
    }

    current += char;
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
    }
  }

  tokens.push(current);
  return tokens;
}

function countTopLevelCommas(text) {
  const tokens = splitTopLevel(text);
  if (tokens.length === 1 && tokens[0].trim() === "") {
    return 0;
  }
  return Math.max(tokens.length - 1, 0);
}

function splitImportEntries(text, offset) {
  const entries = [];
  let currentStart = 0;
  const rawEntries = splitTopLevel(text);
  for (const rawEntry of rawEntries) {
    const leadingWhitespace = rawEntry.match(/^\s*/)?.[0].length || 0;
    const trailingWhitespace = rawEntry.match(/\s*$/)?.[0].length || 0;
    const normalized = rawEntry.trim();
    const entryStart = offset + currentStart + leadingWhitespace;
    const entryEnd = offset + currentStart + rawEntry.length - trailingWhitespace;
    currentStart += rawEntry.length + 1;
    if (!normalized) {
      continue;
    }

    const aliasMatch = normalized.match(
      /^([A-Za-z_][A-Za-z0-9_\.]*|\*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/
    );
    if (!aliasMatch) {
      continue;
    }

    const importedName = aliasMatch[1];
    const aliasName = aliasMatch[2] || null;
    const aliasIndex =
      aliasName !== null ? normalized.lastIndexOf(aliasName) : -1;
    entries.push({
      start: entryStart,
      end: entryEnd,
      moduleName: importedName,
      importedName,
      alias:
        aliasName === null
          ? null
          : {
              name: aliasName,
              start: entryStart + aliasIndex,
              end: entryStart + aliasIndex + aliasName.length
            }
    });
  }
  return entries;
}

function isReferenceChar(char) {
  return /[A-Za-z0-9_.]/.test(char);
}

module.exports = {
  extractCompletionReference,
  extractImportReference,
  extractReferenceAtOffset,
  extractSignatureCall,
  parseDisplaySignature,
  parseKnownHostType,
  parseKnownHostTypes,
  resolveExpressionAlias,
  resolveKnownHostTypeExpression
};
