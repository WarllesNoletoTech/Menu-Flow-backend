import { deflateSync, inflateSync } from "node:zlib";

type Report = {
  reportNumber: string;
  periodStart: Date | string;
  periodEnd: Date | string;
  generatedAt: Date | string;
  orderCount: number;
  serviceFeeTotalCents: number;
  includeMonthlyFee: boolean;
  monthlyFeeCents: number;
  totalCents: number;
  timezone: string;
  restaurantSnapshot: Record<string, unknown>;
  paymentSnapshot?: { pixReceiverName?: string; pixKey?: string };
};

type Item = {
  orderNumber: string;
  completedAt: Date | string;
  fulfillment: string;
  orderTotalCents: number;
  feeCents: number;
};

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
// Formatação inspirada na ABNT NBR 14724: papel A4, margem superior/esquerda
// de aproximadamente 3 cm e inferior/direita de aproximadamente 2 cm.
const MARGIN_LEFT = 85;
const MARGIN_RIGHT = 57;
const MARGIN_TOP = 85;
const MARGIN_BOTTOM = 57;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN_RIGHT;
const BRAND_R = 0.48;
const BRAND_G = 0.18;
const BRAND_B = 0.18;

export const normalizePdfText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\r\n?/g, "\n");

const money = (n: number) =>
  normalizePdfText(
    (n / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    }),
  );

const date = (v: Date | string, tz: string) =>
  normalizePdfText(
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz }).format(new Date(v)),
  );

const time = (v: Date | string, tz: string) =>
  normalizePdfText(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(v)),
  );

// As fontes Type1 padrão do PDF trabalham com WinAnsi. O encoder abaixo mantém
// a ortografia pt-BR (acentos, cedilha e pontuação) sem transliteração para ASCII.
const cp1252: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

export function encodeWinAnsi(value: unknown) {
  const bytes: number[] = [];
  for (const char of normalizePdfText(value)) {
    const code = char.codePointAt(0)!;
    const byte = code <= 0xff ? code : cp1252[code];
    if (byte === undefined)
      throw new Error(
        `Caractere não suportado pela fonte WinAnsi: U+${code.toString(16).toUpperCase()}`,
      );
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

type PngImage = {
  width: number;
  height: number;
  rgb: Buffer;
  alpha?: Buffer;
};

function pngImage(png: Buffer): PngImage {
  if (png.subarray(1, 4).toString() !== "PNG")
    throw new Error("Logo não é PNG.");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png[24];
  const color = png[25];
  const interlace = png[28];
  if (depth !== 8 || ![2, 6].includes(color) || interlace !== 0)
    throw new Error("Formato PNG da logo não suportado.");

  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const kind = png.subarray(at + 4, at + 8).toString();
    if (kind === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = color === 6 ? 4 : 3;
  const stride = width * bpp;
  const decoded = Buffer.alloc(stride * height);
  let source = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x++) {
      const current = raw[source++];
      const left = x >= bpp ? decoded[row * stride + x - bpp] : 0;
      const up = row ? decoded[(row - 1) * stride + x] : 0;
      const upperLeft = row && x >= bpp ? decoded[(row - 1) * stride + x - bpp] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        prediction = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else if (filter !== 0) {
        throw new Error("Filtro PNG não suportado.");
      }
      decoded[row * stride + x] = (current + prediction) & 255;
    }
  }

  if (color === 2) {
    return { width, height, rgb: deflateSync(decoded) };
  }

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  let r = 0;
  let a = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    rgb[r++] = decoded[i];
    rgb[r++] = decoded[i + 1];
    rgb[r++] = decoded[i + 2];
    alpha[a++] = decoded[i + 3];
  }
  return {
    width,
    height,
    rgb: deflateSync(rgb),
    alpha: deflateSync(alpha),
  };
}

function approximateWidth(value: unknown, size: number) {
  return normalizePdfText(value).length * size * 0.51;
}

