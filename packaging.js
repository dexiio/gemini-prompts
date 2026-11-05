/* =====================================================================
 * packaging.js - one product: its shelf label plus its packaging, any store
 * ---------------------------------------------------------------------
 * 2026-11-04 - REBUILT ON THE SHELF-AGENT CODE
 *   Writes the same columns and the same RAW_DATA_JSON as aldi-nord.js,
 *   aldi-sud.js, lidl.js and rewe.js (the Field Genius output format), so
 *   a row from here and a row from a shelf agent can sit in one table.
 *   The normalization helpers are copied unchanged from lidl.js - keep
 *   them in step: a fix to the shared logic belongs in all five files.
 *
 * INPUT - ONE PRODUCT PER ROW
 *   imageURL holds one or more photos of the SAME product, separated by
 *   "|". At most one of them is the shelf label, and when there is one it
 *   is the FIRST photo and clearly shown. The others show the packaging,
 *   usually held in a hand. A row may have no label (packaging only) or no
 *   packaging (label only). The model sorts the photos itself and reads
 *   only the centred label and the product the photo is about - never a
 *   neighbouring label or a product behind it.
 *
 * GENERIC - ALL STORES
 *   The label rules describe shelf labels in general (paper, electronic,
 *   produce signs, any currency) instead of one retailer's layout. The
 *   article-number procedure is the shelf agents': two readings, "?" for
 *   a digit that will not resolve, a 'high' identifiers grade, and a
 *   generic 4-8 digit length.
 *
 * WHICH SOURCE WINS
 *   BRAND, DESCRIPTION and the size (ITEM_SIZE, ITEM_UOFM, PACK_SIZE):
 *     the PACKAGING when it shows them, the label otherwise.
 *   Prices, unit price, SKU, UPC: the LABEL only. UPC follows the spec -
 *     the label's own barcode or a produce PLU. A barcode read off the
 *     pack goes to RAW_DATA_JSON.package_barcode, never to UPC.
 *   Ingredients, nutrition, claims, scores: the PACKAGING only, under
 *     RAW_DATA_JSON.packaging.
 *   country_of_origin and organic: the label first, the pack second.
 *
 * PACK_SIZE
 *   Counts separately sellable units, each in its own retail packaging (6
 *   bottles in a shrink-wrap). Pieces sealed together in one tray or bag
 *   ("5 Stück", "5 Fleischwürste à 20g = 100g") are ONE item: ITEM_SIZE is
 *   the total (100 g) and PACK_SIZE is 1.
 *
 * clean
 *   Clean - read as expected
 *   Check - price / size does not reproduce the printed unit price, or the
 *           label and the pack print different sizes
 *   Error - neither a label nor any packaging could be read
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
      // 0: always the most likely reading.
      TEMPERATURE: 0,
      MAX_OUTPUT_TOKENS: 32768,

      // Keeps image detail for the small article-number print and panel
      // text. '' = Gemini's default. If Gemini rejects it (an error
      // mentioning mediaResolution), set this back to ''.
      MEDIA_RESOLUTION: 'MEDIA_RESOLUTION_HIGH',

      // gemini-3.8-flash, USD per 1M tokens (output includes thinking).
      // Google doubles every rate on 2027-01-01; readUsage takes the last
      // entry whose date has been reached, so no edit is needed then.
      PRICES: [
        { from: '2026-01-01', input: 0.75, cachedInput: 0.075, output: 3.75 },
        { from: '2027-01-01', input: 1.50, cachedInput: 0.15, output: 7.50 }
      ],

      // All stores, so no default market. A Country agent input wins over
      // what the model reads off the label.
      DEFAULT_COUNTRY: '',
      COUNTRY_OVERRIDES_MODEL: true,

      // Photos past this many are ignored, with a warning.
      MAX_IMAGES: 8,

      // Generic retailer article number.
      SKU_MIN_DIGITS: 4,
      SKU_MAX_DIGITS: 8,
      // See lidl.js: off, because one omission by the model would empty
      // the SKU. A productId that contradicts its printed token is still
      // dropped.
      SKU_REQUIRE_PRINTED_TOKEN: false,

      UNIT_PRICE_TOLERANCE_ABS: 0.02,
      UNIT_PRICE_TOLERANCE_PCT: 0.02,
      UNIT_PRICE_MISMATCH_FLAG: 'Check',

      // Label size vs pack size: past this gap they disagree and the row
      // is flagged (the pack's size is still the one written).
      SIZE_MISMATCH_TOLERANCE_PCT: 0.02,
      SIZE_MISMATCH_FLAG: 'Check',

      // true hands a failed download or Gemini call back to Mozenda as a
      // failed item; false writes one row marked 'Error' instead.
      STOP_ON_EXTRACTION_ERROR: true,

      RAW_MAX_EXTRAS: 20,
      RAW_MAX_VALUE_CHARS: 200,
      RAW_MAX_PRICE_STRINGS: 8,
      RAW_MAX_PRICE_STRING_CHARS: 40,

      PACKAGING_MAX_INGREDIENT_CHARS: 10000,
      PACKAGING_MAX_PARSED_ITEMS: 80,
      PACKAGING_MAX_NUTRIENTS: 30,
      PACKAGING_MAX_CLAIMS: 15,
      PACKAGING_MAX_SCORES: 5,
      PACKAGING_MAX_LIST_ITEM_CHARS: 200
    };

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

    // -----------------------------------------------------------------
    // Prompt - shelf-agent register: numbered, imperative, one rule a line.
    //
    //   buildSortSection()      which photo is the label, which are packs
    //   buildLabelSection()     the label. Reads NOTHING off the packaging
    //   buildPackagingSection() the packs. Reads NOTHING off the label
    // The code, not the model, decides which source wins a column.
    // -----------------------------------------------------------------

    function buildSortSection(imageCount) {
      return `You are an expert at reading retail shelf price labels and product packaging, in any store and any country. You will receive ${imageCount} image${imageCount === 1 ? '' : 's'} of ONE product, numbered IMAGE 1 to IMAGE ${imageCount} in the order given.

=============================================================
STEP 1 - SORT THE IMAGES
=============================================================
Decide for EVERY image what it shows, and write it in "images" as {"image": n, "kind": ...}:
- "label" - a shelf price label for this product: a paper tag, an electronic shelf label, a produce sign. When there is a label it is IMAGE 1, shown clearly and in full. AT MOST ONE image is the label
- "packaging" - the product itself, usually held in a hand or photographed close up: its front, back, side or bottom panels
- "other" - neither: blurred, a different product, a shelf with no readable label
Some products have no label image and some have no packaging image. That is normal: the missing section is null.

READ ONLY THE PRODUCT THE PHOTOS ARE ABOUT
The photos are taken in a store, so OTHER labels and OTHER products are visible around the edges and in the background.
- In the label image, read ONLY the one label in the centre of the frame that is fully visible. Labels cut off by the frame, above, below or beside it belong to other products
- In a packaging image, read ONLY the product that is held or centred. Packs on the shelf behind it are other products, even when they look alike
- Two packaging images may show the SAME panel twice (a second, sharper shot). Read the clearer one; never merge two different readings of one panel

You have TWO SEPARATE JOBS after sorting, and they must not contaminate each other:
  SECTION A - the LABEL: price, name, size, article number. Source: the label image ONLY
  SECTION B - the PACKAGING: brand, name, size and the printed panels. Source: the packaging images ONLY
A field in one section is NEVER filled from the other's source, even when both show the same thing - both readings are wanted.`;
    }

    function buildLabelSection() {
      return `

=============================================================
SECTION A - THE LABEL ("label", or null when no image is the label)
=============================================================
RULES
1. Read ONLY what is printed inside the label's own border
2. NEVER take a value from a neighbouring label, from the packaging, or from what you already know about the product
3. null IS A CORRECT ANSWER. A label with gaps is right; a label completed by guessing is wrong
4. A label photographed through freezer or chiller glass: digits under a reflection are NOT readable, however plausible a guess looks

FIELDS, in the order you will write them:

1. "brand" - the brand line exactly as printed, usually small capitals above the name ("DULANO", "FERDI FUCHS", "MOSER ROTH"). null if there is none. The store's own name or logo that appears on every label of the store is NOT a brand
   "name" - the product name exactly as printed, in its own language. A name broken over lines is joined with a space ("Mini Würstchen/" + "Salami" -> "Mini Würstchen/Salami"). Never translate it, never put the brand in it
   - A thin VARIANT line under the name ("verschiedene Sorten", "various flavours", "Erdbeere/Kirsche") is NOT part of the name -> extras "variant"
   "brandDisplay" / "nameDisplay" - the SAME brand and name again, written in Proper Case for display. Every word starts with a capital and the rest is lower case; small words (und, oder, mit, ohne, aus, in, im, auf, von, zum, zur, für, der, die, das, and, of, the, with) stay lower case unless they are the first word; a brand you know is written in its own official spelling ("TRADER JOE'S" -> "Trader Joe's", "MOSER ROTH" -> "Moser Roth", "SCHOKO-FRUCHTAUFSTRICH MIT KIRSCHEN" -> "Schoko-Fruchtaufstrich mit Kirschen"). Same words, same abbreviations, same order as "brand" / "name" - ONLY the capitals change. Never translate, never expand an abbreviation, never add a word. null when "brand" / "name" is null

2. "country" - the ISO 3166-1 alpha-2 code of the market the store is in, judged ONLY from the label: its currency, its language, a market prefix on an organic control code ("DE-ÖKO-006" -> "DE"). It is NOT the product's origin. A language spoken in several markets does not settle it on its own (German alone could be DE, AT, CH or LU). null if the label does not settle it
   "currency" - the currency symbol or code as printed on the label ("€", "£", "zł", "Kč", "Ft", "CHF", "kr", "$"). null when none is printed

3. PRICES - the large number is the current price. Cents are often printed smaller and raised: a big "1" with a small "69" is "1.69". Read every digit left to right - do not drop the first one. Return a dot decimal with no symbol: "1,69" -> "1.69", "-.99" -> "0.99", "7.-" and "7,-" -> "7.00". A price field holds ONE number and nothing else - never "2 für 3,00" or "2 x 1.99"
   - ONE price -> "regularPrice"
   - An OLD price - struck through, or marked "statt", "UVP", "vorher", "was" - beside the current price, or a printed discount ("BILLIGER", "AKTION", "Angebot", "SALE", "-30${PCT}") -> the old price is "regularPrice" and the current price is "promoPrice"
   - A printed discount with no old price -> "promoPrice", regularPrice null
   - NOT promotions: colour alone, "NEU", "NEW", "TIEFPREIS", "Dauerhaft günstig", "Preis-Hit" with no old price, a "BIO" badge
   - LOYALTY is a price the label GATES behind something the shopper must present: an app, a loyalty card, a coupon, a membership ("Lidl Plus", "REWE Bonus", "mit App", "Clubcard Price", "Member price") -> "loyaltyPrice". The price for everyone else is "regularPrice", or "promoPrice" if it is itself discounted. No printed condition means not loyalty
   - MULTI-BUY ("2 für 3.00", "ab 2 Stück je 0.99", "1+1 gratis") -> the price is the TOTAL for the quantity and the count goes in that lane's multiple: "2 für 3.00" -> "3.00" with multiple "2"; "ab 2 Stück je 0.99" -> "1.98" with multiple "2"; "1+1 gratis" on a 1.49 item -> "1.49" with multiple "2". A single-item price has multiple "1"
   - The badge text ("BILLIGER", "-30${PCT}", "Lidl Plus", "1+1 gratis") -> extras "promo_badge"; a validity window ("gültig bis 04.10.") -> extras "promo_valid_text"

4. "unitPrice" / "unitPriceBasis" - the small comparison price: "1 kg = 10.69" -> "10.69" and "1 kg"; "100 g = 0.76" -> "0.76" and "100 g"; "kg = 22.45 €" -> "22.45" and "kg"
   - "unitPriceText" - the whole comparison-price token copied exactly as printed: "1 kg = 10.69", "100 g = 0,76 €", "67.2¢/oz". null when there is no unit price
   - CENTS: a unit price printed in cents ("67.2¢", "99 ct") keeps its printed number ("67.2", "99")
   - READ it off the label. NEVER divide the price by the size to produce one
   - Several values for alternative sizes ("1 kg = 33.80 / 16.90") -> null, and the whole token in extras "unit_price_text"
   - It NEVER goes in a price field

5. "itemSize" / "itemUom" - the net quantity of ONE item, from the label's size line: "130 g Packung" -> "130" and "g"
   - The word after it ("Packung", "Glas", "Flasche", "Becher", "Dose", "Beutel") is the package -> extras "package"
   - A MULTIPACK of separate retail units ("6x0,33 l", "4 x 125 g") -> the COMPONENT is the size: "0.33" and "l", plus extras "pack_printed" = "6x0,33 l"
   - A PACK COUNT with no component size ("6er Pack", "6-Pack") -> extras "pack_printed" as printed. The count is never "itemSize"
   - SEVERAL ALTERNATIVE SIZES ("50/100 g Packung", "395/360 g") -> both null, plus extras "size_variants" = "50/100 g"
   - AN EXAMPLE WEIGHT ("z.B. 500 g", "ca. 1 kg", "per kg") -> both null, plus extras "example_weight" as printed; loose goods sold by weight -> extras "variable_weight" = "true"
   - Never take a size from the packaging

6. "rawPriceStrings" - the PRICE tokens on the label, copied exactly as printed and untidied: ["1,49", "1.39", "1 kg = 10.69", "-7${PCT}"]. PRICES ONLY - no article number, PLU or barcode digits. A token you cannot fully read is left out

7. "confidence" - four honest grades, each "high", "medium" or "low", written BEFORE the small print below:
   "description" (brand, name) | "price" (every price field) | "size" (itemSize, itemUom) | "identifiers" (productId, upc)
   - "high" ONLY when the characters are plainly legible
   - "medium" when you are fairly sure but would not stake the row on it
   - "low" for glare, an oblique angle, blur, faint or tiny print, or a value you pieced together
   - The article number is the smallest print on the label, so "identifiers" is routinely lower than "price". That is the expected answer

8. THE ARTICLE NUMBER - the retailer's own item number, printed small on the label: usually 4 to 8 digits, often beside or under a QR code, a DataMatrix or a barcode, or in a corner, sometimes after "Art.-Nr.", "Art.", "Item" or "#" ("0125957", "637739|4|F1", "Art.-Nr. 4006"). A wrong one is worse than none, because it attaches this price to a different product. So read it, or say you could not - but do not approximate it.
   NOT the article number: a barcode's digits (8, 12 or 13 digits under the bars), a date, a price, a phone number, a short handling code printed beside it ("4T", "1M", "STE, R") -> extras "tag_code"
   "productIdPrinted" - what you actually see, copied as printed including any prefix and separators ("637739|4|F1", "36/0080987", "0125957"). Read the digits one at a time, left to right. Write "?" in place of EVERY digit that will not resolve and keep the others ("01259?7"). null when you cannot see the number at all
   "productIdCheck" - read the same digits a SECOND time, starting from the RIGHT end and moving left, looking at each digit again rather than copying "productIdPrinted". Write the result in normal left-to-right order, with "?" for any digit that will not resolve
   "productId" - the article number alone, digits only, leading zeros kept: "0125957", "637739". ONLY when "productIdPrinted" and "productIdCheck" contain no "?" and agree digit for digit - otherwise null
   - SEVERAL candidate numbers on the label and you cannot tell which is the article number -> productId null
   - LOOK-ALIKES: 5/8, 6/8, 3/8, 3/5, 5/6, 0/8, 8/9, 0/6, 1/7, 1/4, 2/7. A digit that could be either of a pair is "?"
   - A square code (QR / DataMatrix) cannot be decoded and is NOT an identifier -> extras "has_qr" = "true"
   - NEVER from the packaging

9. "upc" - null unless the LABEL ITSELF prints one of these:
    - a barcode's full digits, all 8, 12 or 13 of them, copied exactly as printed
    - a number the label marks "PLU", returned as printed including the word ("PLU4011")
    - an unlabelled produce PLU: 4 digits from 3000-4999, or 5 digits starting with 9
    A PLU NEVER goes in productId. A barcode on the PACKAGING is never the label's upc - it belongs to SECTION B

10. "organic" - true only when the label shows an organic logo or badge ("BIO", the EU leaf) or an organic control code ("DE-ÖKO-006")

11. "extras" - anything else printed on the label, as {"key","value"}, values exactly as printed:
    "variant", "package", "pack_printed", "size_variants", "example_weight", "variable_weight", "unit_price_text", "promo_badge", "promo_valid_text", "tag_code", "has_qr" as above, and "organic_code" (the control code as printed), "origin" (the origin line without its heading: "Ursprung: Italien" -> "Italien", "Herkunft: s. Etikett" -> "s. Etikett"), "grade" ("Klasse: I" -> "I"), "variety", "label_type" ("paper", "esl_eink", "produce_sign", "handwritten")
    DEPOSIT is never added to or subtracted from the price: "pfand" (the number alone), "pfand_text" (as printed), "pfand_included" ("true" for "inkl.", "false" for "zzgl.")

EXAMPLE - an electronic label reading "FERDI FUCHS" / "Mini Würstchen/" / "Salami" / "verschiedene Sorten" / "50/100 g Packung", a QR code with "0125957" under it and "4 T" beside it, "1 kg = 33.80 / 16.90", big price 1.69:
{"brand":"FERDI FUCHS","name":"Mini Würstchen/Salami","brandDisplay":"Ferdi Fuchs","nameDisplay":"Mini Würstchen/Salami","country":null,"currency":null,"regularPrice":"1.69","regularMultiple":"1","promoPrice":null,"promoMultiple":null,"loyaltyPrice":null,"loyaltyMultiple":null,"unitPrice":null,"unitPriceBasis":null,"unitPriceText":"1 kg = 33.80 / 16.90","itemSize":null,"itemUom":null,"rawPriceStrings":["1.69","1 kg = 33.80 / 16.90"],"confidence":{"description":"high","price":"high","size":"high","identifiers":"high"},"productIdPrinted":"0125957","productIdCheck":"0125957","productId":"0125957","upc":null,"organic":false,"extras":[{"key":"variant","value":"verschiedene Sorten"},{"key":"package","value":"Packung"},{"key":"size_variants","value":"50/100 g"},{"key":"unit_price_text","value":"1 kg = 33.80 / 16.90"},{"key":"tag_code","value":"4 T"},{"key":"has_qr","value":"true"},{"key":"label_type","value":"esl_eink"}]}`;
    }

    function buildPackagingSection() {
      return `

=============================================================
SECTION B - THE PACKAGING ("packaging", or null when no image is packaging)
=============================================================
Every packaging image shows the SAME product. Read them TOGETHER into ONE record: the front gives the brand and name, the back the ingredients, the side the nutrition table. You extract NO prices here.

CRITICAL RULES
1. RETURN ONLY CHARACTERS YOU CAN SEE printed on the pack in the images
2. YOUR PRODUCT KNOWLEDGE IS FORBIDDEN AS A SOURCE. You will recognise many brands; a recited ingredient list is indistinguishable from a read one, which is why it is banned
3. A panel that was not photographed is not there: null and [] are the normal, correct answer for it, and you must not compensate
4. NEVER complete a word, list or table whose end you cannot read - return what you read and set "isPartial" true
5. NEVER calculate, convert, estimate or infer - no Nutri-Score from a nutrition table, no servings from a net weight
6. FINAL CHECK on every string: "can I point at these exact characters on the pack?" If no, delete it. The ONE exception is languageCode

FIELDS:
- "brandOnPack" - the brand exactly as printed on the pack, usually the logo ("Ferdi Fuchs", "Dulano"). null if not legible. Not the manufacturer's company name from the address block ("Rügenwalder Mühle Carl Müller GmbH & Co. KG")
- "nameOnPack" - the product name exactly as printed on the FRONT, with its variant or flavour line when there is one ("Leberwurst" + "Fein" -> "Leberwurst Fein", "Mini Würstchen"). WITHOUT the brand, the size, slogans ("FÜR GROSS UND KLEIN", "Spitzenqualität"), claims or seals. null if not legible
- "brandOnPackDisplay" / "nameOnPackDisplay" - the SAME brandOnPack and nameOnPack again, written in Proper Case for display, by the same rule as the label's "brandDisplay" / "nameDisplay". null when brandOnPack / nameOnPack is null
- "netContent" - the net quantity statement exactly as printed ("130 g", "5 Fleischwürste à 20g = 100g", "6 x 0,33 l", "500 g e"). Never from the label
- "packItemSize" / "packItemUom" - the net quantity of ONE sellable item, taken from netContent, with a dot decimal and the unit alone ("g", "kg", "ml", "l", "cl", "oz", "lb", "Stück"):
   * "130 g" -> "130" and "g"; "0,5 l" -> "0.5" and "l". The "e" mark is not part of it
   * PIECES SEALED TOGETHER in one tray, bag or box are ONE item, so the TOTAL is the size: "5 Fleischwürste à 20g = 100g" -> "100" and "g"; "5 Stück, 130 g" -> "130" and "g"
   * A MULTIPACK of separate retail units, each in its own complete packaging (bottles in a shrink-wrap, cups in a sleeve, individually wrapped bars in an outer box) -> the size of ONE unit: "6 x 0,33 l" -> "0.33" and "l"
   * null when no net quantity is legible
- "packCount" - how many of those separate retail units the package holds: "6" for six bottles in a shrink-wrap. "1" for everything else, including pieces sealed together ("5 Stück", "5 Fleischwürste à 20g"). null when no net quantity is legible
- "barcode" - the number printed under the barcode ON THE PACK, all 8, 12 or 13 digits, copied exactly as printed, left to right. If ANY digit will not resolve, null - never a "?", never a guessed or dropped digit. Never from the label, never from memory
- "originOnPack" - the country-of-origin statement printed on the pack, verbatim, WITHOUT its heading: "Herkunft: Spanien" -> "Spanien", "Ursprungsland: Peru" -> "Peru", "Made in Germany" -> "Germany". ONLY an explicit origin statement - a manufacturer or distributor address is NOT an origin, and neither is "EU-Landwirtschaft / Nicht-EU-Landwirtschaft". null if not printed or not legible
- "organicCodeOnPack" - the organic control code printed on the pack, as printed ("DE-ÖKO-006"). null if not printed or not legible
- "ingredients.rawText" - the exact declaration after the heading ("Zutaten", "Ingredients", "Ingrédients"), line wraps joined with one space and wrap-hyphens removed. Same words, order, punctuation, script and capitalisation. Do NOT translate or re-order. Do NOT include the "Contains:" sentence
- "ingredients.parsedList" - the same declaration as an array, one entry per top-level ingredient, in printed order, each verbatim INCLUDING its percentage and parenthesised sub-ingredients. A comma INSIDE parentheses does not start a new entry. [] when rawText is null
- "ingredients.isPartial" - a real BOOLEAN. true when the list is cut off, curves out of view, blurs mid-list or is hidden. false when read heading to end. null when there is no ingredient text
- "ingredients.activeIngredients" - ONLY from an "Active ingredients"/"Wirkstoffe" table: "name", "strength" ("3.0${PCT}", "500 mg") and "purpose" as separate printed columns. [] for food and cosmetics, which is nearly always
- "ingredients.allergensContains" - allergens declared present, from a "Contains:"/"Enthält" sentence OR items in BOLD, UPPERCASE or underlined inside the list. As printed, never inferred. [] if none
- "ingredients.allergensMayContain" - trace warnings ("Kann Spuren von ... enthalten"), kept STRICTLY apart from allergensContains. [] if none
- "nutritionFacts" - the WHOLE OBJECT is null unless a nutrition table is printed and readable:
  * "servingsPerContainer" / "servingSize" - as printed, as strings. NEVER calculated
  * "basis" - ONE value for the panel, as printed ("per 100g", "je 100 g", "per serving"). If two columns are printed, return the PER SERVING column and say so here
  * "nutrients" - one object per row, in printed order. "name" standardized to ENGLISH ("Brennwert" -> "Calories", "Fett" -> "Total Fat", "davon gesättigte Fettsäuren" -> "Saturated Fat", "Kohlenhydrate" -> "Carbohydrates", "davon Zucker" -> "Sugars", "Eiweiß" -> "Protein", "Ballaststoffe" -> "Fiber"). This is the ONLY field you may translate
  * SALT vs SODIUM ARE TWO DIFFERENT NUTRIENTS and are NEVER converted into each other. Decide from the PRINTED WORD: "Salz"/"Salt"/"Sel"/"Sale"/"Sal"/"Zout" -> "Salt", "Natrium"/"Sodium"/"Sodio" -> "Sodium"
  * "amount" - the value WITHOUT its unit ("21.3", "< 0.5", "0"), always with a DOT decimal: "21,3" -> "21.3". A thousands separator is dropped: "2.038 kJ" -> "2038". Never round or re-scale
  * "unit" - the unit alone ("kcal", "kJ", "g", "mg"). null if the row prints none
  * "dailyValuePercent" - a NUMBER, or null when there is no ${PCT} column. Never computed
  * A row printing BOTH kJ and kcal is TWO entries
- "productClaims" - dietary, health, environmental, welfare and quality claims printed on the pack, VERBATIM ("Laktose- und glutenfrei", "Ohne Zusatz von Geschmacksverstärkern", "Fairtrade"). Do not paraphrase, merge or invent. Not the product name, not a slogan. AT MOST 15, most prominent first. [] if none
- "healthScores" - printed front-of-pack scores and seals: "systemName" ("Nutri-Score", "Haltungsform", "Eco-Score"), "scoreValue" as printed ("E", "2"), "scaleMax" ("E", "5") when known, "details" as one "; "-joined string or null. On a Nutri-Score ladder the score is the ONE enlarged letter; if you cannot tell which is enlarged, return no Nutri-Score. On a Haltungsform strip the score is the highlighted number. OBSERVED ONLY, never computed. [] if none
- "languageCode" - lowercase ISO 639-1 for the language of the pack text you returned ("de", "en"). The ONE field you may DERIVE; judge it from the text you read, never from the brand. null when no pack text was readable

NULL vs EMPTY ARRAY: null (scalar/object) and [] (array) both mean "not present or not readable". Never the string "null", never "", never a dash, never "N/A".`;
    }

    function buildPrompt(imageCount) {
      return buildSortSection(imageCount) + buildLabelSection() + buildPackagingSection() + `

=============================================================
OUTPUT
=============================================================
Return ONE JSON OBJECT with exactly three keys:
  "images"    - one entry per image, from STEP 1
  "label"     - the object from SECTION A, or null when no image is the label
  "packaging" - the object from SECTION B, or null when no image is packaging
No markdown fences, no text outside the object. NEVER guess.`;
    }

    // -----------------------------------------------------------------
    // Response schema
    // -----------------------------------------------------------------

    const IMAGES_SCHEMA = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          image: { type: 'INTEGER', nullable: true },
          kind: { type: 'STRING', nullable: true }
        },
        propertyOrdering: ['image', 'kind']
      }
    };

    // The shelf agents' tag object, for one label: no tagLocation, and
    // country / currency read off the label because there is no default
    // market.
    const LABEL_SCHEMA = {
      type: 'OBJECT',
      nullable: true,
      properties: {
        brand: { type: 'STRING', nullable: true },
        name: { type: 'STRING', nullable: true },
        brandDisplay: { type: 'STRING', nullable: true },
        nameDisplay: { type: 'STRING', nullable: true },
        country: { type: 'STRING', nullable: true },
        currency: { type: 'STRING', nullable: true },
        regularPrice: { type: 'STRING', nullable: true },
        regularMultiple: { type: 'STRING', nullable: true },
        promoPrice: { type: 'STRING', nullable: true },
        promoMultiple: { type: 'STRING', nullable: true },
        loyaltyPrice: { type: 'STRING', nullable: true },
        loyaltyMultiple: { type: 'STRING', nullable: true },
        unitPrice: { type: 'STRING', nullable: true },
        unitPriceBasis: { type: 'STRING', nullable: true },
        unitPriceText: { type: 'STRING', nullable: true },
        itemSize: { type: 'STRING', nullable: true },
        itemUom: { type: 'STRING', nullable: true },
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
        productIdPrinted: { type: 'STRING', nullable: true },
        productIdCheck: { type: 'STRING', nullable: true },
        productId: { type: 'STRING', nullable: true },
        upc: { type: 'STRING', nullable: true },
        organic: { type: 'BOOLEAN', nullable: true },
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
      // Same reading order as the shelf agents: the large print, the price
      // evidence, the grade - and only then the article number.
      propertyOrdering: [
        'brand', 'name', 'brandDisplay', 'nameDisplay', 'country', 'currency',
        'regularPrice', 'regularMultiple', 'promoPrice', 'promoMultiple',
        'loyaltyPrice', 'loyaltyMultiple',
        'unitPrice', 'unitPriceBasis', 'unitPriceText', 'itemSize', 'itemUom',
        'rawPriceStrings', 'confidence',
        'productIdPrinted', 'productIdCheck', 'productId', 'upc', 'organic', 'extras'
      ]
    };

    // The shelf agents' package object without the binding fields, plus
    // the pack's own size.
    const PACKAGING_SCHEMA = {
      type: 'OBJECT',
      nullable: true,
      properties: {
        brandOnPack: { type: 'STRING', nullable: true },
        nameOnPack: { type: 'STRING', nullable: true },
        brandOnPackDisplay: { type: 'STRING', nullable: true },
        nameOnPackDisplay: { type: 'STRING', nullable: true },
        netContent: { type: 'STRING', nullable: true },
        packItemSize: { type: 'STRING', nullable: true },
        packItemUom: { type: 'STRING', nullable: true },
        packCount: { type: 'STRING', nullable: true },
        barcode: { type: 'STRING', nullable: true },
        originOnPack: { type: 'STRING', nullable: true },
        organicCodeOnPack: { type: 'STRING', nullable: true },
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
              details: { type: 'STRING', nullable: true }
            },
            propertyOrdering: ['systemName', 'scoreValue', 'scaleMax', 'details']
          }
        },
        languageCode: { type: 'STRING', nullable: true }
      },
      propertyOrdering: [
        'brandOnPack', 'nameOnPack', 'brandOnPackDisplay', 'nameOnPackDisplay', 'netContent', 'packItemSize', 'packItemUom', 'packCount',
        'barcode', 'originOnPack', 'organicCodeOnPack',
        'ingredients', 'nutritionFacts', 'productClaims', 'healthScores', 'languageCode'
      ]
    };

    const RESPONSE_SCHEMA = {
      type: 'OBJECT',
      properties: { images: IMAGES_SCHEMA, label: LABEL_SCHEMA, packaging: PACKAGING_SCHEMA },
      propertyOrdering: ['images', 'label', 'packaging']
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

    // All photos of the product in ONE call, each announced as "IMAGE n"
    // so the model can name it in "images". Returns the raw label and
    // packaging objects (either may be null) and the usage.
    async function extractProductInfo(images, apiKey) {
      const parts = [{ text: buildPrompt(images.length) }];
      images.forEach((image, index) => {
        parts.push({ text: `IMAGE ${index + 1}:` });
        parts.push(image);
      });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts }],
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
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Could not parse JSON from model response: ${text.slice(0, 300)}`);
      }

      const label = parsed.label && typeof parsed.label === 'object' ? parsed.label : null;
      const packaging = parsed.packaging && typeof parsed.packaging === 'object' ? parsed.packaging : null;
      return { images: Array.isArray(parsed.images) ? parsed.images : [], label, packaging, usage };
    }

    // -----------------------------------------------------------------
    // Normalization - unchanged from the tested version
    // -----------------------------------------------------------------

    function isBlank(value) {
      return value === null || value === undefined || /^\s*(null|n\/a|-)?\s*$/i.test(String(value));
    }

    // Accepts what a tag prints, in any locale: "1.89", "1,89", "-.99",
    // "2,-", "1.234,56", "1 299 Ft", "89p". Returns a number or null.
    // A printed number -> a Number, with no cents conversion. A single
    // separator followed by 1-2 digits is the decimal point; followed by 3
    // it is a thousands separator ("2.038"), except after a bare 0
    // ("0,672"), which can only be a decimal. "7.-" and "1.299,-" are whole
    // units, so any separator left in them is thousands.
    function parseAmount(value) {
      if (isBlank(value)) return null;
      let s = String(value).trim();
      s = s.replace(/^[-–—]\s*(?=[.,]\d)/, '0');
      const wholeUnits = /[.,]\s*[-–—]+$/.test(s);
      s = s.replace(/[.,]\s*[-–—]+$/, '');
      s = s.replace(/[^\d.,]/g, '');
      if (!/\d/.test(s)) return null;

      const sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
      const decimals = sep === -1 ? 0 : s.length - sep - 1;
      const intPart = sep === -1 ? s : s.slice(0, sep).replace(/[.,]/g, '');
      if (!wholeUnits && sep !== -1 && (decimals === 1 || decimals === 2 || (decimals === 3 && /^0*$/.test(intPart)))) {
        s = intPart + '.' + s.slice(sep + 1);
      } else {
        s = s.replace(/[.,]/g, '');
      }

      const n = Number(s);
      return isFinite(n) ? n : null;
    }

    // A value printed in cents: "67.2¢", "99 ct", "99p".
    function isCents(value) {
      return /\d\s*(¢|ct\.?|cents?|p)\s*$/i.test(String(isBlank(value) ? '' : value).trim());
    }

    // A price in main currency units: "67.2¢" -> 0.672, "99 ct" -> 0.99.
    function parsePrice(value) {
      const n = parseAmount(value);
      if (n === null) return null;
      return isCents(value) ? n / 100 : n;
    }

    function formatPrice(n) {
      return n === null ? '' : n.toFixed(2);
    }

    // "1.000" is a thousand, "0,75" three quarters, and in "2 x 200" the
    // component (200) is the size - the count belongs to the pack.
    function parseQuantity(value) {
      if (isBlank(value)) return null;
      let s = String(value).trim();
      const pack = s.match(/^\d+\s*[x×*]\s*(\d.*)$/i);
      if (pack) s = pack[1];
      const n = parseAmount(s);
      return n !== null && n > 0 ? n : null;
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
      // Unknown units fall back to Title case, like Ea / Pk / Ct ("BTL" -> "Btl").
      return UOM_MAP[key] || titleCase(raw);
    }

    // Small words kept lower case inside a title (never as the first word).
    const MINOR_WORDS = new Set([
      // English
      'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'at',
      'to', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'per', 'vs',
      // German
      'und', 'oder', 'mit', 'ohne', 'in', 'im', 'an', 'am', 'auf', 'aus',
      'bei', 'von', 'vom', 'zu', 'zum', 'zur', 'für', 'nach', 'über', 'unter',
      'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'je'
    ]);

    // Title case: every word starts with a capital and the rest is lower
    // case, except the small words above when they are not the first word
    // ("MOSER ROTH" -> "Moser Roth", "KARTOFFELN MIT SCHALE" -> "Kartoffeln
    // mit Schale"). A word starts after a space, - / ( & or +.
    function titleCase(value) {
      if (isBlank(value)) return '';
      const s = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
      return s.replace(/(^|[\s\-\/(&+])(\p{L})(\p{L}*)/gu, (m, sep, ch, rest, offset) =>
        offset > 0 && sep === ' ' && MINOR_WORDS.has(ch + rest) ? m : sep + ch.toUpperCase() + rest);
    }

    // BRAND and DESCRIPTION casing comes from the model: it returns
    // brandDisplay / nameDisplay in Proper Case next to the verbatim
    // brand / name, and knows brand spellings code cannot ("Trader Joe's",
    // "ja!"). Its text is used as given. When it is missing, or still all
    // capitals, the verbatim text is title-cased here instead.
    function displayCase(shown, raw) {
      const s = isBlank(shown) ? '' : String(shown).trim().replace(/\s+/g, ' ');
      if (s && s !== s.toUpperCase()) return s;
      return titleCase(s || raw);
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
    // Returns { value, raw }. UPC only ever holds digits, so the value is
    // the bare code ("541"); the printed text ("PLU541") goes to
    // RAW_DATA_JSON.plu_raw, and upc_type "plu" is what tells a short
    // produce code apart from a bad barcode read.
    function labelledPlu(value) {
      const match = String(isBlank(value) ? '' : value).match(/PLU\D{0,3}(\d{1,5})(?!\d)/i);
      if (!match) return { value: '', raw: '' };
      return { value: match[1], raw: match[0].trim() };
    }

    // Returns { value, type }. UPC holds digits only, as printed - an 8-
    // or 12-digit barcode is not padded to 13. A barcode is either read
    // whole with a matching check digit or dropped: no rebuilding of
    // partial reads.
    function normalizeUpc(value) {
      const plu = labelledPlu(value);
      if (plu.value) return { value: plu.value, type: 'plu', raw: plu.raw };
      // Words and URLs never become a UPC, even when digits are buried in
      // them: "https://shop.example/p/4003786602259" is a link, not a scan.
      if (/[a-z]/i.test(String(isBlank(value) ? '' : value))) {
        console.warn(`Discarding "${value}" as UPC - it contains letters`);
        return { value: '', type: '' };
      }
      // A "?" is a digit the model could not read. Stripping it would leave
      // 12 digits that can pass the check digit as a different UPC-A.
      if (String(isBlank(value) ? '' : value).indexOf('?') !== -1) {
        console.log(`UPC withheld - "${value}" has unconfirmed digits`);
        return { value: '', type: '' };
      }
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
      if (text.indexOf('?') !== -1 || /[a-z]/i.test(text)) return '';
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

    // The items in a package, from the "pack_printed" extra: "6x120 ml",
    // "6er Pack", "6-Pack", "6pk", "pack of 6". 1 when there is none. The
    // number must sit against the pack word, so "400 g PK" is not a count.
    function packCountOf(label) {
      const extras = Array.isArray(label.extras) ? label.extras : [];
      const pack = extras.find(extra => extra && String(extra.key || '').toLowerCase() === 'pack_printed');
      const text = pack ? String(pack.value || '') : '';
      const match = text.match(/(\d+)\s*[x×*]\s*\d/i) ||
        text.match(/(\d+)\s*-?\s*(?:er\b|pack|pk\b)/i) ||
        text.match(/\bpack\s+of\s+(\d+)/i);
      const count = match ? Number(match[1]) : 1;
      return count > 1 ? count : 1;
    }

    // -----------------------------------------------------------------
    // Packaging: normalization
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
      // Origin and organic code as printed on the pack. buildRawJson lifts
      // them to the top level when the tag has none of its own.
      const originOnPack = cleanText(pkg.originOnPack, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (originOnPack) out.origin_on_pack = originOnPack;
      const organicCodeOnPack = cleanText(pkg.organicCodeOnPack, CONFIG.PACKAGING_MAX_LIST_ITEM_CHARS);
      if (organicCodeOnPack) out.organic_code_on_pack = organicCodeOnPack;

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

    // The currency unit a printed price NAMES - '' when it names none. A
    // bare "15.90" is not guessed into euros or cents.
    function currencyUnitOf(text) {
      const t = String(isBlank(text) ? '' : text);
      if (/¢|\d\s*ct\b|\bcents?\b/i.test(t)) return 'cent';
      if (/€|\bEUR\b/i.test(t)) return 'euro';
      if (/\$|\bUSD\b/i.test(t)) return 'dollar';
      if (/£|\bGBP\b|\bCHF\b|\bS?Fr\./i.test(t)) return 'other';
      return '';
    }

    // The unit price as the tag prints it, plus what the check needs:
    //   printed    the token off the tag, untidied ("67.2¢/oz")
    //   amount     the number in the unit printed (67.2 for "67.2¢")
    //   effective  amount in main currency units (0.672) - ONLY when the
    //              currency unit is printed, and only when the amount can
    //              be found in the printed text, so a number the model
    //              already converted is not converted twice.
    function readUnitPrice(label) {
      const printed = cleanText(label.unitPriceText, CONFIG.RAW_MAX_VALUE_CHARS);
      const amount = parseAmount(label.unitPrice);
      if (amount === null && !printed) return null;

      const out = { printed, amount };
      const currency = currencyUnitOf(`${printed} ${isBlank(label.unitPrice) ? '' : label.unitPrice}`);
      const amountDigits = String(isBlank(label.unitPrice) ? '' : label.unitPrice).replace(/\D/g, '');
      const inPrinted = !printed || printed.replace(/\D/g, '').indexOf(amountDigits) !== -1;
      if (amount !== null && currency && inPrinted) {
        out.effective = Number((currency === 'cent' ? amount / 100 : amount).toFixed(4));
      }
      return out;
    }

    // upc_type tells downstream whether the UPC column holds a PLU or a
    // GTIN.
    // -----------------------------------------------------------------
    // Country of origin
    //
    // The printed origin ("Italien", "Spanien / Marokko", "s. Etikett") is
    // mapped to ISO 3166-1 alpha-2 by THIS TABLE, never by the model.
    // value is set only when exactly one country is recognised; printed
    // always keeps the text. Text naming no country in the table
    // ("s. Etikett", "EU") gives no country_of_origin - the tag's verbatim
    // line is still in the "origin" extra.
    // Names: lowercase, accents stripped, ß -> ss, words joined by a single
    // space. One name per array entry, so multi-word names stay whole.
    // -----------------------------------------------------------------
    const ORIGIN_NAMES = {
      DE: ['deutschland', 'germany', 'allemagne', 'germania', 'alemania', 'duitsland', 'niemcy', 'nemecko', 'nemetorszag'],
      AT: ['osterreich', 'oesterreich', 'austria', 'autriche', 'oostenrijk'],
      CH: ['schweiz', 'switzerland', 'suisse', 'svizzera', 'suiza', 'zwitserland'],
      NL: ['niederlande', 'holland', 'netherlands', 'pays bas', 'paesi bassi', 'paises bajos', 'nederland', 'holandia'],
      BE: ['belgien', 'belgium', 'belgique', 'belgio', 'belgica', 'belgie'],
      LU: ['luxemburg', 'luxembourg', 'lussemburgo'],
      FR: ['frankreich', 'france', 'francia', 'frankrijk', 'francja'],
      IT: ['italien', 'italy', 'italie', 'italia', 'wlochy'],
      ES: ['spanien', 'spain', 'espagne', 'spagna', 'espana', 'spanje', 'hiszpania'],
      PT: ['portugal', 'portogallo', 'portugalia'],
      GR: ['griechenland', 'greece', 'grece', 'grecia', 'griekenland', 'grecja'],
      CY: ['zypern', 'cyprus', 'chypre', 'cipro', 'chipre'],
      MT: ['malta', 'malte'],
      IE: ['irland', 'ireland', 'irlande', 'irlanda', 'ierland'],
      GB: ['grossbritannien', 'vereinigtes konigreich', 'vereinigtes koenigreich', 'united kingdom', 'great britain',
        'england', 'schottland', 'scotland', 'wales', 'nordirland', 'northern ireland', 'royaume uni', 'regno unito', 'reino unido'],
      DK: ['danemark', 'daenemark', 'denmark', 'danimarca', 'dinamarca', 'denemarken', 'dania'],
      SE: ['schweden', 'sweden', 'suede', 'svezia', 'suecia', 'zweden', 'szwecja'],
      NO: ['norwegen', 'norway', 'norvege', 'norvegia', 'noruega', 'noorwegen', 'norwegia'],
      FI: ['finnland', 'finland', 'finlande', 'finlandia'],
      IS: ['island', 'iceland', 'islande', 'islanda', 'islandia', 'ijsland'],
      PL: ['polen', 'poland', 'pologne', 'polonia', 'polska'],
      CZ: ['tschechien', 'tschechische republik', 'czech republic', 'czechia', 'republique tcheque', 'repubblica ceca',
        'chequia', 'tsjechie', 'czechy'],
      SK: ['slowakei', 'slovakia', 'slovaquie', 'slovacchia', 'eslovaquia', 'slowakije', 'slowacja'],
      HU: ['ungarn', 'hungary', 'hongrie', 'ungheria', 'hungria', 'hongarije', 'wegry'],
      SI: ['slowenien', 'slovenia', 'slovenie', 'eslovenia'],
      HR: ['kroatien', 'croatia', 'croatie', 'croazia', 'croacia', 'kroatie', 'chorwacja'],
      RS: ['serbien', 'serbia', 'serbie'],
      RO: ['rumanien', 'rumaenien', 'romania', 'roumanie', 'rumania', 'roemenie', 'rumunia'],
      BG: ['bulgarien', 'bulgaria', 'bulgarie', 'bulgarije'],
      LT: ['litauen', 'lithuania', 'lituanie', 'lituania', 'litouwen', 'litwa'],
      LV: ['lettland', 'latvia', 'lettonie', 'lettonia', 'letonia', 'letland', 'lotwa'],
      EE: ['estland', 'estonia', 'estonie'],
      UA: ['ukraine', 'ucraina', 'ucrania', 'oekraine', 'ukraina'],
      MD: ['moldau', 'moldawien', 'moldova'],
      TR: ['turkei', 'tuerkei', 'turkey', 'turquie', 'turchia', 'turquia', 'turkije', 'turcja', 'turkiye'],
      IL: ['israel', 'israele'],
      EG: ['agypten', 'aegypten', 'egypt', 'egypte', 'egitto', 'egipto', 'egipt'],
      MA: ['marokko', 'morocco', 'maroc', 'marocco', 'marruecos', 'maroko'],
      TN: ['tunesien', 'tunisia', 'tunisie', 'tunez'],
      ZA: ['sudafrika', 'suedafrika', 'south africa', 'afrique du sud', 'zuid afrika'],
      KE: ['kenia', 'kenya'],
      SN: ['senegal'],
      CI: ['elfenbeinkuste', 'elfenbeinkueste', 'ivory coast', 'cote d ivoire', 'costa d avorio', 'costa de marfil'],
      GH: ['ghana'],
      US: ['usa', 'vereinigte staaten', 'united states', 'etats unis', 'stati uniti', 'estados unidos', 'verenigde staten'],
      CA: ['kanada', 'canada'],
      MX: ['mexiko', 'mexico', 'mexique', 'messico'],
      GT: ['guatemala'],
      HN: ['honduras'],
      CR: ['costa rica'],
      PA: ['panama'],
      DO: ['dominikanische republik', 'dominican republic', 'republique dominicaine', 'repubblica dominicana', 'republica dominicana'],
      CO: ['kolumbien', 'colombia', 'colombie'],
      EC: ['ecuador', 'equateur'],
      PE: ['peru', 'perou'],
      BR: ['brasilien', 'brazil', 'bresil', 'brasile', 'brasil'],
      CL: ['chile', 'cile'],
      AR: ['argentinien', 'argentina', 'argentine'],
      UY: ['uruguay'],
      IN: ['indien', 'india', 'inde'],
      LK: ['sri lanka'],
      CN: ['china', 'chine', 'cina'],
      VN: ['vietnam', 'viet nam'],
      TH: ['thailand', 'thailande', 'tailandia'],
      ID: ['indonesien', 'indonesia', 'indonesie'],
      AU: ['australien', 'australia', 'australie'],
      NZ: ['neuseeland', 'new zealand', 'nouvelle zelande', 'nuova zelanda', 'nueva zelanda', 'nieuw zeeland']
    };
    const ORIGIN_COUNTRIES = {};
    Object.keys(ORIGIN_NAMES).forEach(code => {
      ORIGIN_NAMES[code].forEach(name => { ORIGIN_COUNTRIES[name] = code; });
    });

    // ISO codes named in a printed origin, in printed order, no repeats.
    // A two-letter code printed in capitals ("Herkunft: ES") counts too,
    // but only for a code in the table.
    function originCodes(text) {
      if (isBlank(text)) return [];
      const raw = String(text);
      const words = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
        .toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
      const capitals = raw.replace(/[^A-Za-z]+/g, ' ').trim().split(' ');
      const found = [];
      for (let i = 0; i < words.length; i++) {
        let code = '';
        for (let len = 3; len >= 1 && !code; len--) {
          if (i + len > words.length) continue;
          const phrase = words.slice(i, i + len).join(' ');
          if (ORIGIN_COUNTRIES[phrase]) {
            code = ORIGIN_COUNTRIES[phrase];
            i += len - 1;
          }
        }
        if (!code && words[i].length === 2) {
          const upper = words[i].toUpperCase();
          if (ORIGIN_NAMES[upper] && capitals.indexOf(upper) !== -1) code = upper;
        }
        if (code && found.indexOf(code) === -1) found.push(code);
      }
      return found;
    }

    function originFrom(text, source) {
      const printed = cleanText(text, CONFIG.RAW_MAX_VALUE_CHARS);
      if (!printed) return null;
      const codes = originCodes(printed);
      if (codes.length === 0) return null;
      const out = {};
      if (codes.length === 1) out.value = codes[0];
      out.printed = printed;
      out.source = source;
      return out;
    }

    // The tag first; the pack only when the tag names no country (no
    // origin line, or one that reads "s. Etikett"). A pack is only here
    // when its bind was "high" and checkBind() agreed.
    function buildCountryOfOrigin(label, packaging) {
      const extras = Array.isArray(label.extras) ? label.extras : [];
      const tagOrigin = extras.find(extra => extra && String(extra.key || '').trim().toLowerCase() === 'origin' && !isBlank(extra.value));
      const fromTag = tagOrigin ? originFrom(tagOrigin.value, 'tag') : null;
      const fromPack = packaging ? originFrom(packaging.origin_on_pack, 'pack') : null;
      if (fromTag && fromPack && fromTag.value && fromPack.value && fromTag.value !== fromPack.value) {
        console.warn(`Origin on the tag (${fromTag.printed}) and on the pack (${fromPack.printed}) disagree - keeping the tag`);
      }
      return fromTag || fromPack;
    }

    function buildRawJson(label, unitInfo, unitCheck, upcType, packaging, pluRaw) {
      const raw = {};
      // Where on the fixture this row came from - the reviewer's way back to
      // the tag in the photo, and what the duplicate check keys on.
      const location = cleanText(label.tagLocation, CONFIG.RAW_MAX_VALUE_CHARS);
      if (location) raw.tag_location = location;
      if (upcType) raw.upc_type = upcType;
      // The printed produce-code text, kept whenever it did not become the
      // UPC (a PLU printed in the article-number slot, say).
      if (pluRaw) raw.plu_raw = pluRaw;
      // printed is the token as printed, so cents vs euros and the basis
      // survive; a response without it falls back to the number.
      if (unitInfo) {
        raw.unit_price = {
          printed: unitInfo.printed || formatPrice(unitInfo.amount),
          per: String(label.unitPriceBasis || '').trim()
        };
        // Always one of three: ok, mismatch, or not_checkable when the
        // size, basis or units do not allow the comparison.
        raw.unit_price.check = unitCheck || 'not_checkable';
      }

      const priceStrings = buildPriceStrings(label.rawPriceStrings);
      if (priceStrings) raw.raw_price_strings = priceStrings;

      const confidence = buildConfidence(label.confidence);
      if (confidence) raw.confidence = confidence;

      const extras = Array.isArray(label.extras) ? label.extras : [];

      // organic_code is a standard key, not an extra: the control code as
      // printed ("DE-ÖKO-006"). A printed code is itself the organic mark.
      const organicCode = extras.find(extra => extra && String(extra.key || '').trim().toLowerCase() === 'organic_code' && !isBlank(extra.value));
      if (organicCode) raw.organic_code = String(organicCode.value).trim().slice(0, CONFIG.RAW_MAX_VALUE_CHARS);
      if (label.organic === true || raw.organic_code) {
        raw.organic = true;
      } else if (packaging && packaging.organic_code_on_pack) {
        // The tag shows no organic mark, but the bound pack prints a code.
        raw.organic_code = packaging.organic_code_on_pack.slice(0, CONFIG.RAW_MAX_VALUE_CHARS);
        raw.organic = true;
        packaging = Object.assign({}, packaging);
        delete packaging.organic_code_on_pack;
        if (Object.keys(packaging).length === 0) packaging = null;
      }

      // Tag first, pack second - see buildCountryOfOrigin. The pack's text
      // leaves the packaging block when it is the one used.
      const origin = buildCountryOfOrigin(label, packaging);
      if (origin) {
        if (origin.source === 'pack') {
          packaging = Object.assign({}, packaging);
          delete packaging.origin_on_pack;
          if (Object.keys(packaging).length === 0) packaging = null;
        }
        // source is only for choosing above; it is not written out.
        delete origin.source;
        raw.country_of_origin = origin;
      }

      // The package barcode sits at the top level next to the UPC, not
      // inside packaging. Set before the extras so none can claim the key.
      if (packaging && packaging.package_barcode) {
        raw.package_barcode = packaging.package_barcode;
        packaging = Object.assign({}, packaging);
        delete packaging.package_barcode;
        if (Object.keys(packaging).length === 0) packaging = null;
      }

      let written = 0;
      for (const extra of extras) {
        if (!extra || isBlank(extra.key) || isBlank(extra.value)) continue;
        if (written >= CONFIG.RAW_MAX_EXTRAS) break;
        const key = String(extra.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!key || raw[key] !== undefined) continue;
        raw[key] = String(extra.value).trim().slice(0, CONFIG.RAW_MAX_VALUE_CHARS);
        written++;
      }

      // Last, so the extras caps above never apply to it. "packaging" is
      // a reserved key, so an extra that happened to be called
      // "packaging" cannot displace it.
      if (packaging) raw.packaging = packaging;

      return Object.keys(raw).length > 0 ? JSON.stringify(raw) : '';
    }

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
        PACK_SIZE: '1',
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

    // -----------------------------------------------------------------
    // One product, one row
    // -----------------------------------------------------------------

    const IMAGE_KINDS = ['label', 'packaging', 'other'];

    // One kind per photo, in input order. A photo the model did not name
    // is "other". At most one label: a second one is demoted, because two
    // labels for one product means one of them belongs to a neighbour.
    function readImageKinds(images, count) {
      const kinds = [];
      for (let i = 0; i < count; i++) kinds.push('other');
      (Array.isArray(images) ? images : []).forEach(entry => {
        if (!entry || typeof entry !== 'object') return;
        const index = Number(entry.image) - 1;
        const kind = String(entry.kind || '').trim().toLowerCase();
        if (index >= 0 && index < count && IMAGE_KINDS.indexOf(kind) !== -1) kinds[index] = kind;
      });
      let labelSeen = false;
      kinds.forEach((kind, index) => {
        if (kind !== 'label') return;
        if (labelSeen) {
          console.warn(`IMAGE ${index + 1} was also called a label - only the first label is read`);
          kinds[index] = 'other';
        }
        labelSeen = true;
      });
      const labelIndex = kinds.indexOf('label');
      if (labelIndex > 0) console.warn(`The label is IMAGE ${labelIndex + 1}, not IMAGE 1 as expected`);
      return kinds;
    }

    // The pack's size, when it prints one the code can use.
    function packSizeOf(pkg) {
      if (!pkg) return null;
      const size = parseQuantity(pkg.packItemSize);
      const uom = normalizeUom(pkg.packItemUom);
      if (size === null || !uom) return null;
      const count = Math.round(parseQuantity(pkg.packCount) || 1);
      return { size, uom, count: count > 1 ? count : 1, source: 'pack' };
    }

    function labelSizeOf(label) {
      const size = parseQuantity(label.itemSize);
      if (size === null) return null;
      return { size, uom: normalizeUom(label.itemUom), count: packCountOf(label), source: 'label' };
    }

    // Both sides print a size and they are not the same quantity: one of
    // them was misread, or the photos are of two different products.
    function sizesDisagree(a, b) {
      if (!a || !b) return false;
      const fa = UOM_FACTOR[a.uom];
      const fb = UOM_FACTOR[b.uom];
      if (!fa || !fb || fa[0] !== fb[0]) return false;
      const totalA = a.size * fa[1] * a.count;
      const totalB = b.size * fb[1] * b.count;
      return Math.abs(totalA - totalB) > Math.max(totalA, totalB) * CONFIG.SIZE_MISMATCH_TOLERANCE_PCT;
    }

    // label and pkg are the model's objects ({} when absent); packaging is
    // pkg after normalizePackaging, or null.
    function buildRow(label, pkg, packaging, ctx, usage) {
      const detected = normalizeCountry(label.country);
      const country = (ctx.pinnedCountry && (CONFIG.COUNTRY_OVERRIDES_MODEL || !detected))
        ? ctx.pinnedCountry
        : detected;
      if (ctx.pinnedCountry && detected && detected !== ctx.pinnedCountry) {
        console.warn(`Label reads as ${detected} but the agent is pinned to ${ctx.pinnedCountry}`);
      }

      const row = baseRow(ctx.imagesInput, ctx.imageUrl, ctx.lastSeen, country,
        resolveCurrency(label.currency, country), usage, 'no', 'Clean');

      // Prices: the label only.
      const regular = parsePrice(label.regularPrice);
      const promo = parsePrice(label.promoPrice);
      const loyalty = parsePrice(label.loyaltyPrice);
      row.REG_PRICE = formatPrice(regular);
      row.REG_MULTIPLE = parseMultiple(label.regularMultiple, regular !== null);
      row.PROMO_PRICE = formatPrice(promo);
      row.PROMO_MULTIPLE = parseMultiple(label.promoMultiple, promo !== null);
      row.LOYALTY_PRICE = formatPrice(loyalty);
      row.LOYALTY_MULTIPLE = parseMultiple(label.loyaltyMultiple, loyalty !== null);

      // Brand and name: the pack first, the label otherwise. Taken field by
      // field, so a pack whose brand is legible but whose name is not still
      // gives its brand.
      const brand = !isBlank(pkg.brandOnPack)
        ? displayCase(pkg.brandOnPackDisplay, pkg.brandOnPack)
        : displayCase(label.brandDisplay, label.brand);
      const name = !isBlank(pkg.nameOnPack)
        ? displayCase(pkg.nameOnPackDisplay, pkg.nameOnPack)
        : displayCase(label.nameDisplay, label.name);
      row.BRAND = brand;
      row.DESCRIPTION = buildDescription(brand, name);

      // Size: the pack first, the label otherwise.
      const fromPack = packSizeOf(pkg);
      const fromLabel = labelSizeOf(label);
      const chosen = fromPack || fromLabel;
      if (chosen) {
        row.ITEM_SIZE = String(chosen.size);
        row.ITEM_UOFM = chosen.uom;
        row.ITEM_SIZE_UOFM = chosen.uom ? `${chosen.size} ${chosen.uom}` : String(chosen.size);
        row.PACK_SIZE = String(chosen.count);
      }
      const sizeMismatch = sizesDisagree(fromPack, fromLabel);
      if (sizeMismatch) {
        console.warn(`The label says ${label.itemSize} ${label.itemUom}, the pack says ${pkg.packItemSize} ${pkg.packItemUom} - keeping the pack`);
        if (CONFIG.SIZE_MISMATCH_FLAG) row.clean = CONFIG.SIZE_MISMATCH_FLAG;
      }

      // UPC and SKU: the label only (see lidl.js for the PLU handling).
      const pluInId = labelledPlu(label.productId);
      let upc = normalizeUpc(label.upc);
      if (!upc.value && pluInId.value) upc = { value: pluInId.value, type: 'plu', raw: pluInId.raw };
      if (!upc.value && !upc.raw && pluInId.raw) upc = { value: '', type: '', raw: pluInId.raw };
      row.UPC = upc.value;
      row.SKU = pluInId.raw ? '' : resolveSku(label);
      if (upc.type === 'plu' && row.SKU === upc.value) row.SKU = '';

      // The label's unit price checked against its own prices and the size
      // written above.
      const unitInfo = readUnitPrice(label);
      const unitPrice = unitInfo && unitInfo.effective !== undefined ? unitInfo.effective : parsePrice(label.unitPrice);
      const prices = [];
      if (regular !== null) prices.push({ price: regular, multiple: Number(row.REG_MULTIPLE) });
      if (promo !== null) prices.push({ price: promo, multiple: Number(row.PROMO_MULTIPLE) });
      if (loyalty !== null) prices.push({ price: loyalty, multiple: Number(row.LOYALTY_MULTIPLE) });
      const unitCheck = chosen
        ? checkUnitPrice(prices, chosen.size, chosen.uom, unitPrice, label.unitPriceBasis, chosen.count)
        : '';
      if (unitCheck === 'mismatch') {
        console.warn(`Unit price ${label.unitPrice}/${label.unitPriceBasis} does not match ${label.regularPrice || label.promoPrice || label.loyaltyPrice} for ${row.ITEM_SIZE_UOFM} - "${row.DESCRIPTION}"`);
        if (CONFIG.UNIT_PRICE_MISMATCH_FLAG) row.clean = CONFIG.UNIT_PRICE_MISMATCH_FLAG;
      }

      row.RAW_DATA_JSON = buildRawJson(label, unitInfo, unitCheck, upc.type, packaging,
        upc.raw && upc.raw !== row.UPC ? upc.raw : '');

      return row;
    }

    // -----------------------------------------------------------------
    // Main
    // -----------------------------------------------------------------

    const lastSeen = nowStamp();

    // Loaded from GitHub by packaging.loader.js, Mozenda never fills the
    // placeholders in this file, so the loader passes the filled inputs in
    // window.MOZENDA_INPUTS. Pasted into the agent directly, that object is
    // absent and the placeholders below are filled as before.
    const agentInputs = (typeof window !== 'undefined' && window.MOZENDA_INPUTS) || {};

    // Optional market pin. An unfilled placeholder is ignored, and the
    // model's reading of the label is used instead.
    const pinnedCountry = normalizeCountry(readAgentInput('Country' in agentInputs ? agentInputs.Country : '%Country%') || CONFIG.DEFAULT_COUNTRY);
    if (pinnedCountry) console.log(`Market pinned to ${pinnedCountry}`);
    const pinnedCurrency = COUNTRY_CURRENCY[pinnedCountry] || '';

    // ONE product per row: one or more photos of it, separated by "|".
    const imagesInput = readAgentInput('imageURL' in agentInputs ? agentInputs.imageURL : '%imageURL%');
    let links = imagesInput.split('|').map(url => url.trim()).filter(url => url);
    if (links.length > CONFIG.MAX_IMAGES) {
      console.warn(`The imageURL input carried ${links.length} photos - only the first ${CONFIG.MAX_IMAGES} are read`);
      links = links.slice(0, CONFIG.MAX_IMAGES);
    }

    if (links.length === 0) {
      console.error('No image URL in the imageURL input');
      M_SetFieldValues(baseRow(imagesInput, '', lastSeen, pinnedCountry, pinnedCurrency, EMPTY_USAGE, 'no', 'Error'));
      M_StopWaiting();
      return;
    }

    let extraction;
    try {
      // Every photo must download: a row read from only some of them would
      // look complete while missing the label or a panel.
      const fetched = await Promise.all(links.map(link => fetchImageWithRetry(convertGoogleDriveUrl(link))));
      const failed = links.filter((link, index) => !fetched[index]);
      if (failed.length > 0) {
        throw new Error(`Failed to fetch ${failed.length} of ${links.length} images: ${failed.join(' | ')}`);
      }
      extraction = await extractProductInfo(fetched, apiKeyValue);
    } catch (error) {
      console.error(`Extraction error: ${error.message}`);
      if (CONFIG.STOP_ON_EXTRACTION_ERROR) {
        // We learned nothing, so no row is written: the item goes back to
        // Mozenda as failed instead of looking processed.
        M_StopWithError('Extraction Error', error.message);
        return;
      }
      M_SetFieldValues(baseRow(imagesInput, links[0], lastSeen, pinnedCountry, pinnedCurrency, EMPTY_USAGE, 'no', 'Error'));
      M_StopWaiting();
      return;
    }

    const kinds = readImageKinds(extraction.images, links.length);
    const hasLabelImage = kinds.indexOf('label') !== -1;
    const hasPackImage = kinds.indexOf('packaging') !== -1;

    // A section is used only when the model also said a photo shows it: a
    // label object with no label photo was read off something else -
    // usually the packaging - and is exactly the cross-contamination the
    // prompt forbids.
    let label = extraction.label;
    if (label && !hasLabelImage) {
      console.warn('A label was returned but no photo was sorted as a label - ignoring it');
      label = null;
    }
    let pkg = extraction.packaging;
    if (pkg && !hasPackImage) {
      console.warn('Packaging was returned but no photo was sorted as packaging - ignoring it');
      pkg = null;
    }

    const packaging = normalizePackaging(pkg);
    const packSize = packSizeOf(pkg);
    const usage = extraction.usage || EMPTY_USAGE;

    // IMAGE_URL is the photo the row's price came from: the label, else
    // the first packaging photo, else the first photo.
    const labelIndex = kinds.indexOf('label');
    const packIndex = kinds.indexOf('packaging');
    const imageUrl = links[labelIndex !== -1 ? labelIndex : (packIndex !== -1 ? packIndex : 0)];
    const ctx = { imagesInput, imageUrl, lastSeen, pinnedCountry };

    const row = buildRow(label || {}, pkg || {}, packaging, ctx, usage);

    const readLabel = !!label && (hasPrice(label) || !isBlank(label.name) || !isBlank(label.brand));
    const readPack = !!packaging || !!packSize;
    if (!readLabel && !readPack) {
      console.warn('Neither a label nor any packaging could be read');
      row.clean = 'Error';
    }
    console.log(`Label: ${readLabel ? 'read' : 'none'} | packaging: ${readPack ? 'read' : 'none'} | photos: ${kinds.join(', ')}`);

    M_SetFieldValues(row);
    M_StopWaiting();

  } catch (error) {
    console.error('Script error:', error);
    M_StopWithError('Script Error', error.message);
  }
})();
