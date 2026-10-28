(async function () {
  try {
    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------
    //
    // Packaging-panel extractor. Sibling of costco.js / germany.js / japan.js /
    // mexico.js, but it reads the PRODUCT PACKAGING instead of the shelf label:
    // ingredients, Drug Facts actives, allergens, nutrition, claims and
    // front-of-pack scores. It returns NO pricing - run it alongside a country
    // script, not instead of one.
    //
    // Language-agnostic: an EU Zutaten block, a US Drug Facts panel, a Japanese
    // 原材料名 block and an INCI cosmetics list all go through the same prompt.
    //
    // The prompt below is kept identical to ingredients_prompt.js, which is the
    // readable reference copy. Edit there, then re-sync, or edit here and treat
    // this file as the source of truth - do not let them drift.

    // gemini-3.8-flash pricing, USD per 1M tokens (output includes thinking).
    // Google doubles every rate on 2027-01-01; the cost code takes the last
    // entry whose date has been reached, so no edit is needed then.
    const GEMINI_PRICES = [
      { from: '2026-01-01', input: 0.75, cachedInput: 0.075, output: 3.75 },
      { from: '2027-01-01', input: 1.50, cachedInput: 0.15, output: 7.50 }
    ];

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function convertGoogleDriveUrl(url) {
      if (url.includes('drive.google.com')) {
        let fileId = null;

        const match1 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match1) fileId = match1[1];

        const match2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (match2) fileId = match2[1];

        if (fileId) {
          return [
            `https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`,
            `https://lh3.googleusercontent.com/d/${fileId}`,
            `https://drive.google.com/uc?export=view&id=${fileId}`
          ];
        }
      }

      return [url];
    }

    // Panel text is written through VERBATIM - no proper-casing, no reordering.
    // Panels are frequently printed in ALL CAPS and the whole point of the
    // field is that it matches the package. Only whitespace and line-wrap
    // artifacts are normalized.
    function cleanText(value) {
      if (value === null || value === undefined) return '';
      const text = String(value).replace(/\s+/g, ' ').trim();
      // The model is told to use null, but guard against the literal string.
      if (text === '' || text.toLowerCase() === 'null') return '';
      return text;
    }

    // ---------------------------------------------------------------------
    // Flattening
    //
    // The whole result travels as JSON TEXT in ONE field, raw_data_json. The
    // shape is dynamic - a sunscreen has active_ingredients and no nutrients,
    // a biscuit is the reverse, and a nutrition panel can carry 4 rows or 25 -
    // so a fixed column set would be mostly blank and would silently drop
    // anything unforeseen.
    //
    // Field contract: always compact valid JSON with all five top-level keys.
    // Downstream that is a one-liner: JSON.parse(raw_data_json)
    // ---------------------------------------------------------------------

    // A real boolean in the JSON. Tolerates the string forms in case the model
    // ignores the schema, so consumers never have to re-parse "true".
    function normalizeFlag(value) {
      if (value === true || value === false) return value;
      const text = cleanText(value).toLowerCase();
      if (text === 'true') return true;
      if (text === 'false') return false;
      return null;
    }

    // '' -> null, so absent stays absent inside the JSON instead of becoming an
    // empty string that reads like a value.
    function textOrNull(value) {
      const text = cleanText(value);
      return text === '' ? null : text;
    }

    // Nutrition panels outside the US print a decimal COMMA ("21,3 g"), and a
    // European panel prints a thousands DOT ("2.038 kJ"). The prompt asks the
    // model to return dot decimals - but all four price scripts learned not to
    // leave separator decisions to the model, so the swap is enforced here too.
    // Same last-separator heuristic as parsePrice() in germany.js.
    //
    // Only separators are touched. amount is a STRING field because panels
    // legitimately print "< 0.5", "0" and words like "Spuren", so anything that
    // is not a number survives verbatim.
    function normalizeAmount(value) {
      const text = cleanText(value);
      if (text === '') return null;
      return text.replace(/\d[\d.,]*\d|\d/g, normalizeNumberToken);
    }

    // "21,3" -> "21.3"   "2.038" -> "2038"   "0,006" -> "0.006"   "1,13" -> "1.13"
    function normalizeNumberToken(number) {
      const commaCount = (number.match(/,/g) || []).length;
      const dotCount = (number.match(/\./g) || []).length;
      if (commaCount === 0 && dotCount === 0) return number;

      // Both separators present: the right-most one is the decimal mark.
      if (commaCount > 0 && dotCount > 0) {
        return number.lastIndexOf(',') > number.lastIndexOf('.')
          ? number.replace(/\./g, '').replace(',', '.')
          : number.replace(/,/g, '');
      }

      const separator = commaCount > 0 ? ',' : '.';
      const count = commaCount > 0 ? commaCount : dotCount;
      const last = number.lastIndexOf(separator);
      const decimals = number.length - last - 1;

      // A group of exactly 3 digits is a thousands separator - "2.038 kJ" and
      // "2,038 kJ" are both 2038. The exception is an integer part of 0, which
      // is what a 3-decimal European value looks like ("0,006 g").
      const isThousands = count > 1
        || decimals === 0
        || (decimals === 3 && number.slice(0, last) !== '0');

      if (isThousands) return number.split(separator).join('');
      return separator === ',' ? number.replace(',', '.') : number;
    }

    // ISO 639 base code, lowercased, region suffix dropped ("pt-BR" -> "pt").
    // Anything that is not a code - a language NAME ("German"), a country code,
    // a sentence - becomes null rather than polluting a field meant to be a
    // join key.
    function normalizeLanguageCode(value) {
      const text = cleanText(value).toLowerCase();
      if (text === '') return null;
      const base = text.split(/[-_]/)[0];
      return /^[a-z]{2,3}$/.test(base) ? base : null;
    }

    function normalizeStringArray(values) {
      if (!Array.isArray(values)) return [];
      return values.map(cleanText).filter(text => text !== '');
    }

    // Keeps only the schema's keys, in schema order, so every row parses the
    // same way even when the model omits a key or invents one.
    //
    // A row missing any `required` key is dropped: a truncated response
    // salvages up to the last comma, which can leave {"name":"Salt"} with no
    // amount - a row that reads as data but carries none.
    function normalizeObjectArray(values, keys, required) {
      if (!Array.isArray(values)) return [];
      return values.map(entry => {
        if (!entry || typeof entry !== 'object') return null;
        const out = {};
        let hasValue = false;
        keys.forEach(key => {
          let value;
          if (key === 'daily_value_percent') {
            value = entry[key] === null || entry[key] === undefined || String(entry[key]).trim() === '' ? null : entry[key];
          } else if (key === 'amount') {
            // Only the nutrient rows carry an 'amount', so this never touches
            // active_ingredients or the health-score rows.
            value = normalizeAmount(entry[key]);
          } else {
            value = textOrNull(entry[key]);
          }
          out[key] = value;
          if (value !== null) hasValue = true;
        });
        if (!hasValue) return null;
        if ((required || []).some(key => out[key] === null)) return null;
        return out;
      }).filter(entry => entry !== null);
    }

    function isEmptyValue(value) {
      if (value === null || value === undefined) return true;
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === 'object') {
        return Object.keys(value).every(key => isEmptyValue(value[key]));
      }
      return String(value).trim() === '';
    }

    const NULL_RESULT = {
      brand: null,
      description: null,
      package_barcode: null,
      ingredients: {
        raw_text: null,
        parsed_list: [],
        is_partial: null,
        active_ingredients: [],
        allergens_contains: [],
        allergens_may_contain: []
      },
      nutrition_facts: null,
      product_claims: [],
      nutrition_and_health_scores: [],
      language_code: null
    };

    // True when the model read at least one PANEL off the packaging.
    //
    // An object that parsed but holds no panel data is an empty read, and must
    // be flagged Error rather than written as a Clean row.
    //
    // language_code, brand, description and package_barcode are deliberately
    // NOT counted here.
    // They identify the product or the text rather than being panel data, so
    // a front-only read carrying nothing but a brand and name stays an Error.
    function hasAnyPanel(product) {
      if (!product || typeof product !== 'object') return false;

      const ingredients = product.ingredients || {};
      const nutrition = product.nutrition_facts;

      const filled = value => value !== null && value !== undefined && String(value).trim() !== '';
      const populated = value => Array.isArray(value) && value.length > 0;

      return filled(ingredients.raw_text)
        || populated(ingredients.parsed_list)
        || populated(ingredients.active_ingredients)
        || populated(ingredients.allergens_contains)
        || populated(ingredients.allergens_may_contain)
        || (nutrition !== null && nutrition !== undefined && typeof nutrition === 'object'
            && (filled(nutrition.serving_size) || filled(nutrition.servings_per_container) || populated(nutrition.nutrients)))
        || populated(product.product_claims)
        || populated(product.nutrition_and_health_scores);
    }

    // True when a brand or product name was read. Not panel data, so it does
    // not make a row Clean on its own - but it is kept instead of discarded.
    function hasIdentity(product) {
      if (!product || typeof product !== 'object') return false;
      return textOrNull(product.brand) !== null || textOrNull(product.description) !== null;
    }

    // imageURL may hold several photos of the SAME product separated by "|"
    // (front, back, side). All of them go to Gemini in one call.
    async function findProductInfo(imageUrl, apiKey) {
      const imageUrls = imageUrl.split('|').map(url => url.trim()).filter(Boolean);
      if (imageUrls.length === 0) {
        return { data: NULL_RESULT, usage: null };
      }

      // Google Drive conversion (with variants for retry), per image
      const imageVariantLists = imageUrls.map(convertGoogleDriveUrl);

      // Every image must download: a row read from only some of its photos
      // would look complete while missing panels. Thrown outside the try
      // below, so it reaches the top-level M_StopWithError.
      const fetched = await Promise.all(imageVariantLists.map(fetchImageWithRetry));
      const failed = imageUrls.filter((url, index) => !fetched[index]);
      if (failed.length > 0) {
        throw new Error(`Failed to fetch ${failed.length} of ${imageUrls.length} images: ${failed.join(' | ')}`);
      }

      try {
        const result = await extractProductInfo(fetched, apiKey);

        // Keep the record if ANY panel came back, or at least a brand or product
        // name. A front-only photo of a non-food pack ("Power Force Alufolie")
        // legitimately yields nothing else, and wiping it lost real data.
        if (hasAnyPanel(result.data) || hasIdentity(result.data)) {
          return result;
        }

        console.warn('No readable panel in extraction result');
        return { data: NULL_RESULT, usage: result.usage };
      } catch (error) {
        console.error(`Extraction error: ${error.message}`);
      }

      return { data: NULL_RESULT, usage: null };
    }

    // MIME types the Gemini vision API accepts for inline image data.
    const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

    const EXTENSION_MIME_TYPES = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heic: 'image/heic', heif: 'image/heif'
    };

    // Decodes the leading bytes of the base64 payload so the real format can be
    // identified from its magic number.
    function decodeHeaderBytes(base64Data) {
      const chunk = base64Data.length >= 32 ? base64Data.slice(0, 32) : base64Data;
      try {
        const binary = atob(chunk);
        const bytes = [];
        for (let i = 0; i < binary.length; i++) {
          bytes.push(binary.charCodeAt(i) & 0xFF);
        }
        return bytes;
      } catch (error) {
        return [];
      }
    }

    function matchesAscii(bytes, offset, text) {
      for (let i = 0; i < text.length; i++) {
        if (bytes[offset + i] !== text.charCodeAt(i)) return false;
      }
      return true;
    }

    // Identifies the image format from its magic number. Servers frequently
    // send image bytes as application/octet-stream, which Gemini rejects.
    function sniffMimeType(bytes) {
      if (bytes.length < 12) return null;

      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
      if (bytes[0] === 0x89 && matchesAscii(bytes, 1, 'PNG')) return 'image/png';
      if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) return 'image/webp';
      if (matchesAscii(bytes, 4, 'ftyp')) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
        if (brand === 'mif1' || brand === 'msf1' || brand === 'heif') return 'image/heif';
        return 'image/heic';
      }
      if (matchesAscii(bytes, 0, 'GIF8')) return 'image/gif';
      if (matchesAscii(bytes, 0, 'BM')) return 'image/bmp';

      return null;
    }

    // Drive permission/quota pages and CDN error pages return HTTP 200 with HTML.
    function looksLikeHtml(bytes) {
      let index = 0;
      while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0A || bytes[index] === 0x0D)) {
        index++;
      }
      return bytes[index] === 0x3C; // '<'
    }

    function mimeTypeFromUrl(url) {
      const match = String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
      if (!match) return null;
      return EXTENSION_MIME_TYPES[match[1].toLowerCase()] || null;
    }

    async function fetchImageWithRetry(urlVariants) {
      // Try each variant until one succeeds
      for (let variantIndex = 0; variantIndex < urlVariants.length; variantIndex++) {
        const url = urlVariants[variantIndex];
        try {
          const imageResponse = await fetch(url);

          if (imageResponse.ok) {
            const imageBlob = await imageResponse.blob();
            const base64Image = await blobToBase64(imageBlob);
            const base64Data = base64Image.split(',')[1] || base64Image;

            if (!base64Data) {
              console.warn(`Image: empty response body - trying next variant`);
              continue;
            }

            const headerBytes = decodeHeaderBytes(base64Data);

            if (looksLikeHtml(headerBytes)) {
              console.warn(`Image: got an HTML page instead of image data (permission/quota?) - trying next variant`);
              continue;
            }

            // Trust the bytes first: many hosts (and Google Drive's uc endpoint)
            // report application/octet-stream for perfectly valid JPEGs.
            const headerType = (imageBlob.type || '').split(';')[0].trim().toLowerCase();
            const mimeType = sniffMimeType(headerBytes)
              || (SUPPORTED_IMAGE_TYPES.indexOf(headerType) !== -1 ? headerType : null)
              || mimeTypeFromUrl(url)
              || 'image/jpeg';

            if (SUPPORTED_IMAGE_TYPES.indexOf(mimeType) === -1) {
              console.warn(`Image: format "${mimeType}" is not supported by Gemini - convert it to JPEG or PNG`);
            }

            return {
              inline_data: {
                mime_type: mimeType,
                data: base64Data
              }
            };
          }

          console.warn(`Image: HTTP ${imageResponse.status} from ${url}`);
        } catch (error) {
          // Continue to next variant
        }
      }

      console.error('Failed to fetch image - all variants failed');
      return null;
    }

    // Mozenda treats any pair of percent signs in the script as a field variable and
    // substitutes it before the script runs, which can silently cut text out
    // of the prompt. The prompt therefore never contains a literal percent
    // sign: it is inserted at run time instead.
    const PCT = String.fromCharCode(37);

    const PACKAGING_PROMPT = `You are an expert product data extraction AI. Analyze the provided image or images of ONE product (package panels or a shelf photo) and extract structured, high-accuracy metadata from the printed panels.

Packaging may be in ANY language and ANY script (Latin, Japanese, Chinese, Korean, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari, ...). You read them all with equal confidence.

You do NOT extract prices. Prices, unit prices and promotions are handled by a different prompt. Package text always wins over shelf-label text. Only when NO package text is readable and the image shows just a retailer shelf label may brand and description be copied from that label (its first line is usually the brand, the second the product name); even then never copy its price, unit price, promotion ("AKTION", "Nur für kurze Zeit") or its "Klasse / Ursprung" detail line.

Return ONLY a valid JSON object matching the schema below. Do not include markdown code block backticks or conversational text. Never announce what you are about to do, never justify a choice, never describe a conflict between these instructions and the image.

=============================================================
RULE 1 - VISIBILITY. THIS OVERRIDES EVERY OTHER INSTRUCTION.
=============================================================
- Return ONLY characters you can actually SEE printed in the image
- You will often RECOGNISE the product (Coca-Cola, Nestlé, Kellogg's, Neutrogena, Nivea, L'Oréal, Colgate, Tylenol, Bimbo, Sabritas, Lala, 明治, 伊藤園...). That knowledge is FORBIDDEN as a source. It may NOT fill a single field
- On a shelf photo, packages FACE FORWARD, so back panels are very often NOT visible. Returning nulls and empty arrays is the NORMAL, CORRECT outcome - it is not a failure and you must not compensate for it
- NEVER reconstruct a list from the product name, the flavour, the category, the front-of-pack claims or the seals
- NEVER "complete" a list, table or word whose end you cannot read - return the part you can read and flag it partial
- NEVER calculate, convert, estimate or infer a value. If a number is not printed, it does not exist. Do NOT derive servings from a net weight, do NOT recompute a ${PCT} Daily Value, do NOT compute a Nutri-Score from a nutrition table
- HIDDEN TEXT IS THE #1 SOURCE OF INVENTED DATA. A thumb, a fold, glare, a crease, a price sticker, candy seen through a clear window, or the curve of a bag often covers part of a panel. For every word or number you cannot actually see, you return NOTHING - you do not fill the gap:
  * An ingredient list you can read only partly: return exactly the words you read, in order, and set is_partial true. Never add the "typical" ingredients of that kind of product - a word you did not see on this pack does not exist
  * A nutrition table with hidden cells: return ONLY the rows whose number you can read. A row whose value is covered is left out entirely - never estimated, never taken from memory
  * If you can make out only scattered fragments of a list, return raw_text null rather than a reconstructed list
  * Well-known brands are where this goes wrong most, because you know their recipes. The more familiar the product, the more strictly you copy only the pixels
- FINAL SELF-CHECK before answering: for every string you are about to return, ask "can I point at these exact characters in the image?" If no, delete it. The ONE exception is language_code, which only names the language of text you have already read

=============================================================
RULE 2 - PANEL EVIDENCE GATES EACH FIELD
=============================================================
Fill a section ONLY when you have seen the panel it comes from:
- Saw an ingredient declaration -> fill ingredients.raw_text / parsed_list
- Saw an "Active ingredients" + "Purpose" table -> fill active_ingredients
- Saw a Nutrition Facts panel, a Supplement Facts panel, or a mineral-water analysis table -> fill nutrition_facts
- Saw an allergen statement, or allergens emphasised inside the list -> fill allergens_contains / allergens_may_contain
- Saw a printed FoP score or seal -> fill nutrition_and_health_scores
- Saw a legible brand name or product name -> fill brand / description
- Saw a barcode with every one of its printed digits legible -> fill package_barcode
- Saw none of these -> those fields stay null / empty
Never decide from what you think the product IS. If a panel is printed, you read it; if it is not, the field stays empty.

ORIENTATION: photos are often taken sideways or upside down, and seals print their text around a circle. Read rotated text in its own reading direction, and read circular seal text from its start to its end, so the phrase comes out in its printed word order. Never return the words of a phrase in a scrambled order and never drop a word from the middle of one - if you cannot recover the full phrase in order, omit it.

=============================================================
IMAGE HANDLING
=============================================================
1. You receive ONE OR MORE images, all of the SAME product - often its front, back and sides. Wherever these instructions say "the image", read "the images": use them together and return ONE object for the product. Read only what they show - a list that wraps around a bottle out of view in every image is partial, never completed
   - Take each panel from the image where it is most complete and legible
   - NEVER join two pieces of a list from different images unless the same overlapping words are visible in both. Otherwise return the most complete single piece and set is_partial true
   - An image that shows a DIFFERENT product is ignored entirely
2. If several DIFFERENT products are visible (a shelf photo), extract only the product the image is centred on - the one in focus, or the one the shelf label sits under. NEVER merge panels from different packages
3. If you cannot tell which package a panel belongs to, leave the affected fields null. A wrong pairing is far worse than a null
4. Front-of-pack marketing is NOT an ingredient list. "Made with real butter", "no added sugar", "100${PCT} natural" never become ingredients
5. If no panel is readable in the image, return the object with every field null/empty - never an invented record

=============================================================
IDENTIFYING WHICH PANEL YOU ARE LOOKING AT
=============================================================
You do not output a product category - but you must recognise the panel, because
each kind routes its text to a DIFFERENT field. Walk this ladder and stop at the
first match:
1. "drug" - a "Drug Facts" header, an "Active ingredients"/"Purpose" table, the "Uses"+"Warnings"+"Directions" trio, or an equivalent national OTC panel ("Registro Sanitario", "IPP", 医薬品, "Arzneimittel", "Notice patient")
2. "supplement" - a "Supplement Facts" / "Complemento alimenticio" / "Nahrungsergänzungsmittel" / 栄養機能食品 panel, or "Dietary Supplement" on the front
3. "food" - a "Nutrition Facts" / "Información nutrimental" / "Nährwerte" / "Valori nutrizionali" / 栄養成分表示 / "Пищевая ценность" table, or a food ingredient list with no panel above
4. "cosmetic" - an INCI-style list (starts with Aqua/Water/Eau, contains Parfum/Fragrance, CI + 5 digits), a period-after-opening symbol ("12M", "24M"), or "Cosmetic"/化粧品 wording
5. "household" - GHS hazard diamonds, "Danger"/"Warning"/"Peligro", "Keep out of reach of children", an EPA/biocide registration number, or a surfactant disclosure ("5-15${PCT} anionic surfactants")
6. "other" - packaging readable but matching none of the above
7. null - not enough visible to tell

The ladder matters BECAUSE panels overlap on one pack. Resolve by the ladder, never by intuition:
- Sunscreen: a cosmetic in the EU, an OTC drug in the US. If a Drug Facts panel is printed, read it as one - the label tells you the market
- Toothpaste, antidandruff shampoo, medicated lip balm, antiperspirant: often carry BOTH a Drug Facts panel and an INCI list. Read BOTH - the actives go to active_ingredients, the INCI text to raw_text
- Protein powder / meal replacement: whichever of Supplement Facts or Nutrition Facts is printed is the one you read

=============================================================
EXTRACTION RULES
=============================================================

1. INGREDIENTS & DRUG FACTS:

   "raw_text" - copy the exact ingredient statement from the packaging:
   - Find it after a heading such as: Ingredients / Ingrédients / Zutaten / Ingredientes / Ingredienti / Ingrediënten / Ingredienser / Ainesosat / Składniki / Složení / Zloženie / Összetevők / Ingrediente / Съставки / Състав / Sastojci / Sestavine / Sudėtis / Sastāvs / Koostis / Συστατικά / İçindekiler / Состав / Склад / 原材料名 / 原材料 / 配料 / 配料表 / 成分 / 원재료명 / 성분 / المكونات / רכיבים / ส่วนประกอบ / Thành phần / Komposisi / Mga Sangkap
   - PANEL ROUTING - three panels, three destinations:
     * DRUG FACTS: the "Inactive ingredients:" run IS raw_text. The Active ingredients table is active_ingredients, NOT raw_text
     * SUPPLEMENT FACTS: the "Other ingredients:" run IS raw_text. The panel's nutrient rows are nutrition_facts, NOT raw_text
     * COSMETICS: an unlabelled INCI block IS raw_text
   - VERBATIM: same words, same order, same punctuation, same script, same accents, same capitalisation (many panels are ALL CAPS - keep them that way)
   - Do NOT translate, transliterate, summarise, correct spelling, expand abbreviations or re-order
   - Do NOT restructure: never move an ingredient into or out of a parenthesised group, never repeat an ingredient that is printed once, never drop one that is printed. If a dense list defeats you, return what you read with certainty and set is_partial true - a rewritten list is far worse than a partial one
   - Read every percentage DIGIT BY DIGIT against the image before answering - "10,9 ${PCT}" is not "9,9 ${PCT}", and a wrong digit here passes every downstream check
   - Drop the heading itself, keep everything after it
   - Join line-wrapped text with a single space; remove hyphens that exist ONLY because of line wrapping
   - Keep percentages, parentheses, E-numbers and origin notes that sit inside the list
   - Do NOT include the "Contains:" or "May contain:" sentence here - those are their own fields
   - The list normally ends at the first full stop, at the allergen sentence, or at the next panel heading
   - null if no ingredient declaration is readable

   "parsed_list" - the SAME declaration broken into a clean array of strings:
   - One entry per top-level ingredient, in the printed order (descending weight)
   - Keep each entry verbatim INCLUDING its percentage and its parenthesised sub-ingredients: "Chocolate (32${PCT}) (sugar, cocoa mass, emulsifier: soya lecithin)"
   - A comma INSIDE parentheses does NOT start a new entry
   - Japanese/Chinese lists often separate with 、 or ・ - split on those; keep 、 inside parentheses intact
   - Keep a class word with its additives when printed together ("CONSERVADORES: BENZOATO DE SODIO, SORBATO DE POTASIO")
   - The joined entries MUST reproduce raw_text - never add, drop or reorder an item
   - Empty array [] when raw_text is null

   "is_partial" - a real BOOLEAN, true or false (not the strings "true"/"false"):
   - true when the declaration is cut off, curves out of view around a bottle or jar, is blurred mid-list, or is hidden behind another package - i.e. you returned only part of it
   - false when you read it from its heading to its end
   - null when there is no ingredient text at all
   - Never guess the hidden part. Flag it instead

   "active_ingredients" - ONLY from an "Active ingredients" / "Principios activos" / "Wirkstoffe" / "Substances actives" / 有効成分 table:
   - Drug Facts panels print substance, strength and purpose in SEPARATE columns:
       Active ingredients          Purpose
       Avobenzone 3.0${PCT} ........... Sunscreen
   - "name" = the substance ONLY, without its strength ("Avobenzone")
   - "strength" = the printed amount with its unit ("3.0${PCT}", "500 mg", "10 mg/g"). null if no strength is printed
   - "purpose" = the printed purpose column ("Sunscreen", "Pain reliever", "Antacid", "Analgésico"). null if there is no purpose column
   - Keep strength and purpose in their OWN fields. They are different facts printed in different columns - never merge them into one value, and never put a purpose where a strength belongs
   - Keep the printed language and capitalisation
   - Empty array [] when no actives table is printed - the normal case for food and cosmetics

   "allergens_contains" - allergens declared PRESENT:
   - Sources: a "Contains:" / "Allergy advice" / "CONTIENE:" / "Enthält" / "Contient" / "アレルギー物質" / "一部に...を含む" sentence, OR items printed in BOLD, UPPERCASE or underlined inside an otherwise normal list
   - Keep the words as printed, in the original language ("WHEAT", "小麦", "leche", "SOJA"), one allergen per entry
   - EU PACKS (German, French, Italian, Dutch, Polish... any EU-language list): there is usually NO "Contains:" line, because EU law requires every allergenic ingredient to be EMPHASISED inside the list instead - and on a photo that emphasis is often too faint to see. So on an EU-language ingredient list, allergens_contains is every ingredient in YOUR raw_text that names one of the 14 EU allergen groups, copied as printed ("Weizenmehl" -> "Weizen", "Eier" -> "Eier", "Süßmolkenpulver" -> "Milch", "Bio-Milch" -> "Milch", "Lecithine (Soja)" -> "Soja", "gemahlene Haselnüsse" -> "Haselnüsse"):
       gluten cereals (Weizen, Roggen, Gerste, Hafer, Dinkel) - Krebstiere - Eier - Fisch - Erdnüsse - Soja - Milch (incl. Butter, Sahne, Molke, Milchzucker/Laktose, Käse, Joghurt) - Schalenfrüchte (Mandeln, Haselnüsse, Walnüsse, Cashew, Pistazien...) - Sellerie - Senf - Sesam - Schwefeldioxid/Sulfite - Lupinen - Weichtiere
     The source is still the printed list - never a substance you assume the product contains, and never an ingredient you did not return in raw_text
   - Outside the EU, only what is declared ("Contains:") or visibly emphasised counts
   - A substance named ONLY in a "May contain" / "Kann Spuren von" sentence goes to allergens_may_contain and NEVER to allergens_contains
   - Empty array [] if none declared

   "allergens_may_contain" - trace / cross-contamination warnings:
   - Sources: "May contain traces of...", "PUEDE CONTENER TRAZAS DE...", "Kann Spuren von ... enthalten", "Made in a facility that also processes...", "同一ライン"
   - Keep STRICTLY SEPARATE from allergens_contains - a "may contain" substance is NOT a declared allergen
   - Empty array [] if none

2. NUTRITION FACTS (International-Compatible):
   - This whole object is null unless a Nutrition Facts panel, a Supplement Facts panel, or a mineral-water analysis table ("Mineralstoffe", "Analyse", "Análisis", "Composición", "Composizione", 成分分析表 - a table of dissolved ions in mg/l) is actually printed and readable. A sunscreen, a shampoo or a detergent has NO nutrition panel -> null. NEVER invent a value such as "about 4 applications per can"
   - "servings_per_container": as printed, as a string ("About 30", "1", "8 порций"). NEVER calculate it from net weight. null if absent
   - "serving_size": raw string as printed ("2 Tbsp (30g)", "100g", "1 tablet", "1 個分"). null if absent
   - "basis": ONE value for the whole panel - what every number in it is per, as printed: "per serving", "per 100g", "per 100ml", "per container", "per tablet", "100gあたり". If the panel prints TWO columns (per serving AND per 100 g), return the PER SERVING column and set basis to "per serving". Do NOT repeat this on every nutrient row. null if the panel states no basis
   - "nutrients": an array of objects for ALL listed nutrients, vitamins and minerals, in printed order
     * Capture standard nutrients (Calories, Fat, Saturated Fat, Trans Fat, Cholesterol, Salt, Sodium, Carbohydrates, Fiber, Sugars, Added Sugars, Protein) AND micro-nutrients (Iron, Calcium, Magnesium, Potassium, Vitamin D, ...)
     * "name": standardized nutrient name in ENGLISH, whatever the panel language. Map what is printed onto the English term: "Grasas totales"/"Fett"/"脂質" -> "Total Fat"; "Proteínas"/"Eiweiß"/"たんぱく質" -> "Protein"; "Hidratos de carbono"/"Kohlenhydrate"/"炭水化物" -> "Carbohydrates"; "Azúcares"/"Zucker"/"糖類" -> "Sugars"; "Fibra"/"Ballaststoffe"/"食物繊維" -> "Fiber"; "Valor energético"/"Brennwert"/"エネルギー" -> "Calories". This is the ONLY field you may translate - it is the join key for cross-market reporting
     * SALT vs SODIUM - TWO DIFFERENT NUTRIENTS that are NEVER interchangeable. Salt (NaCl) weighs about 2.5x its sodium content, so filing one under the other corrupts the figure silently and nothing downstream can tell it apart from a correct read
       - Decide from the WORD PRINTED ON THE PANEL. Never from the country, the retailer, the brand, or what kind of product you think this is
       - Printed as salt -> "name": "Salt". Covers "Salt", "Salz", "Sel", "Sale", "Sal", "Zout", "Sól", "Sůl", "Soľ", "Só", "Suola", "Sare", "Sol", "So", "Соль", "Сіль", "Сол", "Kripë", "Αλάτι", "Tuz", and the Japanese salt-equivalent line "食塩相当量"
       - Printed as sodium -> "name": "Sodium". Covers "Sodium", "Sodio", "Sódio", "Natrium", "Sód", "Sodyum", "Natriumi", "Натрий", "Натрій", "Νάτριο", "ナトリウム", "나트륨", "钠", "Na", "Na+"
       - NEVER convert between the two, in either direction. Do not divide a salt figure by 2.5 and do not multiply a sodium figure - RULE 1 forbids returning a number that is not printed
       - If the pack declares BOTH - a nutrition panel printing Salt alongside a mineral analysis table printing Natrium, routine on bottled water - return BOTH rows exactly as printed. Never emit a row for a nutrient the panel did not print
       - Sanity check, never a licence to relabel: EU/UK/Balkan/international food panels almost always declare Salt, while US and Canadian FDA panels, Mexican NOM-051 panels and mineral analysis tables almost always declare Sodium. Where what you read disagrees with that expectation, THE PRINTED WORD WINS
     * "amount": the numerical value or text as printed, WITHOUT the unit ("180", "16", "< 0.5", "0")
     * DECIMAL SEPARATOR - ALWAYS return a DOT, whatever the panel prints. European, Balkan and Latin American panels use a decimal COMMA: return "21,3" as "21.3", "0,06" as "0.06", "1,13" as "1.13"
       - A THOUSANDS separator is dropped entirely: "2.038 kJ" (European) and "2,038 kJ" (English) both return as "2038"
       - Swap the separator ONLY. Never round, never re-scale, never gain or lose a digit
       - Non-numeric amounts keep their wording and take the same swap: "< 0,5" returns as "< 0.5"; "Spuren", "traces", "trazas" stay exactly as printed
       - This applies to the numeric fields of THIS panel only - amount, serving_size and servings_per_container. raw_text and parsed_list stay VERBATIM, decimal commas included: an ingredient reading "Kakaobutter 32,5${PCT}" keeps its comma
     * "unit": the unit of measure only ("kcal", "kJ", "g", "mg", "mcg", "µg", "IU"). null if the row prints none
     * "daily_value_percent": the ${PCT} Daily Value / RI / NRV as a NUMBER (21, 8, 0). null when the row has no ${PCT} column. Never compute it yourself
     * The ${PCT} must be for the SAME basis as the amount. EU panels often print amounts "pro 100 g" beside "${PCT} RI pro Portion (25 g)" - those two columns describe different quantities, so when you return the per-100 g amounts, daily_value_percent is null for every row
     * ${PCT}DV COLUMN ALIGNMENT - a frequent and SILENT error, read this twice: the ${PCT} is printed at the RIGHT EDGE of its nutrient's row, but the digits commonly sit LOWER than the nutrient's baseline, aligned to the row's bottom rule line. On a photo - above all a curved bag, pouch or bottle - the entire ${PCT} column therefore LOOKS shifted DOWN by one row
     * Bind each ${PCT} to the nutrient whose row it shares by following the panel's horizontal RULE LINES, never by vertical closeness. A ${PCT} that appears beside "Saturated Fat" but sits inside the "Total Fat" band belongs to TOTAL FAT
     * Anchors to check yourself against: the FIRST ${PCT} in a US panel belongs to Total Fat. Rows that legitimately print NO ${PCT} - Trans Fat, Polyunsaturated Fat, Monounsaturated Fat, Total Sugars, and Protein on most US panels - must be null. If you have assigned a ${PCT} to one of those, your whole column is off by one and every value below it is wrong
     * If you still cannot bind the percentages to their rows with confidence, set daily_value_percent to null for EVERY row. A systematic off-by-one corrupts the entire panel and is far worse than no percentages at all
     * A row printing BOTH kcal and kJ is TWO entries: Calories/kcal and Calories/kJ
     * Each nutrient carries ONLY name, amount, unit and daily_value_percent - the basis is stated once for the panel, above
   - Empty nutrients array [] only when a panel is visible but its rows are unreadable

3. PRODUCT CLAIMS & CERTIFICATIONS:
   - Extract all dietary, health, environmental and quality claims displayed anywhere on the packaging or label ("USDA Organic", "Certified Gluten-Free", "Clinically Proven", "Water Resistant (80 Minutes)", "Broad Spectrum SPF 100", "Non-GMO Project Verified", "Sin gluten", "Bio", "有機JAS", "Halal", "Kosher OU")
   - VERBATIM ONLY. Copy the printed wording. Do not paraphrase, do not merge two claims into one, do not generate plausible extras. This field is unbounded prose and is the easiest place in the whole schema to hallucinate - copy it or omit it
   - A claim must be PRINTED. Do not add "Gluten Free" because the ingredients contain no wheat
   - Certifications, seals and awards ARE claims - return their printed wording here ("Fairtrade", "Naturland", "OEKO-TEX STANDARD 100"), once each, and never also in nutrition_and_health_scores
   - NOT claims, even though they are printed on the pack - leave them out: storage, preparation and opening instructions ("Kühl und trocken lagern", "Mit Wiederverschlussetikett"), disposal and recycling guidance, safety warnings, operating instructions, legal and address text, the net quantity, technical specifications (dimensions, capacity, wattage), the nutrition-variability note ("Die Nährwerte unterliegen ... Schwankungen"), the product name itself, and retailer SHELF-LABEL promotions ("Nur für kurze Zeit", "Aktion")
   - Also never claims: waste-sorting marks and their text ("So trennt man richtig", "Gelbe Tonne", "Io Riciclo", "Valido solo in Italia", "Tipps für die Tonne"), conformity marks (CE, WEEE bin), "Made in China"-style manufacturing origin lines, pack counts and sizes ("2ER PACK", "6x1,5L", "200 ML", "40 W"), and mass-balance legal notes ("Der gesamte Fairtrade-Kakao kann ... ersetzt ... werden")
   - COMPLETE PHRASES ONLY. A claim that is cut off or runs out of view ("AUS DEUTSCHER", "SEIT MEHR ALS") is omitted - unlike an ingredient list, a claim cannot be flagged partial
   - A printed SCALE of options with one marked ("mild - mittelalt - würzig") yields only the MARKED option, never every label on the scale
   - Only claims printed on THIS package. Text on a neighbouring package or in the background never belongs here
   - Return AT MOST 15, choosing the most prominent. Empty array [] if none

4. NUTRITION & HEALTH SCORES:
   - Front-of-Pack scores, health ratings and retailer shelf ratings that are PRINTED on the pack or on the shelf label
   - "system_name": "Nutri-Score", "Health Star Rating", "UK Traffic Light", "Eco-Score", "NuVal", "Guiding Stars", "Retailer Score", "NOM-051 warning seals"
   - "score_value": as printed - "A", "4.5", 82, or for warning seals the seal text itself
   - "scale_max": the top of the scale when it is known from the system or printed ("E", 5, 100). null otherwise
   - "details": a STRING holding any per-nutrient breakdown, joined with "; " - e.g. for a UK traffic light "Fat: RED; Saturates: AMBER; Sugars: GREEN; Salt: AMBER", or for Mexican seals "EXCESO AZÚCARES; EXCESO CALORÍAS". null when there is no breakdown
   - OBSERVED ONLY. NEVER compute, estimate or infer a score from the nutrition table. If no score is printed, return an empty array even when you could calculate one
   - NUTRI-SCORE: return it ONLY when you can clearly see which single letter tile is enlarged. If the badge is small, blurred, far away, at an angle, partly covered, or you are not certain which tile is enlarged, leave the Nutri-Score out. An omitted Nutri-Score is a correct answer; a wrong letter is a serious error
   - A score must be a badge or seal visible IN ONE OF THE IMAGES. A back panel showing a nutrition table but no Nutri-Score badge has NO Nutri-Score unless another image clearly shows the badge - never carry one over from what the front of the pack probably shows
   - ONLY GRADED SYSTEMS belong here - a scale with a position marked on it. A certification, seal or award is NOT a score and NEVER goes in this array: organic logos and control codes (EU organic leaf, "DE-ÖKO-001", "BE-BIO-02"), Bio-Siegel, Naturland, Bioland, Demeter, Fairtrade, Rainforest Alliance, FSC, PEFC, Der Blaue Engel, OEKO-TEX STANDARD 100 (the 100 is part of the NAME, not a score), Institut Fresenius, DLG, and taste awards (International Taste Institute, Superior Taste Award). Those are claims - put their printed wording in product_claims
   - Empty array [] if none

5. LANGUAGE:
   - "language_code" - the language of the panel text you returned, as a lowercase ISO 639-1 code ("en", "de", "fr", "es", "it", "nl", "pt", "pl", "ru", "el", "tr", "ar", "he", "th", "vi", "id", "ja", "zh", "ko")
   - This is the ONE field in this schema you may DERIVE rather than copy. You are naming the language of text you have ALREADY returned - nothing more
   - It may never work backwards. Knowing the language must not add, complete or correct a single character anywhere else in this object; RULE 1 still governs every other field
   - Judge it from ingredients.raw_text. Where there is no raw_text, judge it from whatever panel text you did read - the allergen statement, the actives table, the nutrition rows as printed, the claims, the description
   - NEVER judge it from the brand, the retailer, a flag, an address, a currency or the country you think the pack is sold in
   - Script alone does not settle it - Latin script covers dozens of languages, and an INCI list reads much the same in every market. Where the text is too short or too ambiguous to name the language, return null
   - Use the base code only, no region suffix ("pt", never "pt-BR"). "zh" for Chinese in either script
   - null when no panel text was readable

6. BRAND & DESCRIPTION:
   "brand" - the brand name as printed in the pack's logo or wordmark:
   - Copy it VERBATIM in its own script and capitalisation ("Lala", "NIVEA", "明治", "Kirkland Signature")
   - The brand is NOT the manufacturer, importer or distributor. "Manufactured by / Elaborado por / Hergestellt für / Distributed by / 製造者 / 販売者" lines name a COMPANY, not a brand - never take the brand from that address block
   - The brand is NOT the retailer. A store logo (ALDI, Hofer, LIDL, Costco, Walmart, Tesco...) printed on an own-label pack is NOT the brand - the brand is the product-line name printed on that pack ("Kirkland Signature", "Milbona", "Great Value", "meine Kuchen Welt", "Natur Lieblinge", "Power Force"). If the store logo is the ONLY mark on the pack, return null. The ALDI, ALDI SÜD, ALDI NORD and HOFER logos in particular are NEVER a brand - they appear on every ALDI own-label pack, including the ones whose product line you cannot see
   - A name followed by a company form (GmbH, KG, AG, S.A., Sp. z o.o., Ltd, Inc...) or printed in the address block is the MANUFACTURER, never the brand - even when it looks like a brand ("Musterbäcker GmbH", "Beispiel Süßwaren KG") - unless the same name is also printed as the logo on the front
   - The brand is NOT a certification or seal (Naturland, Bioland, Demeter, Fairtrade, FSC, OEKO-TEX, the EU organic leaf, a bare "bio"/"Bio"), NOT a region or wine appellation ("Mosel", "Rioja", "Allgäu"), and NOT a category word
   - A logo you can only RECOGNISE by its colours, shape or mascot is not readable text. If you cannot read the brand's letters in the image, return null - RULE 1 applies here more than anywhere
   - null if no brand name is legible

   "description" - the product name as printed on the pack:
   - The name plus its flavour / variant as printed ("Leche Entera Lala", "Galletas Marías", "Sport Sunscreen Spray SPF 50", "Butterkekse")
   - Take it from the front of the pack. If the images show only a back or side panel, use the legal product name printed there ("Denominación: GALLETAS DULCES", "Verkehrsbezeichnung: Butterkekse", "名称: 清涼飲料水") - drop the heading, keep the name
   - VERBATIM: same words, same script, same capitalisation. Do not translate, re-order, or add a word that is not printed
   - EXCLUDE the net weight / volume, prices, promotions and marketing claims ("Sin gluten", "New!", "20${PCT} more") - claims belong in product_claims
   - Do not use retailer SHELF-LABEL text ("LALA LECHE ENT 1L") when package text is readable - see the shelf-label rule at the top
   - Pick ONE language: on a multilingual pack return the product name in the language you chose for the rest of the object, not every translation joined together
   - null if no product name is legible

7. PACKAGE BARCODE:
   "package_barcode" - the number printed under the EAN / UPC barcode on the pack:
   - All 8, 12 or 13 digits, copied exactly as printed, left to right. Do not add, pad or drop a digit
   - If ANY digit will not resolve, return null - never write a "?", never guess a digit. The code checks the last digit, so a misread is caught and costs you the field
   - Only the barcode of THIS product. On a shelf photo, a barcode on a neighbouring pack or on a shelf label is not it
   - A QR code or Datamatrix square is NOT a barcode. Never from memory - knowing the product's barcode is not reading it
   - null if no barcode digits are legible, which on a front-facing pack is the normal answer

=============================================================
NULL vs EMPTY ARRAY - THESE MEAN DIFFERENT THINGS
=============================================================
- null (scalar or object) / [] (array) = not present on the pack, or not readable
- A populated value = you read it
- Never return the string "null", never return "" - use real null
- Never fill a field with a placeholder, a dash, "N/A" or "unknown"

=============================================================
MULTILINGUAL PACKAGING
=============================================================
- Many packs print the same declaration in several languages, marked "GB:", "FR:", "DE:", "ES:" or separated by "/"
- Return ONE object, choosing the MOST COMPLETE and legible language version for raw_text and parsed_list
- Do NOT translate, and do NOT merge two languages into one list
- Nutrient names are standardized to English regardless of which language version you chose
- language_code names the version you CHOSE - never every language printed on the pack, and never a language you did not read from

=============================================================
STEP-BY-STEP PROCESS
=============================================================
1. Identify the product the images are about, and which of its panels are visible across them
2. Inventory which panels are actually present (brand / product name, ingredient declaration, actives table, nutrition/supplement panel, allergen statement, FoP score/seals)
3. Read each present panel into its field, verbatim; leave every absent panel null/empty
4. Split raw_text into parsed_list and confirm the two match
5. Standardize nutrient names to English; leave every other string in its printed language
6. Name the language of the text you read in language_code, deriving it from nothing but that text
7. Copy the brand and the product name exactly as printed on the package, or null
8. Copy the barcode digits exactly as printed, or null if any digit is unreadable

=============================================================
VALIDATION - RUN THIS BEFORE ANSWERING
=============================================================
- Every field comes from the SAME product
- Every returned character is visible in the image - no memory, no inference, no completion, no calculation. language_code is the single exception, and naming the language did not add, complete or correct one character anywhere else
- language_code was judged from the words you actually read, never from the brand, the country, a flag or an address
- parsed_list joined back together reproduces raw_text
- active_ingredients never carries a purpose inside strength, or a strength inside name
- nutrition_facts is null unless an actual Nutrition/Supplement Facts panel or mineral analysis table was seen
- Every salt/sodium row is named after the WORD PRINTED on that panel, and neither figure was converted into the other
- Every amount, serving_size and servings_per_container uses a DOT decimal separator, with no digit gained or lost in the swap
- nutrition_and_health_scores contains only printed GRADED scores, never computed ones, and no certification, seal or award
- No ingredient, nutrient row or number was supplied for text that is covered, cropped or unreadable - partial lists are flagged is_partial, hidden nutrition rows are left out
- On an EU-language list, every ingredient naming one of the 14 EU allergens appears in allergens_contains
- product_claims contains only printed, complete phrases from this package - never a claim deduced from the ingredients, never an instruction, warning, specification or shelf promotion
- No allergen from a "may contain" sentence appears in allergens_contains
- brand was READ from legible letters on the pack, never recognised from a logo's look, and is not the manufacturer or distributor from the address block, a store logo, a certification seal or a region
- description is printed package text, not a shelf-label abbreviation, and carries no net weight, price or claim
- package_barcode is every digit printed under this pack's barcode, read from the image, with nothing guessed, padded or dropped - or null
- No field was filled from the product's fame rather than from its label

=============================================================
REQUIRED JSON OUTPUT SCHEMA - return exactly this object, nothing else
=============================================================
{
  "brand": "string or null",
  "description": "string or null",
  "package_barcode": "string or null",
  "ingredients": {
    "raw_text": "string or null",
    "parsed_list": ["string"],
    "is_partial": "boolean or null",
    "active_ingredients": [{ "name": "string", "strength": "string or null", "purpose": "string or null" }],
    "allergens_contains": ["string"],
    "allergens_may_contain": ["string"]
  },
  "nutrition_facts": {
    "servings_per_container": "string or null",
    "serving_size": "string or null",
    "basis": "string or null",
    "nutrients": [{ "name": "string", "amount": "string", "unit": "string or null", "daily_value_percent": "number or null" }]
  },
  "product_claims": ["string"],
  "nutrition_and_health_scores": [{ "system_name": "string", "score_value": "string", "scale_max": "string or null", "details": "string or null" }],
  "language_code": "string or null"
}

EXAMPLE - the BACK of a US sunscreen can: a Drug Facts panel, NO nutrition panel, and no legible brand or product name on this side:
{"brand":null,"description":null,"package_barcode":null,"ingredients":{"raw_text":"Alcohol Denat., Isobutane, VA/Butyl Maleate/Isobornyl Acrylate Copolymer, Caprylyl Glycol, Polyglyceryl-3 Stearate","parsed_list":["Alcohol Denat.","Isobutane","VA/Butyl Maleate/Isobornyl Acrylate Copolymer","Caprylyl Glycol","Polyglyceryl-3 Stearate"],"is_partial":false,"active_ingredients":[{"name":"Avobenzone","strength":"3.0${PCT}","purpose":"Sunscreen"},{"name":"Homosalate","strength":"10.0${PCT}","purpose":"Sunscreen"},{"name":"Octisalate","strength":"5.0${PCT}","purpose":"Sunscreen"},{"name":"Octocrylene","strength":"10.0${PCT}","purpose":"Sunscreen"},{"name":"Oxybenzone","strength":"6.0${PCT}","purpose":"Sunscreen"}],"allergens_contains":[],"allergens_may_contain":[]},"nutrition_facts":null,"product_claims":["Broad Spectrum SPF 100","Clinically Proven","UVA/UVB Protection","Water Resistant (80 Minutes)"],"nutrition_and_health_scores":[],"language_code":"en"}

EXAMPLE - a Mexican biscuit pack, back panel visible. The small logo reads "La Abuela"; the only product name on this side is the legal name after "Denominación:". "Elaborado por Galletera del Norte S.A. de C.V." is the manufacturer, NOT the brand:
{"brand":"La Abuela","description":"GALLETAS DULCES","package_barcode":null,"ingredients":{"raw_text":"HARINA DE TRIGO, AZÚCAR, GRASA VEGETAL, JARABE DE MAÍZ DE ALTA FRUCTOSA, SAL, LECHE EN POLVO, LECITINA DE SOYA.","parsed_list":["HARINA DE TRIGO","AZÚCAR","GRASA VEGETAL","JARABE DE MAÍZ DE ALTA FRUCTOSA","SAL","LECHE EN POLVO","LECITINA DE SOYA"],"is_partial":false,"active_ingredients":[],"allergens_contains":["TRIGO","LECHE","SOYA"],"allergens_may_contain":["HUEVO"]},"nutrition_facts":{"servings_per_container":"About 4","serving_size":"6 galletas (30 g)","basis":"per serving","nutrients":[{"name":"Calories","amount":"140","unit":"kcal","daily_value_percent":7},{"name":"Total Fat","amount":"4.5","unit":"g","daily_value_percent":6},{"name":"Sodium","amount":"115","unit":"mg","daily_value_percent":5},{"name":"Protein","amount":"2","unit":"g","daily_value_percent":null}]},"product_claims":[],"nutrition_and_health_scores":[{"system_name":"NOM-051 warning seals","score_value":"2 seals","scale_max":null,"details":"EXCESO AZÚCARES; EXCESO CALORÍAS"}],"language_code":"es"}

EXAMPLE - a German food pack. The panel prints "2.038 kJ" and "21,3 g", so the thousands dot is dropped and the decimal commas become dots. It declares "Salz", so the row is Salt - never Sodium, even though "Natriumhydrogencarbonat" appears in the ingredient list:
{"brand":"Sonnenhof","description":"Butterkekse","package_barcode":null,"ingredients":{"raw_text":"Weizenmehl, Zucker, pflanzliches Öl (Palm), Magermilchpulver, Speisesalz, Backtriebmittel: Natriumhydrogencarbonat, Emulgator: Sojalecithine.","parsed_list":["Weizenmehl","Zucker","pflanzliches Öl (Palm)","Magermilchpulver","Speisesalz","Backtriebmittel: Natriumhydrogencarbonat","Emulgator: Sojalecithine"],"is_partial":false,"active_ingredients":[],"allergens_contains":["WEIZEN","MILCH","SOJA"],"allergens_may_contain":["HASELNÜSSE"]},"nutrition_facts":{"servings_per_container":null,"serving_size":null,"basis":"per 100g","nutrients":[{"name":"Calories","amount":"2038","unit":"kJ","daily_value_percent":null},{"name":"Calories","amount":"487","unit":"kcal","daily_value_percent":null},{"name":"Total Fat","amount":"21.3","unit":"g","daily_value_percent":null},{"name":"Saturated Fat","amount":"10.6","unit":"g","daily_value_percent":null},{"name":"Carbohydrates","amount":"66.4","unit":"g","daily_value_percent":null},{"name":"Sugars","amount":"28.9","unit":"g","daily_value_percent":null},{"name":"Protein","amount":"6.1","unit":"g","daily_value_percent":null},{"name":"Salt","amount":"1.13","unit":"g","daily_value_percent":null}]},"product_claims":["Ohne Konservierungsstoffe"],"nutrition_and_health_scores":[{"system_name":"Nutri-Score","score_value":"D","scale_max":"E","details":null}],"language_code":"de"}

EXAMPLE - the back of a German seasoning sachet held in a hand. The thumb covers the second half of the ingredient list and the fat rows of the nutrition table. Only the visible words and rows are returned, the list is flagged partial, nothing is filled in from what such a seasoning usually contains, and "Weizenmehl" puts Weizen in allergens_contains:
{"brand":null,"description":"Grillwürzer Kräuter","package_barcode":null,"ingredients":{"raw_text":"Speisesalz, Paprika, Weizenmehl, Zwiebeln","parsed_list":["Speisesalz","Paprika","Weizenmehl","Zwiebeln"],"is_partial":true,"active_ingredients":[],"allergens_contains":["Weizen"],"allergens_may_contain":[]},"nutrition_facts":{"servings_per_container":null,"serving_size":null,"basis":"per 100g","nutrients":[{"name":"Carbohydrates","amount":"41.2","unit":"g","daily_value_percent":null},{"name":"Sugars","amount":"6.3","unit":"g","daily_value_percent":null},{"name":"Protein","amount":"9.8","unit":"g","daily_value_percent":null},{"name":"Salt","amount":"38.5","unit":"g","daily_value_percent":null}]},"product_claims":[],"nutrition_and_health_scores":[],"language_code":"de"}

EXAMPLE - a bottled mineral water. No ingredient declaration, and the analysis table lists DISSOLVED IONS, so the row is Sodium - never Salt. The label prints the brand and the name; "Natürliches Mineralwasser" is a claim, not the description:
{"brand":"Bergquell","description":"Classic Mineralwasser mit Kohlensäure","package_barcode":null,"ingredients":{"raw_text":null,"parsed_list":[],"is_partial":null,"active_ingredients":[],"allergens_contains":[],"allergens_may_contain":[]},"nutrition_facts":{"servings_per_container":null,"serving_size":null,"basis":"per 100ml","nutrients":[{"name":"Calcium","amount":"8.02","unit":"mg","daily_value_percent":null},{"name":"Magnesium","amount":"2.61","unit":"mg","daily_value_percent":null},{"name":"Sodium","amount":"1.16","unit":"mg","daily_value_percent":null},{"name":"Potassium","amount":"0.42","unit":"mg","daily_value_percent":null}]},"product_claims":["Natürliches Mineralwasser"],"nutrition_and_health_scores":[],"language_code":"de"}`;


    // Structured output: the model physically cannot emit prose, markdown fences
    // or a "let me explain" preamble around the JSON.
    const PACKAGING_GENERATION_CONFIG = {
      // 0 plus a fixed seed: the review found the SAME image giving materially
      // different ingredient lists and Nutri-Score letters across runs.
      temperature: 0,
      seed: 42,
      topK: 40,
      topP: 0.95,
      // A full nutrition panel runs 15-20 nutrient rows, each its own object, on
      // top of a long verbatim ingredient list. If finishReason comes back
      // MAX_TOKENS, that is the cause.
      maxOutputTokens: 16384,
      // Keeps more image detail for small print: Nutri-Score badges, dense
      // ingredient lists. Costs more input tokens. If Gemini rejects it (an
      // error mentioning mediaResolution), delete this line.
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      // No thinkingConfig: removed on 2026-09-30 with the move to
      // gemini-3.8-flash, matching aldi-sud.js. The model then uses its own
      // default - check thoughtsTokens in the output to see whether it
      // still thinks.
      responseMimeType: "application/json",
      // OBJECT, not ARRAY: one product per call, per the supplied spec.
      responseSchema: {
        type: "OBJECT",
        properties: {
          // Copied off the pack like everything else - never recognised from a
          // logo. Also written out as their own Mozenda fields.
          brand: { type: "STRING", nullable: true },
          description: { type: "STRING", nullable: true },
          // As printed - the code checks the last digit and never pads.
          package_barcode: { type: "STRING", nullable: true },
          ingredients: {
            type: "OBJECT",
            properties: {
              raw_text: { type: "STRING", nullable: true },
              parsed_list: { type: "ARRAY", items: { type: "STRING" } },
              // A real boolean - "true"/"false" as strings forced every consumer to
              // re-parse them.
              is_partial: { type: "BOOLEAN", nullable: true },
              active_ingredients: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING", nullable: true },
                    // Kept apart on purpose: on a Drug Facts panel these are two
                    // different printed columns, and merging them makes strength
                    // unqueryable downstream.
                    strength: { type: "STRING", nullable: true },
                    purpose: { type: "STRING", nullable: true }
                  },
                  propertyOrdering: ["name", "strength", "purpose"]
                }
              },
              allergens_contains: { type: "ARRAY", items: { type: "STRING" } },
              allergens_may_contain: { type: "ARRAY", items: { type: "STRING" } }
            },
            propertyOrdering: ["raw_text", "parsed_list", "is_partial", "active_ingredients", "allergens_contains", "allergens_may_contain"]
          },
          // Nullable OBJECT: null is the correct answer for every product with no
          // Nutrition/Supplement Facts panel, which is most of them.
          nutrition_facts: {
            type: "OBJECT",
            nullable: true,
            properties: {
              servings_per_container: { type: "STRING", nullable: true },
              serving_size: { type: "STRING", nullable: true },
              // Stated ONCE for the panel. As a per-row field it repeated the same
              // string 20+ times, ~24 percent of the nutrition payload for no information.
              basis: { type: "STRING", nullable: true },
              nutrients: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING", nullable: true },
                    // STRING, not NUMBER: panels print "< 0.5" and "0" alike, and a
                    // union type is not expressible in a responseSchema.
                    amount: { type: "STRING", nullable: true },
                    unit: { type: "STRING", nullable: true },
                    daily_value_percent: { type: "NUMBER", nullable: true }
                  },
                  propertyOrdering: ["name", "amount", "unit", "daily_value_percent"]
                }
              }
            },
            propertyOrdering: ["servings_per_container", "serving_size", "basis", "nutrients"]
          },
          product_claims: { type: "ARRAY", items: { type: "STRING" } },
          nutrition_and_health_scores: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                system_name: { type: "STRING", nullable: true },
                score_value: { type: "STRING", nullable: true },
                scale_max: { type: "STRING", nullable: true },
                // STRING, not object: a responseSchema cannot express "object or
                // string or null", so per-nutrient breakdowns arrive '; '-joined.
                details: { type: "STRING", nullable: true }
              },
              propertyOrdering: ["system_name", "score_value", "scale_max", "details"]
            }
          },
          // A CORE field, not a panel: it describes the text the panels were
          // read in. It is also the ONE derived value in the schema - the
          // prompt carves it out of RULE 1 explicitly and bars it from
          // influencing any other field.
          language_code: { type: "STRING", nullable: true }
        },
        propertyOrdering: [
          "brand", "description", "package_barcode",
          "ingredients", "nutrition_facts", "product_claims",
          "nutrition_and_health_scores", "language_code"
        ]
      }
    };

    // imageParts: the already-fetched inline_data parts, one per image.
    async function extractProductInfo(imageParts, apiKey) {
      const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

      // A single image is sent exactly as before; several are numbered so the
      // model can tell them apart.
      const parts = [{ text: PACKAGING_PROMPT }];
      if (imageParts.length === 1) {
        parts.push(imageParts[0]);
      } else {
        imageParts.forEach((part, index) => {
          parts.push({ text: `Image ${index + 1} of ${imageParts.length}:` });
          parts.push(part);
        });
      }

      const payload = {
        contents: [{
          parts: parts
        }],
        generationConfig: PACKAGING_GENERATION_CONFIG
      };

      const response = await fetch(GEMINI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API request failed:', response.status, errorText);
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();

      const candidate = (result.candidates || [])[0];
      if (!candidate) {
        const blockReason = result.promptFeedback?.blockReason;
        throw new Error(blockReason ? `Gemini returned no candidates (blocked: ${blockReason})` : 'Gemini returned no candidates');
      }
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        console.warn(`Gemini finishReason: ${candidate.finishReason}${candidate.finishReason === 'MAX_TOKENS' ? ' - response was cut off, salvaging what parsed' : ''}`);
      }

      const text = (candidate.content?.parts || []).map(part => part.text || '').join('');

      let usageInfo = {
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        cost: 0
      };

      if (result.usageMetadata) {
        const inputTokens = result.usageMetadata.promptTokenCount || 0;
        const outputTokens = result.usageMetadata.candidatesTokenCount || 0;
        const thoughtsTokens = result.usageMetadata.thoughtsTokenCount || 0;
        const cachedTokens = result.usageMetadata.cachedContentTokenCount || 0;
        const totalTokens = result.usageMetadata.totalTokenCount || 0;

        const today = new Date().toISOString().slice(0, 10);
        const rate = GEMINI_PRICES.filter(p => p.from <= today).pop() || GEMINI_PRICES[0];
        const regularInputTokens = inputTokens - cachedTokens;
        const regularInputCost = (regularInputTokens / 1000000) * rate.input;
        const cachedInputCost = (cachedTokens / 1000000) * rate.cachedInput;
        const outputCost = ((outputTokens + thoughtsTokens) / 1000000) * rate.output;
        const totalCost = regularInputCost + cachedInputCost + outputCost;

        usageInfo = {
          inputTokens: inputTokens,
          outputTokens: outputTokens,
          thoughtsTokens: thoughtsTokens,
          cachedTokens: cachedTokens,
          totalTokens: totalTokens,
          cost: parseFloat(totalCost.toFixed(6))
        };

        console.log(`Tokens: ${totalTokens} (${cachedTokens} cached) | Cost: $${totalCost.toFixed(6)}`);
      }

      const parsed = parseModelJson(text);
      if (parsed !== null) {
        return { data: parsed, usage: usageInfo };
      }

      console.error('Could not parse JSON from model response:', text.slice(0, 500));
      return { data: NULL_RESULT, usage: usageInfo };
    }

    // Pulls the JSON payload out of a model response. Structured output makes
    // this trivial in the normal case, but it still has to cope with markdown
    // fences, an explanatory preamble, and responses cut off by the token limit.
    function parseModelJson(text) {
      if (!text) return null;

      // Strip markdown fences; prose is handled by trying each candidate start.
      const body = String(text).replace(/```(?:json)?/gi, '').trim();

      for (let start = 0; start < body.length; start++) {
        const char = body[start];
        if (char !== '[' && char !== '{') continue;

        const attempt = extractJsonAt(body, start);
        if (attempt === null) continue;

        const value = Array.isArray(attempt.value) ? attempt.value[0] : attempt.value;

        // Prose like "see note [1]" parses to something that is not a packaging
        // payload - keep looking past it. Unlike the price scripts this also
        // rejects a bare {}, so an empty read becomes an Error row instead of a
        // blank Clean one.
        if (!isPackagingShape(value)) continue;

        if (!attempt.complete) {
          console.warn('Recovered a truncated response - some panels may be incomplete');
          // allergens_may_contain is the last key of ingredients in
          // propertyOrdering, so its absence means the cut landed inside the
          // ingredients block and the list we kept is only part of it.
          const ingredients = value.ingredients;
          if (ingredients && typeof ingredients === 'object' && ingredients.raw_text
              && !Object.prototype.hasOwnProperty.call(ingredients, 'allergens_may_contain')) {
            ingredients.is_partial = true;
          }
        }
        return value;
      }

      return null;
    }

    // A packaging payload is an object carrying at least one of the schema's
    // top-level keys. Presence of the key is enough here; hasAnyPanel() decides
    // whether it actually holds data.
    function isPackagingShape(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      return ['ingredients', 'nutrition_facts', 'product_claims',
              'nutrition_and_health_scores']
        .some(key => Object.prototype.hasOwnProperty.call(value, key));
    }

    // Reads one JSON value starting at `start`, tolerating truncation.
    // Returns { value, complete } or null when nothing usable is there.
    function extractJsonAt(body, start) {
      const opening = body[start];
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let i = start; i < body.length; i++) {
        const char = body[i];

        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (char === '[' || char === '{') {
          depth++;
        } else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (end !== -1) {
        try {
          return { value: JSON.parse(body.slice(start, end + 1)), complete: true };
        } catch (error) {
          return null;
        }
      }

      // Truncated: close the open containers so a cut-off answer still yields
      // the panels that did finish. Trailing partial tokens are trimmed back to
      // the last completed property first.
      if (opening === '{') {
        const salvaged = salvageTruncatedObject(body.slice(start));
        if (salvaged !== null) {
          try {
            return { value: JSON.parse(salvaged), complete: false };
          } catch (error) {
            return null;
          }
        }
      }

      return null;
    }

    // Walks back to the last position where the JSON was structurally sound,
    // then closes every container still open at that point.
    function salvageTruncatedObject(fragment) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let lastSafe = -1;
      const stack = [];
      let safeStack = [];

      for (let i = 0; i < fragment.length; i++) {
        const char = fragment[i];

        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (char === '{' || char === '[') {
          stack.push(char);
          depth++;
        } else if (char === '}' || char === ']') {
          stack.pop();
          depth--;
        } else if (char === ',' && depth > 0) {
          // A comma at depth means everything before it is a complete property.
          lastSafe = i;
          safeStack = stack.slice();
        }
      }

      if (lastSafe === -1) return null;

      let salvaged = fragment.slice(0, lastSafe);
      for (let i = safeStack.length - 1; i >= 0; i--) {
        salvaged += safeStack[i] === '{' ? '}' : ']';
      }
      return salvaged;
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // ---------------------------------------------------------------------
    // Deterministic clean-up
    //
    // Rules the model applied inconsistently from run to run. The prompt still
    // states them; code applies them the same way every time as a backstop.
    // ---------------------------------------------------------------------

    // Store logos, certifications and regions are never the brand; neither is
    // a company name from the address block ("KuchenMeister GmbH").
    const NOT_A_BRAND = /^(aldi( s[üu]d| nord)?|hofer|lidl|bio|naturland|fairtrade|mosel)$/i;
    const COMPANY_FORM = /\b(GmbH|KG|AG|eG|Ltd|Inc|S\.A\.|Sp\. z o\.o\.)(?=[\s.,]|$)/;

    function cleanBrand(value) {
      const text = textOrNull(value);
      if (text === null || NOT_A_BRAND.test(text) || COMPANY_FORM.test(text)) return null;
      return text;
    }

    // raw_text is the list itself: no "Zutaten:" heading in front and no
    // "Kann Spuren von ... enthalten" sentence behind (that goes to
    // allergens_may_contain).
    const INGREDIENT_HEADING = /^\s*(zutaten|ingredients?|ingrédients|ingredienti|ingrediënten|ingredientes|składniki|složení|zloženie|összetevők|ingrediente|sastojci|sestavine)\s*:\s*/i;
    const MAY_CONTAIN_TAIL = /\s*Kann\s+(auch\s+)?(Spuren\s+)?[^.]*?enthalten\.?.*$/i;

    function cleanIngredientText(value) {
      const text = textOrNull(value);
      if (text === null) return null;
      return textOrNull(text.replace(INGREDIENT_HEADING, '').replace(MAY_CONTAIN_TAIL, ''));
    }

    // A substance named in the "may contain" sentence is never a declared
    // allergen. "Weizen" and "Weizen (Gluten)", "Erdnüsse" and "Erdnüssen"
    // count as the same substance.
    const allergenKey = text => text.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-zäöüß]/g, '');

    function cleanAllergensContains(contains, mayContain) {
      const may = mayContain.map(allergenKey).filter(key => key !== '');
      const seen = new Set();
      return contains.filter(item => {
        const key = allergenKey(item);
        if (key === '' || seen.has(key)) return false;
        seen.add(key);
        return !may.some(m => m.startsWith(key) || key.startsWith(m));
      });
    }

    // Printed text that is not a marketing or certification claim.
    const NOT_A_CLAIM = [
      /so trennt man richtig|gelbe tonne|tipps? für die tonne|io riciclo|valido solo|recycl/i, // waste sorting
      /^ce$/i,                                                                                 // conformity mark
      /\b\d+\s*er[- ]?pack\b|\b\d+\s*x\s*\d/i,                                                  // pack counts
      /^(ca\.?\s*)?(max\.?\s*)?\d[\d.,]*\s*(ml|l|g|kg|w|cm|mm|m|meter)\b/i,                     // sizes, specs
      /lagern|nach dem öffnen|verbrauchen|mindestens haltbar|schutzatmosphäre|vor wärme/i,      // storage
      /nährwerte unterliegen|mengenausgleich|mengenbilanz|ersetzt oder mit diesem vermischt/i  // legal notes
    ];

    function cleanClaims(values, brand, description) {
      const identity = [brand, description].filter(Boolean).map(text => text.toLowerCase());
      const seen = new Set();
      return normalizeStringArray(values).filter(claim => {
        const key = claim.toLowerCase();
        if (seen.has(key) || identity.includes(key)) return false;
        seen.add(key);
        return !NOT_A_CLAIM.some(pattern => pattern.test(claim));
      }).slice(0, 15);
    }

    // Only a Nutri-Score with a single letter A-E survives; certifications,
    // awards and animal-welfare labels never belong in this array.
    function cleanScores(values) {
      return normalizeObjectArray(values, ['system_name', 'score_value', 'scale_max', 'details'], ['system_name', 'score_value'])
        .filter(score => /nutri/i.test(score.system_name) && /^[A-E]$/i.test(score.score_value))
        .slice(0, 1)
        .map(score => ({ system_name: 'Nutri-Score', score_value: score.score_value.toUpperCase(), scale_max: 'E', details: null }));
    }

    // Remainder without the percent operator (see PCT).
    function mod(a, b) {
      return a - b * Math.floor(a / b);
    }

    function hasValidGtinCheckDigit(digits) {
      const body = digits.slice(0, -1);
      const check = Number(digits[digits.length - 1]);
      let sum = 0;
      for (let i = 0; i < body.length; i++) {
        sum += Number(body[i]) * (mod(body.length - i, 2) === 1 ? 3 : 1);
      }
      return mod(10 - mod(sum, 10), 10) === check;
    }

    // The barcode exactly as printed - no padding - or null. Only a whole
    // 8, 12 or 13 digit barcode whose check digit holds survives; a "?"
    // means a digit was not read, so the whole number goes.
    function normalizePackageBarcode(value) {
      const text = cleanText(value);
      if (text.indexOf('?') !== -1) return null;
      const digits = text.replace(/D/g, '');
      if (!digits) return null;
      if ([8, 12, 13].indexOf(digits.length) === -1 || !hasValidGtinCheckDigit(digits)) {
        console.warn(`Discarding package barcode "${text}" - not a whole barcode with a valid check digit`);
        return null;
      }
      return digits;
    }

    // Turns the raw model payload into the record Mozenda expects:
    //   raw_data_json  the whole normalized object as compact JSON text. Every
    //                  section is always present (null / [] when absent), so
    //                  downstream is one JSON.parse and null-vs-empty survives.
    //   brand, description  also copied out as plain-text fields so they are
    //                  queryable without a JSON.parse; '' when not legible.
    function buildRecord(product) {
      const source = product && typeof product === 'object' ? product : NULL_RESULT;
      const brand = cleanBrand(source.brand);
      const description = textOrNull(source.description);
      const rawIngredients = source.ingredients && typeof source.ingredients === 'object' ? source.ingredients : {};
      const rawNutrition = source.nutrition_facts && typeof source.nutrition_facts === 'object' ? source.nutrition_facts : null;
      const rawText = cleanIngredientText(rawIngredients.raw_text);
      const mayContain = normalizeStringArray(rawIngredients.allergens_may_contain);

      const ingredients = {
        raw_text: rawText,
        parsed_list: normalizeStringArray(rawIngredients.parsed_list).map(item => item.replace(INGREDIENT_HEADING, '')).filter(Boolean),
        is_partial: normalizeFlag(rawIngredients.is_partial),
        active_ingredients: normalizeObjectArray(rawIngredients.active_ingredients, ['name', 'strength', 'purpose'], ['name']),
        // Declared allergens come from the ingredient list; with no list read
        // there is nothing to declare (the HARIBO back put its "Kann Spuren
        // von Milch, Weizen" here twice with raw_text null).
        allergens_contains: rawText === null ? [] : cleanAllergensContains(normalizeStringArray(rawIngredients.allergens_contains), mayContain),
        allergens_may_contain: mayContain
      };

      const nutritionFacts = rawNutrition === null ? null : {
        // Both carry numbers ("1,5 l", "1.000 ml"), so they take the same
        // separator normalization as the nutrient amounts.
        servings_per_container: normalizeAmount(rawNutrition.servings_per_container),
        serving_size: normalizeAmount(rawNutrition.serving_size),
        basis: textOrNull(rawNutrition.basis),
        nutrients: normalizeObjectArray(rawNutrition.nutrients, ['name', 'amount', 'unit', 'daily_value_percent'], ['name', 'amount'])
      };

      return {
        brand: brand || '',
        description: description || '',
        raw_data_json: JSON.stringify({
          brand,
          description,
          package_barcode: normalizePackageBarcode(source.package_barcode),
          ingredients,
          // An all-empty panel object collapses to null, same as no panel.
          nutrition_facts: isEmptyValue(nutritionFacts) ? null : nutritionFacts,
          product_claims: cleanClaims(source.product_claims, brand, description),
          nutrition_and_health_scores: cleanScores(source.nutrition_and_health_scores),
          language_code: normalizeLanguageCode(source.language_code)
        })
      };
    }

    // ---------------------------------------------------------------------
    // Main
    // ---------------------------------------------------------------------

    // Loaded from GitHub by packaging.loader.js, Mozenda never fills the
    // placeholder in this file, so the loader passes the filled input in
    // window.MOZENDA_INPUTS. Pasted into the agent directly, that object is
    // absent and the placeholder below is filled as before.
    const agentInputs = (typeof window !== 'undefined' && window.MOZENDA_INPUTS) || {};

    // ONE product per row, from the imageURL field: a single URL, or several
    // photos of that product separated by "|".
    const imageUrl = String('imageURL' in agentInputs ? agentInputs.imageURL : '%imageURL%').trim();

    const result = await findProductInfo(imageUrl, apiKeyValue);

    // If no result or error, set empty values
    if (!result || !result.data) {
      console.error('No results returned from extraction');
      M_SetFieldValues({
        ...buildRecord(NULL_RESULT),
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        cost: 0,
        clean: 'Error'
      });
      M_StopWaiting();
      return;
    }

    // One product per call: the prompt returns a single object, so there is no
    // multi-product split and no cost apportioning to do here.
    const record = buildRecord(result.data);

    M_SetFieldValues({
      ...record,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      thoughtsTokens: result.usage?.thoughtsTokens || 0,
      cachedTokens: result.usage?.cachedTokens || 0,
      totalTokens: result.usage?.totalTokens || 0,
      cost: result.usage?.cost || 0,
      // Judged on the NORMALIZED record: raw output like parsed_list [""] or
      // nutrients [{}] passes hasAnyPanel but normalizes to nothing. A row
      // with only a brand/name is kept but still flagged Error.
      clean: hasAnyPanel(JSON.parse(record.raw_data_json)) ? 'Clean' : 'Error'
    });

    M_StopWaiting();

  } catch (error) {
    console.error('Script error:', error);
    M_StopWithError('Script Error', error.message);
  }
})();
