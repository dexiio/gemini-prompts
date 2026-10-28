/* =====================================================================
 * aldi-sud.js - ALDI SUD Germany shelf price label extractor
 * ---------------------------------------------------------------------
 * 2026-09-29 - GERMANY ONLY, LABELS ONLY
 *   - Scope cut to ALDI SUD Germany. The model is no longer asked for a
 *     country or currency; CONFIG.DEFAULT_COUNTRY = 'DE' fills both.
 *   - PACKAGING_ENABLED = false: sections B and C are gone from the
 *     prompt (about half of it). See the note at that setting.
 *   - Article numbers must be exactly 6 digits.
 *   - Prompt: "shelf price label" wording, promotions read from the small
 *     struck-through old price, labels cut off by the frame or glared
 *     over are skipped. The article-number rules are unchanged.
 *   - Unit-price check accepts multipacks; a mismatch now sets clean to
 *     CONFIG.UNIT_PRICE_MISMATCH_FLAG instead of only logging.
 *   - No literal percent signs except the two real Mozenda inputs.
 *   Measured against the 40-photo test run of the same date.
 * ---------------------------------------------------------------------
 * Rewritten from scratch in the register of costco.js: short numbered
 * rules, one line each, imperative. The previous prompt had grown to
 * ~20,000 characters of prose and the model started reasoning around it
 * instead of reading - most visibly by inventing article numbers. This
 * one says the same things in about a third of the space.
 *
 * WHAT DID NOT CHANGE
 *   - the output columns, exactly as before (see baseRow)
 *   - every normalization helper, which has been regression-tested
 *     against real exports: parsePrice, normalizeSku, normalizeUpc,
 *     labelledPlu, checkUnitPrice, resolveCurrency, checkBind,
 *     tagIndexBase
 *   - RAW_DATA_JSON, including the "packaging" block
 *
 * WHAT CHANGED
 *   - the prompt, in all three sections
 *   - the tag rules are numbered and terse, costco style: "EACH TAG IS
 *     SEPARATE", "NEVER MIX DATA FROM DIFFERENT TAGS", one rule per line
 *   - the fixes that were bought with real failures are kept, stated
 *     once each instead of argued: the unit-price anchor for the article
 *     number, one-tag-one-row, PLU never in SKU, loyalty claimed by its
 *     badge, honest confidence
 *
 * THE ALDI TAG (ALDI SUD Germany, verified week 39/2026)
 *
 *     1.89                                  <- price, no currency symbol
 *     NATUR LIEBLINGE                       <- brand line
 *     Snack Paprika                         <- product name
 *     Klasse: I, 250g, Ursprung: s. Etikett <- attribute line
 *     7.56/kg                    631939|39  <- unit price | article no.
 *
 *   Everything right of the first bar is a batch code - a print week
 *   ("|39"), a letter code ("|F1", "|X", "|FR37") or a second bar
 *   ("279506|L|F1"). It is never part of the article number.
 *
 * TWO JOBS IN ONE CALL
 *   SECTION A reads the TAGS and nothing else.
 *   SECTION B reads the printed PANELS on the packages and returns no
 *   price. SECTION C binds one to the other. The result lands INSIDE
 *   RAW_DATA_JSON under "packaging", never in a column of its own, and
 *   only when the model says "high" AND checkBind() agrees.
 *   CONFIG.PACKAGING_ENABLED = false removes B and C from the prompt,
 *   the schema and the row, and roughly halves the prompt.
 *
 * READING ORDER IS THE SAFEGUARD
 *   The tag object is emitted in the order the work is actually done:
 *
 *     tagLocation -> the large print -> rawPriceStrings -> confidence
 *       -> productIdPrinted -> productId
 *
 *   Naming the tag's place on the fixture first commits the model to ONE
 *   physical tag before it reads a character, and gives the dedup key.
 *   Grading legibility BEFORE the article number means the grade can no
 *   longer be a rationalisation of a number already written - which is
 *   what it was when productId came first and confidence last.
 *   productIdPrinted is the whole token ("637739|4|F1") read character by
 *   character; productId must be derivable from it or the code drops both.
 *
 *   This was measured, not guessed. On one chocolate shelf 3 of 7 article
 *   numbers came back with substituted digits (683224 -> 483224, 637739 ->
 *   627239, 307663 -> 307443), all graded "medium", all shipped, and one
 *   tag of eight was never written at all. Escalating the warnings had no
 *   effect, because a warning cannot outrank a number already committed.
 *
 * ONE IMAGE PER RUN
 *   The agent sends a single photo, so there is no image selection, no
 *   "IMAGE 1" numbering and no imageIndex on a row. A rule about which
 *   image to read is an invitation to reason about images that are not
 *   there. If the imageURL input ever carries a pipe-separated list, the first
 *   link is read and the rest are ignored with a warning.
 * ===================================================================== */

