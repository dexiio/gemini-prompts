/* =====================================================================
 * lidl.js - LIDL Germany shelf-tag extractor
 * ---------------------------------------------------------------------
 * 2026-09-30 - SAME CHANGES AS aldi-sud.js
 *   - gemini-3.7-flash, no thinkingConfig, temperature 0, media
 *     resolution HIGH.
 *   - Germany only: the model is no longer asked for a country or
 *     currency; CONFIG.DEFAULT_COUNTRY = 'DE' fills both.
 *   - Article number: an uncertain digit is written as "?", a second
 *     right-to-left reading (productIdCheck) must agree, and a group with
 *     a letter in it is rejected instead of "repaired" (B -> 8).
 *   - Unit-price check accepts multipacks; a mismatch sets clean to
 *     CONFIG.UNIT_PRICE_MISMATCH_FLAG.
 *   - No literal percent signs except the two real Mozenda inputs.
 *   Article numbers keep the 4-8 digit range (not fixed to 7).
 * ---------------------------------------------------------------------
 * Same logic, same prompt register and same code as aldi.js - short
 * numbered rules, one line each, imperative. Only the parts that are
 * genuinely Lidl differ: the tag layout, Lidl Plus, the BILLIGER / BIO
 * bubble, advertising panels in the rail, freezer glass, the markets and
 * currencies, the article number beside the square code, and the
 * direction of the fixtures. Keep the two files in step: a fix to the
 * shared logic belongs in both.
 *
 * WHAT IS SHARED WITH aldi.js
 *   - the output columns, exactly as before (see baseRow)
 *   - every normalization helper: parsePrice, normalizeSku, normalizeUpc,
 *     labelledPlu, checkUnitPrice, resolveCurrency, checkBind,
 *     tagIndexBase, resolveSku
 *   - RAW_DATA_JSON, including "tag_location" and the "packaging" block
 *   - the reading order (below), the tagLocation dedup, the printed-token
 *     check on the article number, ONE image per run
 *
 * THE LIDL TAG (Lidl Germany electronic shelf label, verified Sept 2026)
 *
 *     DULANO                              <- brand line
 *     Hähnchenbrust Paprika/Curry         <- product name
 *     verschiedene Sorten                 <- variant (optional)
 *     100 g Packung                       <- size + package
 *     [code] 0080987 1M   1 kg = 15.90   1.59
 *            ^article ^not part  ^unit    ^price
 *
 *   Promo tags carry a "BILLIGER" or "-13 percent" speech bubble next to a
 *   struck-through old price, often in inverted colours. The same bubble
 *   reading "BIO" is an organic flag, NOT a discount.
 *
 * LOYALTY
 *   Lidl Plus app prices go to LOYALTY_PRICE / LOYALTY_MULTIPLE. Confirmed
 *   on a produce label: "Ohne Lidl Plus 2.22" beside a red panel reading
 *   1.99 and "-10 percent gunstiger mit der Lidl Plus App". The left number is
 *   REG_PRICE, the gated one LOYALTY_PRICE.
 *
 * ARTICLE NUMBER
 *   7 digits under or beside the square code, sometimes with a prefix
 *   ("36/0080987") - normalizeSku picks the 7-digit group by length. On
 *   top of the shared procedure, Lidl keeps its measured tag-count rule:
 *   every sample frame with more than SKU_MAX_TAGS_IN_FRAME tags produced
 *   invented numbers, so the prompt nulls the article number there.
 *
 * TWO JOBS IN ONE CALL
 *   SECTION A reads the TAGS and nothing else.
 *   SECTION B reads the printed PANELS on the packages and returns no
 *   price. SECTION C binds one to the other. The result lands INSIDE
 *   RAW_DATA_JSON under "packaging", never in a column of its own, and
 *   only when the model says "high" AND checkBind() agrees.
 *   CONFIG.PACKAGING_ENABLED = false removes B and C from the prompt,
 *   the schema and the row.
 *
 *   In the sample photos the Lidl tag rail sat ABOVE the goods it prices,
 *   the opposite of ALDI - but that is one store on one visit, so the
 *   prompt states it as a tendency only and the bind is gated on a
 *   PRINTED detail matching. Being wrong about the direction costs
 *   coverage, not correctness.
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
 *   longer be a rationalisation of a number already written.
 *   productIdPrinted is the whole token read character by character;
 *   productId must be derivable from it or the code drops both.
 *
 * ONE IMAGE PER RUN
 *   The agent sends a single photo, so there is no image selection, no
 *   "IMAGE 1" numbering and no imageIndex on a row. If the imageURL input ever
 *   carries a pipe-separated list, the first link is read and the rest
 *   are ignored with a warning.
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
      // Same model and settings as aldi-sud.js since 2026-09-30. No
      // thinkingConfig is sent, so the model uses its own default.
      MODEL: 'gemini-3.8-flash',
      // 0: always the most likely reading, so the same tag reads the same
      // way on every photo.
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

      // Germany only since 2026-09-30. The prompt no longer asks the model
      // for a country or currency, so this pin fills both columns. A
      // Country agent input still wins over it.
      DEFAULT_COUNTRY: 'DE',
      COUNTRY_OVERRIDES_MODEL: true,

      // A retailer article number is short. Lidl Germany prints 7.
      SKU_MIN_DIGITS: 4,
      SKU_MAX_DIGITS: 8,

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
      // reveal that - only the photo can. (The ALDI token is shown; a Lidl
      // token reads "0080987" or "36/0080987".)
      SKU_REQUIRE_PRINTED_TOKEN: false,

      // Unit-price check tolerance: the larger of the two.
      UNIT_PRICE_TOLERANCE_ABS: 0.02,
      UNIT_PRICE_TOLERANCE_PCT: 0.02,

      // What the "clean" column says when price / size does not reproduce
      // the printed unit price. '' = keep "Clean" and only log it.
      UNIT_PRICE_MISMATCH_FLAG: 'Check',

      // LIDL-SPECIFIC, and used in the prompt. Above this many tags in one
      // frame the article numbers are too small to resolve, so the prompt
      // tells the model not to attempt them. Every Lidl sample frame above
      // this count produced invented numbers; every frame below it produced
      // plausible ones. (aldi.js keeps 12 as an unused backstop - the Lidl
      // number sits beside the square code in far smaller print.)
      SKU_MAX_TAGS_IN_FRAME: 6,

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

    // Every market Lidl trades in. Bulgaria has been on the euro since
    // 1 Jan 2026; lev prices still printed beside it go to extras.
    const COUNTRY_CURRENCY = {
      DE: 'EUR', AT: 'EUR', BE: 'EUR', NL: 'EUR', LU: 'EUR', FR: 'EUR',
      IE: 'EUR', ES: 'EUR', PT: 'EUR', IT: 'EUR', MT: 'EUR', CY: 'EUR',
      GR: 'EUR', SK: 'EUR', SI: 'EUR', HR: 'EUR', LT: 'EUR', LV: 'EUR',
      EE: 'EUR', FI: 'EUR', BG: 'EUR',
      CH: 'CHF', GB: 'GBP', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
      RS: 'RSD', DK: 'DKK', SE: 'SEK', US: 'USD'
    };

    // Printed symbol -> ISO-4217. "kr" is left out on purpose: it is
    // Denmark or Sweden, resolved by the country (see resolveCurrency).
    const CURRENCY_SYMBOLS = {
      '€': 'EUR', eur: 'EUR', euro: 'EUR',
      '£': 'GBP', gbp: 'GBP', p: 'GBP',
      chf: 'CHF', fr: 'CHF', 'fr.': 'CHF', sfr: 'CHF',
      'zł': 'PLN', zl: 'PLN', pln: 'PLN',
      'kč': 'CZK', kc: 'CZK', czk: 'CZK',
      ft: 'HUF', huf: 'HUF',
      lei: 'RON', ron: 'RON',
      din: 'RSD', rsd: 'RSD',
      'лв': 'BGN', 'лв.': 'BGN', bgn: 'BGN',
      dkk: 'DKK', sek: 'SEK',
      '$': 'USD', usd: 'USD', '¢': 'USD'
    };
    const AMBIGUOUS_CURRENCY = { kr: ['DK', 'SE'], 'kr.': ['DK', 'SE'] };

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
        ? '\n5. A tag whose article number will not resolve is SKIPPED entirely'
        : '';

      return `
HOW TO WORK - once, in this order:
1. LOCATE - scan the photo top shelf to bottom, left to right, and give every tag a location: "shelf 2 from top, tag 3 from left". That location is the tag's identity
2. READ - take each tag in turn and read ONLY what is printed inside that tag's own border
3. GRADE - say how well you could read it, BEFORE you report the small print
4. MOVE ON - carry nothing forward to the next tag

FOUR RULES
1. ONE PHYSICAL TAG = ONE ROW. Every tag with a readable price gets exactly one row, and no two rows share a location
2. A tag with NO readable price is skipped
3. NEVER take a value from a neighbouring tag, from the packaging behind the tag, or from what you already know about the product
4. null IS A CORRECT ANSWER. A row with gaps is right; a row completed by guessing is wrong${idRule}

NOT EVERY PANEL IN THE RAIL IS A TAG
Lidl mounts advertising panels in the same rails, the same size and style as a real tag - most often a "Lidl Punkte" / "Lidl Plus" panel reading "sammeln & noch mehr sparen" with an app logo and a lidl.de URL. It has NO price and NO product: it is NOT a row, and you never invent a price for it. The same goes for shelf-talkers, category headers and "Deutschlands Nr. 1 für Wein" style banners

SHOT THROUGH GLASS
Freezer and chiller doors reflect the aisle lights back at the camera. Digits under a reflection are NOT readable, however plausible a guess looks. Return null for whatever the glare covers and keep the fields you can genuinely read. A partly-read price is not a price

THE TAG
One electronic label (sometimes a printed card) in a rail. Lidl Germany prints:

   DULANO                                  <- brand, small capitals, top-left
   Hähnchenbrust                           <- product name, 1-2 bold lines
   Paprika/Curry
   verschiedene Sorten                     <- variant line (optional)
   100 g Packung                           <- size + package
   [code]  0080987  1M    1 kg = 15.90     1.59
           ^article ^not part ^unit price  ^price, large, bottom-right

Large PORTRAIT tags on top shelves print the same fields: brand, name and size at the top, the big price below, unit price and article number at the bottom.
- PROMO tags put a speech bubble ("BILLIGER", "-13${PCT}") beside a smaller STRUCK-THROUGH old price, and are often printed INVERTED - white text on dark red
- The same speech bubble reading "BIO" is an ORGANIC mark, NOT a discount
- LOOSE PRODUCE tags print "PLU" and a short number ("PLU541") under the square code INSTEAD of an article number

FIELDS, in the order you will write them:

1. "tagLocation" - where this tag is, as above. Write it FIRST, before reading anything on the tag

2. "brand" - the small uppercase line at the top-left ("DULANO", "MARIBEL", "MISTER CHOC", "METZGERFRISCH", "VEMONDO"), exactly as printed. null if there is none
   "name" - the bold line(s) under it, exactly as printed, in its own language. A name broken over two lines is joined with a space ("Hähnchenbrust" + "Paprika/Curry" -> "Hähnchenbrust Paprika/Curry"; "Schoko-" + "Fruchtaufstrich" -> "Schoko-Fruchtaufstrich"). Never translate it, never put the brand in it
   - The thin VARIANT line under the name ("verschiedene Sorten", "creamy/crunchy", "Erdbeere/Kirsche/Aprikose", "z.B. Paprika Trio") is NOT part of the name -> extras "variant"

3. PRICES - the cents are printed smaller and raised: a big "1" with a small "59" is "1.59". Read every digit left to right - do not drop the first one. Return a dot decimal with no symbol: "1,59" -> "1.59". "-.99" is "0.99", "7.-" and "7,-" are "7.00"
   - ONE price -> "regularPrice"
   - A STRUCK-THROUGH old price beside a "BILLIGER" / "-13${PCT}" bubble, or beside other discount wording ("Angebot", "Aktion", "Rabatt") -> the old price is "regularPrice" and the big current price is "promoPrice"
   - ONE price with a printed discount and no old price -> "promoPrice", regularPrice null
   - A "BIO" bubble and "NEU" are NOT discounts
   - LOYALTY is a price the tag GATES behind something the shopper must present. At Lidl that is LIDL PLUS: a price marked "Lidl Plus", "mit Lidl Plus", "Lidl Plus Preis" or shown beside the Lidl Plus app logo -> "loyaltyPrice". The price for everyone else on the same tag ("Ohne Lidl Plus 2.22") is "regularPrice", or "promoPrice" if it is itself discounted. No printed gate means not loyalty
   - MULTI-BUY ("2 für 3.00", "ab 2 Stück je 0.99", "1+1 gratis") -> the price is the TOTAL for the quantity and the count goes in that lane's multiple: "ab 2 Stück je 0.99" -> "1.98" with multiple "2"; "1+1 gratis" on a 1.49 item -> "1.49" with multiple "2". A single-item price has multiple "1"
   - The badge text ("BILLIGER", "-13${PCT}", "Lidl Plus", "1+1 gratis") -> extras "promo_badge"

4. "unitPrice" / "unitPriceBasis" - the small comparison price next to the big price: "1 kg = 15.90" -> "15.90" and "1 kg"; "100 g = 0.76" -> "0.76" and "100 g"; "1 kg = 7.-" -> "7.00" and "1 kg"
   - READ it off the tag. NEVER divide the price by the size to produce one
   - Several bases for a variable pack ("1 kg = 15.51 / 13.96", "7,83/8,19/8,31/kg") -> null, and put the whole string in extras as "unit_price_text"
   - It NEVER goes in a price field. If the only number you can read on a tag is a unit price, that tag has no shelf price - skip it

5. "itemSize" / "itemUom" - the net quantity of ONE item, from the size line: "100 g Packung" -> "100" and "g"
   - The word after it ("Packung", "Glas", "Flasche", "Becher", "Dose", "Beutel") is the package -> extras "package"
   - "versch. Größen z.B. 220g" -> the example size "220" and "g", plus the whole line in extras "size_note"
   - A MULTIPACK ("6x120 ml") -> the COMPONENT is the size: "120" and "ml", plus extras "pack_printed" = "6x120 ml". When a total is also printed ("2 x 200 ml = 400 ml"), add extras "total_size_printed" = "400 ml"
   - SEVERAL ALTERNATIVE SIZES ("225/250 g Packung", "395/360/377 g") -> both null, plus extras "size_variants"
   - Never take a size from the packaging

6. "rawPriceStrings" - the PRICE tokens on this tag, copied exactly as printed and untidied: ["1,49", "1,39", "1 kg = 17.38", "-13${PCT}"]. Keep the comma, the symbol and the "1 kg =" prefix
   - PRICES ONLY. The article number, a PLU and barcode digits do NOT belong here
   - COPY, NEVER RECONSTRUCT. A token you can see but cannot fully read is left out

7. "confidence" - four honest grades, each "high", "medium" or "low". You write these BEFORE the small print below, so grade what you actually saw:
   "description" (brand, name) | "price" (every price field) | "size" (itemSize, itemUom) | "identifiers" (productId, upc)
   - "high" ONLY when the characters are plainly legible
   - "medium" when you are fairly sure but would not stake the row on it
   - "low" for glare or a reflection through freezer or chiller glass, an oblique angle, blur, faint or tiny print, a crowded label strip, or a value you pieced together
   - The article number is the smallest print on the tag, so "identifiers" is routinely lower than "price". That is the expected and useful answer, not a failure
   - These grades REPORT how the reading went. They do not decide what you fill in: a "medium" here does not empty a field you genuinely read

8. THE ARTICLE NUMBER - the tiny digits under or beside the square code (QR / DataMatrix) at the bottom-left, usually 7 ("0080987", "0128071"). A wrong one is worse than none, because it attaches this price to a different product. So read it, or say you could not - but do not approximate it.
   COUNT THE TAGS FIRST. If this image shows MORE THAN ${CONFIG.SKU_MAX_TAGS_IN_FRAME} tags it is a wide shelf shot: the article numbers are physically too small to resolve, so "productIdPrinted", "productIdCheck" and "productId" are null on EVERY row and you do not attempt them. Apply this by counting, not by how readable the digits feel
   "productIdPrinted" - what you actually see there, copied as printed, including a prefix and its separator when there is one: "36/0080987", or just "0080987". The short code a little to its right ("1M", "2M", "4T", "1M P") is NOT part of it - leave it out. Read the digits one at a time, left to right, naming each one to yourself. Write "?" in place of EVERY digit that will not resolve and keep the others (for the example tag above: "00809?7"). A "?" is a correct, useful answer - it is not a failure. null only when you cannot see the number at all
   "productIdCheck" - read the same digits a SECOND time, this time starting from the RIGHT end and moving left, one digit at a time, looking at each digit again rather than copying "productIdPrinted". Write the result in normal left-to-right order ("0080987"), with "?" for any digit that will not resolve
   "productId" - the 7-digit article number alone: "36/0080987" -> "0080987". Keep leading zeros - "0080987" is not "80987". ONLY when "productIdPrinted" and "productIdCheck" contain no "?" and agree digit for digit - otherwise null
   - A digit you settled on because it "looks like" one, or because it matches the shape of the numbers on the neighbouring tags, was not read - write it as "?"
   - LOOK-ALIKES: 5/8, 6/8, 3/8, 3/5, 5/6, 0/8, 8/9, 0/6, 1/7, 1/4, 2/7. If a digit could be either of a pair, it is "?" - even if one seems more likely
   - NULL ON EVERY ROW if the numbers across tags run in a sequence ("0070700", "0070701"), share a long leading run of digits, or repeat
   - A handling code printed beside it ("STE, R", "STE,R,ANK", "4C") is NOT the article number and NOT a PLU -> extras "tag_code"
   - The square code itself cannot be decoded and is NOT an identifier -> extras "has_qr" = "true"
   - NEVER from the packaging

9. "upc" - LIDL TAGS HAVE NO READABLE BARCODE. null unless the TAG ITSELF prints one of these:
    - a barcode's full digits, all 8, 12 or 13 of them
    - a number the tag labels "PLU", returned exactly as printed including the word ("PLU541"). Lidl's own are short - never pad them
    - an unlabelled produce PLU: 4 digits from 3000-4999, or 5 digits starting with 9
    A PLU NEVER goes in productId. Barcodes on the packs behind the tag and PLU stickers on loose fruit are not the tag

10. "organic" - true only when the tag shows a "BIO" bubble or badge, or an organic control code ("DE-ÖKO-006")

11. "extras" - anything else printed on THIS tag, as {"key","value"}, values exactly as printed:
    "variant", "package", "size_note", "pack_printed", "size_variants", "promo_badge", "tag_code", "has_qr" as above, and "vegan" ("yes" for the round V-label or "VEGAN"), "test_rating" ("ÖKO-TEST sehr gut", "Stiftung Warentest gut 2,1"), "grade" ("Klasse: I" -> "I"), "origin", "variety", "promo_valid_text" (a validity window: "21.09.2026 - 27.09.2026", "gültig bis 04.10."), "label_type" ("esl_eink", "paper", "handwritten", "produce_sign")
    PFAND is never added to or subtracted from the price: "pfand" (the number alone), "pfand_text" (as printed), "pfand_included" ("true" for "inkl.", "false" for "zzgl."), "pfand_type" ("EINWEG" / "MEHRWEG")

BEFORE YOU ANSWER
1. Two rows with the same tagLocation -> you read one tag twice. Keep one
2. A tag you can see in the photo but did not write -> write it now, or confirm it has no readable price or is an advertising panel
3. The same productId on two rows, or productIds that count up -> set every one of them to null
4. Any value you cannot point to on its own tag -> null

"tags" is a JSON ARRAY, one object per tag with a readable price, in the order you located them. [] if no tag has one. Numbers as strings, dot decimal, no symbol.

EXAMPLES. The first two are the same tag - which one you write depends only on whether the article number resolved.

Read it (a close-up of three tags):
{"tagLocation":"shelf 1 from top, tag 2 from left","brand":"DULANO","name":"Hähnchenbrust Paprika/Curry","regularPrice":"1.59","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"15.90","unitPriceBasis":"1 kg","itemSize":"100","itemUom":"g","rawPriceStrings":["1.59","1 kg = 15.90"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"high"},"productIdPrinted":"0080987","productIdCheck":"0080987","productId":"0080987","upc":null,"organic":false,"extras":[{"key":"variant","value":"verschiedene Sorten"},{"key":"package","value":"Packung"},{"key":"has_qr","value":"true"},{"key":"label_type","value":"esl_eink"}]}

Same tag, poorer light - the sixth digit could be an 8 or a 3, so it is "?" and the article number is not captured. The row is still worth returning:
{"tagLocation":"shelf 1 from top, tag 2 from left","brand":"DULANO","name":"Hähnchenbrust Paprika/Curry","regularPrice":"1.59","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"15.90","unitPriceBasis":"1 kg","itemSize":"100","itemUom":"g","rawPriceStrings":["1.59","1 kg = 15.90"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"low"},"productIdPrinted":"00809?7","productIdCheck":"00809?7","productId":null,"upc":null,"organic":false,"extras":[{"key":"variant","value":"verschiedene Sorten"},{"key":"package","value":"Packung"},{"key":"has_qr","value":"true"},{"key":"label_type","value":"esl_eink"}]}

Promo tag - "BILLIGER" bubble, old price 1.49 struck through, big price 1.39:
{"tagLocation":"shelf 2 from top, tag 1 from left","brand":"DULANO","name":"Gebackene Hähnchenbrust","regularPrice":"1.49","regularMultiple":"1","promoPrice":"1.39","promoMultiple":"1","loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"17.38","unitPriceBasis":"1 kg","itemSize":"80","itemUom":"g","rawPriceStrings":["1.49","1.39","1 kg = 17.38"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"low"},"productIdPrinted":null,"productIdCheck":null,"productId":null,"upc":null,"organic":false,"extras":[{"key":"variant","value":"verschiedene Sorten"},{"key":"package","value":"Packung"},{"key":"promo_badge","value":"BILLIGER"},{"key":"label_type","value":"esl_eink"}]}

Loose produce - "Nektarinen" / "Sorte: gelbfleischig, Klasse: I" / "Ursprung: siehe Artikel" / "1 kg", "STE,R,ANK" and "PLU541" beside the square code, "1 kg = 1.89", big price 1.89, no brand line:
{"tagLocation":"shelf 1 from top, tag 1 from left","brand":null,"name":"Nektarinen","regularPrice":"1.89","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":"1.89","unitPriceBasis":"1 kg","itemSize":"1","itemUom":"kg","rawPriceStrings":["1.89","1 kg = 1.89"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"high"},"productIdPrinted":null,"productIdCheck":null,"productId":null,"upc":"PLU541","organic":false,"extras":[{"key":"variety","value":"gelbfleischig"},{"key":"grade","value":"I"},{"key":"origin","value":"siehe Artikel"},{"key":"tag_code","value":"STE,R,ANK"},{"key":"has_qr","value":"true"},{"key":"label_type","value":"produce_sign"}]}`;
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
2. YOUR PRODUCT KNOWLEDGE IS FORBIDDEN AS A SOURCE. You will recognise many of these (Iglo, Ocean Sea, Dulano, Milbona, Maribel, Schwartau, Bon Gelati, Deluxe, Chef Select, Cien). A recited ingredient list is indistinguishable from a read one, which is why it is banned
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
- The name and brand as printed ON THE PACK, and the net content ("400 g", "500 g e", "Nettogewicht: 400 g", "2 x 200 ml = 400 ml", "3 x 90 ml")
- NUTRI-SCORE - the A-B-C-D-E ladder with ONE letter enlarged. Return that letter as scoreValue and "E" as scaleMax. If you cannot tell which is highlighted, return no score at all
- German animal-welfare seals: "Haltungsform 1/2/3/4" with its wording ("Stall + Platz"), "Initiative Tierwohl"
- Sustainability marks common on Lidl chilled and frozen packs: "MSC", "ASC", "Rainforest Alliance", "Fairtrade"
- Organic marks: the green EU leaf, "BIO", a control code ("DE-ÖKO-044")
- Claims: "Ohne Konservierungsstoffe", "Laktosefrei", "ALKOHOLFREI", "NEU", "SCHÄRFE", "${PCT} Fett"
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
  * SALT vs SODIUM ARE TWO DIFFERENT NUTRIENTS and are NEVER converted into each other - salt weighs about 2.5x its sodium. Decide from the PRINTED WORD: "Salz"/"Salt"/"Sel"/"Sale"/"Sal"/"Zout" -> "Salt", "Natrium"/"Sodium"/"Sodio"/"Na" -> "Sodium". If the pack declares both, return both rows
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
    //
    // NOTE ON DIRECTION. In the Lidl sample photos the rail carrying a tag
    // sat ABOVE the products it prices - a tag reading "SCHWARTAU Samt
    // Fruchtaufstrich" hung over the Samt jars, with honey on the shelf
    // above it - the opposite of ALDI. That is ONE store's fixtures on one
    // visit, so the prompt states it as a tendency and the gate stays
    // CORROBORATION, not geometry.
    // -----------------------------------------------------------------

    function buildBindingSection() {
      return `

=============================================================
SECTION C - BINDING A PACKAGE TO ITS TAG
=============================================================
Every object in "packages" carries "tagIndex": the 1-BASED position, in the "tags" array you just built, of the tag that package is priced by. The first tag is 1, not 0. This is the ONLY link between the two sections.

HOW LIDL FIXTURES ARE ARRANGED - a tendency, NOT a rule:
On the Lidl gondolas and chillers seen so far the tag rail sits ABOVE the products it prices, so a tag tends to overhang its own goods and the products on the shelf ABOVE it belong to a DIFFERENT tag. Other retailers put the tag at the front-bottom edge of its own shelf, so direction alone is never evidence. It fails often: end caps, dump bins, wire baskets, produce crates and promotional pallets follow no consistent direction; electronic labels clip to wire shelves, freezer-door glass or a cabinet edge and can sit level with, above or below their product; a tall product overhangs the rail of the shelf below; a freezer door's rail may carry tags for goods in a different compartment.
So work out which FIXTURE each tag is attached to, and which products sit in THAT fixture. NEVER bind by pixel distance.

"bindBasis" - in a few words, what actually made you sure: "pack name matches the tag name", "net content matches the tag size", "only product in that compartment". "NEAREST TAG", "TAG ABOVE" AND "TAG BELOW" ARE NOT ACCEPTABLE ON THEIR OWN - if the nearest tag is all you have, you are not sure.

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
5. Two packages must never claim the same tagIndex - keep the better-read one, drop the other
6. SHOT THROUGH FREEZER OR CHILLER GLASS, reflections make both the tag and the pack unreliable. Bind only what you can read through the glare, and prefer an honest "low" to a hopeful "high"`;
    }

    function buildPrompt(pinnedCountry) {
      // Germany only: country and currency come from CONFIG.DEFAULT_COUNTRY.
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

      const intro = `You are an expert at reading the shelf tags of LIDL supermarkets in Germany. You will receive ONE image.
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
Return ONE JSON OBJECT with the single key "tags", in the order you located the tags. [] if no tag has a readable price. No markdown fences, no text outside the object.`;

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
          // The whole printed token, "36/0080987", read character by
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
    function normalizeSku(value) {
      if (isBlank(value)) return '';
      const groups = String(value).trim().split(/[\s|¦\/\\,;:]+/)
        // A group with a letter in it is never repaired (B -> 8, O -> 0):
        // a letter among the digits means the model was not sure, and a
        // repaired digit is a guess.
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
    // every tag in the reference photos (1.59 / 100 g = 15.90/kg, promo
    // tags included), so a mismatch almost always means one of the
    // numbers was misread.
    // Returns 'ok', 'mismatch', or '' when the units cannot be compared.
    // packCount is the n of a printed "n x m" multipack. itemSize holds the
    // COMPONENT, but the price and the unit price are for the whole pack,
    // so either reading is accepted.
    function checkUnitPrice(prices, size, uom, unitPrice, basis, packCount) {
      if (unitPrice === null || size === null || !basis || prices.length === 0) return '';
      const basisMatch = String(basis).trim().match(/^(\d+(?:[.,]\d+)?)?\s*(.+)$/);
      if (!basisMatch) return '';
      const basisQty = basisMatch[1] ? parseQuantity(basisMatch[1]) : 1;
      const itemUnit = UOM_FACTOR[uom];
      const basisUnit = UOM_FACTOR[normalizeUom(basisMatch[2])];
      if (!itemUnit || !basisUnit || itemUnit[0] !== basisUnit[0]) return '';

      const tolerance = Math.max(CONFIG.UNIT_PRICE_TOLERANCE_ABS, unitPrice * CONFIG.UNIT_PRICE_TOLERANCE_PCT);
      const sizes = packCount > 1 ? [size, size * packCount] : [size];
      const matches = prices.some(p => sizes.some(s => {
        const expected = (p.price / p.multiple) / (s * itemUnit[1]) * (basisQty * basisUnit[1]);
        return Math.abs(expected - unitPrice) <= tolerance;
      }));
      return matches ? 'ok' : 'mismatch';
    }

    // The n of a multipack, from the "pack_printed" extra ("6x120 ml").
    // 1 when there is none.
    function packCountOf(label) {
      const extras = Array.isArray(label.extras) ? label.extras : [];
      const pack = extras.find(extra => extra && String(extra.key || '').toLowerCase() === 'pack_printed');
      const match = pack ? String(pack.value || '').match(/(\d+)\s*[x×*]\s*\d/i) : null;
      const count = match ? Number(match[1]) : 1;
      return count > 1 ? count : 1;
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

    // The article number the row ships, from the token the model says it
    // read character by character.
    //
    // The prompt asks for BOTH "productIdPrinted" ("36/0080987") and the
    // cleaned "productId" ("0080987"). Two fields derived from one reading
    // must agree, so this refuses the pair when they do not: on the ALDI
    // photo that prompted the rewrite the model returned digits that were simply
    // not the ones on the tag, and nothing in the response contradicted
    // them. A cleaned value that does not appear in its own printed token
    // is the one form of that error the code CAN see.
    //
    // A response with no printed token falls back to the old behaviour, so
    // an older or truncated response still produces what it always did.
    function resolveSku(label) {
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

      // A "?" marks a digit the model could not confirm. Checked before
      // normalizeSku, which would otherwise strip it and - with the 4-8
      // digit range - ship the shortened number.
      if (printed.indexOf('?') !== -1) {
        console.log(`SKU withheld - "${printed}" has unconfirmed digits`);
        return '';
      }

      const sku = normalizeSku(printed);
      if (!sku) return '';

      // The second, right-to-left reading must agree digit for digit. The
      // reversed string counts too: the model sometimes WRITES the second
      // reading right to left. A response without the field is not held
      // to it.
      const check = cleanText(label.productIdCheck, CONFIG.RAW_MAX_VALUE_CHARS);
      if (check) {
        if (check.indexOf('?') !== -1) {
          console.log(`SKU withheld - second reading "${check}" has unconfirmed digits`);
          return '';
        }
        const checkSku = normalizeSku(check);
        const reversed = check.replace(/\D/g, '').split('').reverse().join('');
        if (checkSku !== sku && reversed !== sku) {
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
        // One of price, size or unit price was misread; nothing is blanked,
        // but the row stops claiming to be Clean.
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

    // Loaded from GitHub by lidl.loader.js, Mozenda never fills the
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
