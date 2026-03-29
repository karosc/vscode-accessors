"use strict";

const NOTEBOOK_CELL_SEPARATOR = "\n\n";
const NOTEBOOK_CELL_SEPARATOR_LINES = 2;

function buildCombinedNotebookSource(cells, activeCellIndex, languageId = "python") {
  if (!Array.isArray(cells)) {
    return null;
  }
  if (activeCellIndex < 0 || activeCellIndex >= cells.length) {
    return null;
  }

  const parts = [];
  let currentLineOffset = 0;
  let activeCellLineOffset = null;

  for (let index = 0; index <= activeCellIndex; index += 1) {
    const cell = cells[index];
    if (!shouldIncludeCell(cell, languageId)) {
      continue;
    }

    if (parts.length > 0) {
      currentLineOffset += NOTEBOOK_CELL_SEPARATOR_LINES;
    }

    if (index === activeCellIndex) {
      activeCellLineOffset = currentLineOffset;
    }

    const text = String(cell.text || "");
    parts.push(text);
    currentLineOffset += Math.max(countLines(text) - 1, 0);
  }

  if (activeCellLineOffset === null) {
    return null;
  }

  return {
    source: parts.join(NOTEBOOK_CELL_SEPARATOR),
    lineOffset: activeCellLineOffset
  };
}

function shouldIncludeCell(cell, languageId) {
  return Boolean(
    cell &&
      cell.kind === "code" &&
      cell.languageId === languageId
  );
}

function countLines(text) {
  if (!text) {
    return 1;
  }
  return String(text).split(/\r\n|\r|\n/).length;
}

module.exports = {
  buildCombinedNotebookSource,
  countLines
};
