import { describe, it, expect } from 'vitest';
import { cleanForTTS } from '../../src/tts/clean.js';

describe('cleanForTTS', () => {
  it('returns plain text unchanged', () => {
    expect(cleanForTTS('Dobro jutro, kako mogu pomoći?')).toBe(
      'Dobro jutro, kako mogu pomoći?',
    );
  });

  it('removes bold markdown', () => {
    expect(cleanForTTS('Naš **specijalni** paket')).toBe('Naš specijalni paket');
  });

  it('removes italic markdown', () => {
    expect(cleanForTTS('Ovo je *važno* za vas')).toBe('Ovo je važno za vas');
  });

  it('removes double underscore bold', () => {
    expect(cleanForTTS('__Popust__ od 20%')).toBe('Popust od 20%');
  });

  it('removes single underscore italic', () => {
    expect(cleanForTTS('_posebna_ ponuda')).toBe('posebna ponuda');
  });

  it('removes markdown headers', () => {
    expect(cleanForTTS('## Naša ponuda\nDobra cijena.')).toBe('Naša ponuda Dobra cijena.');
  });

  it('removes markdown links, keeping label', () => {
    expect(cleanForTTS('Posjetite [našu stranicu](https://example.com) za detalje')).toBe(
      'Posjetite našu stranicu za detalje',
    );
  });

  it('removes bare URLs', () => {
    expect(cleanForTTS('Više na https://example.com/some/path danas')).toBe(
      'Više na danas',
    );
  });

  it('removes inline code backticks', () => {
    expect(cleanForTTS('Koristite `POPUST2025` kod')).toBe('Koristite POPUST2025 kod');
  });

  it('removes fenced code blocks', () => {
    const input = 'Evo primjera:\n```\nkod ovdje\n```\nKraj.';
    expect(cleanForTTS(input)).toBe('Evo primjera: Kraj.');
  });

  it('replaces em-dash with comma+space', () => {
    // ' — ' → ', ' then space collapse removes double-space → ', '
    expect(cleanForTTS('Cijena — samo danas')).toBe('Cijena , samo danas');
  });

  it('replaces en-dash with comma+space', () => {
    // '–' with no surrounding spaces → ', ' directly
    expect(cleanForTTS('2020–2025')).toBe('2020, 2025');
  });

  it('collapses ellipsis to single period', () => {
    expect(cleanForTTS('Pa... ne znam...')).toBe('Pa. ne znam.');
  });

  it('collapses repeated exclamation marks', () => {
    expect(cleanForTTS('Odlično!!!')).toBe('Odlično!');
  });

  it('collapses repeated question marks', () => {
    expect(cleanForTTS('Jeste li sigurni???')).toBe('Jeste li sigurni?');
  });

  it('removes unordered list markers', () => {
    expect(cleanForTTS('- Prva stavka\n* Druga stavka\n+ Treća stavka')).toBe(
      'Prva stavka Druga stavka Treća stavka',
    );
  });

  it('removes ordered list markers', () => {
    expect(cleanForTTS('1. Prvo\n2. Drugo\n3. Treće')).toBe('Prvo Drugo Treće');
  });

  it('removes blockquote markers', () => {
    expect(cleanForTTS('> Citat\n> nastavak')).toBe('Citat nastavak');
  });

  it('removes horizontal rules', () => {
    expect(cleanForTTS('Tekst\n---\nNastavak')).toBe('Tekst Nastavak');
  });

  it('collapses multiple spaces to one', () => {
    expect(cleanForTTS('previše   razmaka   ovdje')).toBe('previše razmaka ovdje');
  });

  it('handles combined markdown', () => {
    const input = '**Dragi korisniče**, ovo je *posebna* ponuda — samo **danas**!!\n\n1. Pozovite nas\n2. Registrujte se';
    const output = cleanForTTS(input);
    // em-dash surrounded by spaces → ', ' then collapse → single space on each side
    expect(output).toBe('Dragi korisniče, ovo je posebna ponuda , samo danas! Pozovite nas Registrujte se');
  });

  it('returns empty string for empty input', () => {
    expect(cleanForTTS('')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanForTTS('  Zdravo  ')).toBe('Zdravo');
  });
});
