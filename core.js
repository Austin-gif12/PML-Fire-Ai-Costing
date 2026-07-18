/* PML Fire Protection — PIN extraction & pricing engine
 * Ported line-for-line from the Python prototype that was validated
 * against the Cubic Works report (58 pins, £6,047.50 grand total,
 * with PIN 0001:01 confirmed against a manually-priced example: £86).
 *
 * This file has NO browser dependencies — it works on a plain array
 * of text lines. index.html is responsible for turning a PDF into
 * that array of lines (using pdf.js) and then calling into here.
 */

// ---------------------------------------------------------------------
// 1. PIN EXTRACTION
// ---------------------------------------------------------------------

function floorFromLocation(loc) {
  const parts = loc.split('/').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : loc.trim();
}

/**
 * Walk the report's text lines and reconstruct one entry per PIN,
 * each holding the floor/location and the raw "Brand: qty × product (dims)"
 * strings under its "Installed Products" section.
 */
function extractPins(lines) {
  const pins = [];
  let currentFloor = null;
  let currentEntry = null;
  let inProducts = false;
  let pendingBrand = null;
  let pendingProduct = null;

  const flushPending = () => {
    if (pendingProduct !== null && currentEntry) {
      currentEntry.products.push(`${pendingBrand}: ${pendingProduct}`);
      pendingProduct = null;
    }
  };

  for (const raw of lines) {
    const stripped = (raw ?? '').replace(/\s+/g, ' ').trim();

    let m = stripped.match(/^Location:\s*(.+)$/);
    if (m) {
      currentFloor = floorFromLocation(m[1]);
      continue;
    }

    m = stripped.match(/^Pin\s*#:\s*(\S+)/);
    if (m) {
      currentEntry = { floor: currentFloor, pin: m[1], products: [] };
      pins.push(currentEntry);
      inProducts = false;
      pendingBrand = null;
      pendingProduct = null;
      continue;
    }

    if (/Installed\s+Products/.test(stripped)) {
      inProducts = true;
      pendingBrand = null;
      pendingProduct = null;
      continue;
    }

    if (!inProducts) continue;

    if (/^(Comments|Operative|Submitted\s+at)/.test(stripped)) {
      flushPending();
      inProducts = false;
      continue;
    }
    if (stripped === '') continue;

    // dimension line, e.g. "(1700mm × 160mm)" or "(2500mm)"
    const dimM = stripped.match(/^\((.+)\)$/);
    if (dimM && pendingProduct !== null) {
      currentEntry.products.push(`${pendingBrand}: ${pendingProduct} (${dimM[1]})`);
      pendingProduct = null;
      continue;
    }

    // product line, e.g. "1 × Batt & Intumescent Mastic THROUGH wall 1 side"
    const prodM = stripped.match(/^(\d+\s*[×xX]\s*.+)$/);
    if (prodM) {
      flushPending(); // flush a previous product that had no dimension
      pendingProduct = prodM[1];
      continue;
    }

    // otherwise it's a brand name line, e.g. "Quel-fire" / "Nullifire"
    flushPending();
    pendingBrand = stripped;
  }

  return pins;
}

// ---------------------------------------------------------------------
// 2. SPLIT EACH PIN'S PRODUCT LIST INTO ONE ROW PER PRODUCT LINE
// ---------------------------------------------------------------------

function parseProductDimensions(s) {
  const isBatt = s.includes('Batt & Intumescent Mastic');

  // two dimensions in parentheses, e.g. "(1700mm × 160mm)"
  let m = s.match(/\((\d+)\s*mm\s*[×xX]\s*(\d+)\s*mm\)/);
  if (m) {
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    const sqm = Math.round((w / 1000) * (h / 1000) * 10000) / 10000;
    return { size1: w, size2: h, sqm, kind: isBatt ? 'batt' : 'other' };
  }

  // single dimension in parentheses, e.g. "(2500mm)"
  m = s.match(/\((\d+)\s*mm\)/);
  if (m) {
    return { size1: parseInt(m[1], 10), size2: null, sqm: null, kind: isBatt ? 'batt' : 'other' };
  }

  // trailing single dimension without parentheses, e.g. "... Wrap 55mm"
  m = s.match(/(\d+)\s*mm\s*$/);
  if (m) {
    return { size1: parseInt(m[1], 10), size2: null, sqm: null, kind: isBatt ? 'batt' : 'other' };
  }

  return { size1: null, size2: null, sqm: null, kind: isBatt ? 'batt' : 'other' };
}

function splitProductRows(pins) {
  const rows = [];
  for (const p of pins) {
    for (const prod of p.products) {
      const dims = parseProductDimensions(prod);
      rows.push({ floor: p.floor, pin: p.pin, product: prod, ...dims });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// 3. PRICING — rate tables ported from PML_Fire_Standard_Rates_2026.xlsx
//    Passed in from the UI so the person can tweak them if PML updates
//    the rate card without needing to touch this file.
// ---------------------------------------------------------------------

const DEFAULT_RATES = {
  throughWall: [
    { limit: 0.0025, label: '50x50', rate: 21 },
    { limit: 0.01, label: '100x100', rate: 28 },
    { limit: 0.04, label: '200x200', rate: 42 },
    { limit: 0.09, label: '300x300', rate: 54 },
    { limit: 0.16, label: '400x400', rate: 60 },
    { limit: 0.25, label: '500x500', rate: 72 },
    { limit: 0.36, label: '600x600', rate: 86 },
    { limit: 0.49, label: '700x700', rate: 102 },
    { limit: 0.64, label: '800x800', rate: 120 },
    { limit: 0.81, label: '900x900', rate: 159 },
    { limit: 1.00, label: '1m2', rate: 188 },
  ],
  overWall: [
    { limit: 0.04, label: '200x200', rate: 60 },
    { limit: 0.09, label: '300x300', rate: 70 },
    { limit: 0.16, label: '400x400', rate: 80 },
    { limit: 0.25, label: '500x500', rate: 95 },
    { limit: 0.36, label: '600x600', rate: 115 },
    { limit: 0.49, label: '700x700', rate: 145 },
    { limit: 0.64, label: '800x800', rate: 175 },
    { limit: 0.81, label: '900x900', rate: 215 },
    { limit: 1.00, label: '1m2', rate: 245 },
  ],
  wrap: [
    { limit: 55, label: 'up to 55mm', rate: 13 },
    { limit: 82, label: 'up to 82mm', rate: 15 },
    { limit: 110, label: 'up to 110mm', rate: 23 },
    { limit: 160, label: 'up to 160mm', rate: 37 },
  ],
  linearSeal: {
    '0-10mm': 15,
    '11-20mm': 20,
    '21-30mm': 25,
  },
};

function bracketLookup(value, table) {
  for (const row of table) {
    if (value <= row.limit + 1e-9) {
      return { label: row.label, rate: row.rate, overMax: false };
    }
  }
  const last = table[table.length - 1];
  return { label: last.label, rate: last.rate, overMax: true };
}

/**
 * Price an area (sqm) against a bracketed area table, splitting anything over
 * the top bracket (1m²) into whole 1m² units plus a remainder priced at its
 * own bracket, rather than capping the whole thing at the 1m² rate.
 * e.g. 1.2m² -> 1 x 1m² bracket + 0.2m² rounded up to its own bracket, summed.
 */
function priceArea(sqm, table) {
  const topBracket = table[table.length - 1];
  const topLimit = topBracket.limit;

  if (sqm <= topLimit + 1e-9) {
    const { label, rate } = bracketLookup(sqm, table);
    return {
      total: rate,
      breakdown: [{ portion: sqm, label, rate }],
    };
  }

  const wholeUnits = Math.floor(sqm / topLimit + 1e-9);
  const remainder = Math.round((sqm - wholeUnits * topLimit) * 10000) / 10000;

  const breakdown = [];
  let total = 0;

  for (let i = 0; i < wholeUnits; i++) {
    breakdown.push({ portion: topLimit, label: topBracket.label, rate: topBracket.rate });
    total += topBracket.rate;
  }
  if (remainder > 1e-9) {
    const { label, rate } = bracketLookup(remainder, table);
    breakdown.push({ portion: remainder, label, rate });
    total += rate;
  }

  return { total, breakdown };
}

function extractQty(productText) {
  const m = productText.match(/^\S.*?:\s*(\d+)\s*[×xX]/);
  return m ? parseInt(m[1], 10) : 1;
}

function extractLinearWidthClass(productText) {
  const m = productText.match(/Linear Mastic Seal\s+(\d+)\s*-\s*(\d+)\s*mm/);
  return m ? `${m[1]}-${m[2]}mm` : null;
}

function categorise(productText) {
  if (productText.includes('THROUGH wall')) return 'through';
  if (productText.includes('OVER wall')) return 'over';
  if (productText.includes('HPE Mastic') || productText.includes('FR Wrap')) return 'wrap';
  if (productText.includes('Linear Mastic Seal')) return 'linear_seal';
  return 'unknown';
}

function priceRow(row, rates) {
  const txt = row.product;
  const qty = extractQty(txt);
  const category = categorise(txt);

  let unitCost = null;
  let totalCost = null;
  let note = null;
  let flag = false;

  if ((category === 'through' || category === 'over') && row.sqm !== null) {
    const table = category === 'through' ? rates.throughWall : rates.overWall;
    const { total, breakdown } = priceArea(row.sqm, table);
    unitCost = Math.round(total * 100) / 100;
    totalCost = Math.round(unitCost * qty * 100) / 100;
    const orientation = category === 'through' ? 'through wall' : 'over wall (Patress), 1 side';

    if (breakdown.length === 1) {
      note = `${row.size1}mm x ${row.size2}mm batt & intumescent mastic, ${orientation} `
        + `(${row.sqm.toFixed(4)}m\u00b2, rounds up to ${breakdown[0].label} bracket) \u2013 `
        + `\u00a3${breakdown[0].rate} each`
        + (qty > 1 ? ` x${qty} = \u00a3${totalCost}` : '');
    } else {
      const parts = breakdown
        .map(b => `${b.portion.toFixed(4)}m\u00b2 @ ${b.label} bracket = \u00a3${b.rate}`)
        .join(' + ');
      note = `${row.size1}mm x ${row.size2}mm batt & intumescent mastic, ${orientation} `
        + `(${row.sqm.toFixed(4)}m\u00b2, exceeds 1m2 \u2013 split into brackets: ${parts} `
        + `= \u00a3${unitCost}) each`
        + (qty > 1 ? ` x${qty} = \u00a3${totalCost}` : '');
    }
  } else if (category === 'wrap' && row.size1 !== null) {
    const { label, rate, overMax } = bracketLookup(row.size1, rates.wrap);
    unitCost = rate;
    totalCost = rate * qty;
    flag = overMax;
    note = `${row.size1}mm HPE Mastic / FR Wrap (${label} bracket) \u2013 \u00a3${rate} each`
      + (qty > 1 ? ` x${qty} = \u00a3${totalCost}` : '');
    if (overMax) note += ' \u2013 EXCEEDS 160mm max bracket, please review';
  } else if (category === 'linear_seal' && row.size1 !== null) {
    const widthClass = extractLinearWidthClass(txt);
    const rateLm = rates.linearSeal[widthClass];
    const lengthM = row.size1 / 1000;
    if (rateLm !== undefined) {
      unitCost = Math.round(rateLm * lengthM * 100) / 100;
      totalCost = Math.round(unitCost * qty * 100) / 100;
      note = `Linear mastic seal ${widthClass} gap, ${lengthM.toFixed(2)}m run \u2013 `
        + `\u00a3${rateLm}/LM x ${lengthM.toFixed(2)}m = \u00a3${unitCost}`
        + (qty > 1 ? ` each x${qty} = \u00a3${totalCost}` : '');
    } else {
      note = `Linear mastic seal \u2013 width class not recognised (${txt})`;
    }
  } else {
    note = `Unrecognised product line \u2013 please price manually: ${txt}`;
    flag = true;
  }

  return { ...row, qty, category, unitCost, totalCost, note, flag };
}

function priceAllRows(rows, rates) {
  return rows.map(r => priceRow(r, rates));
}

// ---------------------------------------------------------------------
// 4. ONE-SHOT ENTRY POINT
// ---------------------------------------------------------------------

function processReport(lines, rates) {
  const pins = extractPins(lines);
  const rows = splitProductRows(pins);
  const priced = priceAllRows(rows, rates || DEFAULT_RATES);
  return { pins, rows: priced };
}

// Export for Node (unit testing) and for the browser (index.html)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPins, splitProductRows, parseProductDimensions,
    bracketLookup, extractQty, extractLinearWidthClass, categorise,
    priceRow, priceAllRows, processReport, DEFAULT_RATES,
  };
}
