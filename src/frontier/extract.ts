import * as ax from "../tools/ax.js";
import * as vision from "../tools/vision.js";
import * as act from "../tools/computer-actions.js";

/**
 * Pulls structured data out of applications that have no API.
 *
 * Legacy desktop tools, internal dashboards, portals with no export button —
 * the data is on screen but unreachable. Two readings are available and they
 * fail differently, so both are used:
 *
 *   - the accessibility tree gives real rows and cells where an app exposes them
 *   - positioned screen text works anywhere, and rows are recovered by grouping
 *     text runs that share a vertical band
 *
 * Scrolling continues until the screen stops producing new rows, which is the
 * only reliable end signal when there is no scrollbar to interrogate.
 */

export interface Table {
  rows: string[][];
  source: "accessibility" | "screen-text";
  note: string;
}

/** Group text runs into rows by their vertical position. */
function rowsFromText(lines: vision.OcrLine[], tolerance = 10): string[][] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const bands: vision.OcrLine[][] = [];
  let current: vision.OcrLine[] = [sorted[0]];
  for (const line of sorted.slice(1)) {
    const last = current[current.length - 1];
    // Same row if the vertical centres are within a line's tolerance.
    if (Math.abs(line.cy - last.cy) <= tolerance) current.push(line);
    else {
      bands.push(current);
      current = [line];
    }
  }
  bands.push(current);

  return bands.map((band) =>
    band.sort((a, b) => a.cx - b.cx).map((l) => l.text.trim()).filter(Boolean)
  );
}

/** One pass over what is currently visible. */
export async function readVisible(): Promise<Table> {
  const dump = await ax.dump();
  if (dump.axAvailable) {
    const cells = dump.elements.filter((e) =>
      ["AXCell", "AXRow", "AXStaticText"].includes(e.role)
    );
    if (cells.length >= 6) {
      const rows = rowsFromText(
        cells.map((c) => ({
          text: c.label || c.value,
          cx: c.x + Math.round(c.w / 2),
          cy: c.y + Math.round(c.h / 2),
          x: c.x, y: c.y, w: c.w, h: c.h,
          confidence: 1,
        }))
      );
      if (rows.length >= 2) {
        return { rows, source: "accessibility", note: `${dump.app} exposed ${rows.length} rows` };
      }
    }
  }

  const ocr = await vision.ocr("accurate");
  if (ocr.error) return { rows: [], source: "screen-text", note: `could not read the screen (${ocr.error})` };
  const rows = rowsFromText(ocr.lines.filter((l) => l.confidence >= 0.6));
  return { rows, source: "screen-text", note: `read ${rows.length} rows from screen text` };
}

const signature = (rows: string[][]) => rows.map((r) => r.join("|")).join("\n");

/**
 * Read every row, scrolling until nothing new appears.
 * maxScreens caps the work so a runaway list cannot loop forever.
 */
export async function readAll(maxScreens = 20): Promise<Table> {
  const seen = new Set<string>();
  const all: string[][] = [];
  let source: Table["source"] = "screen-text";
  let lastSig = "";
  let screens = 0;

  for (; screens < maxScreens; screens++) {
    const page = await readVisible();
    source = page.source;

    for (const row of page.rows) {
      const key = row.join("|");
      // De-duplicate: scrolling overlaps, and headers repeat on every screen.
      if (key.trim() && !seen.has(key)) {
        seen.add(key);
        all.push(row);
      }
    }

    const sig = signature(page.rows);
    // Nothing changed after a scroll — this is the end of the list.
    if (sig === lastSig) break;
    lastSig = sig;

    await act.scroll("down", 8);
    await new Promise((r) => setTimeout(r, 450));
  }

  return {
    rows: all,
    source,
    note: `${all.length} unique rows across ${screens + 1} screen(s), read via ${source}`,
  };
}

/** Render as CSV, quoting only what needs it. */
export function toCsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(",")
    )
    .join("\n");
}
