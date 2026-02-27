import { parse } from 'csv-parse/sync';

/** All lead fields that can be mapped from a CSV column. */
export const LEAD_MAPPABLE_FIELDS = [
  'phone_primary',
  'phone_alt1',
  'phone_alt2',
  'phone_alt3',
  'phone_alt4',
  'first_name',
  'last_name',
  'email',
  'company',
  'notes',
] as const;

export type LeadMappableField = (typeof LEAD_MAPPABLE_FIELDS)[number];

/**
 * Mapping from lead field → CSV column header name.
 * Only phone_primary is required; all others are optional.
 * Any CSV columns not listed in the mapping become custom_fields.
 */
export type LeadFieldMapping = Partial<Record<LeadMappableField, string>> & {
  phone_primary: string;
};

export interface ParsedCsvResult {
  headers: string[];
  /** Up to maxPreviewRows rows as raw string maps */
  previewRows: Record<string, string>[];
  totalRows: number;
}

export interface MappedLead {
  phone_primary: string;
  phone_alt1?: string;
  phone_alt2?: string;
  phone_alt3?: string;
  phone_alt4?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  company?: string;
  notes?: string;
  custom_fields: Record<string, string>;
}

/**
 * Parses a CSV buffer into headers + preview rows.
 * Does NOT import — use mapCsvRows() for the actual import data.
 *
 * @param buffer - Raw CSV file buffer (UTF-8 or Latin-1 detected)
 * @param maxPreviewRows - Max rows to return in preview (default 5)
 * @throws If the buffer cannot be parsed as CSV
 */
export function parseCsvPreview(
  buffer: Buffer,
  maxPreviewRows = 5,
): ParsedCsvResult {
  const content = buffer.toString('utf-8');

  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    return { headers: [], previewRows: [], totalRows: 0 };
  }

  const headers = Object.keys(records[0]!);

  return {
    headers,
    previewRows: records.slice(0, maxPreviewRows),
    totalRows: records.length,
  };
}

/**
 * Parses a CSV buffer and maps all rows to MappedLead objects.
 * Rows where phone_primary is empty after mapping are skipped.
 *
 * @param buffer  - Raw CSV file buffer
 * @param mapping - Field mapping: lead field → CSV header name
 * @returns Array of mapped lead objects ready for DB insertion
 */
export function parseCsvAndMap(
  buffer: Buffer,
  mapping: LeadFieldMapping,
): MappedLead[] {
  const content = buffer.toString('utf-8');

  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) return [];

  // Build reverse lookup: CSV header → lead field (for custom_fields detection)
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));

  const leads: MappedLead[] = [];

  for (const row of records) {
    const phone = row[mapping.phone_primary]?.trim() ?? '';
    if (!phone) continue; // skip rows with no primary phone

    const custom_fields: Record<string, string> = {};

    // Collect unmapped columns into custom_fields
    for (const [col, val] of Object.entries(row)) {
      if (!mappedHeaders.has(col) && val) {
        custom_fields[col] = val;
      }
    }

    leads.push({
      phone_primary: normalizePhone(phone),
      phone_alt1: mapField(row, mapping.phone_alt1),
      phone_alt2: mapField(row, mapping.phone_alt2),
      phone_alt3: mapField(row, mapping.phone_alt3),
      phone_alt4: mapField(row, mapping.phone_alt4),
      first_name: mapField(row, mapping.first_name),
      last_name: mapField(row, mapping.last_name),
      email: mapField(row, mapping.email),
      company: mapField(row, mapping.company),
      notes: mapField(row, mapping.notes),
      custom_fields,
    });
  }

  return leads;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function mapField(
  row: Record<string, string>,
  col: string | undefined,
): string | undefined {
  if (!col) return undefined;
  const val = row[col]?.trim();
  return val && val.length > 0 ? val : undefined;
}

/**
 * Normalises a phone number to digits + leading plus only.
 * Preserves the leading '+' for international numbers.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}
