import fs from "fs";
import mammoth from "mammoth";

type PDFParseResult = { text?: string };

async function extractPdfText(filePath: string): Promise<string> {
  const mod: any = await import("pdf-parse");

  const PDFParse = mod?.PDFParse ?? mod?.default?.PDFParse ?? mod?.default;
  if (!PDFParse) {
    const keys = Object.keys(mod ?? {});
    const defKeys = Object.keys(mod?.default ?? {});
    throw new Error(`PDFParse class not found. keys=${keys.join(",")} defaultKeys=${defKeys.join(",")}`);
  }

  const dataBuffer = fs.readFileSync(filePath);
  const data = new Uint8Array(dataBuffer);

  const parser = new PDFParse({ data });
  const result: PDFParseResult = await parser.getText();
  return result.text ?? "";
}

export async function extractTextFromFile(filePath: string, mimeType: string): Promise<string> {
  if (mimeType === "text/plain") {
    return fs.readFileSync(filePath, "utf-8");
  }

  if (mimeType === "application/pdf") {
    return await extractPdfText(filePath);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value ?? "";
  }

  return "";
}

export function normalizeTextBasic(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}