(async function () {
  try {
    // Mozenda treats any pair of percent signs in the script as an agent
    // input and substitutes it before the script runs. The only literal
    // percent signs in this file are the two real inputs (imageURL and
    // Country, near the bottom); everywhere else the character is built at
    // run time.
    const PCT = String.fromCharCode(37);

    const CONFIG = {
      MODEL: 'gemini-3.8-flash',
      // 0: always the most likely reading. At 0.1 the same Nuii label read
      // 265345 on one photo and 268345 on another.
      TEMPERATURE: 0,
      MAX_OUTPUT_TOKENS: 32768,

      // Keeps more image detail for the small article-number print. Costs
      // more input tokens. '' = Gemini's default. If Gemini rejects it (an
      // error mentioning mediaResolution), set this back to ''.
      MEDIA_RESOLUTION: 'MEDIA_RESOLUTION_HIGH',

      // gemini-3.8-flash, USD per 1M tokens (output includes thinking).
      // Google doubles every rate on 2027-01-01; readUsage takes the last
      // entry whose date has been reached, so no edit is needed then.
      PRICES: [
        { from: '2026-01-01', input: 0.75, cachedInput: 0.075, output: 3.75 },
        { from: '2027-01-01', input: 1.50, cachedInput: 0.15, output: 7.50 }
      ],

      // Pin the market when every image is from one country (ISO-2).
      // '' = detect per tag. A Country agent input wins over this.
      // Germany only since 2026-09-29; the prompt no longer asks the model
      // for a country or currency, so this pin is what fills both columns.
      DEFAULT_COUNTRY: 'DE',
      COUNTRY_OVERRIDES_MODEL: true,

      // ALDI SUD Germany prints exactly 6 digits. The test run of
      // 2026-09-29 shipped two 5-digit numbers (42249, 58547) that were
      // 6-digit numbers with a digit lost, so anything else is refused.
      SKU_MIN_DIGITS: 6,
      SKU_MAX_DIGITS: 6,

      // true drops any productId the model did not back with a printed
      // token. It is OFF because a single omission by the model then empties
      // the whole SKU column, which is exactly what happened the first time
      // it was switched on - a high price for catching the model abstaining
      // in one field but not the other.
      //
      // The check that carries the real weight runs either way: when BOTH
      // fields come back, a productId that is not inside its own printed
      // token is a contradiction and is dropped.
      //
      // Neither setting catches a confident misread. If the model
      // transcribes "483224|4|F1" off a tag that reads "683224|4|F1", the
      // two fields agree and the row ships. Nothing in the response can
      // reveal that - only the photo can.
      //
      // ON since 2026-09-28: an empty SKU is preferred to a wrong one, so a
      // productId with no transcription behind it does not ship. If the SKU
      // column suddenly empties, check that the model is still filling
      // productIdPrinted before turning this off.
      SKU_REQUIRE_PRINTED_TOKEN: true,

      // The lowest confidence.identifiers grade whose article number ships.
      // The model grades legibility and then fills productId anyway - the
      // prompt tells it a grade must not empty a field - so without this the
      // grade is recorded and ignored. The three substituted numbers on the
      // chocolate shelf were all graded "medium", hence 'high'. 'medium'
      // lets those through, '' turns the gate off. A missing grade fails it.
      // Policy: an empty SKU beats a wrong one - do not loosen this without
      // measuring misreads against the photos.
      SKU_MIN_CONFIDENCE: 'high',

      // Article numbers that look filled in rather than read: two in one
      // frame that are consecutive (637739, 637740) or differ only in the
      // last digit. Real neighbours on a shelf are unrelated numbers. When
      // it trips, every SKU in the frame is emptied - the prompt's "NULL
      // ON EVERY ROW" rule, enforced.
      SKU_REJECT_PATTERNED: true,

      // Unit-price check tolerance: the larger of the two.
      UNIT_PRICE_TOLERANCE_ABS: 0.02,
      UNIT_PRICE_TOLERANCE_PCT: 0.02,

      // What the "clean" column says when price / size does not reproduce
      // the printed unit price. '' = keep "Clean" and only log it.
      UNIT_PRICE_MISMATCH_FLAG: 'Check',

      // A BACKSTOP only. The primary test is the unit-price anchor in the
      // prompt, because a count cannot tell a tight 9-tag close-up from a
      // distant 9-tag aisle shot. A 9-tag chocolate shelf had perfectly
      // legible numbers ("456080|4|F1"); the frames that fabricated
      // carried 17-20 tags. Enforced in code: past this many tags every
      // SKU in the frame is emptied. 0 = off.
      SKU_MAX_TAGS_IN_FRAME: 0,

      // costco.js skips any label without BOTH a price and a product ID.
      // Measured on the real ALDI export that would drop 34 percent of rows, so
      // it is off: a priced row with no article number is still the
      // price we came for. Turn it on only if downstream needs an ID.
      REQUIRE_ID_WITH_PRICE: false,

      // A failed call means we learned nothing, not that the shelf was
      // empty. true hands the item back to Mozenda as failed; false
      // writes one row marked 'Error' instead.
      STOP_ON_EXTRACTION_ERROR: true,

      RAW_MAX_EXTRAS: 20,
      RAW_MAX_VALUE_CHARS: 200,

      // Literal price transcription: enough for a busy promo tag and no
      // more. It exists so a reviewer can spot a misread.
      RAW_MAX_PRICE_STRINGS: 8,
      RAW_MAX_PRICE_STRING_CHARS: 40,

      // ---- Packaging pass -------------------------------------------
      // OFF since 2026-09-29. On shelf photos it mostly returned pack names
      // and claims, and bound packages to the wrong tag (shifted by one,
      // or a branded pack onto the ALDI own-label tag beside it). Close-up
      // pack photos are handled by packaging.js. Flip back to true to
      // restore sections B and C of the prompt and the "packaging" block.
      PACKAGING_ENABLED: true,

      // Strict. false also accepts "medium"; nothing ever accepts "low".
      PACKAGING_REQUIRE_HIGH_CONFIDENCE: true,

      PACKAGING_MAX_INGREDIENT_CHARS: 2000,
      PACKAGING_MAX_PARSED_ITEMS: 80,
      PACKAGING_MAX_NUTRIENTS: 30,
      PACKAGING_MAX_CLAIMS: 15,
      PACKAGING_MAX_SCORES: 5,
      PACKAGING_MAX_LIST_ITEM_CHARS: 200,

      // Mozenda truncates a long field silently, which would leave
      // unparseable JSON downstream, so an oversized packaging block is
      // dropped rather than cut. 0 = no limit.
      RAW_MAX_TOTAL_CHARS: 8000,

      // Net content on the pack vs ITEM_SIZE on the tag: past this gap
      // they are not the same product and the bind is refused.
      BIND_SIZE_TOLERANCE_PCT: 0.02
    };

    // Every market ALDI (SUD, Nord) or HOFER trades in.
    const COUNTRY_CURRENCY = {
      DE: 'EUR', AT: 'EUR', SI: 'EUR', IT: 'EUR', IE: 'EUR', NL: 'EUR',
      BE: 'EUR', LU: 'EUR', FR: 'EUR', ES: 'EUR', PT: 'EUR',
      CH: 'CHF', HU: 'HUF', PL: 'PLN', DK: 'DKK',
      GB: 'GBP', US: 'USD', AU: 'AUD', CN: 'CNY'
    };

    // Printed symbol -> ISO-4217. "$" and "kr" are left out on purpose:
    // they are resolved by the country (see resolveCurrency).
    const CURRENCY_SYMBOLS = {
      '€': 'EUR', eur: 'EUR', euro: 'EUR',
      '£': 'GBP', gbp: 'GBP', p: 'GBP',
      chf: 'CHF', fr: 'CHF', 'fr.': 'CHF', sfr: 'CHF',
      ft: 'HUF', huf: 'HUF',
      'zł': 'PLN', zl: 'PLN', pln: 'PLN',
      dkk: 'DKK',
      usd: 'USD', '¢': 'USD',
      aud: 'AUD',
      '¥': 'CNY', '元': 'CNY', cny: 'CNY', rmb: 'CNY'
    };
    const AMBIGUOUS_CURRENCY = { '$': ['US', 'AU'], kr: ['DK'], 'kr.': ['DK'] };

    // House style from costco.js: lowercase metric, title-case count
    // codes. Keys are lowercase with spaces and dots removed.
    const UOM_MAP = {
      mg: 'mg', g: 'g', gr: 'g', gram: 'g', grams: 'g', gramm: 'g', grammes: 'g', grammi: 'g',
      kg: 'kg', kilo: 'kg', kilogram: 'kg', kilogramm: 'kg', kilogramme: 'kg',
      ml: 'ml', cl: 'cl', dl: 'dl',
      l: 'l', lt: 'l', ltr: 'l', liter: 'l', litre: 'l', litro: 'l', litri: 'l',
      oz: 'oz', floz: 'fl oz', lb: 'lb', lbs: 'lb',
      st: 'Ea', stk: 'Ea', 'stück': 'Ea', stueck: 'Ea', each: 'Ea', ea: 'Ea',
      pc: 'Ea', pcs: 'Ea', piece: 'Ea', pieces: 'Ea', stuks: 'Ea', stuk: 'Ea',
      szt: 'Ea', db: 'Ea', kos: 'Ea', pz: 'Ea', pezzi: 'Ea', 'unité': 'Ea', unites: 'Ea',
      unidad: 'Ea', unidades: 'Ea', un: 'Ea', ud: 'Ea', uds: 'Ea',
      pk: 'Pk', pack: 'Pk', packung: 'Pk', pckg: 'Pk',
      ct: 'Ct', count: 'Ct'
    };

    // Grams / millilitres / pieces per unit, for the unit-price check.
    const UOM_FACTOR = {
      mg: ['mass', 0.001], g: ['mass', 1], kg: ['mass', 1000],
      oz: ['mass', 28.349523], lb: ['mass', 453.59237],
      ml: ['volume', 1], cl: ['volume', 10], dl: ['volume', 100], l: ['volume', 1000],
      'fl oz': ['volume', 29.573530],
      Ea: ['count', 1]
    };

    // -----------------------------------------------------------------
    // Input helpers
    // -----------------------------------------------------------------

    // A Mozenda placeholder the agent never filled arrives as the literal
    // input name wrapped in percent signs, which must not be mistaken for
    // real data.
    const UNFILLED_INPUT = new RegExp('^' + PCT + '[A-Za-z0-9_]*' + PCT + '$');
    function readAgentInput(raw) {
      const text = String(raw === null || raw === undefined ? '' : raw).trim();
      return UNFILLED_INPUT.test(text) ? '' : text;
    }

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

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // Google Drive links are tried in several forms (see
    // convertGoogleDriveUrl); any other URL is a single-entry list.
    async function fetchImageWithRetry(urlVariants) {
      for (let variantIndex = 0; variantIndex < urlVariants.length; variantIndex++) {
        const url = urlVariants[variantIndex];
        try {
          const imageResponse = await fetch(url);

          if (imageResponse.ok) {
            const imageBlob = await imageResponse.blob();
            const base64Image = await blobToBase64(imageBlob);
            const base64Data = base64Image.split(',')[1] || base64Image;

            return {
              inline_data: {
                mime_type: imageBlob.type || 'image/jpeg',
                data: base64Data
              }
            };
          }
        } catch (error) {
          // Continue to next variant
        }
      }

      console.error('Failed to fetch the image - every URL form was refused');
      return null;
    }

    // -----------------------------------------------------------------
    // Prompt - costco.js register: numbered, imperative, one rule a line.
    //
    //   buildTagSection()       the tag. Reads NOTHING off the packaging
    //   buildPackagingSection() the panels. Reads NOTHING off the tag
    //   buildBindingSection()   the only place the two meet, and only to
    //                           answer "which tag is this pack priced by?"
    // -----------------------------------------------------------------

    function buildTagSection() {
      const idRule = CONFIG.REQUIRE_ID_WITH_PRICE
        ? '\n6. A label whose article number will not resolve is SKIPPED entirely'
        : '';

      return `
HOW TO WORK - once, in this order:
1. LOCATE - scan the photo top shelf to bottom, left to right, and give every shelf price label a location: "shelf 2 from top, label 3 from left". That location is the label's identity
2. READ - take each label in turn and read ONLY what is printed inside that label's own border
3. GRADE - say how well you could read it, BEFORE you report the small print
4. MOVE ON - carry nothing forward to the next label

FIVE RULES
1. ONE PHYSICAL LABEL = ONE ROW. Every label with a readable price gets exactly one row, and no two rows share a location
2. A label with NO fully readable price is SKIPPED. That includes a label cut off by the edge of the photo, or with glare or a reflection across its big price, so that any digit of that price is missing or uncertain. Never complete a price you cannot fully see
3. ARTICLE NUMBER STRICTNESS: 'productId' is filled ONLY if EVERY SINGLE DIGIT is 100${PCT} visible, crisp, and fully legible. A digit that is blurry, obscured, truncated or could be another digit is written as "?" in 'productIdPrinted' and 'productIdCheck', and 'productId' is null. NEVER guess missing digits or complete partial numbers.
4. NEVER take a value from a neighbouring label, from the packaging behind the label, or from what you already know about the product
5. null IS A CORRECT ANSWER. A row with gaps is right; a row completed by guessing is wrong
6. The packaging is NOT a source. Read the shelf price labels only${idRule}

THE SHELF PRICE LABEL
ALDI SÜD Germany. A printed paper card or an electronic (e-ink) screen in the shelf rail:

   3.99                                  <- price, large, top-left
   MOSER ROTH                            <- brand, small capitals
   Trüffelpralinen                       <- product name, bold
   200g                                  <- attribute line: size, grade, origin
   19.95/kg              637739|4|F1     <- unit price        article number = 637739 only; "|4|F1" is a batch code, not part of it

- PROMOTIONS: an electronic label - very often a RED one - prints a SMALL STRUCK-THROUGH OLD PRICE to the RIGHT of the big price, and often a badge top-right ("NUR FÜR KURZE ZEIT", "AKTION"). The struck-through number is small and easy to miss: look for it on EVERY label before you write the prices
- VARIABLE WEIGHT: "z.B. 232g für 4.99" or "Versch. Gewichte, z.B. 500g für 3.29" - the price is 4.99 / 3.29
- Colour alone proves nothing: ALDI prints red labels for ordinary prices too

FIELDS, in the order you will write them:

1. "tagLocation" - where this label is, as above. Write it FIRST, before reading anything on the label

2. "brand" - the small capitals line above the name ("MOSER ROTH", "MILSANI", "GUT BIO"), exactly as printed. null if there is none
   "name" - the bold line under it ("Trüffelpralinen"), exactly as printed. Never put the brand in it

3. PRICES - read every digit left to right, return a dot decimal with no symbol: "1,89" -> "1.89". "-.99" is "0.99", "2,-" is "2.00"
   - ONE price -> "regularPrice"
   - A STRUCK-THROUGH old price, or one marked "statt", "vorher", "bisher", "UVP" -> that OLD price is "regularPrice" and the big current price is "promoPrice". If you can see a struck-through number but cannot read all its digits, the big price is still "promoPrice" and "regularPrice" is null
   - ONE price with a promotion badge ("NUR FÜR KURZE ZEIT", "AKTION", "-30${PCT}", "Angebot") and no old price -> "promoPrice", regularPrice null
   - "NEU" is NOT a discount
   - "loyaltyPrice" - ALDI SÜD Germany prints no loyalty prices: always null
   - MULTI-BUY ("2 für 3.00") -> the price is the TOTAL "3.00" and the count goes in that lane's multiple. A single-item price has multiple "1"

4. "unitPrice" / "unitPriceBasis" - the small comparison price (Grundpreis): "19.95/kg" -> "19.95" and "kg"; "1 kg = 4,98" -> "4.98" and "kg"; "je 100 g" -> basis "100g"
   - READ it off the label. NEVER divide the price by the size to produce one
   - Several bases ("7,83/8,19/8,31/kg") -> null, and put the whole string in extras as "unit_price_text"

5. "itemSize" / "itemUom" - the net quantity of ONE item, from the attribute line: "200g" -> "200" and "g"
   - Sold by weight ("per kg", "1 kg = ") -> "1" and "kg"
   - An EXAMPLE weight ("z.B. 500g für 3.29") is NOT a size -> both null, plus extras "example_weight" and "variable_weight"
   - A MULTIPACK ("8x25g", "3 x 90 ml") -> the COMPONENT is the size: "25" and "g", plus extras "pack_printed" = "8x25g"
   - SEVERAL ALTERNATIVE SIZES ("355/360/377 g") -> both null, plus extras "size_variants"
   - Never take a size from the packaging

6. "rawPriceStrings" - the PRICE tokens on this label, copied exactly as printed and untidied: ["2,69", "1 kg = 5.38", "-13${PCT}"]. Keep the comma and the "1 kg =" prefix. A struck-through old price is included
   - PRICES ONLY. The article number, the batch code and barcode digits do NOT belong here
   - COPY, NEVER RECONSTRUCT. A token you can see but cannot fully read is left out

7. "confidence" - four honest grades, each "high", "medium" or "low". You write these BEFORE the small print below, so grade what you actually saw:
   "description" (brand, name) | "price" (every price field) | "size" (itemSize, itemUom) | "identifiers" (productId, upc)
   - "high" ONLY when the characters are plainly legible
   - "medium" when you are fairly sure but would not stake the row on it
   - "low" for glare, an oblique angle, blur, faint or tiny print
   - The article number is the smallest print on the label, so "identifiers" is routinely lower than "price". That is the expected and useful answer, not a failure
   - "identifiers" is "high" ONLY when EVERY digit of the article number passes ALL FIVE CHECKS a-e in 8. If any digit fails any check, "identifiers" is not "high", that digit is "?" in "productIdPrinted" and "productIdCheck", and "productId" is null
   - These grades REPORT how the reading went. They never make an unclear value acceptable: a value you could not read clearly is null, whatever its grade

8. THE ARTICLE NUMBER - the small number at the bottom right, "637739|4|F1". A wrong one is worse than none, because it attaches this price to a different product. So read it, or say you could not - but do not approximate it.
   WHAT MATTERS IS THE 6 DIGITS BEFORE THE BAR. The bar is often a thin vertical line touching the digits - find it first, and never join the digits after it onto the number: "637739|39" is "637739", never "63773939". Everything from the first bar onwards is a batch code that gets thrown away - it is fainter than the digits and it must never decide whether you fill these fields
   EVERY DIGIT BEFORE THE BAR MUST PASS ALL FIVE CHECKS. A digit failing any check is written as "?", and one "?" makes "productId" null:
   a. WHOLE - every part of the digit is visible. No label edge, rail, holder, sticker, finger or crop covers any of it
   b. SHARP - its strokes have clean edges. No blur, smear, glare, reflection or shadow lies across it
   c. SEPARATE - it does not merge with the digit beside it. The bar touching the last digit is normal and does not fail this check
   d. ONLY ONE READING - it cannot also be its look-alike: 5/8, 6/8, 3/8, 3/5, 5/6, 0/8, 8/9, 0/6, 1/7, 1/4, 2/7. In this small print an 8 is the most common misreading of a 5, 6 or 3 - before you write an 8, check that BOTH of its loops are closed. If a digit could be either, it fails - even if one seems more likely
   e. SEEN, NOT INFERRED - you read it from the pixels of this digit, not from the digits around it, the usual length, the neighbouring labels, the numbers printed on the shelf trays or the numbers in these instructions
   "productIdPrinted" - what you actually see there, copied as printed: "637739|4|F1" when you can read the batch part too, or just "637739" when you cannot. Check the digits before the bar one at a time, left to right. Write "?" in place of EVERY digit that fails a check and keep the others (for the example label above: "6377?9|4|F1"). A "?" is a correct, useful answer - it is not a failure. null only when you cannot see the number at all
   "productIdCheck" - read the same 6 digits a SECOND time, this time starting from the RIGHT end and moving left, one digit at a time, looking at each digit again rather than copying "productIdPrinted". Write the result in normal left-to-right order ("637739"), with "?" for any digit that fails a check
   "productId" - the 6 digits alone, ONLY when "productIdPrinted" and "productIdCheck" contain no "?" and agree digit for digit: "637739|4|F1" -> "637739". Otherwise null
   - NULL ON EVERY ROW if two numbers across labels are consecutive, differ only in the last digit, or repeat
   - NEVER from the packaging or a shelf tray. Trays print big logistics numbers ("203121 (SAP)", "Art: 1000404-030") inches from the label

9. "upc" - null unless the LABEL ITSELF prints a barcode's full digits (all 8 or 13 of them) or a number it labels "PLU" (returned as printed, "PLU4011"). A PLU NEVER goes in productId. A QR or Datamatrix square is not an identifier - add extras "has_qr" instead

10. "organic" - true only when the label shows an organic logo or an organic control code ("DE-ÖKO-006")

11. "extras" - anything else printed on THIS label, as {"key","value"}, values exactly as printed:
    "grade" ("Klasse: I" -> "I"), "origin", "organic_code", "variety", "promo_badge" ("NUR FÜR KURZE ZEIT", "AKTION", "NEU"), "promo_valid_text" (a validity window), "label_type" ("paper", "esl_eink")
    PFAND is never added to or subtracted from the price: "pfand" (the number alone), "pfand_text" (as printed), "pfand_included" ("true" for "inkl.", "false" for "zzgl.")

BEFORE YOU ANSWER
1. Two rows with the same tagLocation -> you read one label twice. Keep one
2. A label you can see in the photo but did not write -> write it now, or confirm its price is not fully readable
3. Every label: did you check it for a small struck-through old price?
4. The same productId on two rows, or productIds that count up -> set every one of them to null
5. Any value you cannot point to on its own label -> null

"tags" is a JSON ARRAY, one object per label with a fully readable price, in the order you located them. [] if no label has one. Numbers as strings, dot decimal, no symbol.

THREE EXAMPLES.

A regular label, article number read:
{"tagLocation":"shelf 1 from top, label 2 from left","brand":"MOSER ROTH","name":"Trüffelpralinen","regularPrice":"3.99","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"19.95","unitPriceBasis":"kg","itemSize":"200","itemUom":"g","rawPriceStrings":["3.99","19.95/kg"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"high"},"productIdPrinted":"637739|4|F1","productIdCheck":"637739","productId":"637739","upc":null,"organic":false,"extras":[{"key":"label_type","value":"paper"}]}

The same label in poorer light - the fifth digit could be a 3 or an 8, so it is "?" and the article number is not captured. The row is still worth returning:
{"tagLocation":"shelf 1 from top, label 2 from left","brand":"MOSER ROTH","name":"Trüffelpralinen","regularPrice":"3.99","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"19.95","unitPriceBasis":"kg","itemSize":"200","itemUom":"g","rawPriceStrings":["3.99","19.95/kg"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"low"},"productIdPrinted":"6377?9|4|F1","productIdCheck":"6377?9","productId":null,"upc":null,"organic":false,"extras":[{"key":"label_type","value":"paper"}]}

A red electronic promotion label - big price 2.49, small struck-through 2.99 to its right, badge "NUR FÜR KURZE ZEIT":
{"tagLocation":"shelf 3 from top, label 1 from left","brand":"CUCINA","name":"Pesto Genovese","regularPrice":"2.99","regularMultiple":"1","promoPrice":"2.49","promoMultiple":"1","loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"13.11","unitPriceBasis":"kg","itemSize":"190","itemUom":"g","rawPriceStrings":["2.49","2.99","13.11/kg"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"medium"},"productIdPrinted":null,"productIdCheck":null,"productId":null,"upc":null,"organic":false,"extras":[{"key":"label_type","value":"esl_eink"},{"key":"promo_badge","value":"NUR FÜR KURZE ZEIT"}]}`;
    }

    // -----------------------------------------------------------------
    // Packaging section. Same field shape as ingredients_prompt.js,
    // written for the shelf photo this agent actually gets - packs facing
    // forward, back panels rare.
    // -----------------------------------------------------------------

    function buildPackagingSection() {
      return `

=============================================================
SECTION B - THE PACKAGES. A SEPARATE JOB FROM SECTION A.
=============================================================
Read the printed PANELS on the packages standing on the shelves - boxes, bags, cartons, trays. This fills "packages". You extract NO prices here: price, unit price and promotion belong to the tag and are done. Nothing on a package may change a tag field, and nothing on a tag may fill a package field.

CRITICAL RULES FOR THE PACKAGES:
1. RETURN ONLY CHARACTERS YOU CAN SEE printed on a package in the image
2. YOUR PRODUCT KNOWLEDGE IS FORBIDDEN AS A SOURCE. You will recognise many of these (Knoppers, Balisto, hanuta, Kinder, MOSER ROTH, MILSANI, Choceur). A recited ingredient list is indistinguishable from a read one, which is why it is banned
3. PACKS FACE FORWARD on a shelf photo, so back panels are almost never visible. NULLS AND EMPTY ARRAYS ARE THE NORMAL, CORRECT ANSWER and you must not compensate for them
4. NEVER reconstruct a list from the product name, the flavour or the front-of-pack claims
5. NEVER complete a word, list or table whose end you cannot read - return what you read and set "isPartial" true
6. NEVER calculate, convert, estimate or infer. Do NOT compute a Nutri-Score from a nutrition table, do NOT derive servings from a net weight
7. FINAL CHECK on every string you are about to return: "can I point at these exact characters on a package?" If no, delete it. The ONE exception is languageCode, which names the language of text you already read

PANEL EVIDENCE GATES EACH FIELD - fill it only if you SAW the panel it comes from:
- An ingredient declaration ("Zutaten", "Ingredients", "Ingrediënten", "Composition") -> ingredients.rawText / parsedList
- An "Active ingredients"/"Wirkstoffe" table -> activeIngredients
- A nutrition table ("Nährwerte", "Durchschnittliche Nährwerte", "Nutrition Facts") -> nutritionFacts
- An allergen sentence, or allergens emphasised inside the list -> allergensContains / allergensMayContain
- A printed score or seal -> healthScores
- None of these -> those fields stay null / []

WHAT IS ACTUALLY READABLE ON A SHELF PHOTO - this is what you will usually be filling:
- The name and brand as printed ON THE PACK, and the net content ("400 g", "500 g e", "3 x 90 ml")
- NUTRI-SCORE - the A-B-C-D-E ladder with ONE letter enlarged. Return that letter as scoreValue and "E" as scaleMax. If you cannot tell which is highlighted, return no score at all
- German seals: "Haltungsform 1/2/3/4" with its wording, "Initiative Tierwohl", "Bestes aus der Region"
- Organic marks: the green EU leaf, "BIO", a control code ("DE-ÖKO-044")
- Claims: "Fairtrade", "Ohne Konservierungsstoffe", "Laktosefrei", "ALKOHOLFREI", "NEU"
An ingredient list or nutrition table is the EXCEPTION on this kind of photo. When one genuinely is readable - a pack turned side-on, a close-up - read it in full under the rules above.

FIELDS:
- "nameOnPack" / "brandOnPack" - the name and brand AS PRINTED ON THE PACKAGE, verbatim. null if not legible. These exist so SECTION C's bind can be checked - they are NOT copies of the tag
- "netContent" - the net quantity printed on the pack, as printed ("400 g", "3 x 90 ml", "0,5 l"). Never from the tag
- "barcode" - the number printed under the barcode ON THIS PACK, all 8, 12 or 13 digits, copied exactly as printed, left to right. If ANY digit will not resolve, null - never a "?", never a guessed or dropped digit. The barcode is usually on the back or the bottom, so null is the normal answer on a shelf photo. Never from the tag, never from memory
- "ingredients.rawText" - the exact declaration after the heading, line wraps joined with one space and wrap-hyphens removed. Same words, order, punctuation, script and capitalisation. Do NOT translate or re-order. Do NOT include the "Contains:" sentence
- "ingredients.parsedList" - the same declaration as an array, one entry per top-level ingredient, in printed order, each verbatim INCLUDING its percentage and parenthesised sub-ingredients. A comma INSIDE parentheses does not start a new entry. Joined back together it must reproduce rawText. [] when rawText is null
- "ingredients.isPartial" - a real BOOLEAN. true when the list is cut off, curves out of view, blurs mid-list or is hidden. false when read heading to end. null when there is no ingredient text
- "ingredients.activeIngredients" - ONLY from an "Active ingredients"/"Wirkstoffe" table. "name", "strength" ("3.0${PCT}", "500 mg") and "purpose" are different printed columns - never merge them. [] for food and cosmetics, which is nearly always
- "ingredients.allergensContains" - allergens declared present, from a "Contains:"/"Enthält" sentence OR items in BOLD, UPPERCASE or underlined inside the list. As printed. Never inferred from an ingredient name. [] if none
- "ingredients.allergensMayContain" - trace warnings ("Kann Spuren von ... enthalten"), kept STRICTLY apart from allergensContains. [] if none
- "nutritionFacts" - the WHOLE OBJECT is null unless a table is printed and readable:
  * "servingsPerContainer" / "servingSize" - as printed, as strings. NEVER calculated from net weight
  * "basis" - ONE value for the panel, as printed ("per 100g", "je 100 g", "per serving"). If two columns are printed, return the PER SERVING column and say so here. Do not repeat it per row
  * "nutrients" - one object per row, in printed order. "name" standardized to ENGLISH ("Brennwert" -> "Calories", "Fett" -> "Total Fat", "Kohlenhydrate" -> "Carbohydrates", "davon Zucker" -> "Sugars", "Eiweiß" -> "Protein", "Ballaststoffe" -> "Fiber"). This is the ONLY field you may translate
  * SALT vs SODIUM ARE TWO DIFFERENT NUTRIENTS and are NEVER converted into each other - salt weighs about 2.5x its sodium. Decide from the PRINTED WORD: "Salz"/"Salt"/"Sel"/"Zout" -> "Salt", "Natrium"/"Sodium"/"Na" -> "Sodium". If the pack declares both, return both rows
  * "amount" - the value WITHOUT its unit ("21.3", "< 0.5", "0"), always with a DOT decimal: "21,3" -> "21.3". A thousands separator is dropped: "2.038 kJ" and "2,038 kJ" both -> "2038". Swap the separator ONLY - never round or re-scale. This applies to amount, servingSize and servingsPerContainer only; rawText and parsedList stay verbatim, decimal commas included
  * "unit" - the unit alone ("kcal", "kJ", "g", "mg"). null if the row prints none
  * "dailyValuePercent" - a NUMBER, or null when there is no ${PCT} column. Never computed. German panels usually print none
  * A row printing BOTH kJ and kcal is TWO entries
- "productClaims" - dietary, health, environmental, welfare and quality claims printed anywhere on the pack, VERBATIM. Do not paraphrase, merge or invent. Do not add "Gluten Free" because the ingredients contain no wheat. AT MOST 15, most prominent first. [] if none
- "healthScores" - printed front-of-pack scores and seals: "systemName" ("Nutri-Score", "Haltungsform", "Eco-Score"), "scoreValue" as printed ("B", "2"), "scaleMax" ("E", "4") when known, "details" as one "; "-joined string or null. OBSERVED ONLY, never computed. [] if none
- "languageCode" - lowercase ISO 639-1 for the language of the PACK text you returned ("de", "en", "fr"). The ONE field you may DERIVE, and it may never work backwards: knowing the language must not add or correct a single character elsewhere. Judge it from the text you read, never from the brand or the country. Base code only. null when no pack text was readable

NULL vs EMPTY ARRAY: null (scalar/object) and [] (array) both mean "not present or not readable". Never the string "null", never "", never a dash, never "N/A".`;
    }

    // -----------------------------------------------------------------
    // Binding. The only place tag and package meet.
    // -----------------------------------------------------------------

    function buildBindingSection() {
      return `

=============================================================
SECTION C - BINDING A PACKAGE TO ITS TAG
=============================================================
Every object in "packages" carries "tagIndex": the 1-BASED position, in the "tags" array you just built, of the tag that package is priced by. The first tag is 1, not 0. This is the ONLY link between the two sections.

HOW ALDI FIXTURES ARE ARRANGED - a tendency, NOT a rule:
On the ALDI fixtures seen so far the tag sits on the rail at the FRONT-BOTTOM edge of the shelf holding its product, so the product stands above and behind its own tag. Other retailers mount the rail above the goods, so direction alone is never evidence. It fails often: a rail under a glass cabinet frequently belongs to the CHEST FREEZER BENEATH IT; electronic labels clip to wire shelves, glass or a cabinet edge; a tall product on a lower shelf overhangs the tag below it.
So work out which FIXTURE each tag is attached to, and which products sit in THAT fixture. NEVER bind by pixel distance.

"bindBasis" - in a few words, what actually made you sure: "pack name matches the tag name", "net content matches the tag size", "only product in that cabinet". "NEAREST TAG", "TAG ABOVE" AND "TAG BELOW" ARE NOT ACCEPTABLE ON THEIR OWN - if the nearest tag is all you have, you are not sure.

"bindConfidence":
- "high": package and tag are unmistakably the same facing AND at least one printed detail corroborates it - the pack name matches the tag name, or the net content matches the tag size, or it is the only product in that fixture
- "medium": the geometry is clear but nothing printed corroborates it
- "low": position alone, an ambiguous fixture, or several products sharing the facing
ONLY "high" IS KEPT - everything else is discarded downstream, so an honest "low" costs you nothing and inflating it buys you nothing.

BIND NOTHING RATHER THAN BIND WRONGLY:
1. A package you cannot confidently place is LEFT OUT of "packages". In a dense aisle photo that is the normal outcome
2. A tag with no readable package gets no entry. Most tags in a wide shot will have none
3. AT MOST ONE package per tag. A "verschiedene Sorten" tag covers several variants standing together - pick the SINGLE most legible pack and do not merge two
4. NEVER merge panels from two packages into one record. If you cannot tell which pack a panel is on, leave that field null
5. Two packages must never claim the same tagIndex - keep the better-read one, drop the other`;
    }

    // pinnedCountry is kept in the signature for the packaging switch, but
    // the market is fixed: this agent reads ALDI SUD Germany only, and the
    // country and currency columns come from CONFIG.DEFAULT_COUNTRY.
    function buildPrompt(pinnedCountry) {
      const countryHint = '';

      const jobs = CONFIG.PACKAGING_ENABLED
        ? `
You have TWO SEPARATE JOBS on this image and they must not contaminate each other:
  SECTION A - the SHELF TAGS: price, name, size, article number. Source: the tag ONLY
  SECTION B - the PACKAGES: the printed panels on the boxes and bags. Source: the packaging ONLY
A field in one section is NEVER filled from the other's source. SECTION C says which package belongs to which tag.

=============================================================
SECTION A - THE SHELF TAGS
=============================================================`
        : '';

      const intro = `You are an expert at reading the shelf price labels of ALDI SÜD supermarkets in Germany. You will receive ONE photo of a shelf.
${countryHint}${jobs}`;

      const output = CONFIG.PACKAGING_ENABLED
        ? `

=============================================================
OUTPUT
=============================================================
Return ONE JSON OBJECT with exactly two keys:
  "tags"     - the array from SECTION A, in the order you located the tags. [] if no tag has a readable price
  "packages" - the array from SECTION B, each entry carrying the tagIndex, bindBasis and bindConfidence from SECTION C. [] if nothing could be read and bound, which is the common case
No markdown fences, no text outside the object. NEVER guess.`
        : `

=============================================================
OUTPUT
=============================================================
Return ONE JSON OBJECT with the single key "tags", in the order you located the labels. [] if no label has a fully readable price. No markdown fences, no text outside the object.`;

      return CONFIG.PACKAGING_ENABLED
        ? intro + buildTagSection() + buildPackagingSection() + buildBindingSection() + output
        : intro + buildTagSection() + output;
    }

    // -----------------------------------------------------------------
    // Response schema
    // -----------------------------------------------------------------

    const TAG_SCHEMA = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          // FIRST on purpose. Naming the shelf and position commits the
          // model to one physical tag before it reads a single character,
          // and gives the code a dedup key that is not the product name.
          tagLocation: { type: 'STRING', nullable: true },
          // No country / currency: Germany only, filled from the pin.
          brand: { type: 'STRING', nullable: true },
          name: { type: 'STRING', nullable: true },
          regularPrice: { type: 'STRING', nullable: true },
          regularMultiple: { type: 'STRING', nullable: true },
          promoPrice: { type: 'STRING', nullable: true },
          promoMultiple: { type: 'STRING', nullable: true },
          loyaltyPrice: { type: 'STRING', nullable: true },
          loyaltyMultiple: { type: 'STRING', nullable: true },
          unitPrice: { type: 'STRING', nullable: true },
          unitPriceBasis: { type: 'STRING', nullable: true },
          itemSize: { type: 'STRING', nullable: true },
          itemUom: { type: 'STRING', nullable: true },
          // The whole printed token, "637739|4|F1", read character by
          // character. It is the evidence productId is checked against: a
          // guess now has to produce a longer exact string, and the code
          // refuses a productId that is not inside it.
          productIdPrinted: { type: 'STRING', nullable: true },
          // A second, right-to-left reading of the same digits. The code
          // ships a SKU only when both readings agree (see resolveSku).
          productIdCheck: { type: 'STRING', nullable: true },
          productId: { type: 'STRING', nullable: true },
          upc: { type: 'STRING', nullable: true },
          organic: { type: 'BOOLEAN', nullable: true },
          // The PRICE tokens as printed, so a misread stays visible to a
          // reviewer instead of being replaced by a clean number. Identifiers
          // are deliberately excluded: this was the one field that ordered the
          // model to transcribe a number it could see but could not read, and
          // it then corroborated the guess in productId on every row.
          rawPriceStrings: { type: 'ARRAY', items: { type: 'STRING' } },
          confidence: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              description: { type: 'STRING', nullable: true },
              price: { type: 'STRING', nullable: true },
              size: { type: 'STRING', nullable: true },
              identifiers: { type: 'STRING', nullable: true }
            },
            propertyOrdering: ['description', 'price', 'size', 'identifiers']
          },
          extras: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                key: { type: 'STRING', nullable: true },
                value: { type: 'STRING', nullable: true }
              },
              propertyOrdering: ['key', 'value']
            }
          }
        },
        // ORDER IS THE POINT. The model writes where the tag is, then the
        // large print, then the price evidence, then how well it could read
        // the tag - and only then the article number. Every step that could
        // license a guess now comes after the step that would have to admit
        // to it. The old order put productId first and confidence last, so
        // the grade could only rationalise a number already committed.
        propertyOrdering: [
          'tagLocation',
          'brand', 'name',
          'regularPrice', 'regularMultiple', 'promoPrice', 'promoMultiple',
          'loyaltyPrice', 'loyaltyMultiple',
          'unitPrice', 'unitPriceBasis', 'itemSize', 'itemUom',
          'rawPriceStrings', 'confidence',
          'productIdPrinted', 'productIdCheck', 'productId', 'upc', 'organic', 'extras'
        ]
      }
    };

    // camelCase here, flattened to the documented snake_case cell shape in
    // normalizePackaging().
    const PACKAGING_SCHEMA = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tagIndex: { type: 'INTEGER', nullable: true },
          bindConfidence: { type: 'STRING', nullable: true },
          bindBasis: { type: 'STRING', nullable: true },

          // Identity as printed ON THE PACK - what checkBind() examines.
          nameOnPack: { type: 'STRING', nullable: true },
          brandOnPack: { type: 'STRING', nullable: true },
          netContent: { type: 'STRING', nullable: true },
          barcode: { type: 'STRING', nullable: true },

          ingredients: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              rawText: { type: 'STRING', nullable: true },
              parsedList: { type: 'ARRAY', items: { type: 'STRING' } },
              isPartial: { type: 'BOOLEAN', nullable: true },
              activeIngredients: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING', nullable: true },
                    strength: { type: 'STRING', nullable: true },
                    purpose: { type: 'STRING', nullable: true }
                  },
                  propertyOrdering: ['name', 'strength', 'purpose']
                }
              },
              allergensContains: { type: 'ARRAY', items: { type: 'STRING' } },
              allergensMayContain: { type: 'ARRAY', items: { type: 'STRING' } }
            },
            propertyOrdering: [
              'rawText', 'parsedList', 'isPartial', 'activeIngredients',
              'allergensContains', 'allergensMayContain'
            ]
          },

          // null is correct for every pack with no nutrition table, which
          // on a forward-facing shelf photo is nearly all of them.
          nutritionFacts: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              servingsPerContainer: { type: 'STRING', nullable: true },
              servingSize: { type: 'STRING', nullable: true },
              basis: { type: 'STRING', nullable: true },
              nutrients: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING', nullable: true },
                    // STRING, not NUMBER: panels print "< 0.5" and "0"
                    // alike, and a union type is not expressible here.
                    amount: { type: 'STRING', nullable: true },
                    unit: { type: 'STRING', nullable: true },
                    dailyValuePercent: { type: 'NUMBER', nullable: true }
                  },
                  propertyOrdering: ['name', 'amount', 'unit', 'dailyValuePercent']
                }
              }
            },
            propertyOrdering: ['servingsPerContainer', 'servingSize', 'basis', 'nutrients']
          },

          productClaims: { type: 'ARRAY', items: { type: 'STRING' } },
          healthScores: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                systemName: { type: 'STRING', nullable: true },
                scoreValue: { type: 'STRING', nullable: true },
                scaleMax: { type: 'STRING', nullable: true },
                // STRING: a responseSchema cannot express "object or
                // string or null", so breakdowns arrive '; '-joined.
                details: { type: 'STRING', nullable: true }
              },
              propertyOrdering: ['systemName', 'scoreValue', 'scaleMax', 'details']
            }
          },
          languageCode: { type: 'STRING', nullable: true }
        },
        propertyOrdering: [
          'tagIndex', 'bindConfidence', 'bindBasis',
          'nameOnPack', 'brandOnPack', 'netContent', 'barcode',
          'ingredients', 'nutritionFacts', 'productClaims',
          'healthScores', 'languageCode'
        ]
      }
    };

    const RESPONSE_SCHEMA = CONFIG.PACKAGING_ENABLED
      ? {
        type: 'OBJECT',
        properties: { tags: TAG_SCHEMA, packages: PACKAGING_SCHEMA },
        propertyOrdering: ['tags', 'packages']
      }
      : {
        type: 'OBJECT',
        properties: { tags: TAG_SCHEMA },
        propertyOrdering: ['tags']
      };

    // -----------------------------------------------------------------
    // Gemini call
    // -----------------------------------------------------------------

    function readUsage(meta) {
      const m = meta || {};
      const inputTokens = m.promptTokenCount || 0;
      const outputTokens = m.candidatesTokenCount || 0;
      const thoughtsTokens = m.thoughtsTokenCount || 0;
      const cachedTokens = m.cachedContentTokenCount || 0;
      const totalTokens = m.totalTokenCount || 0;

      const today = new Date().toISOString().slice(0, 10);
      const rate = CONFIG.PRICES.filter(p => p.from <= today).pop() || CONFIG.PRICES[0];
      const cost =
        ((inputTokens - cachedTokens) / 1e6) * rate.input +
        (cachedTokens / 1e6) * rate.cachedInput +
        ((outputTokens + thoughtsTokens) / 1e6) * rate.output;

      console.log(`Tokens: ${totalTokens} (${cachedTokens} cached) | Cost: $${cost.toFixed(6)}`);
      return { inputTokens, outputTokens, thoughtsTokens, cachedTokens, totalTokens, cost: parseFloat(cost.toFixed(6)) };
    }

    // Structured output makes this a plain JSON.parse; the fallback only
    // matters if a response was cut off or wrapped anyway.
    function parseModelJson(text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        const match = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
        if (!match) return null;
        try { return JSON.parse(match[0]); } catch (e2) { return null; }
      }
    }

    // A bare array is still accepted, so a fallback parse of a truncated
    // response degrades to tags-only instead of throwing.
    function splitResponse(parsed) {
      if (Array.isArray(parsed)) return { tags: parsed, packages: [] };
      if (!parsed || typeof parsed !== 'object') return { tags: [], packages: [] };
      const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
      const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
      return { tags, packages };
    }

    // One photo in, one array of tags out.
    async function extractProductInfo(link, apiKey, pinnedCountry) {
      const image = await fetchImageWithRetry(convertGoogleDriveUrl(link));
      if (!image) {
        throw new Error('Failed to fetch the image');
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts: [{ text: buildPrompt(pinnedCountry) }, image] }],
        generationConfig: {
          temperature: CONFIG.TEMPERATURE,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      };
      if (CONFIG.MEDIA_RESOLUTION) payload.generationConfig.mediaResolution = CONFIG.MEDIA_RESOLUTION;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API request failed:', response.status, errorText);
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      const usage = readUsage(result.usageMetadata);

      const candidate = (result.candidates || [])[0];
      if (!candidate) {
        const blockReason = result.promptFeedback && result.promptFeedback.blockReason;
        throw new Error(blockReason ? `Gemini returned no candidates (blocked: ${blockReason})` : 'Gemini returned no candidates');
      }
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        console.warn(`Gemini finishReason: ${candidate.finishReason}`);
      }

      const text = ((candidate.content && candidate.content.parts) || [])
        .map(part => part.text || '')
        .join('');

      const parsed = parseModelJson(text);
      if (parsed === null) {
        throw new Error(`Could not parse JSON from model response: ${text.slice(0, 300)}`);
      }

      const split = splitResponse(parsed);
      return { labels: split.tags, packages: split.packages, usage };
    }

    // -----------------------------------------------------------------
    // Normalization - unchanged from the tested version
    // -----------------------------------------------------------------

    function isBlank(value) {
      return value === null || value === undefined || /^\s*(null|n\/a|-)?\s*$/i.test(String(value));
    }

    // Accepts what a tag prints, in any locale: "1.89", "1,89", "-.99",
    // "2,-", "1.234,56", "1 299 Ft", "89p". Returns a number or null.
    function parsePrice(value) {
      if (isBlank(value)) return null;
      let s = String(value).trim();
      const inCents = /\d\s*(p|¢)$/i.test(s) && !/[.,]/.test(s);

      s = s.replace(/^[-–—]\s*(?=[.,]\d)/, '0');
      s = s.replace(/[.,]\s*[-–—]+$/, '');
      s = s.replace(/[^\d.,]/g, '');
      if (!/\d/.test(s)) return null;

      const sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
      const decimals = sep === -1 ? 0 : s.length - sep - 1;
      if (sep !== -1 && decimals >= 1 && decimals <= 2) {
        s = s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1);
      } else {
        s = s.replace(/[.,]/g, '');
      }

      const n = Number(s);
      if (!isFinite(n)) return null;
      return inCents ? n / 100 : n;
    }

    function formatPrice(n) {
      return n === null ? '' : n.toFixed(2);
    }

    function parseQuantity(value) {
      if (isBlank(value)) return null;
      const n = Number(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
      return isFinite(n) && n > 0 ? n : null;
    }

    function parseMultiple(value, hasPriceValue) {
      if (!hasPriceValue) return '';
      const n = Math.round(parseQuantity(value) || 1);
      return String(n < 1 ? 1 : n);
    }

    function normalizeUom(value) {
      if (isBlank(value)) return '';
      const raw = String(value).trim();
      const key = raw.toLowerCase().replace(/[\s.]/g, '');
      return UOM_MAP[key] || raw;
    }

    // ALL-CAPS text ("NATUR LIEBLINGE") is title-cased; anything already
    // mixed case is kept exactly as printed, so German noun capitalisation
    // and lowercase adjectives ("Spitzpaprika rot") survive.
    function displayCase(value) {
      if (isBlank(value)) return '';
      const s = String(value).trim().replace(/\s+/g, ' ');
      if (s !== s.toUpperCase() || s === s.toLowerCase()) return s;
      return s.toLowerCase().replace(/(^|[\s\-\/(&+])(\S)/g, (m, sep, ch) => sep + ch.toUpperCase());
    }

    // Brand + name, without doubling a brand the name already starts with
    // ("BIO" + "Bio Paprika" -> "Bio Paprika").
    function buildDescription(brand, name) {
      if (!name) return brand;
      if (!brand) return name;
      return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
    }

    // The printed code is split into groups on any separator, and the ONE
    // group that is a plausible article number is returned.
    //
    // "First group wins" does not work across retailers: ALDI prints
    // "631939|39" (article first, print week second) but Lidl prints
    // "36/0080987", where the 7-digit SECOND group is the article number.
    // Selecting by LENGTH handles both, and "554264|8|F0.5" as well.
    //
    // Two plausible groups means the code is ambiguous and nothing is
    // returned - the printed string still travels in RAW_DATA_JSON.
    //
    // A group mixing letters and digits is never a candidate. It used to be
    // repaired (B -> 8, O -> 0), but a letter inside the digits means the
    // model was not sure what it saw, and a repaired digit is a guess. The
    // batch codes ("F1", "F0.5") mix letters too and were never candidates.
    //
    // One exception: ALDI prints some article numbers with a single letter
    // AFTER the digits ("134514N|52|F2", "670488N|26|F2"). That letter is
    // printed, not a misread digit, so the digits before it are kept and
    // the letter dropped. A letter anywhere else still rejects the group.
    function normalizeSku(value) {
      if (isBlank(value)) return '';
      const groups = String(value).trim().split(/[\s|¦\/\\,;:]+/)
        .map(part => part.replace(/^(\d+)[A-Za-z]$/, '$1'))
        .map(part => (/[A-Za-z]/.test(part) ? '' : part.replace(/\D/g, '')))
        .filter(digits => digits.length >= CONFIG.SKU_MIN_DIGITS && digits.length <= CONFIG.SKU_MAX_DIGITS);

      if (groups.length === 0) {
        console.warn(`Discarding "${value}" as SKU - no group is the length of an article number`);
        return '';
      }
      if (groups.length > 1) {
        console.warn(`Discarding "${value}" as SKU - ${groups.length} groups could each be the article number`);
        return '';
      }
      return groups[0];
    }

    // Remainder without the percent operator (see PCT at the top).
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

    // IFPS produce codes: 3000-4999, or the same with a leading 9 for
    // organic.
    function isPlu(digits) {
      return /^[34]\d{3}$/.test(digits) || /^9[34]\d{3}$/.test(digits);
    }

    // A value the tag itself labels "PLU" ("PLU541"). Retailers print
    // their own scale codes this way, often outside the IFPS range, so the
    // printed label - not the range - is what makes it a PLU.
    //
    // Returns { value, raw }. The UPC column carries the code exactly as
    // the tag prints it, word included ("PLU43", "PLU541") - the "PLU"
    // is what tells a short produce code apart from a bad barcode read.
    function labelledPlu(value) {
      const match = String(isBlank(value) ? '' : value).match(/PLU\D{0,3}(\d{1,5})(?!\d)/i);
      if (!match) return { value: '', raw: '' };
      return { value: match[0].trim(), raw: match[0] };
    }

    // Returns { value, type }. The UPC goes in the column as printed on
    // the tag - a PLU keeps its "PLU", an 8- or 12-digit barcode is not
    // padded to 13. A barcode is either read whole with a matching check
    // digit or dropped: no rebuilding of partial reads.
    function normalizeUpc(value) {
      const plu = labelledPlu(value);
      if (plu.value) return { value: plu.value, type: 'plu', raw: plu.raw };
      const digits = String(isBlank(value) ? '' : value).replace(/\D/g, '');
      if (!digits) return { value: '', type: '' };
      if (isPlu(digits)) return { value: digits, type: 'plu' };
      if ([8, 12, 13].indexOf(digits.length) === -1 || !hasValidGtinCheckDigit(digits)) {
        console.warn(`Discarding "${digits}" as UPC - neither a valid barcode nor a PLU`);
        return { value: '', type: '' };
      }
      return { value: digits, type: 'gtin' };
    }

    // The barcode read off a PACKAGE in SECTION B - never the tag's UPC.
    // Kept exactly as printed, no padding, and only when it is a whole 8,
    // 12 or 13 digit barcode whose check digit holds. A "?" means a digit
    // was not read, so the whole number goes.
    function normalizePackageBarcode(value) {
      const text = String(isBlank(value) ? '' : value);
      if (text.indexOf('?') !== -1) return '';
      const digits = text.replace(/\D/g, '');
      if (!digits) return '';
      if ([8, 12, 13].indexOf(digits.length) === -1 || !hasValidGtinCheckDigit(digits)) {
        console.warn(`Discarding package barcode "${value}" - not a whole barcode with a valid check digit`);
        return '';
      }
      return digits;
    }

    function normalizeCountry(value) {
      const code = String(value || '').trim().toUpperCase();
      if (code === 'UK') return 'GB';
      return /^[A-Z]{2}$/.test(code) ? code : '';
    }

    function resolveCurrency(rawCurrency, country) {
      const key = String(rawCurrency || '').trim().toLowerCase().replace(/\s+/g, '');
      if (key) {
        if (CURRENCY_SYMBOLS[key]) return CURRENCY_SYMBOLS[key];
        if (AMBIGUOUS_CURRENCY[key]) {
          if (AMBIGUOUS_CURRENCY[key].indexOf(country) !== -1) return COUNTRY_CURRENCY[country];
          console.warn(`Currency "${rawCurrency}" is ambiguous for country "${country || '?'}"`);
          return '';
        }
        if (/^[a-z]{3}$/.test(key)) return key.toUpperCase();
      }
      return COUNTRY_CURRENCY[country] || '';
    }

    // Does price / size reproduce the printed unit price? It holds on
    // every tag in the reference photo (1.89 / 250 g = 7.56/kg), so a
    // mismatch almost always means one of the numbers was misread.
    // Returns 'ok', 'mismatch', or '' when the units cannot be compared.
    //
    // packCount is the n of a printed "n x m" multipack. itemSize holds the
    // COMPONENT (the prompt asks for that), but the price and the unit price
    // are for the whole pack: "3 x 90 ml" for 3.49 is 12.93/l, not 38.78/l.
    // Either reading is accepted, so a multipack no longer reads as a
    // misread just because the size is per piece.
    function checkUnitPrice(prices, size, uom, unitPrice, basis, packCount) {
      if (unitPrice === null || size === null || !basis || prices.length === 0) return '';
      const basisMatch = String(basis).trim().match(/^(\d+(?:[.,]\d+)?)?\s*(.+)$/);
      if (!basisMatch) return '';
      const basisQty = basisMatch[1] ? parseQuantity(basisMatch[1]) : 1;
      const itemUnit = UOM_FACTOR[uom];
      const basisUnit = UOM_FACTOR[normalizeUom(basisMatch[2])];
      if (!itemUnit || !basisUnit || itemUnit[0] !== basisUnit[0]) return '';

      const sizes = packCount > 1 ? [size, size * packCount] : [size];
      const tolerance = Math.max(CONFIG.UNIT_PRICE_TOLERANCE_ABS, unitPrice * CONFIG.UNIT_PRICE_TOLERANCE_PCT);
      const matches = prices.some(p => sizes.some(s => {
        const expected = (p.price / p.multiple) / (s * itemUnit[1]) * (basisQty * basisUnit[1]);
        return Math.abs(expected - unitPrice) <= tolerance;
      }));
      return matches ? 'ok' : 'mismatch';
    }

    // The n of a multipack, from the "pack_printed" extra ("8x25g",
    // "3 x 90 ml"). 1 when there is none.
    function packCountOf(label) {
      const extras = Array.isArray(label.extras) ? label.extras : [];
      const pack = extras.find(extra => extra && String(extra.key || '').toLowerCase() === 'pack_printed');
      const match = pack ? String(pack.value || '').match(/(\d+)\s*[x×*]\s*\d/i) : null;
      const n = match ? Number(match[1]) : 1;
      return n > 1 ? n : 1;
    }

    // -----------------------------------------------------------------
    // Packaging: normalization and binding
    //
    // Everything below touches ONLY the packages array. It never reads a
    // tag field except in checkBind(), which compares the two on purpose.
    // -----------------------------------------------------------------

    function cleanText(value, maxChars) {
      if (isBlank(value)) return null;
      const s = String(value).replace(/\s+/g, ' ').trim();
      if (!s) return null;
      return maxChars && s.length > maxChars ? s.slice(0, maxChars) : s;
    }

    function cleanTextList(value, maxItems, maxChars) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const entry of value) {
        if (out.length >= maxItems) break;
        const text = cleanText(entry, maxChars);
        if (text) out.push(text);
      }
      return out;
    }

    // "400 g", "3 x 90 ml", "2 x 200 ml = 400 ml", "0,5 l" -> grams / ml /
    // pieces, for checkBind. Returns { dimension, amount } or null. A
    // "= total" wins over the multiplier before it; otherwise the factors
    // of an "n x m" are multiplied out.
    function parseNetContent(value) {
      if (isBlank(value)) return null;
      const text = String(value).toLowerCase().replace(/\s+/g, ' ').trim();

      const afterEquals = text.split('=').pop();
      const candidates = afterEquals !== text ? [afterEquals, text] : [text];

      for (const candidate of candidates) {
        const unitMatch = candidate.match(/(\d[\d.,]*)\s*(mg|kg|g|ml|cl|dl|l|oz|lb|st(?:ü|ue)?ck|stk|ea|pcs?)\b/);
        if (!unitMatch) continue;
        const factor = UOM_FACTOR[normalizeUom(unitMatch[2])];
        if (!factor) continue;

        const qty = parseQuantity(unitMatch[1]);
        if (qty === null) continue;

        // Multiply any "3 x" sitting in front of the number.
        let multiplier = 1;
        const head = candidate.slice(0, unitMatch.index);
        const multMatches = head.match(/(\d+)\s*(?:x|\*|×)\s*$/);
        if (multMatches) multiplier = Number(multMatches[1]) || 1;

        return { dimension: factor[0], amount: qty * factor[1] * multiplier };
      }
      return null;
    }

    // Loose containment either way, after case-folding and stripping
    // punctuation - "Chicken Stripes" vs "JACK'S FARM Chicken Stripes".
    function textsAgree(a, b) {
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
      const x = norm(a);
      const y = norm(b);
      if (!x || !y) return false;
      return x === y || x.indexOf(y) !== -1 || y.indexOf(x) !== -1;
    }

    // The code's own opinion on a bind the model called "high". Returns
    // 'confirmed' (something printed corroborates it), 'unconfirmed'
    // (nothing to compare - accepted, since the model saw the fixture and
    // we did not) or 'contradicted' (a printed value disagrees - refused).
    //
    // Deliberately asymmetric: agreement is weak evidence, disagreement is
    // strong. A pack reading 400 g under a tag reading 250 g is not that
    // tag's pack, whatever the geometry looked like.
    function checkBind(pkg, label) {
      let corroborated = false;

      const packSize = parseNetContent(pkg.netContent);
      const tagSize = parseQuantity(label.itemSize);
      const tagUnit = UOM_FACTOR[normalizeUom(label.itemUom)];
      if (packSize && tagSize !== null && tagUnit && tagUnit[0] === packSize.dimension) {
        const tagAmount = tagSize * tagUnit[1];
        const tolerance = Math.max(tagAmount * CONFIG.BIND_SIZE_TOLERANCE_PCT, 0.001);
        if (Math.abs(tagAmount - packSize.amount) <= tolerance) corroborated = true;
        else return 'contradicted';
      }

      // A NAME match confirms; a mismatch does NOT refuse, because the tag
      // prints a retailer description and the pack a marketing name, and
      // those legitimately differ ("Stieleis" vs "SALTED PECAN CARAMEL").
      // Only the net content is trusted to refuse.
      if (textsAgree(pkg.nameOnPack, label.name)) corroborated = true;

      // A BRAND match is deliberately NOT corroboration on its own. A
      // shelf of nine MOSER ROTH bars all match on brand, so it
      // distinguishes nothing - and it was what certified a whole set of
      // mis-shifted bindings as "confirmed".

      return corroborated ? 'confirmed' : 'unconfirmed';
    }

    // Model record -> the snake_case object that goes in the cell, or null
    // when nothing survived. Absent sections are omitted entirely rather
    // than written as null, to keep the cell small.
    function normalizePackaging(pkg) {
      if (!pkg || typeof pkg !== 'object') return null;
      const out = {};

      const name = cleanText(pkg.nameOnPack, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      const brand = cleanText(pkg.brandOnPack, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      const net = cleanText(pkg.netContent, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (name) out.name_on_pack = name;
      if (brand) out.brand_on_pack = brand;
      if (net) out.net_content = net;
      const barcode = normalizePackageBarcode(pkg.barcode);
      if (barcode) out.package_barcode = barcode;

      const src = pkg.ingredients && typeof pkg.ingredients === 'object' ? pkg.ingredients : {};
      const ingredients = {};
      const rawText = cleanText(src.rawText, CONFIG.PACKAGING_MAX_INGREDIENT_CHARS);
      if (rawText) ingredients.raw_text = rawText;

      const parsed = cleanTextList(src.parsedList, CONFIG.PACKAGING_MAX_PARSED_ITEMS, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (parsed.length) ingredients.parsed_list = parsed;
      // isPartial only means something next to an actual declaration.
      if (rawText && typeof src.isPartial === 'boolean') ingredients.is_partial = src.isPartial;

      const actives = Array.isArray(src.activeIngredients) ? src.activeIngredients : [];
      const activeOut = [];
      for (const active of actives) {
        if (activeOut.length >= CONFIG.PACKAGING_MAX_PARSED_ITEMS) break;
        if (!active || typeof active !== 'object') continue;
        const activeName = cleanText(active.name, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        if (!activeName) continue;
        const entry = { name: activeName };
        const strength = cleanText(active.strength, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        const purpose = cleanText(active.purpose, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        if (strength) entry.strength = strength;
        if (purpose) entry.purpose = purpose;
        activeOut.push(entry);
      }
      if (activeOut.length) ingredients.active_ingredients = activeOut;

      const contains = cleanTextList(src.allergensContains, CONFIG.PACKAGING_MAX_PARSED_ITEMS, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      const mayContain = cleanTextList(src.allergensMayContain, CONFIG.PACKAGING_MAX_PARSED_ITEMS, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (contains.length) ingredients.allergens_contains = contains;
      if (mayContain.length) ingredients.allergens_may_contain = mayContain;

      if (Object.keys(ingredients).length) out.ingredients = ingredients;

      const nf = pkg.nutritionFacts && typeof pkg.nutritionFacts === 'object' ? pkg.nutritionFacts : null;
      if (nf) {
        const nutrition = {};
        const servings = cleanText(nf.servingsPerContainer, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        const servingSize = cleanText(nf.servingSize, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        const basis = cleanText(nf.basis, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        if (servings) nutrition.servings_per_container = servings;
        if (servingSize) nutrition.serving_size = servingSize;
        if (basis) nutrition.basis = basis;

        const rows = Array.isArray(nf.nutrients) ? nf.nutrients : [];
        const nutrients = [];
        for (const row of rows) {
          if (nutrients.length >= CONFIG.PACKAGING_MAX_NUTRIENTS) break;
          if (!row || typeof row !== 'object') continue;
          const rowName = cleanText(row.name, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
          const amount = cleanText(row.amount, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
          if (!rowName || amount === null) continue;
          const entry = { name: rowName, amount: amount };
          const unit = cleanText(row.unit, 20);
          if (unit) entry.unit = unit;
          const dv = Number(row.dailyValuePercent);
          if (row.dailyValuePercent !== null && row.dailyValuePercent !== undefined && isFinite(dv)) {
            entry.daily_value_percent = dv;
          }
          nutrients.push(entry);
        }
        if (nutrients.length) nutrition.nutrients = nutrients;
        // A panel with no readable rows carries no information.
        if (nutrients.length) out.nutrition_facts = nutrition;
      }

      const claims = cleanTextList(pkg.productClaims, CONFIG.PACKAGING_MAX_CLAIMS, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (claims.length) out.product_claims = claims;

      const scores = Array.isArray(pkg.healthScores) ? pkg.healthScores : [];
      const scoreOut = [];
      for (const score of scores) {
        if (scoreOut.length >= CONFIG.PACKAGING_MAX_SCORES) break;
        if (!score || typeof score !== 'object') continue;
        const system = cleanText(score.systemName, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        const value = cleanText(score.scoreValue, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        // A system with no value, or a value with no system, says nothing.
        if (!system || !value) continue;
        const entry = { system_name: system, score_value: value };
        const scaleMax = cleanText(score.scaleMax, 20);
        const details = cleanText(score.details, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        if (scaleMax) entry.scale_max = scaleMax;
        if (details) entry.details = details;
        scoreOut.push(entry);
      }
      if (scoreOut.length) out.health_scores = scoreOut;

      const lang = cleanText(pkg.languageCode, 8);
      if (lang && /^[a-z]{2}$/i.test(lang)) out.language_code = lang.toLowerCase();

      // languageCode alone is not panel evidence - it names the language
      // of text that did not survive normalization.
      const keys = Object.keys(out).filter(k => k !== 'language_code');
      return keys.length ? out : null;
    }

    // The prompt asks for a 1-based tagIndex. Production responses have
    // come back 0-based, which silently shifted every package onto the tag
    // before the right one - the worst kind of wrong, because the row
    // still looks complete. So the base is decided ONCE for the whole
    // array from its own range rather than trusted per package: an index
    // of 0 can only be 0-based, and an index equal to the tag count can
    // only be 1-based. Seeing both means the array is internally
    // inconsistent, and nothing is bound rather than half of it wrongly.
    function tagIndexBase(packages, labelCount) {
      let sawZero = false;
      let sawCount = false;
      for (const pkg of packages) {
        const n = Math.round(Number(pkg && pkg.tagIndex));
        if (!isFinite(n)) continue;
        if (n === 0) sawZero = true;
        if (n === labelCount) sawCount = true;
      }
      if (sawZero && sawCount) {
        console.warn('tagIndex spans both 0 and the tag count - the base is ambiguous, so no packaging is bound');
        return null;
      }
      if (sawZero) {
        console.warn('tagIndex came back 0-based - shifting it onto the tag array');
        return 0;
      }
      return 1;
    }

    // packages -> Map(position -> record). Strict by construction: a
    // package is kept only if it names one tag, clears the confidence bar,
    // survives normalization and is not contradicted by that tag's own
    // printed values. At most one per tag; a second claimant is dropped,
    // never merged.
    function bindPackages(packages, labels) {
      const bound = new Map();
      if (!CONFIG.PACKAGING_ENABLED || !Array.isArray(packages)) return bound;

      const accepted = CONFIG.PACKAGING_REQUIRE_HIGH_CONFIDENCE
        ? ['high']
        : ['high', 'medium'];

      const base = tagIndexBase(packages, labels.length);
      if (base === null) return bound;

      for (const pkg of packages) {
        if (!pkg || typeof pkg !== 'object') continue;

        const confidence = String(pkg.bindConfidence || '').trim().toLowerCase();
        if (accepted.indexOf(confidence) === -1) {
          console.log(`Packaging dropped - bind confidence "${pkg.bindConfidence || 'none'}" for "${pkg.nameOnPack || 'unnamed pack'}"`);
          continue;
        }

        const index = Math.round(Number(pkg.tagIndex));
        const at = index - base;
        if (!isFinite(index) || at < 0 || at >= labels.length) {
          console.warn(`Packaging dropped - tagIndex ${pkg.tagIndex} is not one of the ${labels.length} tag(s)`);
          continue;
        }

        const label = labels[at];
        const verdict = checkBind(pkg, label);
        if (verdict === 'contradicted') {
          console.warn(`Packaging dropped - pack "${pkg.netContent}" contradicts tag "${label.itemSize}${label.itemUom}" on "${label.name}"`);
          continue;
        }

        const record = normalizePackaging(pkg);
        if (!record) {
          console.log(`Packaging dropped - nothing readable on "${pkg.nameOnPack || 'unnamed pack'}"`);
          continue;
        }

        if (bound.has(at)) {
          console.warn(`Packaging dropped - tag ${index} already has a package bound to it`);
          continue;
        }

        record.bind_confidence = confidence;
        record.bind_check = verdict;
        const basis = cleanText(pkg.bindBasis, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
        if (basis) record.bind_basis = basis;

        bound.set(at, record);
      }

      return bound;
    }

    // Whether the model's own identifiers grade clears CONFIG.SKU_MIN_CONFIDENCE.
    // Only logged when there was a number to withhold.
    function skuConfident(label) {
      const ranks = { low: 1, medium: 2, high: 3 };
      const needed = ranks[normalizeConfidence(CONFIG.SKU_MIN_CONFIDENCE)];
      if (!needed) return true;
      const grade = normalizeConfidence(label.confidence && label.confidence.identifiers);
      if ((ranks[grade] || 0) >= needed) return true;
      if (!isBlank(label.productIdPrinted) || !isBlank(label.productId)) {
        console.warn(`Withholding SKU "${label.productIdPrinted || label.productId}" - identifiers graded "${grade || 'none'}", needs "${CONFIG.SKU_MIN_CONFIDENCE}"`);
      }
      return false;
    }

    // The article number the row ships, from the token the model says it
    // read character by character.
    //
    // The prompt asks for BOTH "productIdPrinted" ("637739|4|F1") and the
    // cleaned "productId" ("637739"). Two fields derived from one reading
    // must agree, so this refuses the pair when they do not: on the photo
    // that prompted the rewrite the model returned digits that were simply
    // not the ones on the tag, and nothing in the response contradicted
    // them. A cleaned value that does not appear in its own printed token
    // is the one form of that error the code CAN see.
    //
    // A response with no printed token falls back to the old behaviour, so
    // an older or truncated response still produces what it always did.
    function resolveSku(label) {
      if (!skuConfident(label)) return '';

      const printed = cleanText(label.productIdPrinted, CONFIG.RAW_MAX_VALUE_CHARS);
      if (!printed) {
        if (isBlank(label.productId)) return '';
        // Worth a line in the log either way: the prompt asks for the token
        // whenever the digits resolved, so its absence next to a filled
        // productId means the model did not follow the procedure.
        if (CONFIG.SKU_REQUIRE_PRINTED_TOKEN) {
          console.warn(`Dropping SKU "${label.productId}" - no printed token was reported for it`);
          return '';
        }
        console.warn(`SKU "${label.productId}" has no printed token behind it - keeping it, but it was not transcribed as asked`);
        return normalizeSku(label.productId);
      }

      // A "?" marks a digit the model could not confirm.
      if (printed.indexOf('?') !== -1) {
        console.log(`SKU withheld - "${printed}" has unconfirmed digits`);
        return '';
      }

      const sku = normalizeSku(printed);
      if (!sku) return '';

      // The second, right-to-left reading must agree digit for digit.
      // Look-alike misreads (605463 -> 608463) tend not to repeat when the
      // digits are read again in the other direction. A response without
      // the field (older prompt) is not held to it.
      const check = cleanText(label.productIdCheck, CONFIG.RAW_MAX_VALUE_CHARS);
      if (check) {
        // Digits before the bar, any trailing / leading letter ("670488N",
        // "N884076") dropped. The model is told to read right to left and
        // sometimes also WRITES the result right to left, so the reversed
        // string counts as agreement too - it is the same digits read twice.
        const checkDigits = check.split(/[|¦\/]/)[0].replace(/\s+/g, '').replace(/^[A-Za-z]?(\d+)[A-Za-z]?$/, '$1');
        const reversed = checkDigits.split('').reverse().join('');
        if (checkDigits !== sku && reversed !== sku) {
          console.warn(`Dropping SKU - first reading "${sku}", second reading "${check}"`);
          return '';
        }
      }

      // The cleaned field is advisory: the token is the evidence. They
      // disagreeing means one of the two was not read off the tag.
      const claimed = normalizeSku(label.productId);
      if (claimed && claimed !== sku) {
        console.warn(`Dropping SKU - the model read "${printed}" but reported "${label.productId}"`);
        return '';
      }
      return sku;
    }

    // -----------------------------------------------------------------
    // RAW_DATA_JSON
    // -----------------------------------------------------------------

    // "high" | "medium" | "low", or '' for anything else.
    function normalizeConfidence(value) {
      const level = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
      return ['high', 'medium', 'low'].indexOf(level) === -1 ? '' : level;
    }

    // The four groups the prompt asks for, in a fixed order so the cell
    // reads the same on every row. Groups the model left off are omitted
    // rather than guessed at.
    function buildConfidence(value) {
      if (!value || typeof value !== 'object') return null;
      const out = {};
      ['description', 'price', 'size', 'identifiers'].forEach(group => {
        const level = normalizeConfidence(value[group]);
        if (level) out[group] = level;
      });
      return Object.keys(out).length > 0 ? out : null;
    }

    // Price tokens exactly as printed. Deliberately NOT parsed: the point
    // is to preserve what was on the tag so a reviewer can catch a misread,
    // which a cleaned-up number would hide. The prompt keeps identifiers
    // out of this list - an article number echoed here only ever confirmed
    // whatever productId already said.
    function buildPriceStrings(value) {
      if (!Array.isArray(value)) return null;
      const out = [];
      for (const entry of value) {
        if (out.length >= CONFIG.RAW_MAX_PRICE_STRINGS) break;
        if (isBlank(entry)) continue;
        const text = String(entry).replace(/\s+/g, ' ').trim().slice(0, CONFIG.RAW_MAX_PRICE_STRING_CHARS);
        if (text && out.indexOf(text) === -1) out.push(text);
      }
      return out.length > 0 ? out : null;
    }

    // upc_type tells downstream whether the UPC column holds a PLU or a
    // GTIN.
    function buildRawJson(label, unitPrice, unitCheck, upcType, packaging, pluRaw) {
      const raw = {};
      // Where on the fixture this row came from - the reviewer's way back to
      // the tag in the photo, and what the duplicate check keys on.
      const location = cleanText(label.tagLocation, CONFIG.RAW_MAX_VALUE_CHARS);
      if (location) raw.tag_location = location;
      if (upcType) raw.upc_type = upcType;
      // The printed produce-code text, kept whenever it did not become the
      // UPC (a PLU printed in the article-number slot, say).
      if (pluRaw) raw.plu_raw = pluRaw;
      if (unitPrice !== null) {
        raw.unit_price = { printed: formatPrice(unitPrice), per: String(label.unitPriceBasis || '').trim() };
        if (unitCheck) raw.unit_price.check = unitCheck;
      }
      if (label.organic === true) raw.organic = true;

      const priceStrings = buildPriceStrings(label.rawPriceStrings);
      if (priceStrings) raw.raw_price_strings = priceStrings;

      const confidence = buildConfidence(label.confidence);
      if (confidence) raw.confidence = confidence;

      const extras = Array.isArray(label.extras) ? label.extras : [];
      let written = 0;
      for (const extra of extras) {
        if (!extra || isBlank(extra.key) || isBlank(extra.value)) continue;
        if (written >= CONFIG.RAW_MAX_EXTRAS) break;
        const key = String(extra.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!key || raw[key] !== undefined) continue;
        raw[key] = String(extra.value).trim().slice(0, CONFIG.RAW_MAX_VALUE_CHARS);
        written++;
      }

      // Last, and under its own budget: the extras caps above would behead
      // an ingredient list. "packaging" is a reserved key, so an extra
      // that happened to be called "packaging" cannot displace it.
      if (packaging) {
        raw.packaging = packaging;
        if (CONFIG.RAW_MAX_TOTAL_CHARS > 0) {
          const withPackaging = JSON.stringify(raw);
          if (withPackaging.length > CONFIG.RAW_MAX_TOTAL_CHARS) {
            // Cutting the JSON would leave the cell unparseable, so the
            // whole block goes rather than half of it. The tag survives.
            console.warn(`Packaging dropped - RAW_DATA_JSON would be ${withPackaging.length} chars, over the ${CONFIG.RAW_MAX_TOTAL_CHARS} limit`);
            delete raw.packaging;
          }
        }
      }

      return Object.keys(raw).length > 0 ? JSON.stringify(raw) : '';
    }

    // -----------------------------------------------------------------
    // Rows
    // -----------------------------------------------------------------

    const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, thoughtsTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0 };

    // ISO 8601 in UTC to the second: 2026-10-28T14:05:09Z.
    function nowStamp() {
      return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    function hasPrice(label) {
      return !!label && (parsePrice(label.regularPrice) !== null || parsePrice(label.promoPrice) !== null ||
        parsePrice(label.loyaltyPrice) !== null);
    }

    function baseRow(imagesInput, imageUrl, lastSeen, country, currency, usage, multiple, clean) {
      return {
        images: imagesInput,
        UPC: '',
        SKU: '',
        DESCRIPTION: '',
        BRAND: '',
        ITEM_SIZE: '',
        ITEM_UOFM: '',
        ITEM_SIZE_UOFM: '',
        IMAGE_URL: imageUrl,
        COUNTRY: country,
        CURRENCY: currency,
        CATEGORY_L1: '',
        CATEGORY_L2: '',
        CATEGORY_L3: '',
        REG_MULTIPLE: '',
        REG_PRICE: '',
        PROMO_MULTIPLE: '',
        PROMO_PRICE: '',
        LOYALTY_MULTIPLE: '',
        LOYALTY_PRICE: '',
        LAST_SEEN: lastSeen,
        RAW_DATA_JSON: '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtsTokens: usage.thoughtsTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
        MultipleProducts: multiple,
        clean: clean
      };
    }

    // One output row.
    function buildRow(label, ctx, usage, multiple, packaging) {
      const detected = normalizeCountry(label.country);
      const country = (ctx.pinnedCountry && (CONFIG.COUNTRY_OVERRIDES_MODEL || !detected))
        ? ctx.pinnedCountry
        : detected;
      if (ctx.pinnedCountry && detected && detected !== ctx.pinnedCountry) {
        console.warn(`Tag reads as ${detected} but the agent is pinned to ${ctx.pinnedCountry}`);
      }

      const row = baseRow(ctx.imagesInput, ctx.imageUrl, ctx.lastSeen, country,
        resolveCurrency(label.currency, country), usage, multiple, 'Clean');

      const regular = parsePrice(label.regularPrice);
      const promo = parsePrice(label.promoPrice);
      row.REG_PRICE = formatPrice(regular);
      row.REG_MULTIPLE = parseMultiple(label.regularMultiple, regular !== null);
      row.PROMO_PRICE = formatPrice(promo);
      row.PROMO_MULTIPLE = parseMultiple(label.promoMultiple, promo !== null);
      const loyalty = parsePrice(label.loyaltyPrice);
      row.LOYALTY_PRICE = formatPrice(loyalty);
      row.LOYALTY_MULTIPLE = parseMultiple(label.loyaltyMultiple, loyalty !== null);

      const brand = displayCase(label.brand);
      row.BRAND = brand;
      row.DESCRIPTION = buildDescription(brand, displayCase(label.name));

      const size = parseQuantity(label.itemSize);
      const uom = normalizeUom(label.itemUom);
      row.ITEM_SIZE = size === null ? '' : String(size);
      row.ITEM_UOFM = size === null ? '' : uom;
      row.ITEM_SIZE_UOFM = size === null ? '' : (uom ? `${size} ${uom}` : String(size));

      // A PLU the model filed as the article number is moved to UPC, and a
      // number that is the PLU is never also shipped as the SKU. A PLU too
      // short to ship still blocks the SKU: the tag said that number is a
      // produce code, so it is not an article number either.
      const pluInId = labelledPlu(label.productId);
      let upc = normalizeUpc(label.upc);
      if (!upc.value && pluInId.value) upc = { value: pluInId.value, type: 'plu', raw: pluInId.raw };
      if (!upc.value && !upc.raw && pluInId.raw) upc = { value: '', type: '', raw: pluInId.raw };
      row.UPC = upc.value;
      row.SKU = pluInId.raw ? '' : resolveSku(label);
      if (upc.type === 'plu' && row.SKU === upc.value.replace(/\D/g, '')) row.SKU = '';

      const unitPrice = parsePrice(label.unitPrice);
      const prices = [];
      if (regular !== null) prices.push({ price: regular, multiple: Number(row.REG_MULTIPLE) });
      if (promo !== null) prices.push({ price: promo, multiple: Number(row.PROMO_MULTIPLE) });
      if (loyalty !== null) prices.push({ price: loyalty, multiple: Number(row.LOYALTY_MULTIPLE) });
      const unitCheck = checkUnitPrice(prices, size, uom, unitPrice, label.unitPriceBasis, packCountOf(label));
      if (unitCheck === 'mismatch') {
        console.warn(`Unit price ${label.unitPrice}/${label.unitPriceBasis} does not match ${label.regularPrice || label.promoPrice || label.loyaltyPrice} for ${label.itemSize}${label.itemUom} - "${row.DESCRIPTION}"`);
        // One of price, size or unit price was misread, and the code cannot
        // tell which - so nothing is blanked, but the row stops claiming to
        // be Clean. On the test run this caught a price invented for a
        // label cut off by the frame (2.99 for a 9.99 Calvados).
        if (CONFIG.UNIT_PRICE_MISMATCH_FLAG) row.clean = CONFIG.UNIT_PRICE_MISMATCH_FLAG;
      }

      row.RAW_DATA_JSON = buildRawJson(label, unitPrice, unitCheck, upc.type, packaging,
        upc.raw && upc.raw !== row.UPC ? upc.raw : '');

      return row;
    }

    // -----------------------------------------------------------------
    // Main
    // -----------------------------------------------------------------

    const lastSeen = nowStamp();

    // Loaded from GitHub by aldi-sud.loader.js, Mozenda never fills the
    // placeholders in this file, so the loader passes the filled inputs in
    // window.MOZENDA_INPUTS. Pasted into the agent directly, that object is
    // absent and the placeholders below are filled as before.
    const agentInputs = (typeof window !== 'undefined' && window.MOZENDA_INPUTS) || {};

    // Optional market pin. Add a Country input to the Mozenda agent to
    // use it; an unfilled placeholder is ignored.
    const pinnedCountry = normalizeCountry(readAgentInput('Country' in agentInputs ? agentInputs.Country : '%Country%') || CONFIG.DEFAULT_COUNTRY);
    if (pinnedCountry) console.log(`Market pinned to ${pinnedCountry}`);
    const pinnedCurrency = COUNTRY_CURRENCY[pinnedCountry] || '';

    // ONE image per run. The input is still split on "|" because Mozenda
    // has delivered a pipe-separated list before; anything past the first
    // link is ignored rather than silently changing what was read.
    const imagesInput = readAgentInput('imageURL' in agentInputs ? agentInputs.imageURL : '%imageURL%');
    const links = imagesInput.split('|').map(url => url.trim()).filter(url => url);
    if (links.length > 1) {
      console.warn(`The imageURL input carried ${links.length} links - only the first is read`);
    }
    const imageUrl = links[0] || '';

    if (!imageUrl) {
      console.error('No image URL in the imageURL input');
      M_SetFieldValues(baseRow(imagesInput, '', lastSeen, pinnedCountry, pinnedCurrency, EMPTY_USAGE, 'no', 'Error'));
      M_StopWaiting();
      return;
    }

    let extraction;
    try {
      extraction = await extractProductInfo(imageUrl, apiKeyValue, pinnedCountry);
    } catch (error) {
      console.error(`Extraction error: ${error.message}`);
      if (CONFIG.STOP_ON_EXTRACTION_ERROR) {
        // The call failed, so we did not learn that the shelf was empty -
        // we learned nothing. Writing a row would record a non-result as a
        // result and make the item look processed, so it goes back to
        // Mozenda as a failed item instead.
        M_StopWithError('Extraction Error', error.message);
        return;
      }
      M_SetFieldValues(baseRow(imagesInput, imageUrl, lastSeen, pinnedCountry, pinnedCurrency, EMPTY_USAGE, 'no', 'Error'));
      M_StopWaiting();
      return;
    }

    // tagIndex counts positions in the array the MODEL returned, so
    // binding happens before the no-price tags are filtered out. Filtering
    // first would shift every index by the number of skipped tags.
    const allLabels = Array.isArray(extraction.labels) ? extraction.labels : [];
    const boundPackages = bindPackages(extraction.packages, allLabels);

    // One physical tag, one row. The prompt makes the model name each tag's
    // place on the fixture before reading it, which gives a dedup key that
    // does not depend on the product: two genuinely different tags can carry
    // the same name, price and size (a honey sold in a bottle and a jar),
    // and those must both survive - but one tag read twice cannot.
    const seenLocations = new Set();

    const kept = [];
    allLabels.forEach((label, index) => {
      if (!hasPrice(label)) return;

      const location = String(label.tagLocation || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (location) {
        if (seenLocations.has(location)) {
          console.warn(`Row dropped - "${label.tagLocation}" was already written, so this is the same tag read twice`);
          return;
        }
        seenLocations.add(location);
      }

      // costco.js's rule, off by default - see CONFIG.
      if (CONFIG.REQUIRE_ID_WITH_PRICE && !resolveSku(label)) {
        console.log(`Row dropped - no readable article number on "${label.name || 'unnamed tag'}"`);
        return;
      }
      kept.push({ label, packaging: boundPackages.get(index) || null });
    });

    const labels = kept.map(entry => entry.label);
    const usage = extraction.usage || EMPTY_USAGE;

    if (boundPackages.size > 0) {
      const landed = kept.filter(entry => entry.packaging).length;
      console.log(`Packaging bound to ${landed} of ${kept.length} row(s)`);
      if (landed < boundPackages.size) {
        console.warn(`${boundPackages.size - landed} package(s) were bound to a tag that produced no row and are discarded with it`);
      }
    }

    if (labels.length === 0) {
      console.log('No tag with a readable price');
      M_SetFieldValues(baseRow(imagesInput, imageUrl, lastSeen, pinnedCountry, pinnedCurrency, usage, 'no', 'Clean'));
      M_StopWaiting();
      return;
    }

    // Split the call's cost equally across the rows it produced.
    const count = labels.length;
    const split = {
      inputTokens: Math.round(usage.inputTokens / count),
      outputTokens: Math.round(usage.outputTokens / count),
      thoughtsTokens: Math.round(usage.thoughtsTokens / count),
      cachedTokens: Math.round(usage.cachedTokens / count),
      totalTokens: Math.round(usage.totalTokens / count),
      cost: parseFloat((usage.cost / count).toFixed(6))
    };

    const ctx = { imagesInput, imageUrl, lastSeen, pinnedCountry };
    const rows = kept.map(entry => buildRow(entry.label, ctx, split, count > 1 ? 'yes' : 'no', entry.packaging));
    console.log(`Found ${rows.length} product(s)`);

    // A wide shelf shot: the article numbers are too small to resolve, and
    // the frames that fabricated them all carried this many tags or more.
    if (CONFIG.SKU_MAX_TAGS_IN_FRAME > 0 && allLabels.length > CONFIG.SKU_MAX_TAGS_IN_FRAME) {
      const withSku = rows.filter(row => row.SKU).length;
      if (withSku > 0) console.warn(`Dropping ${withSku} SKU(s) - ${allLabels.length} tags in frame, limit ${CONFIG.SKU_MAX_TAGS_IN_FRAME}`);
      rows.forEach(row => { row.SKU = ''; });
    }

    if (CONFIG.SKU_REJECT_PATTERNED) {
      const skus = rows.map(row => row.SKU).filter(Boolean);
      const patterned = skus.some((a, i) => skus.slice(i + 1).some(b =>
        a !== b && a.length === b.length &&
        (Math.abs(Number(a) - Number(b)) === 1 || a.slice(0, -1) === b.slice(0, -1))));
      if (patterned) {
        console.warn(`Dropping ${skus.length} SKU(s) - the numbers run in a sequence (${skus.join(', ')})`);
        rows.forEach(row => { row.SKU = ''; });
      }
    }

    // Every tag has its own article number, so one repeated across rows
    // was copied rather than read. The prompt asks for null; this enforces
    // it.
    const skuCount = {};
    rows.forEach(row => { if (row.SKU) skuCount[row.SKU] = (skuCount[row.SKU] || 0) + 1; });
    rows.forEach(row => {
      if (skuCount[row.SKU] > 1) {
        console.warn(`Dropping SKU ${row.SKU} - it appears on ${skuCount[row.SKU]} rows`);
        row.SKU = '';
      }
    });

    M_SetFieldValues(rows.length === 1 ? rows[0] : rows);
    M_StopWaiting();

  } catch (error) {
    console.error('Script error:', error);
    M_StopWithError('Script Error', error.message);
  }
})();
