// Type shim for pdf-parse lib subpath import.
// The @types/pdf-parse package only types the main index, but the lib
// subpath avoids the broken self-test that runs at import time.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PDFData {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PDFData>;
  export default pdfParse;
}