export function renderBillingReportPdf(
  report: Report,
  items: Item[],
  logo?: Buffer,
) {
  // 17 linhas por página deixam espaço para identificação, resumo financeiro e PIX
  // sem invadir as margens do documento.
  const perPage = 17;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const objects: Array<Buffer | string> = [];
  const add = (v: Buffer | string) => {
    objects.push(v);
    return objects.length;
  };

  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );

  let imageId: number | undefined;
  let imageSize: { width: number; height: number } | undefined;
  let maskId: number | undefined;
  if (logo) {
    const image = pngImage(logo);
    imageSize = image;
    if (image.alpha) {
      maskId = add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>\nstream\n`,
          ),
          image.alpha,
          Buffer.from("\nendstream"),
        ]),
      );
    }
    imageId = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${maskId ? ` /SMask ${maskId} 0 R` : ""} /Length ${image.rgb.length} >>\nstream\n`,
        ),
        image.rgb,
        Buffer.from("\nendstream"),
      ]),
    );
  }

  const pageIds: number[] = [];
  const contents: number[] = [];

  for (let page = 0; page < pages; page++) {
    const rows = items.slice(page * perPage, (page + 1) * perPage);
    const out: Buffer[] = [];
    const raw = (s: string) => out.push(Buffer.from(s + "\n", "ascii"));
    const t = (
      x: number,
      y: number,
      value: unknown,
      size = 10,
      b = false,
    ) => {
      out.push(
        Buffer.from(`BT /${b ? "B" : "F"} ${size} Tf ${x} ${y} Td (`, "ascii"),
        encodeWinAnsi(value),
        Buffer.from(") Tj ET\n", "ascii"),
      );
    };
    const tRight = (
      right: number,
      y: number,
      value: unknown,
      size = 10,
      b = false,
    ) => t(Math.max(MARGIN_LEFT, right - approximateWidth(value, size)), y, value, size, b);
    const line = (y: number, branded = false) =>
      raw(
        `${branded ? `${BRAND_R} ${BRAND_G} ${BRAND_B}` : "0.82 0.79 0.75"} RG ${MARGIN_LEFT} ${y} m ${CONTENT_RIGHT} ${y} l S`,
      );

    // Número de página na margem superior, no padrão de paginação acadêmica.
    raw("0.35 0.32 0.30 rg");
    tRight(CONTENT_RIGHT, PAGE_HEIGHT - 35, `Página ${page + 1} de ${pages}`, 8);

    // Cabeçalho institucional.
    raw(`${BRAND_R} ${BRAND_G} ${BRAND_B} rg`);
    if (imageId && imageSize) {
      const maxW = 155;
      const maxH = 52;
      const scale = Math.min(maxW / imageSize.width, maxH / imageSize.height);
      const w = imageSize.width * scale;
      const h = imageSize.height * scale;
      raw(
        `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN_LEFT} ${(PAGE_HEIGHT - MARGIN_TOP + 13 - h).toFixed(2)} cm /Logo Do Q`,
      );
    } else {
      t(MARGIN_LEFT, 775, "Menu Flow", 16, true);
    }
    tRight(CONTENT_RIGHT, 778, "RELATÓRIO DE SERVIÇOS", 14, true);
    raw("0.16 0.14 0.13 rg");
    tRight(CONTENT_RIGHT, 761, report.reportNumber, 8, true);
    line(710, true);

    let y = 684;
    if (page === 0) {
      t(MARGIN_LEFT, y, "IDENTIFICAÇÃO DO RELATÓRIO", 11, true);
      y -= 21;
      t(MARGIN_LEFT, y, `Relatório: ${report.reportNumber}`, 10, true);
      tRight(
        CONTENT_RIGHT,
        y,
        `Emissão: ${date(report.generatedAt, report.timezone)}`,
        10,
      );
      y -= 18;
      t(
        MARGIN_LEFT,
        y,
        `Estabelecimento: ${report.restaurantSnapshot.tradeName || report.restaurantSnapshot.name}`,
        10,
      );
      y -= 18;
      const registration = [
        report.restaurantSnapshot.cnpj && `CNPJ: ${report.restaurantSnapshot.cnpj}`,
        [report.restaurantSnapshot.city, report.restaurantSnapshot.state]
          .filter(Boolean)
          .join(" - "),
      ]
        .filter(Boolean)
        .join(" | ");
      if (registration) t(MARGIN_LEFT, y, registration, 9);
      tRight(
        CONTENT_RIGHT,
        y,
        `Período: ${date(report.periodStart, report.timezone)} a ${date(report.periodEnd, report.timezone)}`,
        9,
      );
      y -= 24;
      line(y);
      y -= 22;

      t(MARGIN_LEFT, y, "TAXAS DE SERVIÇO MENU FLOW", 11, true);
      y -= 18;
      t(
        MARGIN_LEFT,
        y,
        "Valores das taxas de serviço cobradas dos clientes nos pedidos concluídos",
        9,
      );
      y -= 14;
      t(MARGIN_LEFT, y, "e repassadas ao Menu Flow no período informado.", 9);
      y -= 20;
      t(MARGIN_LEFT, y, `Pedidos concluídos: ${report.orderCount}`, 9);
      tRight(
        CONTENT_RIGHT,
        y,
        `Subtotal das taxas: ${money(report.serviceFeeTotalCents)}`,
        9,
        true,
      );
      y -= 26;
    } else {
      t(MARGIN_LEFT, y, "DETALHAMENTO DOS PEDIDOS - CONTINUAÇÃO", 10, true);
      y -= 24;
    }

    // Cabeçalho da tabela repetido em todas as páginas.
    t(MARGIN_LEFT, y, "PEDIDO", 7.5, true);
    t(MARGIN_LEFT + 82, y, "DATA", 7.5, true);
    t(MARGIN_LEFT + 145, y, "HORA", 7.5, true);
    t(MARGIN_LEFT + 190, y, "MODALIDADE", 7.5, true);
    t(MARGIN_LEFT + 276, y, "VALOR PAGO", 7.5, true);
    t(MARGIN_LEFT + 380, y, "TAXA", 7.5, true);
    y -= 8;
    line(y);
    y -= 15;

    for (const item of rows) {
      t(MARGIN_LEFT, y, item.orderNumber, 8);
      t(MARGIN_LEFT + 82, y, date(item.completedAt, report.timezone), 8);
      t(MARGIN_LEFT + 145, y, time(item.completedAt, report.timezone), 8);
      t(
        MARGIN_LEFT + 190,
        y,
        item.fulfillment === "DELIVERY" ? "Entrega" : "Retirada",
        8,
      );
      tRight(MARGIN_LEFT + 365, y, money(item.orderTotalCents), 8);
      tRight(CONTENT_RIGHT, y, money(item.feeCents), 8);
      y -= 17;
    }

    if (page === pages - 1) {
      y = Math.max(y - 8, 255);
      line(y);
      y -= 23;
      t(MARGIN_LEFT, y, "RESUMO FINANCEIRO", 11, true);
      y -= 21;
      t(MARGIN_LEFT + 155, y, "Taxas de serviço Menu Flow", 9);
      tRight(CONTENT_RIGHT, y, money(report.serviceFeeTotalCents), 10, true);
      y -= 18;
      t(MARGIN_LEFT + 155, y, "Mensalidade Menu Flow", 9);
      tRight(
        CONTENT_RIGHT,
        y,
        report.includeMonthlyFee ? money(report.monthlyFeeCents) : "Não incluída",
        10,
        true,
      );
      y -= 27;
      raw(`${BRAND_R} ${BRAND_G} ${BRAND_B} rg`);
      t(MARGIN_LEFT + 155, y, "TOTAL A PAGAR", 13, true);
      tRight(CONTENT_RIGHT, y, money(report.totalCents), 13, true);
      raw("0.16 0.14 0.13 rg");
      y -= 31;
      line(y);
      y -= 22;
      t(MARGIN_LEFT, y, "DADOS PARA PAGAMENTO", 11, true);
      y -= 19;
      t(MARGIN_LEFT, y, "Pagamento via PIX", 9, true);
      y -= 16;
      t(
        MARGIN_LEFT,
        y,
        `Favorecido: ${report.paymentSnapshot?.pixReceiverName || "Não informado"}`,
        9,
      );
      y -= 16;
      t(
        MARGIN_LEFT,
        y,
        `Chave PIX: ${report.paymentSnapshot?.pixKey || "Não informada"}`,
        9,
      );
    }

    // Rodapé discreto dentro da margem inferior.
    raw("0.45 0.42 0.40 rg");
    line(MARGIN_BOTTOM - 4);
    t(MARGIN_LEFT, 37, "Menu Flow - Cardápios mais simples, clientes mais felizes.", 7);
    tRight(CONTENT_RIGHT, 37, report.reportNumber, 7);

    const stream = Buffer.concat(out);
    contents.push(
      add(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
          stream,
          Buffer.from("endstream"),
        ]),
      ),
    );
    pageIds.push(add(""));
  }

  const pagesId = add("");
  pageIds.forEach(
    (id, n) =>
      (objects[id - 1] =
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F ${font} 0 R /B ${bold} 0 R >>${imageId ? ` /XObject << /Logo ${imageId} 0 R >>` : ""} >> /Contents ${contents[n]} 0 R >>`),
  );
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const chunks = [Buffer.from("%PDF-1.4\n%MENUFLOW\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(obj);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });

  const xref = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++)
    table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  chunks.push(
    Buffer.from(
      `${table}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
