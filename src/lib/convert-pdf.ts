/**
 * Markdown → PDF conversion using marked + pdfmake.
 * Adapted from saas-builder/apps/md2pdf/src/lib/convert.ts
 */

import { marked, type Token, type Tokens } from "marked";

// pdfmake doesn't ship great ESM/TS types — use require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMod = require("pdfmake/src/printer");
const PdfPrinter = pdfMod.default ?? pdfMod;

type PdfContent = Record<string, unknown>;

/** Lazily-cached PdfPrinter — fonts are decoded once and reused. */
let cachedPrinter: ReturnType<typeof createPrinter> | null = null;

function createPrinter() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("pdfmake/build/vfs_fonts");
  const vfs: Record<string, string> = mod.pdfMake?.vfs ?? mod;
  const buf = (name: string) => Buffer.from(vfs[name]!, "base64");
  const fonts = {
    Roboto: {
      normal: buf("Roboto-Regular.ttf"),
      bold: buf("Roboto-Medium.ttf"),
      italics: buf("Roboto-Italic.ttf"),
      bolditalics: buf("Roboto-MediumItalic.ttf"),
    },
  };
  return new PdfPrinter(fonts) as {
    createPdfKitDocument: (
      def: unknown,
    ) => NodeJS.EventEmitter & { end(): void };
  };
}

function getPrinter() {
  return (cachedPrinter ??= createPrinter());
}

function inlineToken(tok: Token): PdfContent | string {
  switch (tok.type) {
    case "strong":
      return {
        text: (tok as Tokens.Strong).tokens?.map(inlineToken) ?? tok.raw,
        bold: true,
      };
    case "em":
      return {
        text: (tok as Tokens.Em).tokens?.map(inlineToken) ?? tok.raw,
        italics: true,
      };
    case "codespan":
      return {
        text: (tok as Tokens.Codespan).text,
        fontSize: 9,
        background: "#f0f0f0",
        characterSpacing: 0.5,
      };
    case "link":
      return {
        text: (tok as Tokens.Link).text,
        color: "#1a56db",
        decoration: "underline",
      };
    case "text":
      return (tok as Tokens.Text).text;
    default:
      return tok.raw ?? "";
  }
}

function inlineTokens(
  tokens: Token[] | undefined,
  fallback: string,
): (PdfContent | string)[] | string {
  if (!tokens?.length) return fallback;
  return tokens.map(inlineToken);
}

function blockToken(tok: Token): PdfContent | PdfContent[] | null {
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading;
      const sizes: Record<number, number> = {
        1: 24,
        2: 20,
        3: 16,
        4: 14,
        5: 12,
        6: 11,
      };
      return {
        text: inlineTokens(h.tokens, h.text),
        fontSize: sizes[h.depth] ?? 11,
        bold: true,
        margin: [0, h.depth <= 2 ? 16 : 10, 0, 6],
      };
    }
    case "paragraph": {
      const p = tok as Tokens.Paragraph;
      return {
        text: inlineTokens(p.tokens, p.text),
        margin: [0, 0, 0, 8],
      };
    }
    case "code": {
      const c = tok as Tokens.Code;
      return {
        text: c.text,
        fontSize: 9,
        background: "#f5f5f5",
        margin: [0, 0, 0, 10],
        lineHeight: 1.4,
      };
    }
    case "blockquote": {
      const bq = tok as Tokens.Blockquote;
      const inner = bq.tokens
        ?.map(blockToken)
        .flat()
        .filter(Boolean) as PdfContent[];
      return {
        stack: inner?.length ? inner : [{ text: bq.raw }],
        margin: [16, 0, 0, 8],
        color: "#555555",
      };
    }
    case "list": {
      const l = tok as Tokens.List;
      const items = l.items.map((item) => {
        const children = item.tokens?.map(blockToken).flat().filter(Boolean);
        if (children && children.length > 1) return { stack: children };
        return children?.[0] ?? { text: item.text };
      });
      return l.ordered
        ? { ol: items, margin: [0, 0, 0, 8] }
        : { ul: items, margin: [0, 0, 0, 8] };
    }
    case "table": {
      const t = tok as Tokens.Table;
      const header = t.header.map((cell) => ({
        text: inlineTokens(cell.tokens, cell.text),
        bold: true,
        fillColor: "#f0f0f0",
      }));
      const rows = t.rows.map((row) =>
        row.map((cell) => ({
          text: inlineTokens(cell.tokens, cell.text),
        })),
      );
      return {
        table: {
          headerRows: 1,
          widths: Array(t.header.length).fill("*") as string[],
          body: [header, ...rows],
        },
        layout: "lightHorizontalLines",
        margin: [0, 0, 0, 10],
      };
    }
    case "hr":
      return {
        canvas: [
          {
            type: "line",
            x1: 0,
            y1: 0,
            x2: 515,
            y2: 0,
            lineWidth: 1,
            lineColor: "#e0dbd3",
          },
        ],
        margin: [0, 8, 0, 8],
      };
    case "space":
      return null;
    default:
      return null;
  }
}

/**
 * Convert a markdown string to a PDF Buffer.
 */
export async function convertMarkdownToPdf(markdown: string): Promise<Buffer> {
  const tokens = marked.lexer(markdown);
  const content = tokens
    .map(blockToken)
    .flat()
    .filter((n): n is PdfContent => n !== null);

  const doc = getPrinter().createPdfKitDocument({
    content,
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.3 },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 40],
  });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
