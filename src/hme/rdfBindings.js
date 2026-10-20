// === Mapping node → SE-Protokoll field bindings ===
// The counterpart of pdfFieldMap.js for the RDF side: it says which HME value
// feeds which node of the OntoCartographer mapping (src/model/rdfMappings.js),
// and how that value's instance URI is minted.
//
// One entry per mapping node id. Nodes that appear in the mapping but have no
// entry here stay unmapped — they produce no triples (see UNBOUND below).
//
// Each entry:
//   idCol    name of the generated table column holding the URI local name
//            (OntoCartographer: mappedColumn)
//   labelCol name of the column holding the human-readable label, written as
//            rdfs:label (OntoCartographer: labelColumn). Omitted for literals.
//   literal  true → the column holds a raw value, not a URI local name. The
//            node is exported with noPrefix so no ID prefix is prepended.
//   datatype optional literal datatype, prefixed name (e.g. 'xsd:date')
//   id(ctx)  computes the URI local name (or the raw value when literal)
//   label(ctx) computes the label
//
// Adding a protocol: add its mapping to rdfMappings.js and its node bindings
// here. Nothing else changes.

import { slugLocal } from './uriNames.js';
import { normalizeDate } from './uriNames.js';

// --- ctx helpers -------------------------------------------------------------
// ctx = { node, seNr, meta, v(path), partner, partnerNr, relationType }

const seUri = (nr) => (nr ? `SE${slugLocal(nr)}` : '');

// Nodes of the standard mapping deliberately left unbound in v1, with reason:
export const UNBOUND = {
  standard: {
    n15: 'E22_Human-Made_Object — HME hat nur ein Fundfeld; alle Funde laufen über n16 (E19)',
    n32: 'E52_Time-Span "Absolutes Datum" — keine Quelle im Standard-Protokoll',
    n33: 'xsd:gYear (P82a begin) — keine Quelle im Standard-Protokoll',
    n34: 'xsd:gYear (P82b end) — keine Quelle im Standard-Protokoll',
  },
};

