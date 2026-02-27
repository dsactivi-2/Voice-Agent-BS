import { describe, it, expect } from 'vitest';
import {
  parseCsvPreview,
  parseCsvAndMap,
  normalizePhone,
  LEAD_MAPPABLE_FIELDS,
} from '../src/utils/csv-parser.js';

// ─── normalizePhone ───────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  it('strips spaces from a local number', () => {
    expect(normalizePhone('061 123 456')).toBe('061123456');
  });

  it('preserves leading + for international numbers', () => {
    expect(normalizePhone('+387 61 123 456')).toBe('+38761123456');
  });

  it('strips parentheses, dashes and dots', () => {
    expect(normalizePhone('(061) 123-456')).toBe('061123456');
  });

  it('handles already clean number', () => {
    expect(normalizePhone('+38761123456')).toBe('+38761123456');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePhone('  061123456  ')).toBe('061123456');
  });

  it('returns empty string for all-non-digit input', () => {
    expect(normalizePhone('--- ---')).toBe('');
  });
});

// ─── parseCsvPreview ──────────────────────────────────────────────────────────

describe('parseCsvPreview', () => {
  it('returns headers from the first row', () => {
    const csv = Buffer.from('name,phone,email\nJohn,061111111,john@test.com\n');
    const result = parseCsvPreview(csv);
    expect(result.headers).toEqual(['name', 'phone', 'email']);
  });

  it('returns up to 5 preview rows by default', () => {
    const dataRows = Array.from({ length: 10 }, (_, i) => `John${i},0611111${i}0,x@x.com`).join('\n');
    const csv = Buffer.from(`name,phone,email\n${dataRows}\n`);
    const result = parseCsvPreview(csv);
    expect(result.previewRows).toHaveLength(5);
    expect(result.totalRows).toBe(10);
  });

  it('returns all rows when count is below maxPreviewRows', () => {
    const csv = Buffer.from('phone\n111\n222\n');
    const result = parseCsvPreview(csv, 10);
    expect(result.previewRows).toHaveLength(2);
    expect(result.totalRows).toBe(2);
  });

  it('returns empty result for CSV with header only (no data rows)', () => {
    const csv = Buffer.from('phone,name\n');
    const result = parseCsvPreview(csv);
    expect(result.totalRows).toBe(0);
    expect(result.headers).toEqual([]);
    expect(result.previewRows).toEqual([]);
  });

  it('respects a custom maxPreviewRows argument', () => {
    const dataRows = Array.from({ length: 8 }, (_, i) => `0611111${i}0`).join('\n');
    const csv = Buffer.from(`phone\n${dataRows}\n`);
    const result = parseCsvPreview(csv, 3);
    expect(result.previewRows).toHaveLength(3);
  });

  it('handles BOM at the start of the file', () => {
    const csv = Buffer.from('\uFEFFphone,name\n061111111,Marko\n');
    const result = parseCsvPreview(csv);
    expect(result.headers).toContain('phone');
  });
});

// ─── parseCsvAndMap ───────────────────────────────────────────────────────────

describe('parseCsvAndMap', () => {
  it('maps columns to the correct lead fields', () => {
    const csv = Buffer.from('tel,fname,lname\n+38761000001,John,Doe\n');
    const leads = parseCsvAndMap(csv, {
      phone_primary: 'tel',
      first_name: 'fname',
      last_name: 'lname',
    });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.phone_primary).toBe('+38761000001');
    expect(leads[0]!.first_name).toBe('John');
    expect(leads[0]!.last_name).toBe('Doe');
  });

  it('skips rows where phone_primary is empty', () => {
    const csv = Buffer.from('phone,name\n,John\n061111111,Jane\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.phone_primary).toBe('061111111');
  });

  it('puts unmapped non-empty columns into custom_fields', () => {
    const csv = Buffer.from('phone,score,tier\n061111111,95,gold\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads[0]!.custom_fields).toEqual({ score: '95', tier: 'gold' });
  });

  it('normalizes phone_primary via normalizePhone', () => {
    const csv = Buffer.from('phone\n+387 61 000 001\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads[0]!.phone_primary).toBe('+38761000001');
  });

  it('returns an empty array for a header-only CSV', () => {
    const csv = Buffer.from('phone\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads).toHaveLength(0);
  });

  it('omits empty-value unmapped columns from custom_fields', () => {
    const csv = Buffer.from('phone,extra\n061111111,\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads[0]!.custom_fields).toEqual({});
  });

  it('maps all optional phone alternate fields', () => {
    const csv = Buffer.from('p1,p2,p3\n061000001,062000002,063000003\n');
    const leads = parseCsvAndMap(csv, {
      phone_primary: 'p1',
      phone_alt1: 'p2',
      phone_alt2: 'p3',
    });
    expect(leads[0]!.phone_alt1).toBe('062000002');
    expect(leads[0]!.phone_alt2).toBe('063000003');
    expect(leads[0]!.phone_alt3).toBeUndefined();
  });

  it('returns undefined for optional fields not in the mapping', () => {
    const csv = Buffer.from('phone\n061111111\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads[0]!.email).toBeUndefined();
    expect(leads[0]!.company).toBeUndefined();
  });

  it('processes multiple rows', () => {
    const csv = Buffer.from('phone\n061000001\n062000002\n063000003\n');
    const leads = parseCsvAndMap(csv, { phone_primary: 'phone' });
    expect(leads).toHaveLength(3);
  });
});

// ─── LEAD_MAPPABLE_FIELDS ─────────────────────────────────────────────────────

describe('LEAD_MAPPABLE_FIELDS', () => {
  it('contains phone_primary as the required field', () => {
    expect(LEAD_MAPPABLE_FIELDS).toContain('phone_primary');
  });

  it('has exactly 10 mappable fields', () => {
    expect(LEAD_MAPPABLE_FIELDS).toHaveLength(10);
  });
});
