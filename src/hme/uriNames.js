// === Helpers for minting URI local names and typed literal values ===
// Shared by the RDF export and the OntoCartographer project export so both
// mint byte-identical identifiers.

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

// Local name safe for a prefixed URI: no colons (they would make
// OntoCartographer's applyPrefix treat the value as already prefixed),
// no whitespace, no characters that need escaping in Turtle.
export const slugLocal = (value) => {
  if (value === null || value === undefined) return '';
  let s = String(value).trim();
  if (s === '') return '';
  s = s.replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c]);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip remaining accents
  s = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return s;
};

// A local name must not start with a digit in a prefixed name (Turtle allows
// it, but several stores and the Explorer's slug handling do not like it).
export const localName = (...parts) => {
  const slug = parts
    .map((p) => slugLocal(p))
    .filter((p) => p !== '')
    .join('_');
  return slug;
};

const MONTHS_OK = /^(0?[1-9]|1[0-2])$/;

// The BDA form records the date as free text. Recognise the common Austrian
// spellings and hand back ISO 8601 so the value can carry an xsd:date type;
// anything else stays untouched and is exported as a plain literal.
// Returns { value, isDate }.
export const normalizeDate = (raw) => {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: '', isDate: false };

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { value: s, isDate: true };

  // 3.5.2024 / 03.05.2024 / 3. 5. 2024 / 3/5/2024
  const dmy = s.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    if (MONTHS_OK.test(m) && Number(d) >= 1 && Number(d) <= 31) {
      const year = y.length === 4 ? y : String(2000 + Number(y));
      return { value: `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, isDate: true };
    }
  }
  return { value: s, isDate: false };
};