export const RDF_BINDINGS = {
  standard: {
    tableId: 'hme_se_standard',
    tableName: 'HME SE-Protokolle (Standard)',
    nodes: {
      // ── Kopfdaten / Maßnahme (project level, identical on every row) ──
      n1: {
        idCol: 'Grabung_uri', labelCol: 'Grabung',
        id: (c) => (c.meta.Mnr ? `M${slugLocal(c.meta.Mnr)}` : ''),
        label: (c) => c.meta.Mbez || c.meta.Mnr || '',
      },
      n2: {
        idCol: 'Mnr_uri', labelCol: 'Mnr',
        id: (c) => (c.meta.Mnr ? `Mnr_${slugLocal(c.meta.Mnr)}` : ''),
        label: (c) => c.meta.Mnr || '',
      },
      n3: {
        idCol: 'Mbez_uri', labelCol: 'Mbez',
        id: (c) => (c.meta.Mbez ? `Mbez_${slugLocal(c.meta.Mbez)}` : ''),
        label: (c) => c.meta.Mbez || '',
      },
      n4: {
        idCol: 'KG_uri', labelCol: 'KG',
        id: (c) => (c.meta.KG ? `KG_${slugLocal(c.meta.KG)}` : ''),
        label: (c) => c.meta.KG || '',
      },
      n5: {
        idCol: 'OG_uri', labelCol: 'OG',
        id: (c) => (c.meta.OG ? `OG_${slugLocal(c.meta.OG)}` : ''),
        label: (c) => c.meta.OG || '',
      },

      // ── Befunddaten: räumlicher Rahmen ──
      n6: {
        idCol: 'Schnitt_Flaeche_uri', labelCol: 'Schnitt_Flaeche',
        id: (c) => { const v = c.v('befunddaten.Schnitt_Flaeche'); return v ? `SF_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Schnitt_Flaeche'),
      },
      n7: {
        idCol: 'Profil_uri', labelCol: 'Profil',
        id: (c) => { const v = c.v('befunddaten.Profil'); return v ? `Profil_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Profil'),
      },
      n8: {
        idCol: 'Objgr_Nr_uri', labelCol: 'Objgr_Nr',
        id: (c) => { const v = c.v('befunddaten.Objgr_Nr'); return v ? `Objgr_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Objgr_Nr'),
      },
      n13: {
        idCol: 'Objgr_Bez_uri', labelCol: 'Objgr_Bez',
        id: (c) => {
          const key = c.v('befunddaten.Objgr_Nr') || c.v('befunddaten.Objgr_Bez');
          return c.v('befunddaten.Objgr_Bez') ? `Objgr_${slugLocal(key)}_Bez` : '';
        },
        label: (c) => c.v('befunddaten.Objgr_Bez'),
      },
      n9: {
        idCol: 'Objnr_uri', labelCol: 'Objnr',
        id: (c) => { const v = c.v('befunddaten.Objnr'); return v ? `Obj_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Objnr'),
      },
      n12: {
        idCol: 'Objbez_uri', labelCol: 'Objbez',
        id: (c) => {
          const key = c.v('befunddaten.Objnr') || c.v('befunddaten.Objbez');
          return c.v('befunddaten.Objbez') ? `Obj_${slugLocal(key)}_Bez` : '';
        },
        label: (c) => c.v('befunddaten.Objbez'),
      },

      // ── Die stratigrafische Einheit selbst ──
      // The SE number comes from the node label (what the matrix shows), the
      // form field befunddaten.SE is the fallback for records typed there.
      n10: {
        idCol: 'SE_uri', labelCol: 'SE',
        id: (c) => seUri(c.seNr),
        label: (c) => c.node.label,
      },
      n11: {
        idCol: 'SE_Bez_uri', labelCol: 'SE_Bez',
        id: (c) => (c.v('befunddaten.SE_Bez') ? `${seUri(c.seNr)}_Bez` : ''),
        label: (c) => c.v('befunddaten.SE_Bez'),
      },

      // ── Stratigrafische Relation (eine Zeile je Matrix-Kante) ──
      n14: {
        idCol: 'SE_Relation_uri', labelCol: 'SE_Relation',
        id: (c) => seUri(c.partnerNr),
        label: (c) => (c.partner ? c.partner.label : ''),
      },
      // Dot-one target of AP11.1_has_type. HME edges carry direction only:
      // the edge source lies above its target, so every emitted relation is
      // of type "above" (see rdfTable.js).
      n23: {
        idCol: 'Relationstyp_uri', labelCol: 'Relationstyp', labelLang: 'en',
        id: (c) => (c.relationType ? `Relationstyp_${slugLocal(c.relationType)}` : ''),
        label: (c) => c.relationType || '',
      },

      // ── Funde ──
      n16: {
        idCol: 'Funde_uri', labelCol: 'Funde',
        id: (c) => (c.hasFunde ? `${seUri(c.seNr)}_Fund` : ''),
        label: (c) => c.v('befunddaten.Funde_Text') || (c.hasFunde ? `Funde ${c.node.label}` : ''),
      },
      n19: {
        idCol: 'Fundtyp_uri', labelCol: 'Fundtyp',
        id: (c) => { const v = c.v('befunddaten.Funde_Text'); return v ? `Fundtyp_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Funde_Text'),
      },

      // ── Probe ──
      n17: {
        idCol: 'Probe_uri', labelCol: 'Probe',
        id: (c) => (c.hasProbe ? `SE_Probe_${slugLocal(c.seNr)}` : ''),
        label: (c) => (c.hasProbe ? `Probenentnahme ${c.node.label}` : ''),
      },
      n18: {
        idCol: 'Probe_Art_uri', labelCol: 'Probe_Art',
        id: (c) => { const v = c.v('befunddaten.Probe_Art'); return v ? `Probenart_${slugLocal(v)}` : ''; },
        label: (c) => c.v('befunddaten.Probe_Art'),
      },

      // ── Interpretation und Datierung ──
      n27: {
        idCol: 'Interpretation_uri', labelCol: 'Interpretation',
        id: (c) => {
          const v = c.v('interpretation.vorlaeufige_Interpretation');
          return v ? `Interpretation_${slugLocal(v)}` : '';
        },
        label: (c) => c.v('interpretation.vorlaeufige_Interpretation'),
      },
      // A4_Stratigraphic_Genesis carries the dating; it is only minted when
      // there is a dating to hang on it.
      n31: {
        idCol: 'Genesis_uri', labelCol: 'Genesis',
        id: (c) => (c.v('interpretation.vorlaeufige_Datierung') ? `${seUri(c.seNr)}_gen` : ''),
        label: (c) => (c.v('interpretation.vorlaeufige_Datierung') ? `Entstehung ${c.node.label}` : ''),
      },
      n35: {
        idCol: 'Datierung_uri', labelCol: 'Datierung',
        id: (c) => {
          const v = c.v('interpretation.vorlaeufige_Datierung');
          return v ? `Datierung_${slugLocal(v)}` : '';
        },
        label: (c) => c.v('interpretation.vorlaeufige_Datierung'),
      },

      // ── Freitexte (Literale) ──
      n25: {
        idCol: 'Beschreibung_SE', literal: true,
        // same fallback the PDF export uses (pdfFieldMap descFallback)
        id: (c) => c.v('beschreibungen.Beschreibung_SE') || c.node.description || '',
      },
      n24: {
        idCol: 'Beschreibung_Interface', literal: true,
        id: (c) => c.v('beschreibungen.Beschreibung_Interface'),
      },
      n21: {
        idCol: 'Verweise_Dokumentation', literal: true,
        id: (c) => c.v('dokumentation.Verweise_Dokumentation'),
      },

      // ── Aufnahme (S4_Observation = das ausgefüllte SE-Protokoll) ──
      n28: {
        idCol: 'Protokoll_uri', labelCol: 'Protokoll',
        id: (c) => (c.hasProtokoll ? `${seUri(c.seNr)}_Protokoll` : ''),
        label: (c) => (c.hasProtokoll ? `SE-Protokoll ${c.node.label}` : ''),
      },
      n29: {
        idCol: 'Datum', literal: true, datatype: 'xsd:date',
        id: (c) => normalizeDate(c.v('abschluss.Datum')).value,
        // only type it when it really parsed as a date
        typed: (c) => normalizeDate(c.v('abschluss.Datum')).isDate,
      },
      n30: {
        idCol: 'Bearbeiter_in_uri', labelCol: 'Bearbeiter_in',
        id: (c) => { const v = c.v('abschluss.Bearbeiter_in'); return v ? `Person_${slugLocal(v)}` : ''; },
        label: (c) => c.v('abschluss.Bearbeiter_in'),
      },
    },
  },
};

export const getBindings = (protocolId) => RDF_BINDINGS[protocolId] || null;
