/**
 * Type declaration for pdf-parse's library entry point.
 * We import `pdf-parse/lib/pdf-parse.js` directly (not the package root)
 * because the root index.js runs debug code that reads a test fixture when
 * loaded outside a CJS parent module (i.e. from ESM dynamic import).
 */
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdfParse;
}

